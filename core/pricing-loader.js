// pricing-loader.js — Phase 2.5 (spec v2, 2026-05-04)
// Single `Pricing` tab · 10-min TTL · published flag · per-row validation · granular fallback
// Toggle: PRICING_FROM_SHEET=true (Railway env var) — default false (safe)
// Fallback: if Sheet unavailable or row invalid → HARDCODE_DEFAULTS for that row
// Returns null from getPricingBlock → caller uses hardcoded prompt section unchanged
'use strict';

// ─── HARDCODE_DEFAULTS — confirmed by Phao 2026-05-04 ────────────────────────
// These must match the prices in KAPTAN_SYSTEM_PROMPT (ai-reply.js)
// Keep in sync: if you change a price here, also change it in the prompt (and vice versa)
const HARDCODE_DEFAULTS = {
  RATE_HOME_1N:    { price: 3900, unit: 'per_person', name_th: 'Home / Beach Chalet',    type: 'room_rate', nights: 1 },
  RATE_HOME_2N:    { price: 6400, unit: 'per_person', name_th: 'Home / Beach Chalet',    type: 'room_rate', nights: 2 },
  RATE_MANILA_1N:  { price: 4400, unit: 'per_person', name_th: 'Manila Deluxe Chalet',   type: 'room_rate', nights: 1 },
  RATE_MANILA_2N:  { price: 7400, unit: 'per_person', name_th: 'Manila Deluxe Chalet',   type: 'room_rate', nights: 2 },
  RATE_THAI_1N:    { price: 5400, unit: 'per_person', name_th: 'Thai Style Ocean Villa',  type: 'room_rate', nights: 1 },
  RATE_THAI_2N:    { price: 8400, unit: 'per_person', name_th: 'Thai Style Ocean Villa',  type: 'room_rate', nights: 2 },
  TRIP_SELF:       { price: 1700, unit: 'per_person', name_th: 'Day Trip (มาเอง)',        type: 'day_trip',  nights: 0 },
  TRIP_HH:         { price: 2700, unit: 'per_person', name_th: 'Day Trip (จากหัวหิน)',    type: 'day_trip',  nights: 0 },
  SURCHARGE_SOLO:  { price: 30,   unit: 'percent',    name_th: 'พักเดี่ยว',               type: 'surcharge', direction: 'add' },
  SURCHARGE_HOL:   { price: 500,  unit: 'per_person', name_th: 'วันหยุดยาว',             type: 'surcharge', direction: 'add' },
  SURCHARGE_NY:    { price: 1000, unit: 'per_person', name_th: 'ปีใหม่',                 type: 'surcharge', direction: 'add' },
  DISC_CHILD_3_10: { price: 30,   unit: 'percent',    name_th: 'เด็ก 3-10 ปี',           type: 'discount',  direction: 'subtract' },
  DISC_CHILD_0_2:  { price: 100,  unit: 'percent',    name_th: 'เด็กต่ำกว่า 3 ปี',      type: 'discount',  direction: 'subtract' },
  DISC_SENIOR:     { price: 30,   unit: 'percent',    name_th: 'ผู้สูงอายุ 70+',         type: 'discount',  direction: 'subtract' },
  ACT_SKINDIVING:  { price: 700,  unit: 'per_person', name_th: 'Skindiving',              type: 'activity' },
  ACT_SAILING:     { price: 1500, unit: 'per_boat',   name_th: 'ล่องเรือใบ',             type: 'activity' },
  ACT_TURTLE:      { price: 200,  unit: 'per_person', name_th: 'Turtle Nursing',          type: 'activity' },
  ACT_OYSTER:      { price: 250,  unit: 'per_person', name_th: 'Oyster Hunting',          type: 'activity' },
};

// ─── Validation constants ──────────────────────────────────────────────────────
const VALID_TYPES = ['room_rate', 'day_trip', 'surcharge', 'activity', 'discount', 'dive_course'];
const VALID_UNITS = ['per_person', 'per_room', 'per_boat', 'percent'];

