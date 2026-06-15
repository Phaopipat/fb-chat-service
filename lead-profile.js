'use strict';

// lead-profile.js
// ─────────────────────────────────────────────────────────────────────────────
// Step 2 of sales-agent pipeline — Conversation State / Lead Profile module
//
// Track each lead's position in the sales funnel across messages.
// Bot's reply is influenced by: stage, dates_known, pax_known, room_pref,
// budget_signal, objections, last_signal, inbound_count, bot_last_quote_at.
//
// Sheet tab: `LeadProfile` (21 cols A-U)
// Cache: in-memory Map · 60s TTL · invalidated on saveLeadProfile
// Write strategy: batched queue · flushed every 60s or on critical mutation
// Merge-by-phone: when booking-collector captures phone, link FB+LINE rows
//                 with same phone via `linked_user_ids` col
//
// Env vars:
//   LEAD_PROFILE_ENABLED — "true" | "false" (default false) · master flag
//   GOOGLE_SHEET_ID + GOOGLE_SERVICE_ACCOUNT_JSON — same as rest of app
//
// Public API:
//   isLeadProfileEnabled()
//   loadLeadProfile(userId, platform)
//   classifyMessage(msgText, profile) → mutations (pure function)
//   saveLeadProfile(userId, mutations, opts?)
//   formatProfileForPrompt(profile)
//   setPhone(userId, phone) → triggers merge-by-phone
//   markQuoteSent(userId) → bot_last_quote_at = now
//   getAllProfiles() → for backfill / admin tools
//   _resetCache() · _flushQueue() · _setSheetsClientForTest() — test helpers
// ─────────────────────────────────────────────────────────────────────────────

const { google } = require('googleapis');

// ─── Constants ────────────────────────────────────────────────────────────────
const CACHE_TTL_MS    = 60 * 1000;      // 60s — same as TestMode/BotToggle
const FLUSH_INTERVAL  = 60 * 1000;      // batch write every 60s
const PROMPT_MAX_LEN  = 300;            // hard cap on LEAD CONTEXT block (chars, ~150-300 tokens)
const LOST_DECAY_DAYS = 7;              // silent N days after quote → 'lost'
const SHEET_TAB       = 'LeadProfile';
const SHEET_RANGE     = `${SHEET_TAB}!A2:U10000`;
const SHEET_RANGE_W   = `${SHEET_TAB}!A:U`;

// Debug log — set LEAD_PROFILE_DEBUG=true in Railway for verbose output
const LP_DEBUG = process.env.LEAD_PROFILE_DEBUG === 'true';

// ─── Column indices (0-based · 21 cols A-U) ────────────────────────────────────
const COL = {
  userId:            0,   // A
  platform:          1,   // B  LINE/FB/TT
  displayName:       2,   // C
  stage:             3,   // D  cold/qualifying/comparing/quoting/booking/won/lost
  dates_known:       4,   // E  e.g. "2026-06-15 to 2026-06-17"
  pax_known:         5,   // F  e.g. "2 adults 1 child"
  room_pref:         6,   // G
  budget_signal:     7,   // H  ขอลด / ราคา ok / null
  objections:        8,   // I  comma-separated
  last_signal:       9,   // J  hot/warm/lukewarm/cold/silent
  next_action:      10,   // K
  first_contact:    11,   // L  ISO timestamp
  last_inbound:     12,   // M
  inbound_count:    13,   // N
  bot_reply_count:  14,   // O
  escalation_count: 15,   // P
  notes:            16,   // Q
  updated_at:       17,   // R
  phone:            18,   // S  for merge-by-phone (Q2 decision)
  linked_user_ids:  19,   // T  comma-separated other userIds with same phone
  bot_last_quote_at:20,   // U  ISO timestamp · drives lost-decay logic
};
const NUM_COLS = 21;

const STAGES = ['cold', 'qualifying', 'comparing', 'quoting', 'booking', 'won', 'lost'];
const TERMINAL_STAGES = new Set(['won', 'lost']);

// ─── Module-level state ───────────────────────────────────────────────────────
// Cache: userId → { profile, at }
const _cache = new Map();

