// scripts/setup-lead-profile-tab.js
// สร้าง LeadProfile tab ใน Google Sheet (run once)
//
// วิธีใช้:
//   node scripts/setup-lead-profile-tab.js
//
// ต้องมี env: GOOGLE_SERVICE_ACCOUNT_JSON + GOOGLE_SHEET_ID
//
// Schema (21 cols A-U):
//   A userId            B platform        C displayName     D stage
//   E dates_known       F pax_known       G room_pref       H budget_signal
//   I objections        J last_signal     K next_action     L first_contact
//   M last_inbound      N inbound_count   O bot_reply_count P escalation_count
//   Q notes             R updated_at      S phone           T linked_user_ids
//   U bot_last_quote_at
//
// หลัง run เสร็จ:
//   1. ตรวจ Sheet → ต้องมีแท็บใหม่ "LeadProfile" + header row
//   2. ยังไม่ต้องทำอะไรต่อ — scripts/backfill-lead-profile.js จะ populate
//
'use strict';

require('dotenv').config();
const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SA_JSON  = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

const HEADERS = [
  'userId', 'platform', 'displayName', 'stage',
  'dates_known', 'pax_known', 'room_pref', 'budget_signal',
  'objections', 'last_signal', 'next_action', 'first_contact',
  'last_inbound', 'inbound_count', 'bot_reply_count', 'escalation_count',
  'notes', 'updated_at', 'phone', 'linked_user_ids',
  'bot_last_quote_at',
];

async function main() {
  if (!SHEET_ID || !SA_JSON) {
    console.error('❌ GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON must be set');
    process.exit(1);
  }

  const creds = JSON.parse(SA_JSON.replace(/\\\\n/g, '\\n'));
  const auth  = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // ── 1. Create tab ──────────────────────────────────────────────────────────
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{
          addSheet: {
            properties: {
              title: 'LeadProfile',
              tabColor: { red: 0.4, green: 0.7, blue: 0.95 }, // light blue
              gridProperties: { frozenRowCount: 1 },
            },
          },
        }],
      },
    });
    console.log('✅ Created tab: LeadProfile');
  } catch (err) {
    if (err.message?.includes('already exists')) {
      console.log('⏭️  Tab already exists: LeadProfile (continuing — will rewrite header)');
    } else {
      console.error('❌ Failed to create tab:', err.message);
      process.exit(1);
    }
  }

  // ── 2. Write header row ────────────────────────────────────────────────────
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'LeadProfile!A1:U1',
      valueInputOption: 'RAW',
      requestBody: { values: [HEADERS] },
    });
    console.log('✅ Header written: 21 columns A-U');
  } catch (err) {
    console.error('❌ Failed to write header:', err.message);
  }

  console.log('\n✅ LeadProfile tab ready in Sheet:', SHEET_ID);
  console.log('\nNext steps:');
  console.log('  1. ตรวจ Sheet — แท็บใหม่ "LeadProfile" + header row');
  console.log('  2. รัน backfill: node scripts/backfill-lead-profile.js');
  console.log('  3. Deploy webhook-kohtalu (lead-profile.js + integration · LEAD_PROFILE_ENABLED=false)');
  console.log('  4. ทดสอบ TestMode: ตั้ง LEAD_PROFILE_ENABLED=true + TEST_MODE_ENABLED=true ใน Railway');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