// Price sanity ranges per type — out-of-range rows are skipped + hardcode fallback used
const PRICE_RANGES = {
  room_rate:        { min: 1000,  max: 20000 },
  day_trip:         { min: 500,   max: 8000  },
  activity:         { min: 50,    max: 10000 },
  dive_course:      { min: 500,   max: 30000 }, // OW/AOW courses (12k–23.5k); catch fat-finger prices
  surcharge_person: { min: -5000, max: 5000  }, // unit=per_person/per_room
  surcharge_pct:    { min: 0,     max: 200   }, // unit=percent
  discount:         { min: 0,     max: 100   }, // always percent
};

// ─── Cache ─────────────────────────────────────────────────────────────────────
let _cache   = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes (spec Section 5)

// ─── _parseRow ────────────────────────────────────────────────────────────────
// Parse + validate one Sheet row (A:N = 14 cols).
// Returns validated object on success, null to skip (logs warning for invalid rows).
// published=FALSE / future valid_from / expired valid_to → null silently (not a warning).
function _parseRow(row, today) {
  const id        = String(row[0]  || '').trim();
  const type      = String(row[1]  || '').trim();
  const name_th   = String(row[2]  || '').trim();
  // row[3] = name_en (optional, not validated strictly)
  const nights    = String(row[4]  || '').trim();
  const priceStr  = String(row[5]  || '').trim();
  const unit      = String(row[6]  || '').trim();
  const direction = String(row[7]  || '').trim() || 'add';
  const condition = String(row[8]  || '').trim();
  const validFrom = String(row[9]  || '').trim();
  const validTo   = String(row[10] || '').trim();
  const published = String(row[11] || '').trim().toUpperCase();

  if (!id) return null;

  // published must be exactly 'TRUE' — blank or 'FALSE' = draft, skip silently
  if (published !== 'TRUE') return null;

  // Date validity — invalid format → warn but treat as "always valid"
  if (validFrom) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) {
      console.warn(`[pricing] WARN: id=${id} valid_from="${validFrom}" invalid format — treating as always valid`);
    } else if (validFrom > today) {
      return null; // not yet active — skip silently
    }
  }
  if (validTo) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(validTo)) {
      console.warn(`[pricing] WARN: id=${id} valid_to="${validTo}" invalid format — treating as always valid`);
    } else if (validTo < today) {
      return null; // expired — skip silently
    }
  }

  // type required + enum
  if (!VALID_TYPES.includes(type)) {
    console.warn(`[pricing] WARN: id=${id} type="${type}" invalid — skipping`);
    return null;
  }

  // name_th required
  if (!name_th || name_th.length > 100) {
    console.warn(`[pricing] WARN: id=${id} name_th missing or too long — skipping`);
    return null;
  }

  // price required + numeric
  const price = parseFloat(priceStr);
  if (isNaN(price)) {
    console.warn(`[pricing] WARN: id=${id} price="${priceStr}" not a number — skipping`);
    return null;
  }

  // price range sanity check — surcharge splits by unit (percent vs per_person)
  const rangeKey =
    type === 'surcharge' && unit === 'percent' ? 'surcharge_pct'    :
    type === 'surcharge'                       ? 'surcharge_person'  :
    type;
  const range = PRICE_RANGES[rangeKey];
  if (range && (price < range.min || price > range.max)) {
    const hcPrice = HARDCODE_DEFAULTS[id]?.price ?? 'N/A';
    console.warn(`[pricing] WARN: id=${id} price=${price} out of range [${range.min}–${range.max}] for type=${type} — fallback to hardcode ${hcPrice}`);
    return null;
  }

  // unit required + enum
  if (!VALID_UNITS.includes(unit)) {
    console.warn(`[pricing] WARN: id=${id} unit="${unit}" invalid — skipping`);
    return null;
  }

  // room_rate must have nights
  const nightsInt = parseInt(nights, 10);
  if (type === 'room_rate' && (nights === '' || isNaN(nightsInt))) {
    console.warn(`[pricing] WARN: id=${id} type=room_rate nights blank — skipping`);
    return null;
  }

  return {
    id, type, name_th,
    nights:    isNaN(nightsInt) ? null : nightsInt,
    price,
    unit,
    direction: direction === 'subtract' ? 'subtract' : 'add',
    condition,
  };
}

