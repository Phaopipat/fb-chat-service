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

// ─── V100a · Deterministic tab routing for all 60 bookable rooms ───────────────
// Replaces auto-detection by header text (which had -1 offset bug in Pearl Bay Home)
// Future V100b will expand SELECTED_ROOMS to use this · for now only existing 12 use it
const ROOM_TAB_MAP = {
  big_bay_deluxe: {
    tabTitle: 'Big Bay Deluxe',
    dataStartRow: 3,
    headerRow: 2,
    rooms: {
      D1: 2, D2: 3, D3: 4, D4: 5, D5: 6, D6: 7, D7: 8, D8: 9,
      D9: 10, D10: 11, D11: 12, D12: 13, D13: 14, D14: 15, D15: 16, D16: 17,
    },
  },
  big_bay_thai: {
    tabTitle: 'Big Bay Thai',
    dataStartRow: 3,
    headerRow: 2,
    rooms: {
      T1: 2, T2: 3, T3: 4, T4: 5, T5: 6, T6: 7, T7: 8, T8: 9,
      T9: 10, T10: 11, T11: 12, T12: 13, T13: 14, T14: 15, T15: 16,
      T16: 17, T17: 18, T18: 19,
      // V20=ผู้บริหาร, V21=ผู้บริหาร skipped
      D17: 22, D18: 23,  // Honeymoon Ocean Front co-located in Thai tab
    },
  },
  pearl_bay_home: {
    tabTitle: 'Pearl Bay Home',
    dataStartRow: 4,  // V100a FIX: was 3 in old code (read code header row as data)
    headerRow: 3,
    rooms: {
      R20: 2, R21: 3, R22: 4, R23: 5, R24: 6, R25: 7, R26: 8, R27: 9,
      R28: 10, R29: 11, R30: 12, R31: 13, R32: 14, R33: 15, R34: 16,
      // V100a FIX -1 offset: was R21:2 R31:12 R33:14 R34:15 (reading wrong header)
      //                     now R21:3 R31:13 R33:15 R34:16 (header-aligned to "21" "31" "33" "34")
    },
  },
  pearl_bay_beach_chalet: {
    tabTitle: 'Pearl Bay Beach Chalet',
    dataStartRow: 3,
    headerRow: 2,
    rooms: {
      R10: 2, R11: 3, R12: 4, R13: 5, R14: 6, R15: 7, R16: 8, R17: 9, R18: 10,
    },
  },
};

// V100a · helper: look up tab + col + dataStartRow for a room code
function getRoomLocation(roomCode) {
  for (const [, config] of Object.entries(ROOM_TAB_MAP)) {
    if (Object.prototype.hasOwnProperty.call(config.rooms, roomCode)) {
      return {
        tabTitle: config.tabTitle,
        colIdx: config.rooms[roomCode],
        dataStartRow: config.dataStartRow,
      };
    }
  }
  return null;
}