// Pending writes queue: userId → { mutations, queuedAt, immediate }
const _writeQueue = new Map();

// Sheets client (lazy)
let _sheetsClient = null;

// Flush timer
let _flushTimer = null;

// Feature flag — read dynamically so env mutations during tests take effect
function isLeadProfileEnabled() {
  return (process.env.LEAD_PROFILE_ENABLED || 'false').toLowerCase() === 'true';
}

// ─── Sheets client (lazy) ─────────────────────────────────────────────────────
async function _getSheetsClient() {
  if (_sheetsClient) return _sheetsClient;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}';
  const creds = JSON.parse(raw.replace(/\\\\n/g, '\\n'));
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  _sheetsClient = google.sheets({ version: 'v4', auth });
  return _sheetsClient;
}

function _setSheetsClientForTest(client) {
  _sheetsClient = client;
}

// ─── rowToProfile / profileToRow ──────────────────────────────────────────────
function rowToProfile(row) {
  if (!row || row.length === 0) return null;
  return {
    userId:            row[COL.userId]            || '',
    platform:          row[COL.platform]          || 'LINE',
    displayName:       row[COL.displayName]       || '',
    stage:             row[COL.stage]             || 'cold',
    dates_known:       row[COL.dates_known]       || '',
    pax_known:         row[COL.pax_known]         || '',
    room_pref:         row[COL.room_pref]         || '',
    budget_signal:     row[COL.budget_signal]     || '',
    objections:        row[COL.objections]        || '',
    last_signal:       row[COL.last_signal]       || '',
    next_action:       row[COL.next_action]       || '',
    first_contact:     row[COL.first_contact]     || '',
    last_inbound:      row[COL.last_inbound]      || '',
    inbound_count:     parseInt(row[COL.inbound_count]    || '0', 10) || 0,
    bot_reply_count:   parseInt(row[COL.bot_reply_count]  || '0', 10) || 0,
    escalation_count:  parseInt(row[COL.escalation_count] || '0', 10) || 0,
    notes:             row[COL.notes]             || '',
    updated_at:        row[COL.updated_at]        || '',
    phone:             row[COL.phone]             || '',
    linked_user_ids:   row[COL.linked_user_ids]   || '',
    bot_last_quote_at: row[COL.bot_last_quote_at] || '',
  };
}

function profileToRow(p) {
  const row = new Array(NUM_COLS).fill('');
  row[COL.userId]            = p.userId            || '';
  row[COL.platform]          = p.platform          || 'LINE';
  row[COL.displayName]       = p.displayName       || '';
  row[COL.stage]             = p.stage             || 'cold';
  row[COL.dates_known]       = p.dates_known       || '';
  row[COL.pax_known]         = p.pax_known         || '';
  row[COL.room_pref]         = p.room_pref         || '';
  row[COL.budget_signal]     = p.budget_signal     || '';
  row[COL.objections]        = p.objections        || '';
  row[COL.last_signal]       = p.last_signal       || '';
  row[COL.next_action]       = p.next_action       || '';
  row[COL.first_contact]     = p.first_contact     || '';
  row[COL.last_inbound]      = p.last_inbound      || '';
  row[COL.inbound_count]     = String(p.inbound_count    || 0);
  row[COL.bot_reply_count]   = String(p.bot_reply_count  || 0);
  row[COL.escalation_count]  = String(p.escalation_count || 0);
  row[COL.notes]             = p.notes             || '';
  row[COL.updated_at]        = p.updated_at        || '';
  row[COL.phone]             = p.phone             || '';
  row[COL.linked_user_ids]   = p.linked_user_ids   || '';
  row[COL.bot_last_quote_at] = p.bot_last_quote_at || '';
  return row;
}

function _emptyProfile(userId, platform) {
  const now = new Date().toISOString();
  return {
    userId, platform: platform || 'LINE',
    displayName: '', stage: 'cold',
    dates_known: '', pax_known: '', room_pref: '',
    budget_signal: '', objections: '', last_signal: '',
    next_action: '',
    first_contact: now, last_inbound: now,
    inbound_count: 0, bot_reply_count: 0, escalation_count: 0,
    notes: '', updated_at: now,
    phone: '', linked_user_ids: '', bot_last_quote_at: '',
  };
}

