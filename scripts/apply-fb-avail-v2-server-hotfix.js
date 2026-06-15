// scripts/apply-fb-avail-v2-server-hotfix.js
// Hotfix for v2 patcher · server.js edits only (parser already done)
// Combines edits 1 (formatter) + 2 (trigger widen) · no chain dependency
//
// IDEMPOTENT: marker FB_AVAIL_V2_SERVER_HOTFIX
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'server.js');
const BAK = FILE + '.bak-v2-hotfix-' + new Date().toISOString().replace(/[:.]/g, '-');
const DRY_RUN = process.argv.includes('--dry-run');

const MARKER = 'FB_AVAIL_V2_SERVER_HOTFIX';

// Edit 1: formatter uses parsed.checkIn directly
const FMT_OLD = `function _formatAvailabilityReplyFB(parsed, result) {
  const { checkIn, checkOut, bays, totalAvailable } = result;
  const dateStr = checkIn === checkOut || (new Date(checkOut) - new Date(checkIn)) === 86_400_000
    ? checkIn
    : \`\${checkIn} ถึง \${checkOut}\`;`;

const FMT_NEW = `function _formatAvailabilityReplyFB(parsed, result) {
  // ${MARKER}: use parsed.checkIn directly · reliable
  const { bays, totalAvailable } = result;
  const checkIn = parsed.checkIn;
  const checkOut = parsed.checkOut;
  const oneNight = (new Date(checkOut).getTime() - new Date(checkIn).getTime()) === 86_400_000;
  const dateStr = oneNight ? checkIn : \`\${checkIn} ถึง \${checkOut}\`;`;

// Edit 2: combine trigger widen + parse reuse into single block
const TRIGGER_OLD = `    // ── FB_AVAILABILITY_WIRED — availability check before AI gen ──
    if (process.env.AVAILABILITY_CHECK_ENABLED !== 'false' && messageType === 'text') {
      try {
        const _availIntent = _classifyIntentShadowFB(text, _leadProfileFB);
        if (_availIntent.intent === 'AVAILABILITY') {
          const _parsed = _parseThaiDateRangeFB(text);
          if (_parsed) {`;

const TRIGGER_NEW = `    // ── FB_AVAILABILITY_WIRED + ${MARKER} — availability check before AI gen ──
    if (process.env.AVAILABILITY_CHECK_ENABLED !== 'false' && messageType === 'text') {
      try {
        const _availIntent = _classifyIntentShadowFB(text, _leadProfileFB);
        // ${MARKER}: widen trigger — fire on explicit AVAILABILITY OR (date + booking verb) OR (date + FREE_FORM)
        const _hasBookingVerb = /พัก|ค้าง|จอง|อยาก(?:ไป|มา|พัก)?|ไปเที่ยว|มาเที่ยว|stay|book/i.test(text);
        const _parsedProbe = _parseThaiDateRangeFB(text);
        const _shouldCheckAvail = _availIntent.intent === 'AVAILABILITY' ||
          (_parsedProbe && (_hasBookingVerb || (_availIntent.intent === 'FREE_FORM' && /\\d/.test(text))));
        if (_shouldCheckAvail) {
          const _parsed = _parsedProbe || _parseThaiDateRangeFB(text);
          if (_parsed) {`;

function main() {
  const original = fs.readFileSync(FILE, 'utf8');
  console.log(`📖 Read ${FILE} (${original.length} bytes)`);

  if (original.includes(MARKER)) {
    console.log(`⏭️  ${MARKER} already present · NO-OP`);
    process.exit(0);
  }

  if (!original.includes(FMT_OLD)) {
    console.error(`❌ Formatter anchor not found`);
    process.exit(1);
  }
  if (!original.includes(TRIGGER_OLD)) {
    console.error(`❌ Trigger anchor not found`);
    process.exit(1);
  }

  let patched = original.replace(FMT_OLD, FMT_NEW);
  patched = patched.replace(TRIGGER_OLD, TRIGGER_NEW);

  if (patched === original) {
    console.error(`❌ No change after replace`);
    process.exit(1);
  }

  console.log(`\n📐 Patch ready · adds ${patched.length - original.length} bytes`);

  if (DRY_RUN) {
    console.log(`\n💡 Dry run.`);
    process.exit(0);
  }

  fs.writeFileSync(BAK, original);
  console.log(`💾 Backup: ${BAK}`);
  fs.writeFileSync(FILE, patched);
  console.log(`✍️  Wrote ${FILE}`);

  const verify = fs.readFileSync(FILE, 'utf8').toLowerCase();
  const checks = [
    [MARKER.toLowerCase(), 'marker'],
    ['parsed.checkin', 'parsed.checkIn used'],
    ['_hasbookingverb', 'booking verb detect'],
    ['_parsedprobe', 'parse probe'],
    ['_shouldcheckavail', 'should-check var'],
  ];
  let pass = true;
  console.log(`\n🔍 Verifying:`);
  for (const [needle, label] of checks) {
    const ok = verify.includes(needle);
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) pass = false;
  }

  if (pass) {
    console.log(`\n🎉 Server hotfix applied. Next:`);
    console.log(`   git add server.js scripts/apply-fb-avail-v2-server-hotfix.js`);
    console.log(`   git commit -m "fix(fb-avail-v2-server): formatter + trigger widen"`);
    console.log(`   git push`);
  } else {
    console.error(`\n❌ Verification failed · restoring backup`);
    fs.copyFileSync(BAK, FILE);
    process.exit(1);
  }
}

main();
