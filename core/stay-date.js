'use strict';
// stay-date.js · Canonical stay-date parser (Availability/Booking — Date resolver capability)
//
// WHY THIS EXISTS (root cause, verified 2026-06-20):
//   ai-reply.js `parseDateRangeContext` only handles RANGE forms and returns null
//   for the most common booking shape "31 ก.ค. 1 คืน" (single date + nights).
//   That gap let booking-shaped messages skip the deterministic availability path.
//   This module is the ONE canonical parser for every path (router / orchestrator /
//   pricing). It is self-contained (no require of ai-reply.js) so it has no side
//   effects and can be unit-tested in isolation.
//
// Logic ported from the proven V81 helpers in ai-reply.js (UTC-based, year inference,
// real-date validation) — behaviour for ranges is identical; single-date+nights and
// numeric single-date are added.

const THAI_MONTHS = {
  'ม.ค.': 0, 'มค': 0, 'มกราคม': 0, 'มกรา': 0,
  'ก.พ.': 1, 'กพ': 1, 'กุมภาพันธ์': 1, 'กุมภา': 1,
  'มี.ค.': 2, 'มีค': 2, 'มีนาคม': 2, 'มีนา': 2,
  'เม.ย.': 3, 'เมย': 3, 'เมษายน': 3, 'เมษา': 3,
  'พ.ค.': 4, 'พค': 4, 'พฤษภาคม': 4, 'พฤษภา': 4,
  'มิ.ย.': 5, 'มิย': 5, 'มิถุนายน': 5, 'มิถุนา': 5,
  'ก.ค.': 6, 'กค': 6, 'กรกฎาคม': 6, 'กรกฎา': 6,
  'ส.ค.': 7, 'สค': 7, 'สิงหาคม': 7, 'สิงหา': 7,
  'ก.ย.': 8, 'กย': 8, 'กันยายน': 8, 'กันยา': 8,
  'ต.ค.': 9, 'ตค': 9, 'ตุลาคม': 9, 'ตุลา': 9,
  'พ.ย.': 10, 'พย': 10, 'พฤศจิกายน': 10, 'พฤศจิกา': 10,
  'ธ.ค.': 11, 'ธค': 11, 'ธันวาคม': 11, 'ธันวา': 11,
};
const MONTH_ALT = Object.keys(THAI_MONTHS)
  .sort((a, b) => b.length - a.length)
  .map(m => m.replace(/\./g, '\\.'))
  .join('|');
const FUZZY = /ปลาย|ต้น|กลาง|เดือนหน้า|พรุ่งนี้|มะรืน|หรือ/i;
const NIGHTS_RE = /(\d{1,2})\s*คืน/;
const MAX_NIGHTS = 30;

