// image-lint.js · Phase 2.5B Plan D — Anti-hallucination linter for reply text
//
// Purpose: Guard against LLM (Claude Haiku) hallucinating image promises in text
// replies when no actual imageMessage is being attached.
//
// Failure modes blocked (from judge calibration cases CAL-022 / CAL-035 / CAL-044):
//   • LLM types "ส่งรูปให้แล้วครับ" but reply has only text bubble (no image)
//   • LLM types "ดูรูปด้านล่าง" without attached images
//   • LLM types "นี่คือรูปห้อง" without attached images
//   • LLM types "แนบรูปมาแล้ว" without attached images
//   • EN equivalents: "Here's the photo", "see the attached image"
//
// Wiring (per ai-reply.js integration):
//   const { lintReplyText } = require('./image-lint');
//   const finalText = generatedText;
//   const lintResult = lintReplyText(finalText, /* hasImages */ false);
//   if (!lintResult.clean) {
//     console.warn(`[image-lint] blocked: ${lintResult.reason} pattern=${lintResult.matchedPattern}`);
//     return lintResult.suggestedRewrite;
//   }
//   return finalText;
//
// Modes that should pass `hasImages=true` (because they DO attach images):
//   - decision.mode === 'image_request' (matchImages returned URLs)
//   - decision.mode where ai-reply appends image bubble from detectRoomImage()
// All other modes (kb_answer, tool_then_ai, ai, standby, menu_followup) should
// pass `hasImages=false` since they emit text-only replies.
//
// Safety properties:
//   - Pure function (no I/O, no external deps)
//   - Idempotent
//   - Conservative — only flags very explicit promise patterns to minimize false-positives
//   - Returns helpful suggestedRewrite that follows brand voice + Q8.1 (no staff names)
'use strict';

// ─── Hallucination patterns ──────────────────────────────────────────────────
// Each regex matches a phrase that asserts "an image is being delivered NOW".
// Thai patterns intentionally avoid matching benign phrases like:
//   "ขอดูรูปนะครับ"     (question, not claim)
//   "มีรูปไหมครับ"       (question)
//   "เดี๋ยวส่งรูปให้นะ"  (future tense — admin coming)
//
// Patterns target the assertive present/perfect tense only.
const HALLUCINATION_PATTERNS = [
  // Thai: "ส่งรูป...ให้แล้ว/เรียบร้อย/ครับ" — claim of completed image delivery
  /ส่ง(?:รูป|ภาพ)(?:ห้อง[ก-ฮ\sA-Za-z0-9]*)?(?:ให้)?(?:แล้ว|เรียบร้อย)/i,
  // Thai: "ดูรูป/ภาพด้านล่าง"
  /ดู(?:รูป|ภาพ)(?:ด้านล่าง|ข้างล่าง|ตามนี้|ตามรูป|ตามภาพ)/i,
  // Thai: "นี่คือ/นี้คือรูป" — "here is the photo"
  /(?:^|\s|ครับ\s|คับ\s)(?:นี่|นี้)(?:คือ)?(?:รูป|ภาพ)/i,
  // Thai: "แนบรูป/ภาพ...มา/ให้แล้ว"
  /แนบ(?:รูป|ภาพ)(?:มา)?(?:แล้ว|ให้)/i,
  // English: "Here's/Here is the photo", "attached is the picture"
  /\bhere(?:'s|\s+is|\s+are)\s+(?:the|a|some|your)?\s*(?:photo|picture|image|pic)s?\b/i,
  /\battached\s+(?:is|are|here|herewith)?\s*(?:the|a|some)?\s*(?:photo|picture|image|pic)s?\b/i,
  // English: "see the attached", "see below image"
  /\bsee\s+(?:the\s+)?(?:attached|below|above)\s+(?:photo|picture|image|pic)s?\b/i,
];

// ─── Safe rewrite text (Thai + EN aware) ─────────────────────────────────────
// Q8.1: use "เจ้าหน้าที่" — no personal staff names
const REWRITE_TH = 'ขอเช็คกับเจ้าหน้าที่ก่อนนะครับ — เดี๋ยวเจ้าหน้าที่ส่งรูปให้เลย 🥰';
const REWRITE_EN = 'Let me check with the team — they\'ll send the photos to you shortly! 🙏';

// Detect if reply looks like an English reply (>60% Latin ratio, excluding Thai chars)
// Mirrors language detection logic in ai-reply.js (Rule 9 in system prompt)
function looksEnglish(text) {
  if (!text) return false;
  const latinCount = (text.match(/[A-Za-z]/g) || []).length;
  const thaiCount = (text.match(/[ก-ฮ]/g) || []).length;
  if (latinCount + thaiCount === 0) return false;
  return latinCount / (latinCount + thaiCount) > 0.6;
}

// ─── Main API ────────────────────────────────────────────────────────────────
/**
 * Check reply text for hallucinated image promises.
 *
 * @param {string} text - The generated reply text to validate.
 * @param {boolean} hasImages - Whether the LINE reply will include imageMessages.
 *                              If true, image-promise phrases are honest and allowed.
 *                              If false (most modes), they must be blocked.
 * @returns {{clean: boolean, reason: string|null, matchedPattern: string|null, suggestedRewrite: string|null}}
 */
function lintReplyText(text, hasImages) {
  if (!text || typeof text !== 'string') {
    return { clean: true, reason: null, matchedPattern: null, suggestedRewrite: null };
  }
  // When images ARE actually attached, image-promise text is honest — allow it.
  if (hasImages) {
    return { clean: true, reason: null, matchedPattern: null, suggestedRewrite: null };
  }

  for (const re of HALLUCINATION_PATTERNS) {
    const match = re.exec(text);
    if (match) {
      const isEN = looksEnglish(text);
      return {
        clean: false,
        reason: 'hallucinated_image_promise',
        matchedPattern: re.toString(),
        matchedText: match[0],
        suggestedRewrite: isEN ? REWRITE_EN : REWRITE_TH,
      };
    }
  }
  return { clean: true, reason: null, matchedPattern: null, suggestedRewrite: null };
}

module.exports = {
  lintReplyText,
  // exported for tests + observability
  HALLUCINATION_PATTERNS,
  REWRITE_TH,
  REWRITE_EN,
  looksEnglish,
};
