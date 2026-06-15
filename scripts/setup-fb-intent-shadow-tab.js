// scripts/setup-fb-intent-shadow-tab.js
// One-shot · create IntentShadow tab in FB Sheet · idempotent
//
// Usage: node scripts/setup-fb-intent-shadow-tab.js
'use strict';

require('dotenv').config();
const { google } = require('googleapis');

const TAB_NAME = 'IntentShadow';
const HEADER = ['timestamp', 'psid', 'msgText', 'intent', 'sub', 'handler', 'confidence', 'reason', 'lead_stage'];

async function main() {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  console.log(`📖 Target Sheet: ${sheetId} (FB own Sheet)`);
  console.log(`📖 Checking for tab "${TAB_NAME}"…`);
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets.properties' });
  const exists = (meta.data.sheets || []).some(s => s.properties.title === TAB_NAME);

  if (exists) {
    console.log(`✅ Tab "${TAB_NAME}" already exists`);
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${TAB_NAME}!A1:I1` });
    console.log(`   Header: ${(r.data.values && r.data.values[0] || []).join(' | ')}`);
    process.exit(0);
  }

  console.log(`➕ Creating tab "${TAB_NAME}"…`);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME } } }] },
  });
  console.log(`✅ Tab created`);

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:I1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADER] },
  });
  console.log(`✅ Header: ${HEADER.join(' | ')}`);
  console.log(`\n🎉 Done. Next: apply server.js shadow wiring`);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
