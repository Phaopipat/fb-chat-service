// scripts/apply-fb-avail-v6-fallthrough.js
// v6 — when checker returns empty/unknown, FALL THROUGH to generateReply
// instead of sending escalate template · match LINE bot's graceful UX
//
// LINE bot uses Claude tool calling to drive conversation:
//   - Asks clarifying questions (nights, pax, bay)
//   - Direct Drive check happens later when enough info
//
// FB v5 was rigid: empty result → escalate template ("ขอเช็คให้ก่อน")
// v6: empty result → skip direct send, let generateReply handle conversationally
//
// IDEMPOTENT: marker FB_AVAIL_V6_FALLTHROUGH
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'server.js');
const BAK = FILE + '.bak-v6-' + new Date().toISOString().replace(/[:.]/g, '-');
const DRY_RUN = process.argv.includes('--dry-run');
const MARKER = 'FB_AVAIL_V6_FALLTHROUGH';

const OLD = `  // FB_AVAIL_V3_UNKNOWN + FB_AVAIL_V4_RELAXED: relaxed — any (totalAvailable=0 && hasUnknown) → uncertain · escalate
  // Excel parsing can mis-detect rooms (gray cells, admin markings) · safer to escalate than lie "เต็ม"
  if (totalAvailable === 0 && hasUnknown) {
    console.warn(\`[AVAIL-FB] uncertain · totalAvailable=0 + hasUnknown=true · escalate · dates=\${dateStr}\`);
    return \`ขอเช็คห้องว่างกับแอดมินช่วง \${dateStr} ก่อนนะครับ 🙏 รบกวนรอสักครู่ครับ\`;
  }`;

const NEW = `  // ${MARKER}: when Drive read returns 0/unknown, return null → caller falls through to generateReply
  // This matches LINE bot's graceful AI-driven conversation (asks nights/pax/bay clarification)
  if (totalAvailable === 0 && hasUnknown) {
    console.warn(\`[AVAIL-FB] uncertain · totalAvailable=0 + hasUnknown=true · fall through to AI · dates=\${dateStr}\`);
    return null;  // signal caller to skip direct send + use generateReply instead
  }`;

// Also need to update the caller to handle null return
const CALLER_OLD = `              const _availReply = _formatAvailabilityReplyFB(_parsed, _result);
              await sendAndLog(senderId, _availReply);
              return;  // skip generateReply`;

const CALLER_NEW = `              const _availReply = _formatAvailabilityReplyFB(_parsed, _result);
              if (_availReply) {
                await sendAndLog(senderId, _availReply);
                return;  // skip generateReply
              }
              // ${MARKER}: null from formatter → fall through to generateReply for AI conversation
              console.log('[AVAIL-FB] formatter returned null · fall through to AI gen');`;

function main() {
  const original = fs.readFileSync(FILE, 'utf8');
  console.log(`📖 Read ${FILE} (${original.length} bytes)`);

  if (original.includes(MARKER)) {
    console.log(`⏭️  ${MARKER} already present · NO-OP`);
    process.exit(0);
  }

  if (!original.includes(OLD)) {
    console.error(`❌ Formatter anchor not found`);
    process.exit(1);
  }
  if (!original.includes(CALLER_OLD)) {
    console.error(`❌ Caller anchor not found`);
    process.exit(1);
  }

  let patched = original.replace(OLD, NEW);
  patched = patched.replace(CALLER_OLD, CALLER_NEW);

  console.log(`\n📐 Patch ready · adds ${patched.length - original.length} bytes`);

  if (DRY_RUN) { console.log(`\n💡 Dry run.`); process.exit(0); }

  fs.writeFileSync(BAK, original);
  console.log(`💾 Backup: ${BAK}`);
  fs.writeFileSync(FILE, patched);
  console.log(`✍️  Wrote ${FILE}`);

  const verify = fs.readFileSync(FILE, 'utf8');
  const checks = [
    [verify.includes(MARKER), 'marker'],
    [verify.includes('fall through to AI'), 'fall-through log'],
    [verify.includes('return null'), 'null return'],
    [verify.includes('if (_availReply)'), 'caller null check'],
  ];
  let pass = true;
  console.log(`\n🔍 Verifying:`);
  for (const [ok, label] of checks) {
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) pass = false;
  }

  if (pass) {
    console.log(`\n🎉 v6 applied. Next:`);
    console.log(`   git add server.js scripts/apply-fb-avail-v6-fallthrough.js`);
    console.log(`   git commit -m "fix(fb-avail-v6): fall through to AI conversation on Drive fail · match LINE UX"`);
    console.log(`   git push`);
    console.log(``);
    console.log(`   Smoke: "30 มิ.ย. ห้องว่างมั้ย"`);
    console.log(`   Expect: AI conversational reply asking nights/pax (like LINE)`);
  } else {
    console.error(`\n❌ Verification failed · restoring`);
    fs.copyFileSync(BAK, FILE);
    process.exit(1);
  }
}

main();
