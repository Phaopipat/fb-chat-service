// scripts/apply-fb-avail-v5-bay-arg.js
// v5 — fix missing 'bay' arg in checkBayAvailability call
//
// Bug: function signature is (auth, bay, checkInStr, checkOutStr) — 4 args
//      My call was (auth, checkInStr, checkOutStr) — 3 args
//      checkIn date treated as bay name · filter found 0 rooms · empty results
//
// Fix: pass 'any' as second arg to check all bays
//
// IDEMPOTENT: marker FB_AVAIL_V5_BAY_ARG
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'server.js');
const BAK = FILE + '.bak-v5-' + new Date().toISOString().replace(/[:.]/g, '-');
const DRY_RUN = process.argv.includes('--dry-run');
const MARKER = 'FB_AVAIL_V5_BAY_ARG';

const OLD = `              const _auth = await getGoogleAuth();
              const _result = await _checkBayAvailFB(_auth, _parsed.checkIn, _parsed.checkOut);`;

const NEW = `              const _auth = await getGoogleAuth();
              // ${MARKER}: checkBayAvailability signature is (auth, bay, checkIn, checkOut) — pass 'any' for all bays
              const _result = await _checkBayAvailFB(_auth, 'any', _parsed.checkIn, _parsed.checkOut);`;

function main() {
  const original = fs.readFileSync(FILE, 'utf8');
  console.log(`📖 Read ${FILE} (${original.length} bytes)`);

  if (original.includes(MARKER)) {
    console.log(`⏭️  ${MARKER} already present · NO-OP`);
    process.exit(0);
  }

  if (!original.includes(OLD)) {
    console.error(`❌ Anchor not found`);
    process.exit(1);
  }

  const patched = original.replace(OLD, NEW);
  console.log(`\n📐 Patch ready · adds ${patched.length - original.length} bytes`);

  if (DRY_RUN) { console.log(`\n💡 Dry run.`); process.exit(0); }

  fs.writeFileSync(BAK, original);
  console.log(`💾 Backup: ${BAK}`);
  fs.writeFileSync(FILE, patched);
  console.log(`✍️  Wrote ${FILE}`);

  const verify = fs.readFileSync(FILE, 'utf8');
  const checks = [
    [verify.includes(MARKER), 'marker'],
    [verify.includes(`_checkBayAvailFB(_auth, 'any'`), `'any' arg passed`],
  ];
  let pass = true;
  console.log(`\n🔍 Verifying:`);
  for (const [ok, label] of checks) {
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) pass = false;
  }

  if (pass) {
    console.log(`\n🎉 v5 applied. Next:`);
    console.log(`   git add server.js scripts/apply-fb-avail-v5-bay-arg.js`);
    console.log(`   git commit -m "fix(fb-avail-v5): add missing 'bay' arg to checkBayAvailability"`);
    console.log(`   git push`);
    console.log(``);
    console.log(`   Smoke "30 มิ.ย. ห้องว่างมั้ย" · expect real result with bays populated`);
  } else {
    console.error(`\n❌ Verification failed · restoring`);
    fs.copyFileSync(BAK, FILE);
    process.exit(1);
  }
}

main();
