// availability-checker.js — Phase 2a: room availability lookup via Google Sheets
// Reads admin booking data from monthly spreadsheets named e.g. "2569 พ.ค.(5)"
// Thai Buddhist calendar: CE year + 543 = BE year
// Data format: each row = one booking; cell non-empty = booked, empty = available
'use strict';

const { google } = require('googleapis');

// ─── Constants ────────────────────────────────────────────────────────────────
const THAI_MONTH_ABBR = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
];

const MAX_BOOKING_DAYS = 270; // 9 months · covers typical advance booking window (raised from 90 days · AREÉ Stage A 2026-05-24 evidence: customer "23 ต.ค." 5 months out got too_far → escalated → lost booking)
const CACHE_TTL_MS = 300_000; // V99 · 5 min · quota relief (was 60s · hit limit on concurrent checks)

// ─── Selected rooms from Excel analysis (F=1) — Phase 2 scope ────────────────
// Only these rooms are surfaced to customers via the bot
const SELECTED_ROOMS = {
  // Ao Muk (Pearl Bay) — Pearl Bay Homes tab
  R21: { bay: 'อ่าวมุก', label: 'Family Villa อ่าวมุก' },
  R31: { bay: 'อ่าวมุก', label: 'Family Villa อ่าวมุก' },
  R33: { bay: 'อ่าวมุก', label: 'Beach Chalet อ่าวมุก' },
  R34: { bay: 'อ่าวมุก', label: 'Beach Chalet อ่าวมุก' },
  // Ao Yai (Big Bay) — Thai Style tab
  T5:  { bay: 'อ่าวใหญ่', label: 'Thai Style อ่าวใหญ่' },
  T6:  { bay: 'อ่าวใหญ่', label: 'Thai Style อ่าวใหญ่' },
  T7:  { bay: 'อ่าวใหญ่', label: 'Thai Style อ่าวใหญ่' },
  T8:  { bay: 'อ่าวใหญ่', label: 'Thai Style อ่าวใหญ่' },
  T9:  { bay: 'อ่าวใหญ่', label: 'Thai Style อ่าวใหญ่' },
  T10: { bay: 'อ่าวใหญ่', label: 'Thai Style อ่าวใหญ่' },
  T11: { bay: 'อ่าวใหญ่', label: 'Thai Style อ่าวใหญ่' },
  T12: { bay: 'อ่าวใหญ่', label: 'Thai Style อ่าวใหญ่' },
};

// ─── Caches (module-level, survive across requests) ────────────────────────────
// Key: spreadsheet name → { id, ts }
const _spreadsheetIdCache = new Map();
// Key: `${spreadsheetId}::${tabTitle}` → { rows, ts }
const _tabDataCache = new Map();
// Key: `${spreadsheetId}::${roomCode}` → { tabTitle, colIdx, dataStartRow, ts }
const _roomLocationCache = new Map();

// ─── Sheet name from date ──────────────────────────────────────────────────────
function getSheetName(date) {
  const d = typeof date === 'string' ? new Date(date + 'T00:00:00') : date;
  const yearBE = d.getFullYear() + 543;
  const month = d.getMonth();
  return `${yearBE} ${THAI_MONTH_ABBR[month]}(${month + 1})`;
}

// ─── Drive: find spreadsheet by name ─────────────────────────────────────────
async function findSpreadsheetId(auth, sheetName) {
  const cached = _spreadsheetIdCache.get(sheetName);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.id;

  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.list({
    q: `name='${sheetName}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
    fields: 'files(id,name)',
    pageSize: 5,
    orderBy: 'modifiedTime desc',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    corpora: 'allDrives',
  });

  const files = res.data.files || [];
  if (!files.length) {
    console.warn(`[availability] Sheet not found in Drive: "${sheetName}"`);
    return null;
  }
  const id = files[0].id;
  _spreadsheetIdCache.set(sheetName, { id, ts: Date.now() });
  console.log(`[availability] Resolved "${sheetName}" → ${id}`);
  return id;
}

// ─── Sheets: list all tab titles ────────────────────────────────────────────
async function getAllTabTitles(auth, spreadsheetId) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title',
  });
  return (res.data.sheets || []).map(s => s.properties.title);
}

// ─── Sheets: read full tab data (cached) ─────────────────────────────────────
async function getTabData(auth, spreadsheetId, tabTitle) {
  const key = `${spreadsheetId}::${tabTitle}`;
  const cached = _tabDataCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.rows;

  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabTitle}'`,
  });
  const rows = res.data.values || [];
  _tabDataCache.set(key, { rows, ts: Date.now() });
  return rows;
}

