// scripts/diagnose-fb-send.js
// V99 follow-up · diagnose why [Send] Error: fetch failed on 2026-06-16 15:30
// Read-only by default · use --send to actually try sending a test message
// Usage:
//   node scripts/diagnose-fb-send.js                       # probe only (safe)
//   node scripts/diagnose-fb-send.js --send                # actually send 1 test text
//   node scripts/diagnose-fb-send.js --psid=1496719837083797 --send
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Default PSID = Phao's test PSID from V99 smoke 2026-06-16 15:30
const DEFAULT_PSID = '1496719837083797';
const args = process.argv.slice(2);
const SEND_FLAG = args.includes('--send');
const PSID = (args.find(a => a.startsWith('--psid=')) || '').split('=')[1] || DEFAULT_PSID;

const TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const APP_SECRET = process.env.FB_APP_SECRET;

const RESET = '\x1b[0m', GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m';
function ok(msg)   { console.log(`${GREEN}✅${RESET} ${msg}`); }
function fail(msg) { console.log(`${RED}❌${RESET} ${msg}`); }
function warn(msg) { console.log(`${YELLOW}⚠️${RESET}  ${msg}`); }
function info(msg) { console.log(`${CYAN}ℹ️${RESET}  ${msg}`); }
function section(title) { console.log(`\n${CYAN}═══ ${title} ═══${RESET}`); }

async function call(url, opts = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, opts);
    const dt = Date.now() - t0;
    const txt = await r.text();
    let json;
    try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
    return { ok: r.ok, status: r.status, dt, json };
  } catch (e) {
    const dt = Date.now() - t0;
    return { ok: false, status: 0, dt, err: e.message };
  }
}

