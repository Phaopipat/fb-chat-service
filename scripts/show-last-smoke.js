// scripts/show-last-smoke.js
// V100c smoke verification · show last N inbound/outbound pairs from iB Chatlog
// Usage: node scripts/show-last-smoke.js [N=10] [psid]
'use strict';

const { google } = require('googleapis');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const N = parseInt(process.argv[2], 10) || 10;
const PSID_FILTER = process.argv[3] || null;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = process.env.SHEET_TAB || 'iB Chatlog';

(async () => {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    // V100e diagnostic · auto-detect tab name first (handles "iB Chatlog" vs "Messages" variants)
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID,
      fields: 'sheets.properties.title',
    });
    const allTabs = (meta.data.sheets || []).map(s => s.properties.title);
    let actualTab = SHEET_TAB;
    if (!allTabs.includes(actualTab)) {
      const candidate = allTabs.find(t => /iB|chatlog|Messages/i.test(t));
      if (candidate) {
        console.log(`[note] tab "${SHEET_TAB}" not found · using "${candidate}" instead`);
        console.log(`[note] all tabs: ${allTabs.join(', ')}\n`);
        actualTab = candidate;
      } else {
        console.error(`[error] No chat tab found · available tabs: ${allTabs.join(', ')}`);
        return;
      }
    }
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${actualTab}'!A:O`,
    });

    const rows = res.data.values || [];
    if (rows.length === 0) {
      console.log('No data in sheet.');
      return;
    }

    // Assume row 0 is header · last N data rows
    const dataRows = rows.slice(1);
    let recent = dataRows.slice(-Math.min(N * 3, dataRows.length));
    if (PSID_FILTER) recent = recent.filter(r => (r[3] || '').includes(PSID_FILTER));
    recent = recent.slice(-N);

    console.log(`\n=== Last ${recent.length} rows from "${SHEET_TAB}" ${PSID_FILTER ? `(PSID filter: ${PSID_FILTER})` : ''} ===\n`);

    for (const row of recent) {
      const [ts, date, time, psid, name, mtype, text, , , , , , topic] = row;
      const direction = (row[8] || '').toString();
      const sender = (row[7] || '').toString();
      const isInbound = direction === 'inbound' || sender === 'user';
      const isOutbound = direction === 'outbound' || sender === 'bot' || (name || '').includes('Page Bot');
      const arrow = isInbound ? '⬇️ IN ' : isOutbound ? '⬆️ OUT' : '  ?  ';
      const preview = (text || '').toString().substring(0, 120).replace(/\n/g, ' ');
      const topicTag = topic ? ` [${topic}]` : '';
      console.log(`${arrow} ${time || ts} | ${(name || psid || '?').substring(0, 18).padEnd(18)} | ${preview}${topicTag}`);
    }
    console.log('');
  } catch (e) {
    console.error('FATAL:', e.message);
    if (e.errors) console.error(JSON.stringify(e.errors, null, 2));
    process.exit(1);
  }
})();