// ─── _loadFromSheet ────────────────────────────────────────────────────────────
// Reads Pricing!A2:N100, validates, caches 10 min.
async function _loadFromSheet({ sheets, sheetId }) {
  if (_cache && Date.now() - _cacheAt < CACHE_TTL_MS) return _cache;

  const today = new Date().toISOString().substring(0, 10); // YYYY-MM-DD (UTC; close enough for date checks)
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Pricing!A2:N100',
  });

  const rows = res.data.values || [];
  const rates = new Map();
  const idSeen = new Set();

  for (const row of rows) {
    const id = String(row[0] || '').trim();
    if (!id) continue;
    if (idSeen.has(id)) {
      console.warn(`[pricing] WARN: id=${id} duplicate row — keeping first occurrence`);
      continue;
    }
    idSeen.add(id);
    const parsed = _parseRow(row, today);
    if (parsed) rates.set(id, parsed);
  }

  const expiry = new Date(Date.now() + CACHE_TTL_MS).toISOString().substring(0, 19) + 'Z';
  console.log(`[pricing] Loaded ${rates.size} rows from Sheet (${rows.length} total) — cached until ${expiry}`);

  _cache = { rates, loadedAt: new Date().toISOString(), source: 'sheet' };
  _cacheAt = Date.now();
  return _cache;
}

// ─── _get ──────────────────────────────────────────────────────────────────────
// Get pricing row: Sheet first, HARDCODE_DEFAULTS fallback (granular per-row).
function _get(rates, id) {
  if (rates && rates.has(id)) return { ...rates.get(id), source: 'sheet' };
  const hc = HARDCODE_DEFAULTS[id];
  return hc ? { ...hc, source: 'hardcode' } : null;
}

