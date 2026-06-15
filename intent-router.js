// intent-router.js · Step 3 v0.1 (2026-06-15)
//
// Classifies inbound message into 7 intent classes.
// Phase A.1: PURE FUNCTION · no handlers wired · no side effects.
// Phase A.3 will wire this in SHADOW MODE (log only) into server.js.
//
// Intent classes:
//   ESCALATE         → V41 routing (agent/inhouse/voucher/onshore)
//   KB_FAQ           → KB direct hit (incl. refund/cancel KB-20260615-005)
//   SLOT_FILLING     → bare slot answer (date/pax/room name)
//   BOOKING_CONFIRM  → customer commits ("จองเลย", "โอนแล้ว")
//   PRICE_CALC       → complete price request (room + nights + pax)
//   AVAILABILITY     → availability check request
//   FREE_FORM        → LLM fallback (current default for everything)
//
// Decision shape:
//   {
//     intent: 'KB_FAQ',
//     sub: 'refund',                  // optional subtype
//     handler: 'kbDirect',            // handler name (Phase A.2 will implement)
//     reason: 'matched isRefundCancel + KB-005 hit',
//     evidence: {                      // for shadow logging analysis
//       matchedPatterns: ['refund'],
//       kbId: 'KB-20260615-005',
//     },
//     confidence: 0.95,                // 0..1
//   }
'use strict';

// ─── V41 trigger detectors (pure regex) ────────────────────────────────────

// R1 · AGENT (B2B / tour operator)
const AGENT_RE = /\b(agent|agency|tour\s?operator|contract\s?rate|B2B|wholesale|broker|be\s?my\s?guest)\b|ตัวแทน|นำเที่ยว|รับนำเที่ยว|ทัวร์ส่ง|ขอ\s?contract|คุณเน็ต/i;

function isAgent(text) {
  return AGENT_RE.test(text || '');
}

// R2 · IN-HOUSE GUEST (already at resort)
// Strong: room# + ขอเพิ่ม/ปัญหา · Medium: explicit presence markers
const ROOM_NUMBER_RE = /\b(T(?:1[0-8]|[1-9])|D(?:1[0-8]|[1-9])|R(?:1[0-8]|2[0-9]|3[0-4]|10|12|13|15|22|23|26|27)|BC[1-3])\b/i;
const IN_HOUSE_PRESENCE_RE = /พักอยู่(?:ตอนนี้)?|เช็คอินแล้ว|อยู่(?:ที่)?ห้อง|บนเกาะตอนนี้|ตอนนี้อยู่ที่|on\s?the\s?island\s?now|already\s?(?:at|in)\s?(?:the\s?)?(?:resort|room)/i;
const IN_HOUSE_AMENITY_RE = /ผ้าเช็ดตัว|ผ้าห่ม.*(?:เพิ่ม|extra)|extra.*(?:towel|blanket|pillow)|ขอ.*(?:หมอน|น้ำ.*เพิ่ม)|แอร์.*(?:เสีย|ไม่|พัง)|ไฟ.*(?:ดับ|ไม่)|น้ำ.*ไม่.*(?:ไหล|มี)|ทีวี.*เสีย|generator.*off|hairdryer/i;

function isInHouse(text) {
  const t = text || '';
  if (IN_HOUSE_PRESENCE_RE.test(t)) return true;
  // Strong combo: room# + amenity/problem
  if (ROOM_NUMBER_RE.test(t) && IN_HOUSE_AMENITY_RE.test(t)) return true;
  return false;
}

// R3 · VOUCHER / Online Agent
const VOUCHER_RE = /\b(agoda|booking\.com|expedia|klook|kkday|voucher|barter|barter\s?connect|gift\s?card|redeem|OTA|online\s?agent)\b|วอเชอร์|แลก.*(?:คูปอง|รหัส)|จองผ่าน(?:เว็บ|ออนไลน์|agoda|booking)/i;

function isVoucher(text) {
  return VOUCHER_RE.test(text || '');
}

// R4 · ON-SHORE (mainland property disambig)
// Thai transliterations + EN: "ออนชอร์" / "บ้านมะพร้าว" / "ฝั่งแผ่นดิน"
const ONSHORE_RE = /\b(on\s?shore|onshore|on-shore|baan\s?maprow)\b|ออนชอร์|on\s?shore|ฝั่งแผ่นดิน|บ้านมะพร้าว|พักก่อนข้ามเกาะ/i;

function isOnShore(text) {
  return ONSHORE_RE.test(text || '');
}