// ─── Find room column in a single header row ──────────────────────────────────
// Handles 4 header formats found in actual spreadsheet:
//   1. Direct match:      "D1" or "T5" → cell === roomCode
//   2. Thai Style merged: "ตารางห้องอ่าวใหญ่ .../T5" → cell ends with "/T5"
//   3. Pearl Bay Homes:   "เรือนไทย 1-5/3/21" → cell ends with "/21" (room num only)
//   4. Beach Chalet:      "10", "11"… → cell === "10" (plain number, no R prefix)
function findRoomColInHeader(headerRow, roomCode) {
  const m = roomCode.match(/^([A-Z]+)(\d+)$/);
  if (!m) return -1;
  const [, prefix, numStr] = m;

  for (let i = 0; i < headerRow.length; i++) {
    const cell = (headerRow[i] || '').trim();
    if (!cell) continue;

    if (cell === roomCode) return i;                              // format 1
    if (cell.endsWith('/' + roomCode)) return i;                 // format 2 no space
    if (cell.endsWith('/ ' + roomCode)) return i;                // format 2 with space

    if (prefix === 'R') {
      if (cell.endsWith('/' + numStr)) return i;                 // format 3 no space
      if (cell.endsWith('/ ' + numStr)) return i;                // format 3 with space
      if (cell === numStr) return i;                             // format 4
    }
  }
  return -1;
}

// ─── Find tab + column index for a room code (cached) ─────────────────────────
async function findRoomLocation(auth, spreadsheetId, roomCode) {
  const key = `${spreadsheetId}::${roomCode}`;
  const cached = _roomLocationCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.loc;

  const tabTitles = await getAllTabTitles(auth, spreadsheetId);
  const sheets = google.sheets({ version: 'v4', auth });

  for (const tabTitle of tabTitles) {
    let headerRows;
    try {
      // Read first 3 rows — Thai Style tab has a merged title in row 1, columns in row 2
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${tabTitle}'!1:3`,
      });
      headerRows = res.data.values || [];
    } catch (_) {
      continue;
    }

    for (let rowIdx = 0; rowIdx < headerRows.length; rowIdx++) {
      const colIdx = findRoomColInHeader(headerRows[rowIdx], roomCode);
      if (colIdx >= 0) {
        const loc = {
          tabTitle,
          colIdx,
          dataStartRow: rowIdx + 1, // 0-indexed row where booking data begins
        };
        _roomLocationCache.set(key, { loc, ts: Date.now() });
        console.log(`[availability] ${roomCode} → tab:"${tabTitle}" col:${colIdx} dataStart:${loc.dataStartRow}`);
        return loc;
      }
    }
  }

  console.warn(`[availability] ${roomCode} not found in any tab of ${spreadsheetId}`);
  return null;
}

// ─── Parse DATE cell: "5-7" → {checkIn:5, checkOut:7} ────────────────────────
function parseDateCell(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  return { checkIn: parseInt(m[1], 10), checkOut: parseInt(m[2], 10) };
}

// ─── Convert parsed cell + year/month to absolute JS Dates ───────────────────
// Cross-month: if checkOut day < checkIn day, checkOut is in the following month
function cellToAbsoluteDates(parsed, year, month) {
  const bookingIn = new Date(year, month, parsed.checkIn);
  let outYear = year;
  let outMonth = month;
  if (parsed.checkOut < parsed.checkIn) {
    outMonth = month + 1;
    if (outMonth > 11) { outMonth = 0; outYear++; }
  }
  const bookingOut = new Date(outYear, outMonth, parsed.checkOut);
  return { bookingIn, bookingOut };
}

// ─── Date range overlap (half-open intervals) ─────────────────────────────────
// Returns true if [bookingIn, bookingOut) overlaps [custIn, custOut)
function overlaps(bookingIn, bookingOut, custIn, custOut) {
  return bookingIn < custOut && bookingOut > custIn;
}

// ─── Build list of {year, month} tuples covering a date range ─────────────────
function getMonthsInRange(checkIn, checkOut) {
  const months = [];
  let cur = new Date(checkIn.getFullYear(), checkIn.getMonth(), 1);
  const end = new Date(checkOut.getFullYear(), checkOut.getMonth(), 1);
  while (cur <= end) {
    months.push({ year: cur.getFullYear(), month: cur.getMonth() });
    cur.setMonth(cur.getMonth() + 1);
  }
  return months;
}

