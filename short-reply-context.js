'use strict';
// FB_SHORT_REPLY_PORTED · 2026-06-15

const ACTION = 'shadow_only';

const ACK_RE = /^(ได้|ได้ค่ะ|ได้ครับ|โอเค|โอเคค่ะ|ok|okay|เอา|เอาเลย|ตามนั้น|ตกลง|จ้า+|ค่ะ|คะ|ครับ|คับ|อืม|อ๋อ|รับทราบ|เข้าใจแล้วค่ะ|ขอบคุณ)$/i;
const CORRECTION_RE = /(ไม่ใช่|ผิด|ไม่เอา|ไม่ถูก|ขอแก้|แก้ก่อน)/i;
const TOOL_OR_KB_RE = /(ขอ\s*รูป|ขอดุ\s*ภาพ|ดู\s*รูป|เอา\s*รูป|รูป(?:ห้อง|ที่พัก|ดำน้ำ)?|ราคา|มีกี่ราคา|เท่าไหร่|กี่บาท|day\s*trip|วันเดย์ทริป|สอนดำน้ำ|ไฟฟ้า|อาหารเช้า)/i;
const SELECT_RE = /^(?:อัน|ตัว|แบบ)?(?:แรก|ที่หนึ่ง|หนึ่ง|1|สอง|ที่สอง|2|นั้น|นี้)$/i;
const PAX_RE = /^\s*(\d{1,2})\s*(?:คน|ท่าน|pax|guests?)?\s*$/i;
const NIGHTS_RE = /^\s*(\d{1,2})\s*(?:คืน|night|nights)\s*$/i;
const DATE_RE = /^\s*\d{1,2}\s*(?:[-–/.)]\s*\d{1,2})?(?:\s*(?:ม\.?ค|ก\.?พ|มี\.?ค|เม\.?ย|พ\.?ค|มิ\.?ย|ก\.?ค|ส\.?ค|ก\.?ย|ต\.?ค|พ\.?ย|ธ\.?ค|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|เดือน)?)?(?:\s*[-–]\s*\d{1,2})?/i;

const SLOT_PATTERNS = [
  { slot: 'pax', re: /กี่(?:คน|ท่าน)|จำนวน(?:คน|ท่าน)|มากี่คน|how many (?:people|pax|guests)/i },
  { slot: 'date', re: /วันไหน|วันที่|เดินทางวัน|เช็คอิน|ช่วงวันที่|เมื่อไหร่|which date|what date/i },
  { slot: 'nights', re: /กี่คืน|พักกี่คืน|how many nights/i },
  { slot: 'room', re: /ห้องไหน|ห้องแบบไหน|สนใจห้อง|เลือกห้อง|room type|which room/i },
  { slot: 'yes_no', re: /ต้องการ|ให้.*เช็ค|เช็ค.*ไหม|เอาไหม|ได้ไหม|สนใจไหม|confirm|shall i|would you like/i },
];

const OPTION_NAMES = [
  'Thai Style Family',
  'Thai Style Studio',
  'Thai Style Single',
  'Thai Style',
  'Manila Deluxe',
  'Beach Chalet',
  'Home Chalet',
  'Honeymoon',
  'Ocean Front',
  'อ่าวใหญ่',
  'อ่าวมุก',
  'วิวทะเล',
];

function baseResult(overrides = {}) {
  return {
    isShort: false,
    type: 'unknown',
    expectedSlot: null,
    value: null,
    confidence: 0,
    action: ACTION,
    ...overrides,
  };
}

function normalize(text) {
  return String(text || '').trim();
}

function tokenCount(text) {
  return normalize(text).split(/\s+/).filter(Boolean).length;
}

function isShortReplyText(text) {
  const t = normalize(text);
  if (!t) return false;
  if (t.length <= 18) return true;
  if (tokenCount(t) <= 3) return true;
  if (PAX_RE.test(t) || DATE_RE.test(t) || SELECT_RE.test(t)) return true;
  if (ACK_RE.test(t.toLowerCase().replace(/[ๆ.!~]/g, ''))) return true;
  return false;
}

function detectExpectedSlot(lastBotReply) {
  const text = normalize(lastBotReply);
  for (const item of SLOT_PATTERNS) {
    if (item.re.test(text)) return item.slot;
  }
  return null;
}

function detectOptions(lastBotReply) {
  const text = normalize(lastBotReply);
  return OPTION_NAMES.filter(name => new RegExp(escapeRegExp(name), 'i').test(text));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseSlotValue(text, slot) {
  const t = normalize(text);
  if (slot === 'pax') {
    const m = t.match(PAX_RE);
    return m ? Number(m[1]) : t;
  }
  if (slot === 'nights') {
    const m = t.match(NIGHTS_RE);
    return m ? Number(m[1]) : t;
  }
  if (slot === 'yes_no') {
    if (/^(ได้|ได้ค่ะ|ได้ครับ|โอเค|ok|okay|เอา|เอาเลย|ตามนั้น|ตกลง|yes|y)$/i.test(t)) return 'yes';
    if (/^(ไม่|ไม่ค่ะ|ไม่ครับ|ไม่เอา|no|n)$/i.test(t)) return 'no';
  }
  return t || null;
}

function classifyOptionSelection(userMsg, options) {
  const t = normalize(userMsg);
  const lower = t.toLowerCase();
  if (!options.length) return null;
  if (/^(?:อัน|ตัว|แบบ)?(?:แรก|ที่หนึ่ง|หนึ่ง|1)$/i.test(t)) return options[0];
  if (/^(?:อัน|ตัว|แบบ)?(?:สอง|ที่สอง|2)$/i.test(t)) return options[1] || null;
  return options.find(opt => lower.includes(opt.toLowerCase())) || null;
}

function classifyShortReply({ userMsg, lastBotReply, leadProfile, history } = {}) {
  void leadProfile;
  void history;

  const text = normalize(userMsg);
  const isShort = isShortReplyText(text);
  if (!isShort) return baseResult({ isShort, confidence: 0.1 });

  if (CORRECTION_RE.test(text)) {
    return baseResult({ isShort, type: 'correction', confidence: 0.9 });
  }

  if (TOOL_OR_KB_RE.test(text)) {
    return baseResult({ isShort, type: 'tool_or_kb_intent', confidence: 0.85 });
  }

  const expectedSlot = detectExpectedSlot(lastBotReply);
  if (expectedSlot) {
    return baseResult({
      isShort,
      type: 'slot_answer',
      expectedSlot,
      value: parseSlotValue(text, expectedSlot),
      confidence: expectedSlot === 'yes_no' ? 0.78 : 0.82,
    });
  }

  if (ACK_RE.test(text.toLowerCase().replace(/[ๆ.!~]/g, ''))) {
    return baseResult({ isShort, type: 'backchannel', confidence: 0.75 });
  }

  const options = detectOptions(lastBotReply);
  const selected = classifyOptionSelection(text, options);
  if (selected) {
    return baseResult({
      isShort,
      type: 'option_selection',
      expectedSlot: 'room',
      value: selected,
      confidence: 0.84,
    });
  }

  return baseResult({ isShort, confidence: 0.3 });
}

module.exports = {
  classifyShortReply,
  _isShortReplyText: isShortReplyText,
  _detectExpectedSlot: detectExpectedSlot,
};
