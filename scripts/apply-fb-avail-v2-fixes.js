// scripts/apply-fb-avail-v2-fixes.js
// Availability v2 — 3 fixes from production smoke 2026-06-15:
//   Q1: display date bug — use parsed.checkIn directly (not result.checkIn)
//   Q2: widen trigger — also fire when date parseable + booking verb (no "ว่างมั้ย" required)
//   Q3: relative date support — "พรุ่งนี้" "มะรืนนี้" "วันนี้"
//
// 2 file changes · 4 edits:
//   fb-date-parser.js · add relative date patterns
//   server.js · widen trigger + use parsed dates in formatter
//
// IDEMPOTENT: marker FB_AVAIL_V2_FIXED
'use strict';

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const MARKER = 'FB_AVAIL_V2_FIXED';

const PARSER_FILE = path.join(__dirname, '..', 'fb-date-parser.js');
const SERVER_FILE = path.join(__dirname, '..', 'server.js');

// ─── fb-date-parser.js · add relative date patterns ───────────────────────
const PARSER_OLD = `function parseThaiDateRange(text) {
  if (!text) return null;
  const t = String(text);

  // Build month regex alternation (longest first)
  const monthAlt = MONTH_ALTS.map(escapeRe).join('|');`;

const PARSER_NEW = `// ${MARKER}: relative date helper (พรุ่งนี้/วันนี้/มะรืนนี้)
function _parseRelativeDate(text) {
  const t = String(text);
  const today = todayBKK();
  // วันนี้ — risky (same-day booking) but parse · let validator decide
  if (/วันนี้|today/i.test(t)) {
    const iso = \`\${today.getUTCFullYear()}-\${pad(today.getUTCMonth() + 1)}-\${pad(today.getUTCDate())}\`;
    return { checkIn: iso, checkOut: addDay(iso), hint: 'relative: วันนี้' };
  }
  if (/พรุ่งนี้|tomorrow/i.test(t)) {
    const iso = \`\${today.getUTCFullYear()}-\${pad(today.getUTCMonth() + 1)}-\${pad(today.getUTCDate())}\`;
    const next = addDay(iso);
    return { checkIn: next, checkOut: addDay(next), hint: 'relative: พรุ่งนี้' };
  }
  if (/มะรืน(?:นี้)?|day after tomorrow/i.test(t)) {
    const iso = \`\${today.getUTCFullYear()}-\${pad(today.getUTCMonth() + 1)}-\${pad(today.getUTCDate())}\`;
    const day2 = addDay(addDay(iso));
    return { checkIn: day2, checkOut: addDay(day2), hint: 'relative: มะรืน' };
  }
  return null;
}

function parseThaiDateRange(text) {
  if (!text) return null;
  const t = String(text);

  // ${MARKER}: check relative dates FIRST (พรุ่งนี้/วันนี้/มะรืน)
  const rel = _parseRelativeDate(t);
  if (rel) return rel;

  // Build month regex alternation (longest first)
  const monthAlt = MONTH_ALTS.map(escapeRe).join('|');`;

// ─── server.js · widen trigger + use parsed dates in formatter ──────────────
// Edit 1: formatter uses parsed.checkIn directly (fix display bug)
const SRV_FMT_OLD = `function _formatAvailabilityReplyFB(parsed, result) {
  const { checkIn, checkOut, bays, totalAvailable } = result;
  const dateStr = checkIn === checkOut || (new Date(checkOut) - new Date(checkIn)) === 86_400_000
    ? checkIn
    : \`\${checkIn} ถึง \${checkOut}\`;`;

const SRV_FMT_NEW = `function _formatAvailabilityReplyFB(parsed, result) {
  // ${MARKER}: use parsed.checkIn directly · most reliable (no Date math bugs)
  const { bays, totalAvailable } = result;
  const checkIn = parsed.checkIn;
  const checkOut = parsed.checkOut;
  const oneNight = (new Date(checkOut).getTime() - new Date(checkIn).getTime()) === 86_400_000;
  const dateStr = oneNight ? checkIn : \`\${checkIn} ถึง \${checkOut}\`;`;

// Edit 2: widen trigger — fire when date parseable + booking verb (or AVAILABILITY intent)
const SRV_TRIGGER_OLD = `    // ── FB_AVAILABILITY_WIRED — availability check before AI gen ──
    if (process.env.AVAILABILITY_CHECK_ENABLED !== 'false' && messageType === 'text') {
      try {
        const _availIntent = _classifyIntentShadowFB(text, _leadProfileFB);
        if (_availIntent.intent === 'AVAILABILITY') {`;

