// intent-shadow-log.js · FB Step 3 A.3.5 (2026-06-15)
//
// Persists intent router shadow decisions to FB Sheet IntentShadow tab.
// Self-contained · uses raw sheets.spreadsheets.values.append (no helper dep).
//
// Schema (9 cols · same as LINE IntentShadow):
//   A: timestamp · B: psid · C: msgText · D: intent · E: sub
//   F: handler · G: confidence · H: reason · I: lead_stage
//
// Async fire-and-forget · never blocks bot reply.
'use strict';

const TAB_NAME = 'IntentShadow';
const RANGE = `${TAB_NAME}!A:I`;

async function logShadowDecision({ sheets, sheetId, userId, msgText, decision, leadProfile }) {
  if (!sheets || !sheetId || !decision) return;
  try {
    // BKK time (UTC+7) · match server.js BKK fix
    const ts = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString();
    const text = String(msgText || '').replace(/[\r\n]+/g, ' ').slice(0, 160);
    const row = [
      ts,
      String(userId || ''),
      text,
      String(decision.intent || ''),
      String(decision.sub || ''),
      String(decision.handler || ''),
      typeof decision.confidence === 'number' ? decision.confidence.toFixed(2) : '',
      String(decision.reason || '').slice(0, 100),
      leadProfile && leadProfile.stage ? String(leadProfile.stage) : '',
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: RANGE,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
  } catch (err) {
    console.warn('[IR-SHADOW-LOG] FB write error:', err.message);
  }
}

module.exports = { logShadowDecision, TAB_NAME };