// R5 · REFUND / CANCEL (V41.2 cancel context · routes to KB-20260615-005)
const REFUND_CANCEL_RE = /refund|ขอ\s?refund|คืนเงิน|ยกเลิก(?:การจอง|จอง)?|cancel(?:lation|led)?|เลื่อน(?:วัน|จอง|booking)?|reschedule|postpone/i;

function isRefundCancel(text) {
  return REFUND_CANCEL_RE.test(text || '');
}

// ─── SLOT_FILLING detection ───────────────────────────────────────────────

// Bare slot answers: only the slot value, very short message
const SLOT_PAX_RE = /^\s*\d+\s*(?:คน|ท่าน|adults?|ผู้ใหญ่)\s*$/i;
const SLOT_DATE_RE = /^\s*\d{1,2}\s*[-–\s\/]+\s*\d{1,2}\s*(?:ม\.?ค\.?|ก\.?พ\.?|มี\.?ค\.?|เม\.?ย\.?|พ\.?ค\.?|มิ\.?ย\.?|ก\.?ค\.?|ส\.?ค\.?|ก\.?ย\.?|ต\.?ค\.?|พ\.?ย\.?|ธ\.?ค\.?)\s*\d{0,4}\s*$/i;
const SLOT_BAY_RE = /^\s*(?:อ่าวมุก|อ่าวใหญ่|pearl\s?bay|big\s?bay)\s*$/i;
const SLOT_ROOMTYPE_RE = /^\s*(?:Thai\s?Style|Manila(?:\s?Deluxe)?|Home(?:\s?Chalet)?|Beach\s?Chalet|Honeymoon|มะลิลา|ไทยสไตล์|บีชชาเล|เรือนไทย)\s*$/i;

function isSlotFillingOnly(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length > 30) return false; // bare slots are short
  return SLOT_PAX_RE.test(t) || SLOT_DATE_RE.test(t) || SLOT_BAY_RE.test(t) || SLOT_ROOMTYPE_RE.test(t);
}

// ─── BOOKING_CONFIRM detection ────────────────────────────────────────────

const BOOKING_COMMIT_RE = /^(จองเลย|จองครับ|โอนแล้ว|โอนเรียบร้อย|จอง\s?นะ|ok\s?(?:ครับ|ค่ะ)?\s?จอง|ทำ(?:ลิ้?ง?ค์)?(?:บัตร|ตัดบัตร)|ตัดบัตร|ใช้บัตร|รูดบัตร)/i;

function isBookingCommit(text) {
  return BOOKING_COMMIT_RE.test((text || '').trim());
}

// ─── PRICE_CALC detection (complete slots) ────────────────────────────────

// Customer mentions room + (nights or dates) + pax in one message
const PRICE_REQUEST_KEYWORDS_RE = /ราคา|เท่าไหร่|กี่บาท|how\s?much|price|cost/i;
const ROOM_NAME_RE = /(?:Thai\s?Style|Manila|Home(?:\s?Chalet)?|Beach\s?Chalet|มะลิลา|ไทยสไตล์|บีชชาเล|เรือนไทย)/i;
const NIGHTS_RE = /(\d+)\s*(?:วัน|คืน|night|day)/i;
const PAX_RE = /(\d+)\s*(?:คน|ท่าน|adults?|ผู้ใหญ่)/i;

function hasCompletePriceSlots(text) {
  if (!text) return false;
  const hasKeyword = PRICE_REQUEST_KEYWORDS_RE.test(text);
  const hasRoom = ROOM_NAME_RE.test(text);
  const hasNights = NIGHTS_RE.test(text);
  const hasPax = PAX_RE.test(text);
  // Need keyword + room + (nights OR pax)
  return hasKeyword && hasRoom && (hasNights || hasPax);
}

// ─── AVAILABILITY detection ───────────────────────────────────────────────

// Reuse from ai-reply.js if available · here we duplicate to keep module pure
const AVAILABILITY_RE = /ว่างมั้?ย|ห้องว่าง|มีห้องว่าง|ยังว่าง|จองได้มั้?ย|available|availability|book(?:ing)?\s?(?:available|open)/i;

function isAvailabilityRequest(text) {
  return AVAILABILITY_RE.test(text || '');
}

// ─── MAIN ROUTER ──────────────────────────────────────────────────────────

/**
 * Classify message into intent class.
 *
 * @param {string} msgText
 * @param {object} profile        - LeadProfile (may be empty/null)
 * @param {object} [opts]
 * @param {function} [opts.kbLookup]  - optional KB lookup function (sync return or null)
 * @returns {object}              - IntentDecision (see header)
 */