// ─── _formatPricingBlock ───────────────────────────────────────────────────────
// Builds the `# ราคา Package` prompt section from Sheet/fallback data.
// Matches the format expected by buildKaptanPrompt() in ai-reply.js.
function _formatPricingBlock(rates, loadedAt) {
  const h1 = _get(rates, 'RATE_HOME_1N');
  const h2 = _get(rates, 'RATE_HOME_2N');
  const m1 = _get(rates, 'RATE_MANILA_1N');
  const m2 = _get(rates, 'RATE_MANILA_2N');
  const t1 = _get(rates, 'RATE_THAI_1N');
  const t2 = _get(rates, 'RATE_THAI_2N');

  const p = (row, fallback = 0) => ((row?.price ?? fallback)).toLocaleString('th-TH') + '฿';

  const solo    = _get(rates, 'SURCHARGE_SOLO');
  const hol     = _get(rates, 'SURCHARGE_HOL');
  const ny      = _get(rates, 'SURCHARGE_NY');
  const dtSelf  = _get(rates, 'TRIP_SELF');
  const dtHH    = _get(rates, 'TRIP_HH');

  const soloPct  = solo?.price ?? 30;
  const soloMult = (1 + soloPct / 100).toFixed(1);
  const m1p      = m1?.price ?? 4400;
  const t1p      = t1?.price ?? 5400;
  const h1p      = h1?.price ?? 3900;
  const t2p      = t2?.price ?? 8200;
  const t1pFmt   = t1p.toLocaleString('th-TH');
  const t2pFmt   = t2p.toLocaleString('th-TH');
  const dtSelfP  = dtSelf?.price ?? 1700;
  const dtHHP    = dtHH?.price   ?? 2700;
  const dtChildP = Math.round(dtSelfP * 0.7);

  const actRows = [
    { id: 'ACT_SKINDIVING', label: 'Skindiving',    unitLabel: '' },
    { id: 'ACT_SAILING',    label: 'Sailing',        unitLabel: '/ลำ' },
    { id: 'ACT_TURTLE',     label: 'Turtle Nursing', unitLabel: '' },
    { id: 'ACT_OYSTER',     label: 'Oyster Hunting', unitLabel: '' },
  ];
  const actParts = actRows.map(a => {
    const row = _get(rates, a.id);
    return row ? `${a.label} ${row.price.toLocaleString('th-TH')}฿${a.unitLabel}` : null;
  }).filter(Boolean);

  const updatedDate = (loadedAt || '').substring(0, 10) || '—';

  return [
    `# ราคา Package (อัปเดตล่าสุด ${updatedDate} — ตอบได้เลย)`,
    `Package รวมทุกอย่าง: เรือไป-กลับ + ห้อง + อาหารทุกมื้อ + กิจกรรมพื้นฐาน`,
    ``,
    `**กฎคำนวณจำนวนคืน (สำคัญมาก — ห้ามผิด):**`,
    `- จำนวนคืน = วันเช็คเอาท์ − วันเช็คอิน`,
    `- ✅ เช็คอิน 8 พค เช็คเอาท์ 10 พค = 10−8 = **2 คืน** → แพคเกจ 3วัน2คืน`,
    `- ✅ เช็คอิน 8 พค เช็คเอาท์ 9 พค = 9−8 = **1 คืน** → แพคเกจ 2วัน1คืน`,
    `- ❌ ห้ามคิดว่า "8-10 = 2 วัน = 2วัน1คืน" — ผิด! 8-10 = 2 คืน = 3วัน2คืน`,
    `- **ถ้าลูกค้าบอกจำนวนคืนมาเองเช่น "2 คืน" → เชื่อลูกค้าทันที ห้ามแก้ไข ห้ามเถียง**`,
    ``,
    `เลือก package จากจำนวนคืน: **1 คืน → 2วัน1คืน | 2 คืน → 3วัน2คืน**`,
    ``,
    `ค้างคืน (ราคาต่อคน weekday):`,
    `- Home / Beach Chalet:   2วัน1คืน = ${p(h1)}  |  3วัน2คืน = ${p(h2)}`,
    `- Manila Deluxe Chalet:  2วัน1คืน = ${p(m1)}  |  3วัน2คืน = ${p(m2)}`,
    `- Thai Style Ocean Villa: 2วัน1คืน = ${p(t1)}  |  3วัน2คืน = ${p(t2)}`,
    ``,
    `**กฎแสดงราคา (สำคัญ):**`,
    `- ถ้าลูกค้าระบุจำนวนคืนแล้ว → บอกราคาเฉพาะ package นั้นเท่านั้น ห้ามบอกราคา package อื่นด้วย`,
    `- Format: "Thai Style: **${t2pFmt}฿/คน** (3วัน2คืน)" — ราคาต่อคน ชื่อ package ในวงเล็บ`,
    `- ❌ ห้ามเขียน "${t2pFmt}฿/2คืน (${t1pFmt}฿/คน)" — สับสน เพราะ ${t1pFmt} คือราคาอีก package`,
    `- ❌ ห้ามบอกราคา 2 package พร้อมกัน ถ้ารู้จำนวนคืนแล้ว`,
    ``,
    `ส่วนลด/Surcharge:`,
    `- เด็ก 3–10 ปี: -30% | เด็กต่ำกว่า 3 ปี: ฟรี | ผู้สูงอายุ 70+: -30%`,
    `- **พักเดี่ยว (1 คน/ห้อง): บวกเพิ่ม +${soloPct}% จากราคาต่อคน**`,
    `  ตัวอย่าง: Manila Deluxe พักเดี่ยว 2วัน1คืน = ${m1p.toLocaleString('th-TH')} × ${soloMult} = **${Math.round(m1p * (1 + soloPct / 100)).toLocaleString('th-TH')}฿**`,
    `  ตัวอย่าง: Thai Style พักเดี่ยว 2วัน1คืน = ${t1p.toLocaleString('th-TH')} × ${soloMult} = **${Math.round(t1p * (1 + soloPct / 100)).toLocaleString('th-TH')}฿**`,
    `  ตัวอย่าง: Beach Chalet พักเดี่ยว 2วัน1คืน = ${h1p.toLocaleString('th-TH')} × ${soloMult} = **${Math.round(h1p * (1 + soloPct / 100)).toLocaleString('th-TH')}฿**`,
    `- วันหยุดยาว: +${(hol?.price ?? 500).toLocaleString('th-TH')}฿/คน (จองขั้นต่ำ 2 คืน)`,
    `- ปีใหม่: +${(ny?.price ?? 1000).toLocaleString('th-TH')}฿/คน (รวมงานเลี้ยง)`,
    ``,
    `Day Trip: มาเองที่ท่าเรือ = ${dtSelfP.toLocaleString('th-TH')}฿/คน | เด็ก 4-10 ปี = ${dtChildP.toLocaleString('th-TH')}฿/คน | รวมรถรับจากหัวหิน = ${dtHHP.toLocaleString('th-TH')}฿/คน | กลุ่มใหญ่ติดต่อแอดมินสำหรับ package พิเศษครับ`,
    ``,
    `กิจกรรมเพิ่ม (จ่ายเพิ่ม): ${actParts.join(' | ')}`,
    ``,
    `**กิจกรรมฟรีในแพคเกจ** (ไม่ต้องจ่ายเพิ่ม):`,
    `- ดำน้ำตื้นพร้อมอุปกรณ์และเจ้าหน้าที่ดูแล`,
    `- พายคายัค / ซัฟบอร์ด (SUP) เล่นหน้าหาด`,
    `- เดินเที่ยว ขึ้นจุดชมวิวบนตัวเกาะ`,
    `- ล่องแพตกหมึกยามค่ำ`,
    `- ล่องเรือใบ **(เฉพาะพัก 2 คืนขึ้นไป)**`,
    `- คืนที่ 2: มีเซตปิ้งย่าง BBQ 1 ชุด/ห้อง`,
  ].join('\n');
}