const SRV_TRIGGER_NEW = `    // ── FB_AVAILABILITY_WIRED + ${MARKER} — availability check before AI gen ──
    if (process.env.AVAILABILITY_CHECK_ENABLED !== 'false' && messageType === 'text') {
      try {
        const _availIntent = _classifyIntentShadowFB(text, _leadProfileFB);
        // ${MARKER}: widen trigger — fire on explicit AVAILABILITY intent OR
        // when date parseable + booking-related verb (มาพัก/จอง/อยาก/ค้าง)
        const _hasBookingVerb = /พัก|ค้าง|จอง|อยาก(?:ไป|มา|พัก)?|ไปเที่ยว|มาเที่ยว|stay|book/i.test(text);
        const _parsedProbe = _parseThaiDateRangeFB(text);
        const _shouldCheckAvail = _availIntent.intent === 'AVAILABILITY' ||
          (_parsedProbe && (_hasBookingVerb || _availIntent.intent === 'FREE_FORM' && /\\d/.test(text)));
        if (_shouldCheckAvail) {`;

// Edit 3: change inner block to use already-parsed result (avoid double parse)
const SRV_PARSE_OLD = `        if (_shouldCheckAvail) {
          const _parsed = _parseThaiDateRangeFB(text);
          if (_parsed) {`;

const SRV_PARSE_NEW = `        if (_shouldCheckAvail) {
          const _parsed = _parsedProbe || _parseThaiDateRangeFB(text);  // ${MARKER}: reuse probe
          if (_parsed) {`;

function applyToFile(file, edits, label) {
  const original = fs.readFileSync(file, 'utf8');
  console.log(`📖 ${label}: ${file} (${original.length} bytes)`);

  if (original.includes(MARKER)) {
    console.log(`⏭️  ${MARKER} already in ${label} · NO-OP`);
    return { skip: true };
  }

  // Check all anchors
  for (const [old, , name] of edits) {
    if (!original.includes(old)) {
      console.error(`❌ ${label} anchor "${name}" not found`);
      return { error: true };
    }
  }

  let patched = original;
  for (const [old, neu] of edits) {
    patched = patched.replace(old, neu);
  }

  if (patched === original) {
    console.error(`❌ ${label} no change after replace`);
    return { error: true };
  }

  console.log(`   added ${patched.length - original.length} bytes · ${edits.length} edits`);

  if (DRY_RUN) return { patched: null, dry: true };

  const bak = file + '.bak-v2-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(bak, original);
  fs.writeFileSync(file, patched);
  console.log(`💾 ${label} backup: ${bak}`);
  console.log(`✍️  ${label} wrote`);
  return { patched };
}

function main() {
  console.log(`📐 FB Availability v2 fixes${DRY_RUN ? ' · DRY RUN' : ''}\n`);

  const parserResult = applyToFile(PARSER_FILE, [
    [PARSER_OLD, PARSER_NEW, 'parser anchor'],
  ], 'fb-date-parser.js');

  if (parserResult.error) process.exit(1);

  const serverResult = applyToFile(SERVER_FILE, [
    [SRV_FMT_OLD, SRV_FMT_NEW, 'formatter anchor'],
    [SRV_TRIGGER_OLD, SRV_TRIGGER_NEW, 'trigger anchor'],
    [SRV_PARSE_OLD, SRV_PARSE_NEW, 'parse-reuse anchor'],
  ], 'server.js');

  if (serverResult.error) process.exit(1);

  if (DRY_RUN) {
    console.log(`\n💡 Dry run · re-run without --dry-run to apply`);
    process.exit(0);
  }

  // Verify
  const srvVerify = fs.readFileSync(SERVER_FILE, 'utf8').toLowerCase();
  const parserVerify = fs.readFileSync(PARSER_FILE, 'utf8').toLowerCase();
  const checks = [
    [srvVerify.includes(MARKER.toLowerCase()), 'server.js marker'],
    [srvVerify.includes('_hasbookingverb'), 'booking verb detect'],
    [srvVerify.includes('parsedprobe'), 'parsed probe reuse'],
    [srvVerify.includes('parsed.checkin'), 'parsed.checkIn used'],
    [parserVerify.includes(MARKER.toLowerCase()), 'parser marker'],
    [parserVerify.includes('_parserelativedate'), 'relative date helper'],
    [parserVerify.includes('พรุ่งนี้'), 'tomorrow keyword'],
  ];
  let pass = true;
  console.log(`\n🔍 Verifying:`);
  for (const [ok, label] of checks) {
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) pass = false;
  }

  if (pass) {
    console.log(`\n🎉 Availability v2 fixes applied. Next:`);
    console.log(`   git add fb-date-parser.js server.js scripts/apply-fb-avail-v2-fixes.js`);
    console.log(`   git commit -m "fix(fb-avail-v2): display checkIn · widen trigger · relative dates"`);
    console.log(`   git push  # Railway deploy ~2 min`);
    console.log(``);
    console.log(`   Smoke 4 cases:`);
    console.log(`     📱 "30 มิ.ย. ห้องว่างมั้ย"  → "ช่วง 2026-06-30..."  (Q1 fix)`);
    console.log(`     📱 "มาพัก 15-17 ก.ค."      → availability fires (Q2 widen)`);
    console.log(`     📱 "พรุ่งนี้ห้องว่างมั้ย"      → availability with tomorrow date (Q3 relative)`);
    console.log(`     📱 "30 มิ.ย."              → date-only · no booking verb · should fire (FREE_FORM + date)`);
  } else {
    console.error(`\n❌ Verification failed`);
    process.exit(1);
  }
}

main();