// ─── Core: check a single room for a date range ──────────────────────────────
// Returns:
//   { available: true }
//   { available: false }
//   { available: null, reason: string, sheetName?: string }
async function checkOneRoom(auth, roomCode, checkInStr, checkOutStr) {
  if (!SELECTED_ROOMS[roomCode]) {
    return { available: null, reason: 'unknown_room' };
  }

  const checkIn = new Date(checkInStr + 'T00:00:00');
  const checkOut = checkOutStr
    ? new Date(checkOutStr + 'T00:00:00')
    : new Date(checkInStr + 'T00:00:00');
  if (!checkOutStr) checkOut.setDate(checkOut.getDate() + 1);

  const months = getMonthsInRange(checkIn, checkOut);

  for (const { year, month } of months) {
    const sheetName = getSheetName(new Date(year, month, 1));

    let spreadsheetId;
    try {
      spreadsheetId = await findSpreadsheetId(auth, sheetName);
    } catch (err) {
      console.error(`[availability] Drive error for "${sheetName}":`, err.message);
      return { available: null, reason: 'drive_error', sheetName };
    }
    if (!spreadsheetId) return { available: null, reason: 'sheet_not_found', sheetName };

    let location;
    try {
      location = await findRoomLocation(auth, spreadsheetId, roomCode);
    } catch (err) {
      console.error(`[availability] Tab search error for ${roomCode}:`, err.message);
      return { available: null, reason: 'tab_error' };
    }
    if (!location) return { available: null, reason: 'room_not_in_sheet', sheetName };

    let rows;
    try {
      rows = await getTabData(auth, spreadsheetId, location.tabTitle);
    } catch (err) {
      console.error(`[availability] Data read error for "${location.tabTitle}":`, err.message);
      return { available: null, reason: 'data_error' };
    }

    // Scan booking rows (skip header rows)
    for (let r = location.dataStartRow; r < rows.length; r++) {
      const row = rows[r];
      const dateCell = (row[0] || '').trim();
      const parsed = parseDateCell(dateCell);
      if (!parsed) continue; // skip non-date rows

      const { bookingIn, bookingOut } = cellToAbsoluteDates(parsed, year, month);
      if (!overlaps(bookingIn, bookingOut, checkIn, checkOut)) continue;

      // Booking overlaps our requested period — check if room cell is filled
      const roomCell = (row[location.colIdx] || '').trim();
      if (roomCell) {
        return { available: false };
      }
    }
  }

  return { available: true };
}

// ─── Check all rooms for a bay, return structured summary ────────────────────
// bay: 'อ่าวมุก' | 'อ่าวใหญ่' | 'any'
async function checkBayAvailability(auth, bay, checkInStr, checkOutStr) {
  const roomCodes = Object.entries(SELECTED_ROOMS)
    .filter(([, info]) => bay === 'any' || info.bay === bay)
    .map(([code]) => code);

  const results = await Promise.all(
    roomCodes.map(async (roomCode) => {
      try {
        const r = await checkOneRoom(auth, roomCode, checkInStr, checkOutStr);
        return { roomCode, ...r };
      } catch (err) {
        console.error(`[availability] Unexpected error for ${roomCode}:`, err.message);
        return { roomCode, available: null, reason: 'unexpected_error' };
      }
    })
  );

  // Group by bay
  const byBay = {};
  for (const r of results) {
    const b = SELECTED_ROOMS[r.roomCode]?.bay || 'unknown';
    if (!byBay[b]) byBay[b] = { available: [], booked: [], unknown: [] };
    if (r.available === true)  byBay[b].available.push(r.roomCode);
    else if (r.available === false) byBay[b].booked.push(r.roomCode);
    else byBay[b].unknown.push(r.roomCode);
  }

  const checkIn = new Date(checkInStr + 'T00:00:00');
  const checkOut = checkOutStr
    ? new Date(checkOutStr + 'T00:00:00')
    : new Date(checkInStr + 'T00:00:00');
  if (!checkOutStr) checkOut.setDate(checkOut.getDate() + 1);
  const nights = Math.round((checkOut - checkIn) / 86_400_000);

  return {
    checkIn: checkInStr,
    checkOut: checkOutStr || checkInStr,
    nights,
    bays: byBay,
    totalAvailable: results.filter(r => r.available === true).length,
    hasUnknown: results.some(r => r.available === null),
  };
}

// ─── Validate date inputs (server-side guard) ─────────────────────────────────
function validateDates(checkIn, checkOut) {
  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (!ISO_RE.test(checkIn)) return { ok: false, reason: 'invalid_format' };
  if (checkOut && !ISO_RE.test(checkOut)) return { ok: false, reason: 'invalid_format' };

  // Today in Bangkok time (UTC+7)
  const todayBKK = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
  todayBKK.setUTCHours(0, 0, 0, 0);
  const inDate = new Date(checkIn + 'T00:00:00Z');
  if (inDate < todayBKK) return { ok: false, reason: 'past_date' };

  const maxDate = new Date(todayBKK);
  maxDate.setDate(maxDate.getDate() + MAX_BOOKING_DAYS);
  if (inDate > maxDate) return { ok: false, reason: 'too_far' };

  if (checkOut) {
    const outDate = new Date(checkOut + 'T00:00:00Z');
    if (outDate <= inDate) return { ok: false, reason: 'checkout_before_checkin' };
  }
  return { ok: true };
}

// ─── Cache invalidation (call when you know sheet data changed) ───────────────
function invalidateCache() {
  _spreadsheetIdCache.clear();
  _tabDataCache.clear();
  _roomLocationCache.clear();
}

module.exports = {
  getSheetName,
  findSpreadsheetId,
  checkOneRoom,
  checkBayAvailability,
  validateDates,
  invalidateCache,
  SELECTED_ROOMS,
  MAX_BOOKING_DAYS,
};
