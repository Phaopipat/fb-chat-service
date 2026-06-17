// Show recent FB Messages (last N rows) · formatted for smoke test analysis
// Usage: node scripts/show-recent-messages.js [limit=30]
// Output: human-readable text · pipe to file or terminal
const { google } = require('googleapis');
require('dotenv').config();

const LIMIT = parseInt(process.argv[2]) || 30;
const SHEET_TAB = process.env.SHEET_TAB || 'Messages';

(async () => {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${SHEET_TAB}!A:J`
  });
  const rows = r.data.values || [];
  const recent = rows.slice(-LIMIT);

  console.log(`═══ FB recent ${LIMIT} messages (latest at bottom) ═══`);
  console.log('');

  recent.forEach((row) => {
    if (!row[0]) return;  // skip header
    const time = (row[2] || '').slice(0, 8);  // HH:MM:SS
    const sender = row[9] === 'outbound' ? '🤖 BOT' : `👤 ${(row[4] || '?').slice(0, 15)}`;
    const type = row[5] || 'text';
    const text = (row[6] || '').replace(/\n/g, '\n         ');  // indent newlines
    const marker = type === 'image' ? '[IMAGE]' : '';
    console.log(`${time} ${sender}: ${marker}${text || '(empty)'}`);
    console.log('');
  });
})().catch(e => console.error('ERR:', e.message));
