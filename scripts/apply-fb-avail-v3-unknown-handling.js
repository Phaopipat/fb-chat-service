// scripts/apply-fb-avail-v3-unknown-handling.js
// v3 — distinguish "all booked" from "data not loaded" (Drive read fail)
//
// Issue: result.totalAvailable === 0 happens BOTH when:
//   (a) all rooms genuinely booked (rare for ALL 12 rooms across diff dates)
//   (b) checker couldn't read Excel · all rooms = "unknown" · counts as 0
//
// Fix: check result.hasUnknown · if true · escalate (no Drive data) instead of "เต็ม"
// Also: log full result breakdown for diagnosis
//
// IDEMPOTENT: marker FB_AVAIL_V3_UNKNOWN
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'server.js');
const BAK = FILE + '.bak-v3-' + new Date().toISOString().replace(/[:.]/g, '-');
const DRY_RUN = process.argv.includes('--dry-run');

const MARKER = 'FB_AVAIL_V3_UNKNOWN';

// Edit 1: smarter formatter (distinguish all-booked vs data-unavailable)
const FMT_OLD = `function _formatAvailabilityReplyFB(parsed, result) {
  // FB_AVAIL_V2_SERVER_HOTFIX: use parsed.checkIn directly · reliable
  const { bays, totalAvailable } = result;
  const checkIn = parsed.checkIn;
  const checkOut = parsed.checkOut;
  const oneNight = (new Date(checkOut).getTime() - new Date(checkIn).getTime()) === 86_400_000;
  const dateStr = oneNight ? checkIn : \`\${checkIn} ถึง \${checkOut}\`;

  if (totalAvailable === 0) {
    return \`ช่วง \${dateStr} ห้องเต็มแล้วครับ 😔 ขอแอดมินช่วยเช็ควันอื่นใกล้เคียงให้ครับ 🙏\`;
  }`;

const FMT_NEW = `function _formatAvailabilityReplyFB(parsed, result) {
  // FB_AVAIL_V2_SERVER_HOTFIX + ${MARKER}: parsed dates + smart unknown handling
  const { bays, totalAvailable, hasUnknown } = result;
  const checkIn = parsed.checkIn;
  const checkOut = parsed.checkOut;
  const oneNight = (new Date(checkOut).getTime() - new Date(checkIn).getTime()) === 86_400_000;
  const dateStr = oneNight ? checkIn : \`\${checkIn} ถึง \${checkOut}\`;

  // ${MARKER}: if all rooms = unknown (Drive read fail) · escalate · don't say "เต็ม"
  const allUnknown = totalAvailable === 0 && hasUnknown &&
    Object.values(bays).every(b => (b.available?.length || 0) === 0 && (b.booked?.length || 0) === 0);
  if (allUnknown) {
    console.warn(\`[AVAIL-FB] hasUnknown=true · likely Drive read fail · dates=\${dateStr}\`);
    return \`ขอเช็คห้องว่างกับแอดมินช่วง \${dateStr} ก่อนนะครับ 🙏 รบกวนรอสักครู่ครับ\`;
  }

  if (totalAvailable === 0) {
    return \`ช่วง \${dateStr} ห้องเต็มแล้วครับ 😔 ขอแอดมินช่วยเช็ควันอื่นใกล้เคียงให้ครับ 🙏\`;
  }`;

// Edit 2: add diagnostic log after _checkBayAvailFB call
const LOG_OLD = `              console.log(\`[AVAIL-FB] intent=AVAILABILITY dates=\${_parsed.checkIn}..\${_parsed.checkOut} hint="\${_parsed.hint}"\`);
              const _auth = await getGoogleAuth();
              const _result = await _checkBayAvailFB(_auth, _parsed.checkIn, _parsed.checkOut);`;

const LOG_NEW = `              console.log(\`[AVAIL-FB] intent=\${_availIntent.intent} dates=\${_parsed.checkIn}..\${_parsed.checkOut} hint="\${_parsed.hint}"\`);
              const _auth = await getGoogleAuth();
              const _result = await _checkBayAvailFB(_auth, _parsed.checkIn, _parsed.checkOut);
              // ${MARKER}: log result breakdown for diagnosis
              console.log(\`[AVAIL-FB] result · totalAvailable=\${_result.totalAvailable} hasUnknown=\${_result.hasUnknown} bays=\${JSON.stringify(_result.bays).substring(0,200)}\`);`;

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
  if (!original.includes(LOG_OLD)) {
    console.error(`❌ Log anchor not found`);
    process.exit(1);
  }

  let patched = original.replace(FMT_OLD, FMT_NEW);
  patched = patched.replace(LOG_OLD, LOG_NEW);

  if (patched === original) {
    console.error(`❌ No change`);
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
    ['allunknown', 'allUnknown var'],
    ['hasunknown=true', 'Drive fail warning'],
    ['result · totalavailable', 'diagnostic log'],
  ];
  let pass = true;
  console.log(`\n🔍 Verifying:`);
  for (const [needle, label] of checks) {
    const ok = verify.includes(needle);
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) pass = false;
  }

  if (pass) {
    console.log(`\n🎉 v3 applied. Next:`);
    console.log(`   git add server.js scripts/apply-fb-avail-v3-unknown-handling.js`);
    console.log(`   git commit -m "fix(fb-avail-v3): escalate when Drive read fails · diagnostic log"`);
    console.log(`   git push`);
    console.log(``);
    console.log(`   After deploy · re-smoke 1 case from FB:`);
    console.log(`     📱 "30 มิ.ย. ห้องว่างมั้ย"`);
    console.log(`   Check Railway log for "[AVAIL-FB] result · totalAvailable=X hasUnknown=Y bays={...}"`);
    console.log(`   → If hasUnknown=true · Drive folder share not effective · need to verify SA email + folder access`);
  } else {
    console.error(`\n❌ Verification failed · restoring backup`);
    fs.copyFileSync(BAK, FILE);
    process.exit(1);
  }
}

main();
