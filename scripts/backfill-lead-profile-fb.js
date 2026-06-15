// scripts/backfill-lead-profile-fb.js
// FB version · backfill LeadProfile from FB Messages tab.
//
// Differences from LINE backfill:
//   - FB Messages senderType col J (index 9) = "inbound"/"outbound" (not "user"/"bot")
//   - FB senderId is PSID (numeric string · 16+ digits) not LINE userId (U + hex)
//   - platform written as 'FB'
//
// Usage:
//   node scripts/backfill-lead-profile-fb.js               # dry-run
//   node scripts/backfill-lead-profile-fb.js --write       # commit
//   node scripts/backfill-lead-profile-fb.js --days=30
'use strict';

require('dotenv').config();
const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SA_JSON  = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const daysArg = args.find(a => a.startsWith('--days='));
const WINDOW_DAYS = daysArg ? parseInt(daysArg.split('=')[1], 10) : 90;

// FB Messages schema (server.js appendRow at line 502):
// A:J = timestamp, date, time, senderId(PSID), senderName, messageType, text, extra, mid, senderType
const MSG_COL = {
  timestamp:   0,
  date:        1,
  time:        2,
  userId:      3,  // D · PSID
  displayName: 4,  // E
  messageType: 5,
  messageText: 6,
  senderType:  9,  // J · "inbound"/"outbound" (vs LINE col I "user"/"bot")
};

// LeadProfile schema (same as LINE · 21 cols A:U)
const LP_COL = {
  userId: 0, platform: 1, displayName: 2, stage: 3,
  dates_known: 4, pax_known: 5, room_pref: 6, budget_signal: 7,
  objections: 8, last_signal: 9, next_action: 10,
  first_contact: 11, last_inbound: 12,
  inbound_count: 13, bot_reply_count: 14, escalation_count: 15,
  notes: 16, updated_at: 17, phone: 18, linked_user_ids: 19, bot_last_quote_at: 20,
};

async function main() {
  if (!SHEET_ID || !SA_JSON) {
    console.error('❌ GOOGLE_SHEET_ID + GOOGLE_SERVICE_ACCOUNT_JSON required');
    process.exit(1);
  }
  const creds = JSON.parse(SA_JSON.replace(/\\\\n/g, '\\n'));
  const auth  = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  console.log(`📖 FB LeadProfile backfill${WRITE ? '' : ' · DRY RUN'}`);
  console.log(`   Window: last ${WINDOW_DAYS} days · Sheet: ${SHEET_ID}\n`);

  // Read Messages tab (FB uses 'Messages' default · check env SHEET_TAB)
  const sheetTab = process.env.SHEET_TAB || 'Messages';
  console.log(`📖 Reading ${sheetTab}!A2:J…`);
  const msgRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheetTab}!A2:J`,
  });
  const rows = msgRes.data.values || [];
  console.log(`   → ${rows.length} message rows`);

  // Group by userId · count inbound messages
  const profiles = new Map();
  const cutoffMs = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;

  for (const row of rows) {
    const userId      = row[MSG_COL.userId];
    const displayName = row[MSG_COL.displayName] || '';
    const senderType  = (row[MSG_COL.senderType] || '').toLowerCase();
    const timestamp   = row[MSG_COL.timestamp];
    if (!userId || userId.length < 10) continue;
    if (!timestamp) continue;
    const tsMs = new Date(timestamp).getTime();
    if (isNaN(tsMs) || tsMs < cutoffMs) continue;

    if (!profiles.has(userId)) {
      profiles.set(userId, {
        userId,
        displayName,
        first_contact: timestamp,
        last_inbound:  timestamp,
        inbound_count: 0,
        bot_reply_count: 0,
      });
    }
    const p = profiles.get(userId);
    if (displayName && !p.displayName) p.displayName = displayName;
    if (senderType === 'inbound') {
      p.inbound_count++;
      if (new Date(timestamp) > new Date(p.last_inbound)) p.last_inbound = timestamp;
      if (new Date(timestamp) < new Date(p.first_contact)) p.first_contact = timestamp;
    } else if (senderType === 'outbound') {
      p.bot_reply_count++;
    }
  }

  console.log(`\n📊 Found ${profiles.size} unique FB PSIDs with activity in window`);

  // Read existing LeadProfile rows
  let existingIds = new Set();
  let hasLeadProfileTab = false;
  try {
    const lpRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'LeadProfile!A2:A',
    });
    existingIds = new Set((lpRes.data.values || []).map(r => r[0]).filter(Boolean));
    hasLeadProfileTab = true;
  } catch (err) {
    if (/Unable to parse range/.test(err.message)) {
      console.log(`⚠️  LeadProfile tab not found · run setup-lead-profile-tab.js first`);
      process.exit(1);
    }
    throw err;
  }

  console.log(`   Existing LP rows: ${existingIds.size}`);

  // Build new rows to append
  const nowIso = new Date().toISOString();
  const newRows = [];
  for (const [userId, p] of profiles) {
    if (existingIds.has(userId)) continue;
    const row = new Array(21).fill('');
    row[LP_COL.userId]          = userId;
    row[LP_COL.platform]        = 'FB';
    row[LP_COL.displayName]     = p.displayName;
    row[LP_COL.stage]           = 'cold';
    row[LP_COL.first_contact]   = p.first_contact;
    row[LP_COL.last_inbound]    = p.last_inbound;
    row[LP_COL.inbound_count]   = String(p.inbound_count);
    row[LP_COL.bot_reply_count] = String(p.bot_reply_count);
    row[LP_COL.escalation_count]= '0';
    row[LP_COL.updated_at]      = nowIso;
    newRows.push(row);
  }

  console.log(`\n─── Summary ───`);
  console.log(`  to append: ${newRows.length} new profiles`);
  console.log(`  skip (already exist): ${profiles.size - newRows.length}`);

  if (!WRITE) {
    console.log(`\n💡 Dry run · re-run with --write to commit`);
    if (newRows.length > 0) {
      console.log('\nSample (first 3):');
      newRows.slice(0, 3).forEach(r => {
        console.log(`  ${r[0].substring(0, 16)}... · ${r[2] || '(no name)'} · in=${r[13]} bot=${r[14]}`);
      });
    }
    process.exit(0);
  }

  if (newRows.length === 0) {
    console.log('\n✅ Nothing to append.');
    process.exit(0);
  }

  console.log(`\n✍️  Writing ${newRows.length} rows…`);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'LeadProfile!A:U',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: newRows },
  });

  console.log(`\n🎉 Done · ${newRows.length} FB leads backfilled`);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
