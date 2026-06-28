'use strict';
// Phase R1 · Platform registry (CustomerChannel tab) — maps a customer's contact (phone/email)
// → platform (line|fb) + send-handle (userId|psid), so a LINE office-group relay (Stage 3b card
// link / Stage 4b confirmation) can route to the RIGHT channel: LINE push OR FB send. Lives in the
// SHARED sheet (CHANNEL_SHEET_ID || KB_SHEET_ID || sheetId) so BOTH services read/write the same rows
// (fb's KB_SHEET_ID already points at the LINE sheet). Durable (survives deploy), unlike in-memory carry.
const TAB = 'CustomerChannel';
const RANGE = `${TAB}!A2:F`; // phone | email | platform | sendHandle | displayName | updated_at
const COL = { phone: 0, email: 1, platform: 2, sendHandle: 3, displayName: 4, updated_at: 5 };

function _sheetIdFor(sheetId) {
  return process.env.CHANNEL_SHEET_ID || process.env.KB_SHEET_ID || sheetId;
}
const _norm = (s) => String(s == null ? '' : s).trim();
const _phone = (s) => _norm(s).replace(/[\s\-]/g, '');
const _email = (s) => _norm(s).toLowerCase();

async function _readRows(sheets, sid) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sid, range: RANGE });
    return res.data.values || [];
  } catch (e) { return []; } // tab may not exist yet → empty
}
function _matchIdx(rows, ph, em) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    if ((ph && _phone(r[COL.phone]) === ph) || (em && _email(r[COL.email]) === em)) return i;
  }
  return -1;
}

// Upsert by phone OR email. New row if no match; else update the matched row in place.
async function upsertChannel({ sheets, sheetId, phone, email, platform, sendHandle, displayName } = {}) {
  if (!sheets || !platform || !sendHandle) return false;
  const ph = _phone(phone), em = _email(email);
  if (!ph && !em) return false;
  const sid = _sheetIdFor(sheetId);
  const rows = await _readRows(sheets, sid);
  const idx = _matchIdx(rows, ph, em);
  const row = [ph, em, _norm(platform), _norm(sendHandle), _norm(displayName), new Date().toISOString()];
  if (idx === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sid, range: RANGE, valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS', requestBody: { values: [row] },
    });
  } else {
    const sheetRow = idx + 2; // A2 = sheet row 2
    await sheets.spreadsheets.values.update({
      spreadsheetId: sid, range: `${TAB}!A${sheetRow}:F${sheetRow}`,
      valueInputOption: 'RAW', requestBody: { values: [row] },
    });
  }
  return true;
}

// Lookup by phone OR email → { platform, sendHandle, displayName } or null (for R2 relay routing).
async function lookupChannel({ sheets, sheetId, phone, email } = {}) {
  if (!sheets) return null;
  const ph = _phone(phone), em = _email(email);
  if (!ph && !em) return null;
  const rows = await _readRows(sheets, _sheetIdFor(sheetId));
  const idx = _matchIdx(rows, ph, em);
  if (idx === -1) return null;
  const r = rows[idx];
  return { platform: _norm(r[COL.platform]), sendHandle: _norm(r[COL.sendHandle]), displayName: _norm(r[COL.displayName]) };
}

module.exports = { upsertChannel, lookupChannel, _CHANNEL_TAB: TAB };