// ─── V100b · Full pax + label metadata for all 60 rooms ──────────────────────
// Used by SELECTED_ROOMS (export) and waterfall reply formatter
// pax = max sleeping capacity per "Koh Taluu (selected room).xlsx" reference
const ROOM_INFO = {
  // ─── อ่าวมุก Pearl Bay · Beach Chalet 1-3 (R10-R18) ───
  R10: { bay: 'อ่าวมุก', type: 'beach_chalet', label: 'Beach Chalet (Air)', pax: 2 },
  R11: { bay: 'อ่าวมุก', type: 'beach_chalet', label: 'Beach Chalet (Air)', pax: 2 },
  R12: { bay: 'อ่าวมุก', type: 'beach_chalet', label: 'Beach Chalet (Air)', pax: 2 },
  R13: { bay: 'อ่าวมุก', type: 'beach_chalet', label: 'Beach Chalet (Air)', pax: 2 },
  R14: { bay: 'อ่าวมุก', type: 'beach_chalet', label: 'Beach Chalet (Air)', pax: 2 },
  R15: { bay: 'อ่าวมุก', type: 'beach_chalet', label: 'Beach Chalet (Air)', pax: 2 },
  R16: { bay: 'อ่าวมุก', type: 'beach_chalet', label: 'Beach Chalet (Air)', pax: 2 },
  R17: { bay: 'อ่าวมุก', type: 'beach_chalet', label: 'Beach Chalet (Air)', pax: 2 },
  R18: { bay: 'อ่าวมุก', type: 'beach_chalet', label: 'Beach Chalet (Air)', pax: 2 },

  // ─── อ่าวมุก · Pearl Bay Home (R20-R34) ───
  R20: { bay: 'อ่าวมุก', type: 'family_villa', label: 'Family Thai Style Villa', pax: 3 },
  R21: { bay: 'อ่าวมุก', type: 'family_villa', label: 'Family Thai Style Villa', pax: 1 },
  R22: { bay: 'อ่าวมุก', type: 'two_story', label: 'Two-Story House (Top)', pax: 2 },
  R23: { bay: 'อ่าวมุก', type: 'two_story', label: 'Two-Story House (Bottom)', pax: 2 },
  R24: { bay: 'อ่าวมุก', type: 'biggest', label: 'Biggest Room', pax: 3 },
  R25: { bay: 'อ่าวมุก', type: 'biggest', label: 'Biggest Room', pax: 3 },
  R26: { bay: 'อ่าวมุก', type: 'single', label: 'Single Room', pax: 2 },
  R27: { bay: 'อ่าวมุก', type: 'single_beach', label: 'Single Room (Beach Front)', pax: 2 },
  R28: { bay: 'อ่าวมุก', type: 'four_br', label: '4BR House (Bottom)', pax: 2 },
  R29: { bay: 'อ่าวมุก', type: 'four_br', label: '4BR House (Bottom)', pax: 2 },
  R30: { bay: 'อ่าวมุก', type: 'four_br', label: '4BR House (Top)', pax: 2 },
  R31: { bay: 'อ่าวมุก', type: 'four_br', label: '4BR House (Top)', pax: 1 },
  R32: { bay: 'อ่าวมุก', type: 'two_story_b', label: '2-Story (Bottom)', pax: 2 },
  R33: { bay: 'อ่าวมุก', type: 'two_story_b', label: '2-Story (Top)', pax: 1 },
  R34: { bay: 'อ่าวมุก', type: 'two_story_b', label: '2-Story (Top)', pax: 1 },

  // ─── อ่าวใหญ่ Big Bay · Manila Deluxe Chalet (D1-D16) ───
  D1: { bay: 'อ่าวใหญ่', type: 'manila_deluxe', label: 'Manila Deluxe Chalet', pax: 2 },
  D2: { bay: 'อ่าวใหญ่', type: 'manila_deluxe', label: 'Manila Deluxe Chalet', pax: 2 },
  D3: { bay: 'อ่าวใหญ่', type: 'manila_deluxe', label: 'Manila Deluxe Chalet', pax: 2 },
  D4: { bay: 'อ่าวใหญ่', type: 'manila_deluxe', label: 'Manila Deluxe Chalet', pax: 2 },
  D5: { bay: 'อ่าวใหญ่', type: 'manila_deluxe', label: 'Manila Deluxe Chalet', pax: 2 },
  D6: { bay: 'อ่าวใหญ่', type: 'manila_deluxe', label: 'Manila Deluxe Chalet', pax: 2 },
  D7: { bay: 'อ่าวใหญ่', type: 'manila_deluxe', label: 'Manila Deluxe Chalet', pax: 3 },
  D8: { bay: 'อ่าวใหญ่', type: 'manila_deluxe', label: 'Manila Deluxe Chalet', pax: 3 },
  D9: { bay: 'อ่าวใหญ่', type: 'manila_deluxe', label: 'Manila Deluxe Chalet', pax: 2 },
  D10: { bay: 'อ่าวใหญ่', type: 'manila_deluxe', label: 'Manila Deluxe Chalet', pax: 3 },
  D11: { bay: 'อ่าวใหญ่', type: 'manila_deluxe', label: 'Manila Deluxe Chalet', pax: 3 },
  D12: { bay: 'อ่าวใหญ่', type: 'manila_deluxe', label: 'Manila Deluxe Chalet', pax: 2 },
  D13: { bay: 'อ่าวใหญ่', type: 'manila_deluxe', label: 'Manila Deluxe Chalet', pax: 3 },
  D14: { bay: 'อ่าวใหญ่', type: 'manila_deluxe', label: 'Manila Deluxe Chalet', pax: 3 },
  D15: { bay: 'อ่าวใหญ่', type: 'manila_deluxe', label: 'Manila Deluxe Chalet', pax: 2 },
  D16: { bay: 'อ่าวใหญ่', type: 'manila_deluxe', label: 'Manila Deluxe Chalet', pax: 2 },

  // ─── อ่าวใหญ่ · Honeymoon Ocean Front (D17-D18) ───
  D17: { bay: 'อ่าวใหญ่', type: 'honeymoon', label: 'Honeymoon Ocean Front', pax: 2 },
  D18: { bay: 'อ่าวใหญ่', type: 'honeymoon', label: 'Honeymoon Ocean Front', pax: 2 },

  // ─── อ่าวใหญ่ · Thai Style (T1-T18) ───
  T1: { bay: 'อ่าวใหญ่', type: 'thai_family', label: 'Thai Style Family Villa', pax: 2 },
  T2: { bay: 'อ่าวใหญ่', type: 'thai_family', label: 'Thai Style Family Villa', pax: 2 },
  T3: { bay: 'อ่าวใหญ่', type: 'thai_family', label: 'Thai Style Family Villa', pax: 2 },
  T4: { bay: 'อ่าวใหญ่', type: 'thai_family', label: 'Thai Style Family Villa', pax: 2 },
  T5: { bay: 'อ่าวใหญ่', type: 'thai_single', label: 'Thai Style Single Room (Share)', pax: 1 },
  T6: { bay: 'อ่าวใหญ่', type: 'thai_single', label: 'Thai Style Single Room (Share)', pax: 1 },
  T7: { bay: 'อ่าวใหญ่', type: 'thai_single', label: 'Thai Style Single Room (Share)', pax: 1 },
  T8: { bay: 'อ่าวใหญ่', type: 'thai_single', label: 'Thai Style Single Room (Share)', pax: 1 },
  T9: { bay: 'อ่าวใหญ่', type: 'thai_single', label: 'Thai Style Single Room (Share)', pax: 1 },
  T10: { bay: 'อ่าวใหญ่', type: 'thai_single', label: 'Thai Style Single Room (Share)', pax: 1 },
  T11: { bay: 'อ่าวใหญ่', type: 'thai_single', label: 'Thai Style Single Room (Share)', pax: 1 },
  T12: { bay: 'อ่าวใหญ่', type: 'thai_single', label: 'Thai Style Single Room (Share)', pax: 1 },
  T13: { bay: 'อ่าวใหญ่', type: 'thai_studio', label: 'Thai Style Studio', pax: 2 },
  T14: { bay: 'อ่าวใหญ่', type: 'thai_studio', label: 'Thai Style Studio', pax: 2 },
  T15: { bay: 'อ่าวใหญ่', type: 'thai_studio', label: 'Thai Style Studio (Connect)', pax: 2 },
  T16: { bay: 'อ่าวใหญ่', type: 'thai_studio', label: 'Thai Style Studio', pax: 3 },
  T17: { bay: 'อ่าวใหญ่', type: 'thai_studio', label: 'Thai Style Studio', pax: 2 },
  T18: { bay: 'อ่าวใหญ่', type: 'thai_studio', label: 'Thai Style Studio', pax: 2 },
};

