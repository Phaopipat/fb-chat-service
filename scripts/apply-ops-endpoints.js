'use strict';

/**
 * scripts/apply-ops-endpoints.js
 *
 * Idempotent patcher that adds 6 observability/ops endpoints to FB server.js:
 *   - GET /healthz                    PUBLIC liveness (no auth)
 *   - GET /readyz             [admin] config + optional deep Sheets ping
 *   - GET /runtime-status     [admin] runtime + config snapshot
 *   - GET /bot-stats          [admin] simple counters
 *   - GET /stats              [admin] aggregated last-90d Messages totals
 *   - GET /recent             [admin] last N Messages rows
 *
 * Inserted BEFORE app.get("/webhook", ...) at ~line 467.
 *
 * Also adds require for sheets-helper getStats (renamed getSheetQueueStats).
 *
 * Marker: FB_OPS_ENDPOINTS_WIRED
 *
 * Usage: node scripts/apply-ops-endpoints.js
 *        node scripts/apply-ops-endpoints.js --dry-run
 */

const fs = require('fs');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const MARKER = 'FB_OPS_ENDPOINTS_WIRED';
const DRY = process.argv.includes('--dry-run');

function read() {
  return fs.readFileSync(SERVER_PATH, 'utf8');
}

function write(content) {
  if (DRY) {
    console.log('[dry-run] would write', SERVER_PATH);
    return;
  }
  const backup = `${SERVER_PATH}.bak-ops-endpoints-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(SERVER_PATH, backup);
  fs.writeFileSync(SERVER_PATH, content);
  console.log('✅ wrote', SERVER_PATH);
  console.log('   backup:', backup);
}

const ENDPOINTS_BLOCK = `// ─── ${MARKER} — observability/ops endpoints (E11 gated except /healthz) ───
// FB Messages tab schema (10 cols A:J):
//   0=ts 1=date 2=time 3=psid 4=displayName 5=messageType 6=text 7=extra 8=mid 9=senderType
// PSIDs are 16-digit numerics — mask if pre-existing truncated rows leak via col F.
app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    service: "fb-chat-service",
    uptimeSec: observability.getRuntimeSnapshot().uptimeSec,
  });
});

