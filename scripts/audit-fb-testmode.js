const { google } = require('googleapis');
require('dotenv').config();

(async () => {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  const tab = process.env.TEST_MODE_TAB || 'TestMode';
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: tab + '!A1:E100'
  });
  const rows = r.data.values || [];
  console.log('TestMode tab rows:', rows.length);
  rows.forEach((row, i) => console.log((i+1) + ':', row.join(' | ')));
})().catch(e => console.error('ERR:', e.message));