function getTodayBKK() {
  return new Date(new Date().getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function utc(year, month, day) { return new Date(Date.UTC(year, month, day)); }
function iso(date) { return date.toISOString().slice(0, 10); }
function validDate(d, day, month) { return d.getUTCDate() === day && d.getUTCMonth() === month; }

function inferYear(monthIn, todayIso) {
  const today = todayIso && /^\d{4}-\d{2}-\d{2}$/.test(todayIso)
    ? new Date(`${todayIso}T00:00:00.000Z`) : new Date();
  let year = today.getUTCFullYear();
  const currentMonth = today.getUTCMonth();
  if (monthIn < currentMonth && (currentMonth - monthIn) > 6) year++;
  return year;
}

function buildRange(raw, dayIn, monthIn, dayOut, monthOut, explicitYear, todayIso, source) {
  const dIn = parseInt(dayIn, 10);
  const dOut = parseInt(dayOut, 10);
  if (!Number.isInteger(dIn) || !Number.isInteger(dOut)) return null;
  if (dIn < 1 || dIn > 31 || dOut < 1 || dOut > 31) return null;
  const year = explicitYear || inferYear(monthIn, todayIso);
  const outYear = monthOut < monthIn ? year + 1 : year;
  const ci = utc(year, monthIn, dIn);
  const co = utc(outYear, monthOut, dOut);
  if (!validDate(ci, dIn, monthIn) || !validDate(co, dOut, monthOut)) return null;
  const nights = Math.round((co - ci) / 86_400_000);
  if (nights < 1 || nights > MAX_NIGHTS) return null;
  return { checkIn: iso(ci), checkOut: iso(co), nights, days: nights + 1, raw, source };
}

// ── range forms (identical coverage to V81 parseDateRangeContext) ──
function parseRange(t, todayIso) {
  const withBeYear  = new RegExp(`(\\d{1,2})\\s*(${MONTH_ALT})\\s*[-\\u2013]\\s*(\\d{1,2})\\s*(${MONTH_ALT})\\s*25(\\d{2})`);
  const crossMonth  = new RegExp(`(\\d{1,2})\\s*(${MONTH_ALT})\\s*[-\\u2013]\\s*(\\d{1,2})\\s*(${MONTH_ALT})`);
  const sameMonth   = new RegExp(`(\\d{1,2})\\s*[-\\u2013]\\s*(\\d{1,2})\\s*(?:เดือน\\s*)?(${MONTH_ALT})`);
  const compactNum  = /(\d{1,2})\s*[-–]\s*(\d{1,2})\s*[)\/]\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?/;

  let m = t.match(compactNum);
  if (m) {
    const month = parseInt(m[3], 10) - 1;
    const yr = m[4] ? (m[4].length === 2 ? 2000 + parseInt(m[4], 10) : parseInt(m[4], 10)) : null;
    return buildRange(m[0], m[1], month, m[2], month, yr, todayIso, 'range_compact');
  }
  m = t.match(withBeYear);
  if (m) {
    const yr = 2500 + parseInt(m[5], 10) - 543;
    return buildRange(m[0], m[1], THAI_MONTHS[m[2]], m[3], THAI_MONTHS[m[4]], yr, todayIso, 'range_be_year');
  }
  m = t.match(crossMonth);
  if (m) return buildRange(m[0], m[1], THAI_MONTHS[m[2]], m[3], THAI_MONTHS[m[4]], null, todayIso, 'range_cross_month');
  m = t.match(sameMonth);
  if (m) { const mo = THAI_MONTHS[m[3]]; return buildRange(m[0], m[1], mo, m[2], mo, null, todayIso, 'range_same_month'); }
  return null;
}

function fromCheckIn(ci, day, month, nights, raw, source) {
  if (!validDate(ci, day, month)) return null; // rejects e.g. 31 ก.พ.
  const co = new Date(ci.getTime() + nights * 86_400_000);
  return { checkIn: iso(ci), checkOut: iso(co), nights, days: nights + 1, raw, source };
}

// ── single Thai-month date + optional nights ("31 ก.ค. 1 คืน", "31 ก.ค.") ──
function parseSingleThai(t, todayIso) {
  const m = t.match(new RegExp(`(\\d{1,2})\\s*(${MONTH_ALT})`));
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = THAI_MONTHS[m[2]];
  if (day < 1 || day > 31 || month == null) return null;
  const nm = t.match(NIGHTS_RE);
  const nights = nm ? parseInt(nm[1], 10) : 1; // single date → default 1 night
  if (nights < 1 || nights > MAX_NIGHTS) return null;
  return fromCheckIn(utc(inferYear(month, todayIso), month, day), day, month, nights, m[0], 'single_thai');
}

// ── single numeric date DD/M (+ optional nights) ("31/7 1 คืน") ──
function parseSingleNumeric(t, todayIso) {
  const m = t.match(/(?:^|[^\d])(\d{1,2})\/(\d{1,2})(?!\s*[-–]\s*\d)(?!\d)/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10) - 1;
  if (day < 1 || day > 31 || month < 0 || month > 11) return null;
  const nm = t.match(NIGHTS_RE);
  const nights = nm ? parseInt(nm[1], 10) : 1;
  if (nights < 1 || nights > MAX_NIGHTS) return null;
  return fromCheckIn(utc(inferYear(month, todayIso), month, day), day, month, nights, `${m[1]}/${m[2]}`, 'single_numeric');
}

/**
 * Canonical stay parser. Returns { checkIn, checkOut, nights, days, raw, source } or null.
 * Order: fuzzy reject → ranges → single Thai-month+nights → single numeric+nights.
 */
function parseStay(msgText, todayIso = getTodayBKK()) {
  if (!msgText || typeof msgText !== 'string') return null;
  if (FUZZY.test(msgText)) return null;
  return parseRange(msgText, todayIso)
      || parseSingleThai(msgText, todayIso)
      || parseSingleNumeric(msgText, todayIso)
      || null;
}

module.exports = {
  parseStay,
  getTodayBKK,
  _THAI_MONTHS: THAI_MONTHS,
  _parseRange: parseRange,
};