// ─── loadLeadProfile ──────────────────────────────────────────────────────────
/**
 * Read profile for userId. If not in Sheet, returns minimal cold profile.
 * Cached 60s per userId.
 *
 * @param {string} userId
 * @param {string} platform   'LINE' | 'FB' | 'TT'
 * @returns {Promise<object>} profile (always returns something, never throws to caller)
 */
async function loadLeadProfile(userId, platform = 'LINE') {
  if (!userId) return _emptyProfile('', platform);

  const now = Date.now();
  const cached = _cache.get(userId);
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return { ...cached.profile };  // shallow clone — caller can mutate freely
  }

  try {
    const sheetId = process.env.GOOGLE_SHEET_ID;
    const sheets = await _getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: SHEET_RANGE,
    });
    const rows = (res.data && res.data.values) || [];

    // Find row with matching userId — also rebuild cache while scanning
    let found = null;
    for (const row of rows) {
      const profile = rowToProfile(row);
      if (!profile || !profile.userId) continue;
      _cache.set(profile.userId, { profile, at: now });
      if (profile.userId === userId) found = profile;
    }

    if (found) {
      if (LP_DEBUG) console.log(`[LP] loadLeadProfile hit ${userId.substring(0, 8)}: stage=${found.stage} count=${found.inbound_count}`);
      return { ...found };
    }

    // Not in sheet → minimal profile, cache it so subsequent reads in same window are cheap
    const fresh = _emptyProfile(userId, platform);
    _cache.set(userId, { profile: fresh, at: now });
    if (LP_DEBUG) console.log(`[LP] loadLeadProfile new ${userId.substring(0, 8)} platform=${platform}`);
    return { ...fresh };
  } catch (err) {
    console.warn('[LP] loadLeadProfile error — returning empty:', err.message);
    return _emptyProfile(userId, platform);
  }
}

// ─── classifyMessage ──────────────────────────────────────────────────────────
/**
 * Pure function — analyze msgText + existing profile, return mutations.
 * Does NOT write. Rule-based v0 — Thai regex.
 *
 * @param {string} msgText
 * @param {object} profile  existing profile (may be empty/cold)
 * @returns {object} mutations  partial profile to merge
 */
