// scripts/apply-fb-avail-v4-relaxed-unknown.js
// v4 — relaxed unknown detection · just check (totalAvailable===0 && hasUnknown)
// Also: log per-bay breakdown to diagnose Excel parsing
//
// IDEMPOTENT: marker FB_AVAIL_V4_RELAXED
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'server.js');
const BAK = FILE + '.bak-v4-' + new Date().toISOString().replace(/[:.]/g, '-');
const DRY_RUN = process.argv.includes('--dry-run');
const MARKER = 'FB_AVAIL_V4_RELAXED';

// Edit 1: simplify allUnknown to relaxed condition
const FMT_OLD = `  // FB_AVAIL_V3_UNKNOWN: if all rooms = unknown (Drive read fail) · escalate · don't say "เต็ม"
  const allUnknown = totalAvailable === 0 && hasUnknown &&
    Object.values(bays).every(b => (b.available?.length || 0) === 0 && (b.booked?.length || 0) === 0);
  if (allUnknown) {
    console.warn(\`[AVAIL-FB] hasUnknown=true · likely Drive read fail · dates=\${dateStr}\`);
    return \`ขอเช็คห้องว่างกับแอดมินช่วง \${dateStr} ก่อนนะครับ 🙏 รบกวนรอสักครู่ครับ\`;
  }`;

const FMT_NEW = `  // FB_AVAIL_V3_UNKNOWN + ${MARKER}: relaxed — any (totalAvailable=0 && hasUnknown) → uncertain · escalate
  // Excel parsing can mis-detect rooms (gray cells, admin markings) · safer to escalate than lie "เต็ม"
  if (totalAvailable === 0 && hasUnknown) {
    console.warn(\`[AVAIL-FB] uncertain · totalAvailable=0 + hasUnknown=true · escalate · dates=\${dateStr}\`);
    return \`ขอเช็คห้องว่างกับแอดมินช่วง \${dateStr} ก่อนนะครับ 🙏 รบกวนรอสักครู่ครับ\`;
  }`;

// Edit 2: more detailed diagnostic log per bay
const LOG_OLD = `              // FB_AVAIL_V3_UNKNOWN: log result breakdown for diagnosis
              console.log(\`[AVAIL-FB] result · totalAvailable=\${_result.totalAvailable} hasUnknown=\${_result.hasUnknown} bays=\${JSON.stringify(_result.bays).substring(0,200)}\`);`;

const LOG_NEW = `              // ${MARKER}: detailed per-bay log for Excel parsing diagnosis
              const _bayDebug = Object.fromEntries(Object.entries(_result.bays || {}).map(([k, v]) => [k, {
                a: (v.available || []).length, b: (v.booked || []).length, u: (v.unknown || []).length,
                ids: { a: (v.available || []).slice(0,3), b: (v.booked || []).slice(0,3), u: (v.unknown || []).slice(0,3) },
              }]));
              console.log(\`[AVAIL-FB] result · totalAvailable=\${_result.totalAvailable} hasUnknown=\${_result.hasUnknown}\`);
              console.log(\`[AVAIL-FB] bays detail: \${JSON.stringify(_bayDebug)}\`);`;

function main() {
  const original = fs.readFileSync(FILE, 'utf8');
  console.log(`📖 Read ${FILE} (${original.length} bytes)`);

  if (original.includes(MARKER)) {
    console.log(`⏭️  ${MARKER} already present · NO-OP`);
    process.exit(0);
  }

  if (!original.includes(FMT_OLD)) {
    console.error(`❌ Formatter v3 anchor not found · is v3 deployed?`);
    process.exit(1);
  }
  if (!original.includes(LOG_OLD)) {
    console.error(`❌ Log v3 anchor not found · is v3 deployed?`);
    process.exit(1);
  }

  let patched = original.replace(FMT_OLD, FMT_NEW);
  patched = patched.replace(LOG_OLD, LOG_NEW);

  if (patched === original) {
    console.error(`❌ No change`);
    process.exit(1);
  }

  console.log(`\n📐 Patch ready · adds ${patched.length - original.length} bytes`);

  if (DRY_RUN) { console.log(`\n💡 Dry run.`); process.exit(0); }

  fs.writeFileSync(BAK, original);
  console.log(`💾 Backup: ${BAK}`);
  fs.writeFileSync(FILE, patched);
  console.log(`✍️  Wrote ${FILE}`);

  const verify = fs.readFileSync(FILE, 'utf8').toLowerCase();
  const checks = [
    [MARKER.toLowerCase(), 'marker'],
    ['uncertain · totalavailable=0', 'relaxed condition'],
    ['_baydebug', 'per-bay debug var'],
    ['bays detail:', 'detail log'],
  ];
  let pass = true;
  console.log(`\n🔍 Verifying:`);
  for (const [needle, label] of checks) {
    const ok = verify.includes(needle);
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) pass = false;
  }

  if (pass) {
    console.log(`\n🎉 v4 applied. Next:`);
    console.log(`   git add server.js scripts/apply-fb-avail-v4-relaxed-unknown.js`);
    console.log(`   git commit -m "fix(fb-avail-v4): relaxed unknown · per-bay debug log"`);
    console.log(`   git push`);
    console.log(``);
    console.log(`   After deploy · 1 smoke:`);
    console.log(`     📱 "30 มิ.ย. ห้องว่างมั้ย"`);
    console.log(`   Expected bot reply: "ขอเช็คห้องว่างกับแอดมิน..." (not "เต็ม")`);
    console.log(`   Railway log will show "[AVAIL-FB] bays detail: {...}" with per-bay counts`);
  } else {
    console.error(`\n❌ Verification failed · restoring backup`);
    fs.copyFileSync(BAK, FILE);
    process.exit(1);
  }
}

main();
