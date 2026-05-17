/**
 * fb-chat-service image-lint.js · Stage 4 (v1.4.0)
 *
 * Anti-hallucination linter for image-related claims.
 * Strips phrases like "ส่งรูปให้แล้ว" / "ดูรูปด้านล่าง" when no images attached.
 *
 * Use after AI generates reply · if no images matched → lintReply(text, false)
 */

// Patterns that suggest bot has attached images (but might not have)
const FALSE_IMAGE_CLAIMS_TH = [
  /^[ \t]*ส่งรูปให้.*ครับ.*\n?/gim,
  /ส่งรูป.*ให้.*แล้ว/gi,
  /ดูรูปด้านล่าง/gi,
  /รูปด้านล่าง.*นะครับ/gi,
  /รูป.*แนบ.*ครับ/gi,
  /แนบรูป.*มา.*ครับ/gi,
  /นี่คือรูป/gi,
  /รูปที่ส่ง.*คือ/gi,
  /ตามรูป.*ครับ/gi,
  /ดูตามรูป/gi,
];

const FALSE_IMAGE_CLAIMS_EN = [
  /(here are|here is|attached).*(photo|picture|image)s?/gi,
  /(see|check).*(photo|image).*(below|above|attached)/gi,
  /sent.*(photo|picture).*you/gi,
  /photo[s]?\s+attached/gi,
];

/**
 * Strip false image claims · replace with escalate text if reply becomes too short
 *
 * @param {string} text       AI-generated reply
 * @param {boolean} hasImages true ถ้ามี images ส่งจริง · false ถ้าไม่มี
 * @returns {string}          cleaned text
 */
function lintReply(text, hasImages) {
  if (!text) return text;
  if (hasImages) return text; // bot did send images · keep claims

  let cleaned = text;
  for (const pattern of FALSE_IMAGE_CLAIMS_TH) {
    cleaned = cleaned.replace(pattern, "");
  }
  for (const pattern of FALSE_IMAGE_CLAIMS_EN) {
    cleaned = cleaned.replace(pattern, "");
  }

  // Collapse extra blank lines + trim
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  // If reply too short (<20 non-space chars) → use escalate text
  if (cleaned.replace(/\s+/g, "").length < 20) {
    const isEN = /^[a-zA-Z\s.,'"!?]+$/.test(text.slice(0, 50));
    cleaned = isEN
      ? "Let me get our admin to send you the photos 🙏"
      : "ขอเจ้าหน้าที่ส่งรูปให้นะครับ 🙏";
  }

  return cleaned;
}

/**
 * Check if reply contains any false image claim (without stripping)
 */
function hasFalseImageClaim(text) {
  if (!text) return false;
  for (const pattern of [...FALSE_IMAGE_CLAIMS_TH, ...FALSE_IMAGE_CLAIMS_EN]) {
    if (pattern.test(text)) return true;
  }
  return false;
}

module.exports = { lintReply, hasFalseImageClaim };
