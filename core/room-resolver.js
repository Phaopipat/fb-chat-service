'use strict';
// room-resolver.js · Room/Bay resolver capability (Availability/Booking).
//
// Single canonical owner of "which room type / bay is the customer asking about",
// including bay-dependent nicknames (บ้านปูน/บ้านไทย/เรือนไทย) and cross-turn carry.
// Ported byte-for-byte from ai-reply.js (commits b2744fc + 0d088fe + 85500f8 +
// 15f07d2) — ZERO behaviour change. Only dependency is the room registry
// (SELECTED_ROOMS) from the availability capability.
//
// Canonical room-type vocabulary (= SELECTED_ROOMS .type):
//   manila_deluxe · honeymoon · thai_family · thai_single · thai_studio ·
//   beach_chalet · home (umbrella, อ่าวมุก non-beach) · biggest · two_story · four_br
//
// Bay-dependent nickname rule (material × bay):
//   บ้านปูน(concrete): อ่าวใหญ่→manila_deluxe · อ่าวมุก→beach_chalet
//   บ้านไทย/เรือนไทย(wood): อ่าวใหญ่→thai_single · อ่าวมุก→home
//   no bay → askBay ('concrete' | 'wood') → caller asks which bay (never guess)

const { SELECTED_ROOMS } = require('./availability-checker');

// ── cross-turn carry state (same 10-min TTL as conversationHistory) ──
const _lastRoomTypeByUser = new Map(); // userId -> { type, expireAt }
const _pendingBayByUser = new Map();   // userId -> { nickname:'concrete'|'wood', expireAt }
const _ROOM_CARRY_TTL_MS = 10 * 60 * 1000;

function detectBay(msgText) {
  if (!msgText || typeof msgText !== 'string') return null;
  if (/อ่าว\s*มุก|pearl\s*bay/i.test(msgText)) return 'อ่าวมุก';
  if (/อ่าว\s*ใหญ่|big\s*bay/i.test(msgText)) return 'อ่าวใหญ่';
  return null;
}

function detectRequestedRoomType(msgText) {
  if (!msgText || typeof msgText !== 'string') return null;
  if (/manila|มะนิลา|deluxe|ดีลักซ์|เดอลุกซ์/i.test(msgText)) return 'manila_deluxe';
  if (/honeymoon|ฮันนีมูน|hm\s*ocean|ocean\s*front\s*honey/i.test(msgText)) return 'honeymoon';
  if (/thai\s*family|family\s*villa|เรือนไทย.*แฟมิลี่/i.test(msgText)) return 'thai_family';
  if (/thai\s*style.*studio|studio.*thai|สตูดิโอ.*ไทย/i.test(msgText)) return 'thai_studio';
  if (/thai\s*style|ไทย\s*สไตล์/i.test(msgText)) return 'thai_single';
  if (/studio|สตูดิโอ/i.test(msgText)) return 'thai_studio';
  if (/beach\s*chalet|บีช.*ชาเลต์|บีชชาเล|ชาเลต์.*หาด/i.test(msgText)) return 'beach_chalet';
  if (/home\s*chalet|\bhome\b/i.test(msgText)) return 'home';
  if (/biggest|ห้องใหญ่ที่สุด/i.test(msgText)) return 'biggest';
  if (/2[\s-]?story|2[\s-]?ชั้น|two[\s-]?story|สองชั้น/i.test(msgText)) return 'two_story';
  if (/4\s*bedroom|4\s*br|4\s*ห้องนอน/i.test(msgText)) return 'four_br';
  const codeMatch = msgText.match(/\b([DTRdtr])(\d{1,2})\b/);
  if (codeMatch) {
    const code = codeMatch[1].toUpperCase() + codeMatch[2];
    if (SELECTED_ROOMS[code]) return SELECTED_ROOMS[code].type;
  }
  return null;
}

// Single-turn resolve. Returns { type, askBay? }.
function resolveRoomType(msgText) {
  if (!msgText || typeof msgText !== 'string') return { type: null };
  const direct = detectRequestedRoomType(msgText);
  const bay = detectBay(msgText);
  if (direct) return { type: direct };

  const t = String(msgText || '');
  const wantsConcreteHome = /บ้านปูน/.test(t);
  const wantsThaiHome = /บ้านไทย|เรือนไทย/.test(t);

  if (wantsConcreteHome || wantsThaiHome) {
    if (!bay) return { type: null, askBay: wantsConcreteHome ? 'concrete' : 'wood' };
    if (wantsConcreteHome) {
      return { type: bay === 'อ่าวมุก' ? 'beach_chalet' : 'manila_deluxe' };
    }
    return { type: bay === 'อ่าวมุก' ? 'home' : 'thai_single' };
  }

  return { type: null };
}

// Availability-turn resolve with cross-turn carry. Call once per availability turn.
//   (A) continuation: a prior turn asked which bay, this turn supplies one
//   (B) carry-forward: fresh current-turn type wins + refresh; null falls back to remembered
function resolveRoomTypeForAvailabilityTurn(userId, msgText, now = Date.now()) {
  let { type: requestedRoomType, askBay } = resolveRoomType(msgText);
  const bay = detectBay(msgText);

  if (!requestedRoomType && !askBay && userId && bay) {
    const pend = _pendingBayByUser.get(userId);
    if (pend && now < pend.expireAt) {
      requestedRoomType = pend.nickname === 'concrete'
        ? (bay === 'อ่าวมุก' ? 'beach_chalet' : 'manila_deluxe')
        : (bay === 'อ่าวมุก' ? 'home' : 'thai_single');
      _pendingBayByUser.delete(userId);
    }
  }

  if (userId) {
    if (requestedRoomType) {
      _lastRoomTypeByUser.set(userId, { type: requestedRoomType, expireAt: now + _ROOM_CARRY_TTL_MS });
      _pendingBayByUser.delete(userId);
    } else if (askBay) {
      _pendingBayByUser.set(userId, { nickname: askBay, expireAt: now + _ROOM_CARRY_TTL_MS });
    } else {
      const prev = _lastRoomTypeByUser.get(userId);
      if (prev && now < prev.expireAt) requestedRoomType = prev.type;
    }
  }

  return { type: requestedRoomType || null, askBay };
}

// Clear per-user carry (ai-reply clearHistory(userId) must call this after wiring).
function clearCarry(userId) {
  _lastRoomTypeByUser.delete(userId);
  _pendingBayByUser.delete(userId);
}

module.exports = {
  detectBay,
  detectRequestedRoomType,
  resolveRoomType,
  resolveRoomTypeForAvailabilityTurn,
  clearCarry,
  _ROOM_CARRY_TTL_MS,
};
