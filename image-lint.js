/**
 * fb-chat-service image-lint.js · v1.4.1
 *
 * Changes from v1.4.0:
 *   - Added stripWhenImagesSent: removes "เจ้าหน้าที่จะส่งรูป" when bot ALREADY sent images
 *   - Behavior depends on hasImages flag (BOTH directions handled)
 */

// Patterns สำหรับ hasImages=false (bot ยังไม่ส่ง · strip false claims)
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

// Patterns สำหรับ hasImages=true (ระบบส่งรูปแล้ว · strip "admin will send" claims)
const ADMIN_WILL_SEND_TH = [
  // "ขอ/จะ + เจ้าหน้าที่/แอดมิน + (จะ) + ส่งรูป + ให้"
  /(?:ขอ|จะ)?\s*(?:เจ้าหน้าที่|แอดมิน|ทีม(?:งาน)?)\s*(?:จะ)?\s*ส่งรูป[^\n]*?(?:ให้)?[^\n]*?(?:ครับ|ค่ะ|🙏|\n|$)/gi,
  // "เดี๋ยว + เจ้าหน้าที่ + ส่งรูป"
  /เดี๋ยว\s*(?:เจ้าหน้าที่|แอดมิน|ทีม)[^\n]*?ส่งรูป[^\n]*?(?:ครับ|ค่ะ|🙏|\n|$)/gi,
  // "ขอเช็คกับ + เจ้าหน้าที่ + ส่งรูป"
  /ขอเช็คกับ[^\n]*?(?:เจ้าหน้าที่|แอดมิน)[^\n]*?ส่งรูป[^\n]*?(?:ครับ|ค่ะ|🙏|\n|$)/gi,
  // "ส่วนนี้/ส่วน + รูป + ขอเจ้าหน้าที่"
  /ส่วน[^\n]*?รูป[^\n]*?ขอ(?:เจ้าหน้าที่|แอดมิน)[^\n]*?(?:ครับ|ค่ะ|🙏|\n|$)/gi,
  // Day 9 PM Bug #17: "เรื่องรูป + ขอเช็ค + เจ้าหน้าที่/แอดมิน" (no ส่งรูป required · just prefix mentioning รูป)
  /เรื่อง(?:รูป|ภาพ)[^\n]*?ขอเช็ค[^\n]*?(?:เจ้าหน้าที่|แอดมิน|ทีม)[^\n]*?(?:🙏|ครับ|ค่ะ|\n|$)/gi,
  // Orphan "เดี๋ยว 🙏" left after strip
  /^\s*[—\-·]?\s*เดี๋ยว\s*🙏\s*$/gim,
  // "เรื่องรูป...ขอแอดมิน + ช่วย/ส่ง"
  /เรื่อง(?:รูป|ภาพ)[^\n]*?ขอ(?:แอดมิน|เจ้าหน้าที่)[^\n]*?(?:ช่วย|ส่ง|ช่วยส่ง)[^\n]*?(?:🙏|ครับ|ค่ะ|\n|$)/gi,
];

const ADMIN_WILL_SEND_EN = [
  /(let|i'll let|let me).*(admin|team|staff).*(send|share).*(photo|picture|image)/gi,
  /admin.*will.*send.*photo/gi,
];

/**
 * Lint reply based on whether bot actually sent images.
 *
 * @param {string} text       AI-generated reply
 * @param {boolean} hasImages true ถ้ามี images ส่งจริง · false ถ้าไม่มี
 * @returns {string}          cleaned text
 */
function lintReply(text, hasImages) {
  if (!text) return text;
  let cleaned = text;

  if (hasImages) {
    // v1.4.1: ระบบส่งรูปแล้ว · ลบ "เจ้าหน้าที่จะส่งรูป" ที่ confusing
    for (const pattern of ADMIN_WILL_SEND_TH) {
      cleaned = cleaned.replace(pattern, "");
    }
    for (const pattern of ADMIN_WILL_SEND_EN) {
      cleaned = cleaned.replace(pattern, "");
    }
  } else {
    // hasImages=false: ลบ false claims ว่าส่งรูปแล้ว
    for (const pattern of FALSE_IMAGE_CLAIMS_TH) {
      cleaned = cleaned.replace(pattern, "");
    }
    for (const pattern of FALSE_IMAGE_CLAIMS_EN) {
      cleaned = cleaned.replace(pattern, "");
    }
  }

  // Collapse extra blank lines + trim
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  // Collapse multiple consecutive spaces (residue from stripping)
  cleaned = cleaned.replace(/[ \t]{2,}/g, " ");
  // Clean leading dash/punctuation if at start
  cleaned = cleaned.replace(/^[—\-·:]\s*/gm, "");

  // If reply too short → use appropriate fallback
  if (cleaned.replace(/\s+/g, "").length < 15) {
    const isEN = /^[a-zA-Z\s.,'"!?]+$/.test(text.slice(0, 50));
    if (hasImages) {
      cleaned = isEN ? "Hope these photos help! 😊" : "ตามรูปด้านบนเลยครับ 😊";
    } else {
      cleaned = isEN
        ? "Let me get our admin to send you the photos 🙏"
        : "ขอเจ้าหน้าที่ส่งรูปให้นะครับ 🙏";
    }
  }

  return cleaned;
}

/**
 * Check if reply contains any false image claim (when no images sent)
 */
function hasFalseImageClaim(text) {
  if (!text) return false;
  for (const pattern of [...FALSE_IMAGE_CLAIMS_TH, ...FALSE_IMAGE_CLAIMS_EN]) {
    if (pattern.test(text)) return true;
  }
  return false;
}

module.exports = { lintReply, hasFalseImageClaim };