// ─── Public: getPricingBlock ───────────────────────────────────────────────────
// Returns formatted pricing prompt block string, or null to signal "use hardcoded fallback".
// Reads PRICING_FROM_SHEET dynamically so tests can change process.env without module reload.
async function getPricingBlock({ sheets, sheetId, userId } = {}) {
  const useSheet = (process.env.PRICING_FROM_SHEET || 'false').toLowerCase() === 'true';
  if (!useSheet) return null;
  if (!sheets || !sheetId) return null;

  // TestMode gate: per spec §5 + §7 staged rollout
  // userId absent → admin/script context → proceed
  // TestMode OFF  → production, gate open for all users
  // TestMode ON   → only users in TestMode tab receive Sheet pricing; others get hardcode
  // gate uses checkTestModeGate (real impl); getFeatureFlag is a stub — do not use
  if (userId) {
    try {
      const { checkTestModeGate } = require('./test-mode');
      const gate = await checkTestModeGate(userId);
      if (!gate.allow) return null;
    } catch (err) {
      console.warn('[pricing] TestMode gate check failed — hardcode fallback:', err.message);
      return null;
    }
  }

  try {
    const data = await _loadFromSheet({ sheets, sheetId });
    return _formatPricingBlock(data.rates, data.loadedAt);
  } catch (err) {
    console.error('[pricing] INFO: Sheet unavailable — using hardcode for all pricing:', err.message);
    return null;
  }
}

// ─── Public: getPricingCacheStats ──────────────────────────────────────────────
function getPricingCacheStats() {
  return {
    pricingFromSheet:   (process.env.PRICING_FROM_SHEET || 'false').toLowerCase() === 'true',
    pricingCached:      !!_cache,
    pricingCacheAgeSec: _cache ? Math.round((Date.now() - _cacheAt) / 1000) : null,
    pricingSource:      _cache?.source || null,
  };
}

// ─── Public: invalidatePricingCache ───────────────────────────────────────────
// Called by POST /admin/refresh-pricing-cache — forces reload on next request.
function invalidatePricingCache() {
  _cache   = null;
  _cacheAt = 0;
  console.log('[pricing] Cache invalidated via admin endpoint');
}

module.exports = {
  getPricingBlock,
  getPricingCacheStats,
  invalidatePricingCache,
  HARDCODE_DEFAULTS,
  _parseRow, // exported for unit tests
};
