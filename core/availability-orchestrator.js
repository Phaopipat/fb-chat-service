'use strict';
// availability-orchestrator.js · The single deterministic decision-maker for
// availability / price / booking-with-date (see availability-ownership-contract.md).
//
// PHASE: SHADOW (decide-and-log). It computes WHAT the deterministic path would do
// for a message, so the wire can log it next to the live reply and we can verify on
// real traffic BEFORE promoting it to actually emit. It does NOT compose the final
// customer text yet and has NO customer impact until WU6.
//
// Composes only existing capabilities (no new business logic, no god-object):
//   - room-resolver  → which room type / bay (+ cross-turn carry, ask-which-bay)
//   - stay-date       → canonical checkIn/checkOut/nights
//   - availability-checker → Sheet truth (injected as checkAvailability for testability)
//
// Decision actions:
//   ask_bay     nickname (บ้านปูน/บ้านไทย) without a bay → must ask which bay
//   full        room type + date known, that type has NO room free → would say "เต็ม"
//   available   room type + date known, at least one free → safe to quote
//   need_date   room type known, no parseable date → ask for date
//   need_room   date known, no room type → ask which room
//   passthrough neither → not an availability turn; LLM/other paths handle it
//   error       availability lookup failed → standby/admin

const { SELECTED_ROOMS, isTypeMatch } = require('./availability-checker');
const { parseStay } = require('./stay-date');
const roomResolver = require('./room-resolver');

// codes in the availability result that match the requested type (incl. 'home' set)
function availableCodesOfType(baysResult, roomType) {
  const out = [];
  const bays = (baysResult && baysResult.bays) || {};
  for (const bay of Object.values(bays)) {
    for (const code of (bay.available || [])) {
      const info = SELECTED_ROOMS[code];
      if (info && isTypeMatch(info.type, roomType)) out.push(code);
    }
  }
  return out;
}

/**
 * @param {object} a
 * @param {string} a.msgText
 * @param {string} [a.userId]
 * @param {(checkIn:string, checkOut:string)=>Promise<{totalAvailable:number,bays:object,error?:string}>} a.checkAvailability
 * @param {string} [a.todayIso]
 * @param {number} [a.now]
 * @returns {Promise<{action:string, roomType:?string, askBay?:string, stay:?object, availableCount?:number, totalAvailable?:number, reason?:string}>}
 */
async function decideAvailability({ msgText, userId, checkAvailability, todayIso, now = Date.now() }) {
  const { type: roomType, askBay } = roomResolver.resolveRoomTypeForAvailabilityTurn(userId, msgText, now);
  const stay = parseStay(msgText, todayIso);

  if (askBay) return { action: 'ask_bay', askBay, roomType: null, stay: stay || null };

  if (roomType && stay) {
    let result;
    try {
      result = await checkAvailability(stay.checkIn, stay.checkOut);
    } catch (err) {
      return { action: 'error', roomType, stay, reason: err && err.message ? err.message : 'lookup_threw' };
    }
    if (!result || result.error) {
      return { action: 'error', roomType, stay, reason: (result && result.error) || 'no_result' };
    }
    const codes = availableCodesOfType(result, roomType);
    return {
      action: codes.length ? 'available' : 'full',
      roomType,
      stay,
      availableCount: codes.length,
      totalAvailable: result.totalAvailable,
      primaryResult: result, // raw bays result, so the gate can compose via formatV100bReply
    };
  }

  if (roomType && !stay) return { action: 'need_date', roomType, stay: null };
  if (!roomType && stay) return { action: 'need_room', roomType: null, stay };
  return { action: 'passthrough', roomType: null, stay: null };
}

// One-line summary for shadow logs (compare vs the live reply mode).
function formatShadowLine(decision, liveMode) {
  const d = decision || {};
  const date = d.stay ? `${d.stay.checkIn}->${d.stay.checkOut}(${d.stay.nights}n)` : '-';
  return `[orch-shadow] action=${d.action} room=${d.roomType || '-'} date=${date}`
    + (d.action === 'full' || d.action === 'available' ? ` availOfType=${d.availableCount} totalAvail=${d.totalAvailable}` : '')
    + (d.askBay ? ` askBay=${d.askBay}` : '')
    + (d.reason ? ` reason=${d.reason}` : '')
    + ` | live=${liveMode || '?'}`;
}

module.exports = { decideAvailability, availableCodesOfType, formatShadowLine };