function classifyMessage(msgText, profile = {}) {
  const m = {};
  if (!msgText || typeof msgText !== 'string') return m;

  // ─── dates (Thai patterns · order matters: most-specific first) ───────────
  // 1. Range "15-17 มิ.ย." → "2026-06-15 to 2026-06-17"
  // 2. Single "15 มิ.ย." → "2026-06-15"
  // 3. Numeric "15/6" or "15/6/26" → "2026-06-15"
  // 4. Relative "พรุ่งนี้" / "เสาร์อาทิตย์"
  if (!profile.dates_known) {
    const parsed = _parseDates(msgText);
    if (parsed) m.dates_known = parsed;
  }

  // ─── pax (people + children) ──────────────────────────────────────────────
  if (!profile.pax_known) {
    const adults = msgText.match(/(\d+)\s*(?:คน|ท่าน|adults?|ผู้ใหญ่|people|pax)/i);
    const children = msgText.match(/(?:เด็ก|child|kid|children)\s*(\d+)|(\d+)\s*(?:เด็ก|child|kid|children)/i);
    if (adults) {
      let s = `${adults[1]} adults`;
      if (children) {
        const c = children[1] || children[2];
        s += ` ${c} child`;
      }
      m.pax_known = s;
    }
  }

  // ─── budget signal ────────────────────────────────────────────────────────
  if (/ขอลด|ลดราคา|แพง|ลดได้ป่ะ|ลดให้หน่อย|งบ\s*\d+|ลดหน่อย/.test(msgText)) {
    m.budget_signal = 'ขอลด';
  } else if (/^(ok|okay|โอเค|ตกลง|ได้เลย|รับได้)/i.test(msgText.trim())) {
    m.budget_signal = 'ราคา ok';
  }

  // ─── objections (additive) ────────────────────────────────────────────────
  // Note: budget objection ("แพง") triggered by EITHER explicit complaint ("แพง", "ลดราคา")
  // OR discount-request phrases ("ลดได้", "ลดหน่อย", "ขอลด", "งบ\\d+").
  // Asking for a discount IS a price objection even if customer doesn't say "แพง".
  const newObjs = [];
  if (/แพง|ลดราคา|ลดได้|ลดหน่อย|ขอลด|งบ\s*\d+/.test(msgText)) newObjs.push('แพง');
  if (/ไกล|เดินทาง|กี่ชั่วโมง|กี่ชม/.test(msgText)) newObjs.push('ระยะทาง');
  if (/คลื่น|เมาเรือ|seasick/i.test(msgText)) newObjs.push('เมาเรือ');
  if (/อากาศ|ฝน|มรสุม|พายุ|weather/i.test(msgText)) newObjs.push('อากาศ');
  if (newObjs.length) {
    const existing = (profile.objections || '').split(',').map(s => s.trim()).filter(Boolean);
    const merged = Array.from(new Set([...existing, ...newObjs]));
    m.objections = merged.join(',');
  }

  // ─── commitment signals (override stage to booking) ───────────────────────
  if (/จองเลย|โอนแล้ว|โอนเรียบร้อย|โอนไปแล้ว|ส่งสลิป|สลิป|slip/i.test(msgText)) {
    m.stage = 'booking';
  }

  // ─── engagement signal (last_signal) ──────────────────────────────────────
  m.last_signal = _scoreSignal(msgText);

  // ─── stage inference (only if not explicitly set above) ───────────────────
  if (!m.stage) {
    const stage = _inferStage(profile, m);
    if (stage) m.stage = stage;
  }

  return m;
}

function _scoreSignal(msgText) {
  if (/!|👍|🥰|❤️|จองเลย|เอาด่วน|รีบ|asap/i.test(msgText)) return 'hot';
  if (/น่าสนใจ|สวยมาก|ดีจัง|อยากไป|interesting|love/i.test(msgText)) return 'warm';
  if (/ขอบคุณ|ค่อยติดต่อใหม่|ขอคิดดู|let me think/i.test(msgText)) return 'lukewarm';
  // Engaged inquiry about booking-related topics — neutral tone but active = lukewarm
  if (/(ป่ะ|ไหม|มั้ย|\?)/.test(msgText) && /(ลด|ราคา|จอง|ห้อง|วันที่|พัก|ว่าง)/.test(msgText)) return 'lukewarm';
  return 'cold';
}

// ─── Thai date parsing ────────────────────────────────────────────────────────
// Recognizes ranges + single dates + relative refs.
// Returns ISO-like string or null. For ranges → "YYYY-MM-DD to YYYY-MM-DD".
const _TH_MONTH_PATTERN = '(ม\\.?ค|มกราคม|ก\\.?พ|กุมภาพันธ์|มี\\.?ค|มีนาคม|เม\\.?ย|เมษายน|พ\\.?ค|พฤษภาคม|มิ\\.?ย|มิถุนายน|ก\\.?ค|กรกฎาคม|ส\\.?ค|สิงหาคม|ก\\.?ย|กันยายน|ต\\.?ค|ตุลาคม|พ\\.?ย|พฤศจิกายน|ธ\\.?ค|ธันวาคม)';

function _thMonthToNum(s) {
  const c = (s || '').replace(/\./g, '').toLowerCase();
  if (/มค|มกราคม/.test(c)) return 1;
  if (/กพ|กุมภาพันธ์/.test(c)) return 2;
  if (/มีค|มีนาคม/.test(c)) return 3;
  if (/เมย|เมษายน/.test(c)) return 4;
  if (/พค|พฤษภาคม/.test(c)) return 5;
  if (/มิย|มิถุนายน/.test(c)) return 6;
  if (/กค|กรกฎาคม/.test(c)) return 7;
  if (/สค|สิงหาคม/.test(c)) return 8;
  if (/กย|กันยายน/.test(c)) return 9;
  if (/ตค|ตุลาคม/.test(c)) return 10;
  if (/พย|พฤศจิกายน/.test(c)) return 11;
  if (/ธค|ธันวาคม/.test(c)) return 12;
  return null;
}