app.get("/readyz", requireAdminToken, async (req, res) => {
  const checks = {
    config: observability.getConfigSnapshot(),
    sheets: {
      configured: !!GOOGLE_SHEET_ID && !!GOOGLE_SERVICE_ACCOUNT_JSON,
      ok: null,
      latencyMs: null,
      error: "",
    },
  };

  const deep = req.query.deep === "1" || req.query.deep === "true";
  if (deep && checks.sheets.configured) {
    const started = Date.now();
    try {
      const sheets = await getSheets();
      await Promise.race([
        sheets.spreadsheets.values.get({
          spreadsheetId: GOOGLE_SHEET_ID,
          range: \`\${SHEET_TAB}!A1:A1\`,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Sheets readiness timeout")), 2500)
        ),
      ]);
      checks.sheets.ok = true;
      checks.sheets.latencyMs = Date.now() - started;
    } catch (err) {
      checks.sheets.ok = false;
      checks.sheets.latencyMs = Date.now() - started;
      checks.sheets.error = err.message;
      observability.recordError("readyz.sheets", err);
    }
  }

  const missing =
    !checks.config.sheetIdConfigured ||
    !checks.config.serviceAccountConfigured ||
    !checks.config.fbVerifyTokenConfigured ||
    !checks.config.fbPageTokenConfigured;
  const deepFail = deep && checks.sheets.configured && checks.sheets.ok === false;
  const ok = !missing && !deepFail;

  res.status(ok ? 200 : 503).json({
    ok,
    deep,
    checks,
    runtime: observability.getRuntimeSnapshot(),
    sheetQueue: getSheetQueueStats(),
    leadProfile: getLeadProfileStats(),
  });
});

app.get("/runtime-status", requireAdminToken, (_req, res) => {
  res.json({
    ok: true,
    runtime: observability.getRuntimeSnapshot(),
    config: observability.getConfigSnapshot(),
    sheetQueue: getSheetQueueStats(),
    leadProfile: getLeadProfileStats(),
  });
});

app.get("/bot-stats", requireAdminToken, (_req, res) => {
  const snap = observability.getRuntimeSnapshot();
  res.json({
    botEnabled: BOT_ENABLED,
    autoReplyEnabled: BOT_ENABLED && !!ANTHROPIC_API_KEY && !!FB_PAGE_ACCESS_TOKEN,
    counters: snap.counters,
    uptimeSec: snap.uptimeSec,
  });
});

app.get("/stats", requireAdminToken, async (_req, res) => {
  try {
    const sheets = await getSheets();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: \`\${SHEET_TAB}!A2:J\`,
    });
    const allRows = result.data.values || [];
    const rows = allRows.filter((r) => r[9] !== "bot_silent_test_mode");
    const total = rows.length;
    const totalIncludingSilent = allRows.length;
    const users = [...new Set(rows.map((r) => r[3]))].filter(Boolean);
    const msgTypes = {};
    const dateCount = {};
    const senderCount = {};

    for (const r of rows) {
      const rawType = r[5] || "unknown";
      // mask any FB PSID that leaked into col F (defense-in-depth)
      const type = /^\\d{15,17}$/.test(rawType) ? "unknown" : rawType;
      msgTypes[type] = (msgTypes[type] || 0) + 1;
      const d = r[1] || "unknown";
      dateCount[d] = (dateCount[d] || 0) + 1;
      const s = r[9] || "";
      if (s) senderCount[s] = (senderCount[s] || 0) + 1;
    }

    res.json({
      totalMessages: total,
      totalIncludingSilent,
      uniqueUsers: users.length,
      messageTypes: msgTypes,
      dailyMessages: dateCount,
      senderBreakdown: senderCount,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/recent", requireAdminToken, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "50", 10);
    const includeSilent = req.query.includeSilent === "1";
    const sheets = await getSheets();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: \`\${SHEET_TAB}!A2:J\`,
    });
    const allRows = result.data.values || [];
    const filtered = includeSilent
      ? allRows
      : allRows.filter((r) => r[9] !== "bot_silent_test_mode");
    const rows = filtered.slice(-limit).reverse();
    const messages = rows.map((r) => ({
      timestamp: r[0],
      date: r[1],
      time: r[2],
      psid: r[3],
      displayName: r[4],
      messageType: r[5],
      messageText: r[6],
      extra: r[7],
      mid: r[8],
      senderType: r[9],
    }));
    res.json({ messages, count: messages.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

`;

function main() {
  let src = read();

  if (src.includes(MARKER)) {
    console.log(`ℹ️  ${MARKER} already present — skipping`);
    return;
  }

  const changes = [];

  // ─── 1. Add require for sheets-helper getStats (aliased) ───
  if (!/require\(["']\.\/sheets-helper["']\)/.test(src)) {
    const anchor = 'const { getLeadProfileStats } = require("./lead-profile");';
    const fallbackAnchor =
      'const observability = require("./observability");  // FB_OBSERVABILITY_WIRED';
    const newReq =
      'const { getStats: getSheetQueueStats } = require("./sheets-helper");  // ' + MARKER;
    if (src.includes(anchor)) {
      src = src.replace(anchor, anchor + '\n' + newReq);
      changes.push('added require("./sheets-helper") after lead-profile require');
    } else if (src.includes(fallbackAnchor)) {
      src = src.replace(fallbackAnchor, fallbackAnchor + '\n' + newReq);
      changes.push('added require("./sheets-helper") after observability require');
    } else {
      throw new Error('Could not find anchor for sheets-helper require — bailing');
    }
  }

  // Ensure getLeadProfileStats is imported (FB lead-profile may already export it
  // but server may not have destructured it). Add minimal require if missing.
  if (!/getLeadProfileStats/.test(src)) {
    const lpAnchor = 'const observability = require("./observability");  // FB_OBSERVABILITY_WIRED';
    const newReq = 'const { getLeadProfileStats } = require("./lead-profile");  // ' + MARKER;
    if (src.includes(lpAnchor)) {
      src = src.replace(lpAnchor, lpAnchor + '\n' + newReq);
      changes.push('added require for getLeadProfileStats');
    }
  }

  // ─── 2. Insert endpoints block BEFORE "app.get(\"/webhook\", ...)" ───
  const webhookAnchor = 'app.get("/webhook", (req, res) => {';
  if (src.includes(ENDPOINTS_BLOCK.trim())) {
    console.log('ℹ️  endpoints block already present (text match) — skipping insert');
  } else if (src.includes(webhookAnchor)) {
    src = src.replace(webhookAnchor, ENDPOINTS_BLOCK + webhookAnchor);
    changes.push('inserted 6 ops endpoints before GET /webhook');
  } else {
    throw new Error('Could not find GET /webhook anchor — bailing');
  }

  if (changes.length === 0) {
    console.log(`ℹ️  No changes needed`);
    return;
  }

  console.log('Changes:');
  changes.forEach((c) => console.log('  - ' + c));

  write(src);
  console.log(`\nMarker "${MARKER}" appears ${(src.match(new RegExp(MARKER, 'g')) || []).length}x in server.js`);
}

main();
