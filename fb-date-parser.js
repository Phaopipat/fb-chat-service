// fb-date-parser.js · simple Thai date range extractor for FB availability flow
//
// Handles common customer message patterns:
//   "30 มิ.ย."              → checkIn 2026-06-30 · checkOut 2026-07-01 (1 night assumed)
//   "15-17 มิ.ย."            → checkIn 2026-06-15 · checkOut 2026-06-17
//   "30 มิ.ย. - 2 ก.ค."     → cross-month range
//   "30 มิ.ย. 2026" / "2026" → use specified year
//   "1/7" or "1/7/2026"      → DD/MM[/YYYY]
//
// Returns null if no recognizable date pattern · caller should escalate.
'use strict';

const THAI_MONTHS = {
  'ม.ค.': 1, 'มกราคม': 1, 'มกรา': 1,
  'ก.พ.': 2, 'กุมภาพันธ์': 2, 'กุมภา': 2,
  'มี.ค.': 3, 'มีนาคม': 3, 'มีนา': 3,
  'เม.ย.': 4, 'เมษายน': 4, 'เมษา': 4,
  'พ.ค.': 5, 'พฤษภาคม': 5, 'พฤษภา': 5,
  'มิ.ย.': 6, 'มิถุนายน': 6, 'มิถุนา': 6,
  'ก.ค.': 7, 'กรกฎาคม': 7, 'กรกฎา': 7,
  'ส.ค.': 8, 'สิงหาคม': 8, 'สิงหา': 8,
  'ก.ย.': 9, 'กันยายน': 9, 'กันยา': 9,
  'ต.ค.': 10, 'ตุลาคม': 10, 'ตุลา': 10,
  'พ.ย.': 11, 'พฤศจิกายน': 11, 'พฤศจิกา': 11,
  'ธ.ค.': 12, 'ธันวาคม': 12, 'ธันวา': 12,
};
const EN_MONTHS = {
  'January': 1, 'Jan': 1,
  'February': 2, 'Feb': 2,
  'March': 3, 'Mar': 3,
  'April': 4, 'Apr': 4,
  'May': 5,
  'June': 6, 'Jun': 6,
  'July': 7, 'Jul': 7,
  'August': 8, 'Aug': 8,
  'September': 9, 'Sept': 9, 'Sep': 9,
  'October': 10, 'Oct': 10,
  'November': 11, 'Nov': 11,
  'December': 12, 'Dec': 12,
};

// V98 — Combined month map for unified lookup (TH + EN)
const ALL_MONTHS = { ...THAI_MONTHS, ...EN_MONTHS };
const MONTH_LOOKUP = Object.fromEntries(
  Object.entries(ALL_MONTHS).flatMap(([key, value]) => [[key, value], [key.toLowerCase(), value]])
);
const MONTH_ALTS = Object.keys(ALL_MONTHS).sort((a, b) => b.length - a.length); // longest first

// Bangkok today
function todayBKK() {
  return new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
}