// V95 — validate date components before formatting · prevents "2026-17-15" type invalid dates
function _isValidDateComponents(year, month, day) {
  if (year < 2020 || year > 2030) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  return true;
}

function _parseDates(msgText) {
  if (!msgText) return null;

  // 1. Range with Thai month: "15-17 มิ.ย." / "15 - 17 มิย"
  const rangeRe = new RegExp(`(\\d{1,2})\\s*[-–]\\s*(\\d{1,2})\\s+${_TH_MONTH_PATTERN}`, 'i');
  const rangeMatch = msgText.match(rangeRe);
  if (rangeMatch) {
    const [, d1, d2, monStr] = rangeMatch;
    const m_num = _thMonthToNum(monStr);
    const day1 = parseInt(d1, 10);
    const day2 = parseInt(d2, 10);
    const yr = new Date().getFullYear();
    if (!m_num || !_isValidDateComponents(yr, m_num, day1) || !_isValidDateComponents(yr, m_num, day2)) {
      return null;  // V95 — reject invalid components
    }
    const start = `${yr}-${String(m_num).padStart(2, '0')}-${String(day1).padStart(2, '0')}`;
    const end   = `${yr}-${String(m_num).padStart(2, '0')}-${String(day2).padStart(2, '0')}`;
    return `${start} to ${end}`;
  }

  // 2. Single date with Thai month: "15 มิ.ย." / "วันที่ 15 มิ.ย."
  const singleThaiRe = new RegExp(`(\\d{1,2})\\s+${_TH_MONTH_PATTERN}`, 'i');
  const singleThai = msgText.match(singleThaiRe);
  if (singleThai) {
    const [, d, monStr] = singleThai;
    const m_num = _thMonthToNum(monStr);
    const day = parseInt(d, 10);
    const yr = new Date().getFullYear();
    if (!m_num || !_isValidDateComponents(yr, m_num, day)) {
      return null;  // V95 — reject invalid components
    }
    return `${yr}-${String(m_num).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  // 3. Numeric range "15/6 - 17/6" (less common but possible)
  const numRange = msgText.match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (numRange) {
    const [, d1, m1, d2, m2] = numRange;
    const day1 = parseInt(d1, 10);
    const mth1 = parseInt(m1, 10);
    const day2 = parseInt(d2, 10);
    const mth2 = parseInt(m2, 10);
    const yr = new Date().getFullYear();
    if (!_isValidDateComponents(yr, mth1, day1) || !_isValidDateComponents(yr, mth2, day2)) {
      return null;  // V95 — reject invalid components
    }
    return `${yr}-${String(mth1).padStart(2,'0')}-${String(day1).padStart(2,'0')} to ${yr}-${String(mth2).padStart(2,'0')}-${String(day2).padStart(2,'0')}`;
  }

  // 4. Numeric single: "15/6" or "15/6/26"
  const numMatch = msgText.match(/(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?/);
  if (numMatch) {
    const [, d, mth, y] = numMatch;
    const year = y ? (y.length === 2 ? 2000 + parseInt(y, 10) : parseInt(y, 10)) : new Date().getFullYear();
    const day = parseInt(d, 10);
    const month = parseInt(mth, 10);
    if (!_isValidDateComponents(year, month, day)) {
      return null;  // V95 — reject invalid components
    }
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  // 5. Relative
  if (/พรุ่งนี้|tomorrow/i.test(msgText)) {
    return new Date(Date.now() + 86400000).toISOString().substring(0, 10);
  }
  if (/เสาร์อาทิตย์|สุดสัปดาห์|weekend/i.test(msgText)) {
    return 'weekend';
  }
  return null;
}

function _inferStage(profile, mutations) {
  const merged = { ...profile, ...mutations };

  // Sticky terminal stages — never auto-transition out
  if (TERMINAL_STAGES.has(merged.stage)) return null;
  if (merged.stage === 'booking') return null;  // sticky until slip verified → won externally

  // Lost decay: if was 'quoting' but silent >LOST_DECAY_DAYS since quote → lost
  if (merged.stage === 'quoting' && merged.bot_last_quote_at) {
    const sinceQuote = Date.now() - new Date(merged.bot_last_quote_at).getTime();
    if (sinceQuote > LOST_DECAY_DAYS * 86400000) {
      // Caller decides — we only suggest. Returning 'lost' is consistent with
      // "stage = hint not gate" because saveLeadProfile + bot still allow win-back replies.
      return 'lost';
    }
  }

  // Forward progression
  if (merged.bot_last_quote_at)               return 'quoting';
  if (merged.dates_known && merged.pax_known) return 'comparing';
  if (merged.dates_known || merged.pax_known || merged.budget_signal || merged.room_pref) return 'qualifying';
  return null;  // no signal → keep existing stage (default 'cold')
}

// ─── saveLeadProfile (batched) ────────────────────────────────────────────────
/**
 * Queue mutations for later flush. If `immediate=true` (e.g. stage→booking/won),
 * flush right away.
 *
 * @param {string} userId
 * @param {object} mutations    partial profile to merge
 * @param {object} [opts]
 * @param {boolean} [opts.immediate=false]
 */
async function saveLeadProfile(userId, mutations, opts = {}) {
  if (!userId || !mutations || typeof mutations !== 'object') return;

  // Critical transitions force immediate flush
  const critical = ['booking', 'won', 'lost'].includes(mutations.stage);
  const immediate = !!opts.immediate || critical;

  const existing = _writeQueue.get(userId) || { mutations: {}, queuedAt: Date.now() };
  Object.assign(existing.mutations, mutations);
  existing.mutations.updated_at = new Date().toISOString();
  _writeQueue.set(userId, existing);

  // Update cache optimistically so subsequent loads see fresh data
  const cached = _cache.get(userId);
  if (cached) {
    Object.assign(cached.profile, mutations);
    cached.profile.updated_at = existing.mutations.updated_at;
  }

  if (immediate) {
    await _flushQueue();
  } else {
    _scheduleFlush();
  }
}

function _scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    _flushQueue().catch(err => console.warn('[LP] scheduled flush error:', err.message));
  }, FLUSH_INTERVAL);
  if (_flushTimer.unref) _flushTimer.unref();
}

/**
 * Flush all queued mutations to Sheet — upsert per userId.
 * Reads current rows once, then issues batched updates + appends.
 */
async function _flushQueue() {
  if (_writeQueue.size === 0) return;

  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) {
    if (LP_DEBUG) console.warn('[LP] _flushQueue: GOOGLE_SHEET_ID not set, skipping');
    return;
  }

  // Snapshot queue + clear it (so concurrent writes during flush queue separately)
  const snapshot = new Map(_writeQueue);
  _writeQueue.clear();

  try {
    const sheets = await _getSheetsClient();

    // Read current state (find row indices for upsert)
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: SHEET_RANGE,
    });
    const rows = (res.data && res.data.values) || [];
    const idxByUserId = new Map();
    for (let i = 0; i < rows.length; i++) {
      const uid = rows[i] && rows[i][COL.userId];
      if (uid) idxByUserId.set(uid, i);  // i is 0-based offset from row 2
    }

    const appends = [];   // rows to append (new profiles)
    const updates = [];   // { range, values } for existing rows

    for (const [userId, entry] of snapshot) {
      const existingIdx = idxByUserId.get(userId);
      let merged;
      if (existingIdx !== undefined) {
        const current = rowToProfile(rows[existingIdx]);
        merged = { ...current, ...entry.mutations };
      } else {
        merged = { ..._emptyProfile(userId, entry.mutations.platform), ...entry.mutations };
        merged.userId = userId;  // protect against accidental override
      }
      const row = profileToRow(merged);

      if (existingIdx !== undefined) {
        const sheetRow = existingIdx + 2;  // 1-indexed + skip header row
        updates.push({
          range: `${SHEET_TAB}!A${sheetRow}:U${sheetRow}`,
          values: [row],
        });
      } else {
        appends.push(row);
      }
    }

    // Batch update existing rows
    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          valueInputOption: 'RAW',
          data: updates,
        },
      });
    }

    // Append new rows
    if (appends.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: SHEET_RANGE_W,
        valueInputOption: 'RAW',
        requestBody: { values: appends },
      });
    }

    if (LP_DEBUG) console.log(`[LP] flush ${updates.length} updates + ${appends.length} appends`);
  } catch (err) {
    console.warn('[LP] _flushQueue error:', err.message);
    // Re-queue snapshot — don't lose mutations on transient failure
    for (const [userId, entry] of snapshot) {
      if (!_writeQueue.has(userId)) _writeQueue.set(userId, entry);
    }
    _scheduleFlush();
  }
}

// ─── formatProfileForPrompt ───────────────────────────────────────────────────
/**
 * Build a compact LEAD CONTEXT block for injection into the system prompt.
 * Hard-capped at PROMPT_MAX_LEN chars to prevent prompt bloat (v40 regression guard).
 *
 * @param {object} profile
 * @returns {string} multi-line context block
 */
function formatProfileForPrompt(profile) {
  if (!profile || !profile.userId) return '';

  const parts = [];

  // Stage + signal + count summary
  const since = profile.last_inbound
    ? _humanSince(profile.last_inbound)
    : 'now';
  parts.push(`Stage: ${profile.stage || 'cold'} · ทักครั้งที่ ${(profile.inbound_count || 0) + 1} · last ${since}`);

  if (profile.dates_known) parts.push(`Dates: ${profile.dates_known}`);
  if (profile.pax_known)   parts.push(`Pax: ${profile.pax_known}`);
  if (profile.room_pref)   parts.push(`Room interest: ${profile.room_pref}`);

  if (profile.budget_signal) parts.push(`Budget: ${profile.budget_signal}`);
  if (profile.objections)    parts.push(`Objections: ${profile.objections}`);

  if (profile.bot_last_quote_at) {
    parts.push(`Quote sent: ${_humanSince(profile.bot_last_quote_at)} ago`);
  }

  if (profile.linked_user_ids) {
    parts.push(`Linked: also active on ${profile.linked_user_ids.split(',').length} other channel(s) (same phone)`);
  }

  if (profile.notes) {
    const noteShort = profile.notes.substring(0, 80);
    parts.push(`Note: ${noteShort}`);
  }

  // Suggested next action — derived from stage
  const next = _nextActionHint(profile);
  if (next) parts.push(`Suggested next: ${next}`);

  let block = `[LEAD CONTEXT — use for tone/timing only, NOT for fact lookup]\n${parts.join('\n')}`;

  // Hard cap (very defensive — should rarely fire)
  if (block.length > PROMPT_MAX_LEN) {
    block = block.substring(0, PROMPT_MAX_LEN - 3) + '...';
  }
  return block;
}

function _humanSince(isoTs) {
  try {
    const diffMs = Date.now() - new Date(isoTs).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 48) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `${days}d`;
  } catch (_) {
    return '?';
  }
}

function _nextActionHint(profile) {
  switch (profile.stage) {
    case 'cold':       return 'ทักทายอบอุ่น + ถามวันที่/จำนวนคน';
    case 'qualifying': return 'รวบรวมข้อมูลที่ขาด (date/pax/budget)';
    case 'comparing':  return 'เสนอ bay comparison + recommend room';
    case 'quoting':    return 'follow up · handle objections';
    case 'booking':    return 'รอ slip · ส่ง booking ref + email';
    case 'won':        return 'win confirmed · pre-arrival info';
    case 'lost':       return 'win-back tone · low pressure';
    default:           return '';
  }
}

// ─── setPhone — triggers merge-by-phone (Q2 Option B) ─────────────────────────
/**
 * Called by booking-collector when phone is captured. Sets phone on this
 * profile + scans for other profiles with same phone → cross-links via
 * `linked_user_ids` col.
 *
 * @param {string} userId
 * @param {string} phone   normalized (digits only, leading 0 preserved)
 */
async function setPhone(userId, phone) {
  if (!userId || !phone) return;
  const cleaned = String(phone).replace(/\D/g, '');
  if (cleaned.length < 9 || cleaned.length > 11) {
    if (LP_DEBUG) console.warn(`[LP] setPhone reject malformed: "${phone}"`);
    return;
  }

  try {
    // Flush any pending writes first so cross-link reads see consistent state
    await _flushQueue();

    const sheetId = process.env.GOOGLE_SHEET_ID;
    const sheets = await _getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: SHEET_RANGE,
    });
    const rows = (res.data && res.data.values) || [];

    // Find other rows with same phone
    const links = [];
    for (const row of rows) {
      const p = rowToProfile(row);
      if (!p || !p.userId) continue;
      if (p.userId === userId) continue;
      if (p.phone === cleaned) links.push(p.userId);
    }

    // Queue update for current userId
    const myLinks = links.join(',');
    await saveLeadProfile(userId, { phone: cleaned, linked_user_ids: myLinks });

    // Update each linked profile's linked_user_ids to include current userId
    for (const linkedUid of links) {
      const row = rows.find(r => r && r[COL.userId] === linkedUid);
      if (!row) continue;
      const existing = (row[COL.linked_user_ids] || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!existing.includes(userId)) existing.push(userId);
      await saveLeadProfile(linkedUid, { linked_user_ids: existing.join(',') });
    }

    if (LP_DEBUG && links.length) {
      console.log(`[LP] setPhone linked ${userId.substring(0, 8)} ↔ ${links.length} profile(s) via phone`);
    }

    // Force flush so cross-links are durable
    await _flushQueue();
  } catch (err) {
    console.warn('[LP] setPhone error:', err.message);
  }
}

// ─── markQuoteSent ────────────────────────────────────────────────────────────
/**
 * Bot just sent a quote message. Stamp bot_last_quote_at + advance stage.
 * Called from ai-reply.js when reply text contains a price quote.
 */
async function markQuoteSent(userId) {
  if (!userId) return;
  // Immediate flush — quote-sent timestamp is high-signal · next bot reply
  // needs to see it (drives lost-decay logic + LEAD CONTEXT timestamps).
  await saveLeadProfile(userId, {
    bot_last_quote_at: new Date().toISOString(),
    stage: 'quoting',
  }, { immediate: true });
}

function getLeadProfileStats() {
  return {
    enabled: isLeadProfileEnabled(),
    cacheSize: _cache.size,
    pendingWrites: _writeQueue.size,
    flushScheduled: !!_flushTimer,
    cacheTtlSec: Math.round(CACHE_TTL_MS / 1000),
    flushIntervalSec: Math.round(FLUSH_INTERVAL / 1000),
  };
}

// ─── getAllProfiles (for backfill / admin tools) ──────────────────────────────
async function getAllProfiles() {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID;
    const sheets = await _getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: SHEET_RANGE,
    });
    const rows = (res.data && res.data.values) || [];
    return rows.map(rowToProfile).filter(p => p && p.userId);
  } catch (err) {
    console.warn('[LP] getAllProfiles error:', err.message);
    return [];
  }
}

// ─── Test helpers ─────────────────────────────────────────────────────────────
function _resetCache() {
  _cache.clear();
  _writeQueue.clear();
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  isLeadProfileEnabled,
  loadLeadProfile,
  classifyMessage,
  saveLeadProfile,
  formatProfileForPrompt,
  setPhone,
  markQuoteSent,
  getLeadProfileStats,
  getAllProfiles,
  // Constants for tests + integration
  STAGES,
  COL,
  NUM_COLS,
  SHEET_TAB,
  LOST_DECAY_DAYS,
  PROMPT_MAX_LEN,
  // Test helpers
  _resetCache,
  _setSheetsClientForTest,
  _flushQueue,
  // Internal helpers exposed for unit tests only
  _inferStage,
  _scoreSignal,
  rowToProfile,
  profileToRow,
};