(async () => {
  console.log(`\n${CYAN}🩺 FB SEND ERROR DIAGNOSTIC${RESET}`);
  console.log(`Target PSID: ${PSID}`);
  console.log(`Mode: ${SEND_FLAG ? RED + 'WILL SEND TEST MESSAGE' + RESET : GREEN + 'PROBE ONLY (safe)' + RESET}`);

  // ─── 1. Env presence ────────────────────────────────────────────────────────
  section('1. Environment variables');
  if (TOKEN) { ok(`FB_PAGE_ACCESS_TOKEN present (length: ${TOKEN.length}, prefix: ${TOKEN.substring(0, 8)}...)`); }
  else { fail('FB_PAGE_ACCESS_TOKEN MISSING — set in .env'); process.exit(1); }
  if (APP_SECRET) { ok(`FB_APP_SECRET present (length: ${APP_SECRET.length})`); }
  else { warn('FB_APP_SECRET MISSING — webhook signature verification disabled'); }

  // ─── 2. DNS + reachability to graph.facebook.com ────────────────────────────
  section('2. Network reachability to graph.facebook.com');
  const reachProbe = await call('https://graph.facebook.com/v18.0/?access_token=' + TOKEN);
  if (reachProbe.status === 0) {
    fail(`Network fail: ${reachProbe.err} (took ${reachProbe.dt}ms)`);
    fail('Likely cause: DNS / firewall / TLS / Railway → graph.facebook.com blocked');
    info('Test from this terminal: curl -v https://graph.facebook.com/v18.0/me?access_token=$FB_PAGE_ACCESS_TOKEN');
  } else {
    ok(`Reached graph.facebook.com in ${reachProbe.dt}ms (HTTP ${reachProbe.status})`);
  }

  // ─── 3. Token validity ──────────────────────────────────────────────────────
  section('3. FB_PAGE_ACCESS_TOKEN validity');
  const meProbe = await call(`https://graph.facebook.com/v18.0/me?access_token=${TOKEN}`);
  if (!meProbe.ok) {
    fail(`Token check failed: HTTP ${meProbe.status}`);
    if (meProbe.json && meProbe.json.error) {
      const err = meProbe.json.error;
      fail(`Error: ${err.message} (type: ${err.type}, code: ${err.code}${err.error_subcode ? ', subcode: ' + err.error_subcode : ''})`);
      if (err.code === 190) {
        warn('Code 190 = token expired or revoked → regenerate at developers.facebook.com');
      }
    }
  } else {
    ok(`Token valid · Page: "${meProbe.json.name}" (ID: ${meProbe.json.id})`);
  }

  // ─── 4. Token debug (long-lived check) ──────────────────────────────────────
  section('4. Token debug (expiry + scopes)');
  const debugProbe = await call(`https://graph.facebook.com/v18.0/debug_token?input_token=${TOKEN}&access_token=${TOKEN}`);
  if (debugProbe.ok && debugProbe.json.data) {
    const d = debugProbe.json.data;
    ok(`Type: ${d.type}`);
    ok(`App ID: ${d.app_id}`);
    if (d.expires_at === 0) {
      ok('Expiry: NEVER (long-lived page token) ✓');
    } else if (d.expires_at) {
      const exp = new Date(d.expires_at * 1000);
      const daysLeft = Math.round((exp - Date.now()) / 86400000);
      if (daysLeft < 7) { fail(`Expiry: ${exp.toISOString()} (${daysLeft} days left — RENEW URGENT)`); }
      else if (daysLeft < 30) { warn(`Expiry: ${exp.toISOString()} (${daysLeft} days left)`); }
      else { ok(`Expiry: ${exp.toISOString()} (${daysLeft} days left)`); }
    }
    if (d.scopes && d.scopes.length) {
      const need = ['pages_messaging', 'pages_show_list', 'pages_manage_metadata', 'pages_read_engagement'];
      const have = d.scopes;
      info(`Granted scopes: ${have.join(', ')}`);
      const missing = need.filter(s => !have.includes(s));
      if (missing.length) { warn(`Missing recommended scopes: ${missing.join(', ')}`); }
      else { ok('Critical scopes present'); }
    }
  } else if (!debugProbe.ok) {
    warn(`Token debug failed: HTTP ${debugProbe.status} · ${JSON.stringify(debugProbe.json).substring(0, 200)}`);
  }

  // ─── 5. Subscribed apps (webhook delivery) ─────────────────────────────────
  section('5. Webhook subscriptions on page');
  const subProbe = await call(`https://graph.facebook.com/v18.0/me/subscribed_apps?access_token=${TOKEN}`);
  if (subProbe.ok && subProbe.json.data) {
    if (subProbe.json.data.length === 0) {
      fail('No app subscribed to this page → webhook events will NOT arrive');
      info('Fix: POST /me/subscribed_apps with subscribed_fields=messages,messaging_postbacks,...');
    } else {
      subProbe.json.data.forEach(app => {
        ok(`App "${app.name}" subscribed (fields: ${(app.subscribed_fields || []).join(', ') || 'unknown'})`);
      });
    }
  }

  // ─── 6. PSID conversation status (24h window) ──────────────────────────────
  section('6. PSID conversation lookup');
  const psidProbe = await call(`https://graph.facebook.com/v18.0/${PSID}?fields=name,id&access_token=${TOKEN}`);
  if (!psidProbe.ok) {
    fail(`PSID profile fetch failed: HTTP ${psidProbe.status}`);
    if (psidProbe.json.error) {
      const err = psidProbe.json.error;
      fail(`Error: ${err.message} (code: ${err.code}${err.error_subcode ? ', subcode: ' + err.error_subcode : ''})`);
      if (err.code === 100 && err.error_subcode === 2018001) {
        fail('Subcode 2018001 = "No matching user found" · PSID invalid or never messaged this page');
      } else if (err.code === 230) {
        fail('Code 230 = page-policy / app permission · check messaging permission');
      }
    }
  } else {
    ok(`PSID profile: name="${psidProbe.json.name || '(no name shared)'}", id=${psidProbe.json.id}`);
  }

  // Check 24-hour messaging window by fetching last conversation message timestamp
  const convProbe = await call(`https://graph.facebook.com/v18.0/me/conversations?user_id=${PSID}&fields=updated_time,message_count&access_token=${TOKEN}`);
  if (convProbe.ok && convProbe.json.data && convProbe.json.data.length > 0) {
    const conv = convProbe.json.data[0];
    const updated = new Date(conv.updated_time);
    const hoursAgo = (Date.now() - updated.getTime()) / 3600000;
    info(`Last conversation update: ${conv.updated_time} (${hoursAgo.toFixed(1)} hours ago)`);
    info(`Total messages exchanged: ${conv.message_count}`);
    if (hoursAgo > 24) {
      fail('OUTSIDE 24-hour window · standard "RESPONSE" messaging tag will fail');
      warn('Fix options: (a) wait for user to message again · (b) use messaging_type=MESSAGE_TAG with appropriate tag (e.g. CONFIRMED_EVENT_UPDATE, ACCOUNT_UPDATE) · (c) use HUMAN_AGENT tag (24h → 7 days extension if Page enrolled in beta)');
    } else {
      ok(`Inside 24-hour window (${(24 - hoursAgo).toFixed(1)} hours remaining)`);
    }
  } else {
    warn('Could not fetch conversation history · 24h window status unknown');
  }

  // ─── 7. Test send (gated by --send flag) ───────────────────────────────────
  section('7. Test send (LIVE)');
  if (!SEND_FLAG) {
    info('Skipped · pass --send flag to attempt sending 1 test message');
    info(`Example: node scripts/diagnose-fb-send.js --psid=${PSID} --send`);
  } else {
    const body = {
      recipient: { id: PSID },
      messaging_type: 'RESPONSE',
      message: { text: `[V99 diagnostic test ${new Date().toISOString().substring(11, 19)}] · ตรวจสอบ FB Send · ขอ ignore ครับ` },
    };
    const sendProbe = await call(`https://graph.facebook.com/v18.0/me/messages?access_token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (sendProbe.ok) {
      ok(`Send SUCCESS · message_id=${sendProbe.json.message_id}`);
      info(`Check FB Page inbox · message should appear to PSID ${PSID}`);
    } else {
      fail(`Send FAIL · HTTP ${sendProbe.status}`);
      if (sendProbe.json.error) {
        const err = sendProbe.json.error;
        fail(`Error: ${err.message}`);
        fail(`Type: ${err.type} · Code: ${err.code}${err.error_subcode ? ' · Subcode: ' + err.error_subcode : ''}`);
        info(`Raw: ${JSON.stringify(sendProbe.json).substring(0, 300)}`);

        // Common error decoder
        if (err.code === 10 && err.error_subcode === 2018278) fail('→ Outside 24h window · use MESSAGE_TAG');
        else if (err.code === 100 && err.error_subcode === 2018001) fail('→ PSID invalid');
        else if (err.code === 200 || err.code === 230) fail('→ Permission issue · check pages_messaging scope');
        else if (err.code === 4 || err.code === 17) fail('→ Rate limit · slow down');
        else if (err.code === 551) fail('→ User has unsubscribed or is in restricted period');
      }
    }
  }

  // ─── Summary ────────────────────────────────────────────────────────────────
  section('Summary');
  info('Compare findings against Railway log "[Send] Error: fetch failed" 2026-06-16 15:30');
  info('Most likely causes (rank order based on log pattern):');
  info('  1. Transient Railway→Graph network blip · re-test from production with same PSID');
  info('  2. 24-hour window expired between V99 smokes (13:44 worked · 15:30 failed = ~2 hours gap UNLIKELY but possible if other policy)');
  info('  3. Token rotated/revoked between smokes (rare without admin action)');
  info('  4. PSID blocked / unsubscribed mid-test (check Phao FB Messenger app for any block actions)');
  console.log();
})();