// V100b · Type label map for customer-facing replies
const TYPE_LABELS = {
  manila_deluxe: 'Manila Deluxe Chalet',
  honeymoon: 'Honeymoon Ocean Front',
  thai_family: 'Thai Style Family Villa',
  thai_single: 'Thai Style Single Room (Share)',
  thai_studio: 'Thai Style Studio',
  beach_chalet: 'Beach Chalet (Air)',
  family_villa: 'Family Thai Style Villa',
  two_story: 'Two-Story House',
  biggest: 'Biggest Room',
  single: 'Single Room',
  single_beach: 'Single Room (Beach Front)',
  four_br: '4BR House',
  two_story_b: '2-Story House',
};

function labelForType(type) {
  return TYPE_LABELS[type] || 'ห้อง';
}

// V100b · Bot now reads all 60 rooms (V100a kept it at 12 for safety transition)
// Customer-facing scope: all selected rooms in Excel · Manila Deluxe + Honeymoon
// no longer escalate to admin (V99 scope shrunk · they're answered from D-tabs).
const SELECTED_ROOMS = ROOM_INFO;

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
// V100c · (1) Cache negative results (id=null) to reduce log spam + Drive API calls
//        (2) Fall back to "New <name>" prefix if exact match misses
//            (handles Phao's workflow where new sheets are created with "New " prefix)
async function findSpreadsheetId(auth, sheetName) {
  const cached = _spreadsheetIdCache.get(sheetName);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.id; // null cached OK

  const drive = google.drive({ version: 'v3', auth });
  const baseQuery = `mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`;
  const listParams = {
    fields: 'files(id,name)',
    pageSize: 5,
    orderBy: 'modifiedTime desc',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    corpora: 'allDrives',
  };

  // Try exact match first
  let res = await drive.files.list({ q: `name='${sheetName}' and ${baseQuery}`, ...listParams });
  let files = res.data.files || [];

  // V100c · fallback to "New <sheetName>" prefix
  if (!files.length) {
    res = await drive.files.list({ q: `name='New ${sheetName}' and ${baseQuery}`, ...listParams });
    files = res.data.files || [];
    if (files.length) {
      console.log(`[availability] Resolved via "New " prefix: "New ${sheetName}" → ${files[0].id}`);
    }
  }

  if (!files.length) {
    console.warn(`[availability] Sheet not found in Drive: "${sheetName}" (also tried "New ${sheetName}")`);
    _spreadsheetIdCache.set(sheetName, { id: null, ts: Date.now() }); // V100c · cache null
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

  const loc = getRoomLocation(roomCode);
  if (!loc) {
    console.warn(`[availability] Room not in ROOM_TAB_MAP: ${roomCode}`);
    return null;
  }

  _roomLocationCache.set(key, { loc, ts: Date.now() });
  console.log(`[availability] ${roomCode} → tab:"${loc.tabTitle}" col:${loc.colIdx} dataStart:${loc.dataStartRow}`);
  return loc;
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

// V100b · Scan ±N days for alternative ranges of a specific room type
// Clamped: never before today. Returns top 3 by proximity.
// V100d · windowDays reduced 60→30 to mitigate Sheets API quota stampede
//         during cache warm-up (60 parallel room checks × 4 tabs = 240 reads
//         when cache cold · hit Google 60 reads/min/user limit)
async function findAlternativeDates(auth, roomType, originalCheckIn, nights, windowDays = 30) {
  if (!roomType || !originalCheckIn || !nights) return [];

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const original = new Date(originalCheckIn + 'T00:00:00');
  if (Number.isNaN(original.getTime())) return [];

  const scanStart = new Date(Math.max(today.getTime(), original.getTime() - windowDays * 86_400_000));
  const scanEnd = new Date(original.getTime() + windowDays * 86_400_000);
  const roomCodes = Object.entries(ROOM_INFO)
    .filter(([, info]) => info.type === roomType)
    .map(([code]) => code);
  if (!roomCodes.length) return [];

  const candidates = [];
  for (let d = new Date(scanStart); d <= scanEnd; d.setDate(d.getDate() + 1)) {
    const checkIn = new Date(d);
    const checkInStr = checkIn.toISOString().slice(0, 10);
    if (checkInStr === originalCheckIn) continue;
    candidates.push({
      checkIn,
      checkInStr,
      proximity: Math.abs(checkIn.getTime() - original.getTime()),
    });
  }
  candidates.sort((a, b) => a.proximity - b.proximity);

  const ranges = [];
  for (const candidate of candidates) {
    const checkOut = new Date(candidate.checkIn);
    checkOut.setDate(checkOut.getDate() + nights);
    const checkOutStr = checkOut.toISOString().slice(0, 10);

    try {
      const result = await checkBayAvailability(auth, 'any', candidate.checkInStr, checkOutStr);
      const typeAvailable = roomCodes.filter(code => {
        const bay = ROOM_INFO[code].bay;
        const bayResult = (result.bays || {})[bay];
        return bayResult && (bayResult.available || []).includes(code);
      }).length;

      if (typeAvailable > 0) {
        ranges.push({
          checkIn: candidate.checkInStr,
          checkOut: checkOutStr,
          available: typeAvailable,
          proximity: candidate.proximity,
        });
      }
    } catch (_) {
      continue;
    }

    if (ranges.length >= 5) break;
  }

  ranges.sort((a, b) => a.proximity - b.proximity);
  return ranges.slice(0, 3);
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
  ROOM_TAB_MAP,
  SELECTED_ROOMS,
  getRoomLocation,
  // V100b exports
  ROOM_INFO,
  TYPE_LABELS,
  labelForType,
  findAlternativeDates,
  MAX_BOOKING_DAYS,
};