function classifyIntent(msgText, profile, opts = {}) {
  const text = String(msgText || '').trim();
  if (!text) {
    return { intent: 'FREE_FORM', handler: 'noop', reason: 'empty', confidence: 1.0, evidence: {} };
  }

  // ─── HIGH-PRECEDENCE: V41 ESCALATE triggers ─────────────────────────────
  if (isAgent(text)) {
    return {
      intent: 'ESCALATE', sub: 'agent', handler: 'agentIntake',
      reason: 'matched AGENT_RE',
      confidence: 0.95,
      evidence: { pattern: 'AGENT_RE' },
    };
  }
  if (isInHouse(text)) {
    return {
      intent: 'ESCALATE', sub: 'inhouse', handler: 'frontDeskRoute',
      reason: 'matched in-house presence or room#+amenity',
      confidence: 0.90,
      evidence: { hasRoomNum: ROOM_NUMBER_RE.test(text), hasPresence: IN_HOUSE_PRESENCE_RE.test(text), hasAmenity: IN_HOUSE_AMENITY_RE.test(text) },
    };
  }
  if (isVoucher(text)) {
    return {
      intent: 'ESCALATE', sub: 'voucher', handler: 'voucherExplain',
      reason: 'matched VOUCHER_RE',
      confidence: 0.90,
      evidence: { pattern: 'VOUCHER_RE' },
    };
  }
  if (isOnShore(text)) {
    return {
      intent: 'ESCALATE', sub: 'onshore', handler: 'onshoreDisambig',
      reason: 'matched ONSHORE_RE',
      confidence: 0.95,
      evidence: { pattern: 'ONSHORE_RE' },
    };
  }

  // ─── REFUND/CANCEL: route to KB_FAQ via KB-005 ──────────────────────────
  if (isRefundCancel(text)) {
    return {
      intent: 'KB_FAQ', sub: 'cancellation', handler: 'kbDirect',
      reason: 'matched REFUND_CANCEL_RE',
      confidence: 0.90,
      evidence: { kbId: 'KB-20260615-005', pattern: 'REFUND_CANCEL_RE' },
    };
  }

  // ─── SLOT_FILLING (bare answer) ─────────────────────────────────────────
  if (isSlotFillingOnly(text)) {
    return {
      intent: 'SLOT_FILLING', handler: 'slotFillAck',
      reason: 'bare slot answer',
      confidence: 0.85,
      evidence: { length: text.length, hasProfile: !!profile },
    };
  }

  // ─── BOOKING_CONFIRM ────────────────────────────────────────────────────
  if (isBookingCommit(text)) {
    return {
      intent: 'BOOKING_CONFIRM', handler: 'confirmTemplate',
      reason: 'matched BOOKING_COMMIT_RE',
      confidence: 0.85,
      evidence: { pattern: 'BOOKING_COMMIT_RE' },
    };
  }

  // ─── PRICE_CALC (complete slots) ────────────────────────────────────────
  if (hasCompletePriceSlots(text)) {
    return {
      intent: 'PRICE_CALC', handler: 'computePrice',
      reason: 'complete price request (room + nights/pax)',
      confidence: 0.80,
      evidence: {
        hasRoom: ROOM_NAME_RE.test(text),
        hasNights: NIGHTS_RE.test(text),
        hasPax: PAX_RE.test(text),
      },
    };
  }

  // ─── AVAILABILITY ───────────────────────────────────────────────────────
  if (isAvailabilityRequest(text)) {
    return {
      intent: 'AVAILABILITY', handler: 'availabilityCheck',
      reason: 'matched AVAILABILITY_RE',
      confidence: 0.85,
      evidence: { pattern: 'AVAILABILITY_RE' },
    };
  }

  // ─── KB_FAQ (high-confidence direct mode) ───────────────────────────────
  if (typeof opts.kbLookup === 'function') {
    const hit = opts.kbLookup(text);
    if (hit && hit.confidence >= 0.85 && hit.kb_mode === 'direct') {
      return {
        intent: 'KB_FAQ', sub: hit.category || 'general', handler: 'kbDirect',
        reason: 'KB direct hit · confidence ' + hit.confidence,
        confidence: hit.confidence,
        evidence: { kbId: hit.id, kbMode: hit.kb_mode, category: hit.category },
      };
    }
  }

  // ─── FREE_FORM fallback (LLM gen with LEAD CONTEXT) ─────────────────────
  return {
    intent: 'FREE_FORM', handler: 'llmGenerate',
    reason: 'no specialized intent matched',
    confidence: 0.60,
    evidence: {},
  };
}

module.exports = {
  classifyIntent,
  // Export detectors for unit testing
  isAgent,
  isInHouse,
  isVoucher,
  isOnShore,
  isRefundCancel,
  isSlotFillingOnly,
  isBookingCommit,
  hasCompletePriceSlots,
  isAvailabilityRequest,
};
