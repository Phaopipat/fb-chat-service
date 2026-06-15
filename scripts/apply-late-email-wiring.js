'use strict';

/**
 * scripts/apply-late-email-wiring.js
 *
 * Idempotent patcher that wires late-email-handler into FB server.js.
 *
 * Inserts:
 *   - require: const { tryLateEmailCapture } = require("./late-email-handler");
 *   - In handleMessagingEvent: AFTER isCollecting block, BEFORE slip-image block
 *     a text-only check that calls tryLateEmailCapture, and on handled:true
 *     sends replyText via sendAndLog + return.
 *
 * Marker: FB_LATE_EMAIL_WIRED
 *
 * Usage: node scripts/apply-late-email-wiring.js
 *        node scripts/apply-late-email-wiring.js --dry-run
 */

const fs = require('fs');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const MARKER = 'FB_LATE_EMAIL_WIRED';
const DRY = process.argv.includes('--dry-run');

function read() {
  return fs.readFileSync(SERVER_PATH, 'utf8');
}

function write(content) {
  if (DRY) {
    console.log('[dry-run] would write', SERVER_PATH);
    return;
  }
  const backup = `${SERVER_PATH}.bak-late-email-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(SERVER_PATH, backup);
  fs.writeFileSync(SERVER_PATH, content);
  console.log('✅ wrote', SERVER_PATH);
  console.log('   backup:', backup);
}

function main() {
  let src = read();

  if (src.includes(MARKER)) {
    console.log(`ℹ️  ${MARKER} already present — skipping`);
    return;
  }

  const changes = [];

  // ─── 1. Add require ───
  if (!/require\(["']\.\/late-email-handler["']\)/.test(src)) {
    // Insert after observability require (or fall back to ai-reply require)
    const anchor =
      'const observability = require("./observability");  // FB_OBSERVABILITY_WIRED';
    const fallbackAnchor = 'const { generateReply } = require("./ai-reply");';

    const newReq =
      'const { tryLateEmailCapture } = require("./late-email-handler");  // ' + MARKER;

    if (src.includes(anchor)) {
      src = src.replace(anchor, anchor + '\n' + newReq);
      changes.push('added require("./late-email-handler") after observability');
    } else if (src.includes(fallbackAnchor)) {
      src = src.replace(fallbackAnchor, fallbackAnchor + '\n' + newReq);
      changes.push('added require("./late-email-handler") after ai-reply');
    } else {
      throw new Error('Could not find anchor for require — bailing');
    }
  }

  // ─── 2. Wire call between isCollecting block and slip-image block ───
  // The exact tail of the isCollecting block is the line:
  //   }  ← closing the outer `if (isCollecting(senderId))` block
  // followed (one blank line later) by the slip comment:
  //   // ─── Stage 5: Slip verification (image attachments · NOT in collector) ──
  //
  // We anchor on the comment and insert ABOVE it.
  const slipAnchor =
    '  // ─── Stage 5: Slip verification (image attachments · NOT in collector) ──';

  const wiringBlock =
    '  // ─── ' + MARKER + ' — late-arrival email capture (text-only) ─────────\n' +
    '  if (messageType === "text" && text) {\n' +
    '    try {\n' +
    '      const lateRes = await tryLateEmailCapture({\n' +
    '        senderId,\n' +
    '        msgText: text,\n' +
    '        auth,\n' +
    '        sheetId: GOOGLE_SHEET_ID,\n' +
    '      });\n' +
    '      if (lateRes?.handled && lateRes.replyText) {\n' +
    '        await sendAndLog(\n' +
    '          senderId,\n' +
    '          lateRes.replyText,\n' +
    '          JSON.stringify({ topic: "bot:late_email_capture", bookingRef: lateRes.bookingRef || "" })\n' +
    '        );\n' +
    '        console.log(`[late-email] handled · psid=${senderId} email=${lateRes.email || ""}`);\n' +
    '        return;\n' +
    '      }\n' +
    '    } catch (err) {\n' +
    '      console.warn("[late-email] error (non-blocking):", err.message);\n' +
    '    }\n' +
    '  }\n' +
    '\n';

  if (src.includes(slipAnchor)) {
    if (!src.includes('tryLateEmailCapture({')) {
      src = src.replace(slipAnchor, wiringBlock + slipAnchor);
      changes.push('wired tryLateEmailCapture before slip-image block');
    }
  } else {
    throw new Error('Could not find slip-verification anchor — bailing');
  }

  if (changes.length === 0) {
    console.log(`ℹ️  No changes needed`);
    return;
  }

  console.log('Changes:');
  changes.forEach((c) => console.log('  - ' + c));

  write(src);
  console.log(`\nMarker "${MARKER}" appears ${(src.match(new RegExp(MARKER, 'g')) || []).length}x in server.js`);
}

main();