function pad(n) { return n < 10 ? '0' + n : String(n); }
function fmt(year, month, day) { return `${year}-${pad(month)}-${pad(day)}`; }
function addDay(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// Decide year: if month is past, use next year; else current year
function inferYear(month, optHintYear) {
  if (optHintYear && optHintYear > 2500) return optHintYear - 543; // BE → CE
  if (optHintYear) return optHintYear;
  const t = todayBKK();
  const curYear = t.getUTCFullYear();
  const curMonth = t.getUTCMonth() + 1;
  // If month has passed this year, assume next year
  if (month < curMonth) return curYear + 1;
  return curYear;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function monthNum(s) { return MONTH_LOOKUP[String(s || '').toLowerCase()]; }

/**
 * Parse Thai date range from natural-language text.
 * @param {string} text
 * @returns {{checkIn: string, checkOut: string, hint: string} | null}
 */
// FB_AVAIL_V2_FIXED: relative date helper (พรุ่งนี้/วันนี้/มะรืนนี้)
function _parseRelativeDate(text) {
  const t = String(text);
  const today = todayBKK();
  // วันนี้ — risky (same-day booking) but parse · let validator decide
  if (/วันนี้|today/i.test(t)) {
    const iso = `${today.getUTCFullYear()}-${pad(today.getUTCMonth() + 1)}-${pad(today.getUTCDate())}`;
    return { checkIn: iso, checkOut: addDay(iso), hint: 'relative: วันนี้' };
  }
  if (/พรุ่งนี้|tomorrow/i.test(t)) {
    const iso = `${today.getUTCFullYear()}-${pad(today.getUTCMonth() + 1)}-${pad(today.getUTCDate())}`;
    const next = addDay(iso);
    return { checkIn: next, checkOut: addDay(next), hint: 'relative: พรุ่งนี้' };
  }
  if (/มะรืน(?:นี้)?|day after tomorrow/i.test(t)) {
    const iso = `${today.getUTCFullYear()}-${pad(today.getUTCMonth() + 1)}-${pad(today.getUTCDate())}`;
    const day2 = addDay(addDay(iso));
    return { checkIn: day2, checkOut: addDay(day2), hint: 'relative: มะรืน' };
  }
  return null;
}

function parseThaiDateRange(text) {
  if (!text) return null;
  const t = String(text);

  // FB_AVAIL_V2_FIXED: check relative dates FIRST (พรุ่งนี้/วันนี้/มะรืน)
  const rel = _parseRelativeDate(t);
  if (rel) return rel;

  // Build month regex alternation (longest first)
  const monthAlt = MONTH_ALTS.map(escapeRe).join('|');

  // Pattern 1: range "DD-DD MONTH" — same month
  // e.g. "15-17 มิ.ย." or "15 - 17 มิ.ย." or "15-17 มิย"
  const rangeSameMonthRe = new RegExp(`(\\d{1,2})\\s*[-–]\\s*(\\d{1,2})\\s*(${monthAlt})\\s*(\\d{4})?`, 'i');
  const m1 = t.match(rangeSameMonthRe);
  if (m1) {
    const d1 = parseInt(m1[1], 10);
    const d2 = parseInt(m1[2], 10);
    const month = monthNum(m1[3]);
    const year = inferYear(month, m1[4] ? parseInt(m1[4], 10) : null);
    if (d1 >= 1 && d1 <= 31 && d2 >= 1 && d2 <= 31 && d2 > d1) {
      return {
        checkIn: fmt(year, month, d1),
        checkOut: fmt(year, month, d2),
        hint: `range-same-month: ${m1[0]}`,
      };
    }
  }

  // Pattern 2: cross-month range "DD MONTH - DD MONTH"
  const rangeCrossMonthRe = new RegExp(
    `(\\d{1,2})\\s*(${monthAlt})\\s*(?:[-–]|to|until|check\\s*out)\\s*(\\d{1,2})\\s*(${monthAlt})\\s*(\\d{4})?`,
    'i'
  );
  const m2 = t.match(rangeCrossMonthRe);
  if (m2) {
    const d1 = parseInt(m2[1], 10);
    const month1 = monthNum(m2[2]);
    const d2 = parseInt(m2[3], 10);
    const month2 = monthNum(m2[4]);
    const baseYear = inferYear(month1, m2[5] ? parseInt(m2[5], 10) : null);
    const checkInIso = fmt(baseYear, month1, d1);
    const yearOut = month2 < month1 ? baseYear + 1 : baseYear;
    const checkOutIso = fmt(yearOut, month2, d2);
    return { checkIn: checkInIso, checkOut: checkOutIso, hint: `cross-month: ${m2[0]}` };
  }

  // Pattern 3: single date "DD MONTH"
  const singleRe = new RegExp(`(\\d{1,2})\\s*(${monthAlt})\\s*(\\d{4})?`, 'i');
  const m3 = t.match(singleRe);
  if (m3) {
    const day = parseInt(m3[1], 10);
    const month = monthNum(m3[2]);
    const year = inferYear(month, m3[3] ? parseInt(m3[3], 10) : null);
    if (day >= 1 && day <= 31) {
      const checkIn = fmt(year, month, day);
      return { checkIn, checkOut: addDay(checkIn), hint: `single-date: ${m3[0]}` };
    }
  }

  // Pattern 4: numeric DD/MM[/YYYY] or DD-MM
  const numericRe = /(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{4}))?/;
  const m4 = t.match(numericRe);
  if (m4) {
    const day = parseInt(m4[1], 10);
    const month = parseInt(m4[2], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const year = inferYear(month, m4[3] ? parseInt(m4[3], 10) : null);
      const checkIn = fmt(year, month, day);
      return { checkIn, checkOut: addDay(checkIn), hint: `numeric: ${m4[0]}` };
    }
  }

  return null;
}

module.exports = { parseThaiDateRange };
