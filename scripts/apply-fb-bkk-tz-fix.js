// scripts/apply-fb-bkk-tz-fix.js
// FB BKK timezone fix · log + Sheet show BKK time (UTC+7) instead of UTC
//
// Root cause: FB server.js uses `new Date().toISOString()` directly · returns UTC.
// LINE bot adds +7 hr offset before slicing date/time columns. FB doesn't.
// → log "11:45" actually means 18:45 BKK · confusing for cross-Sheet analysis.
//
// Fix: add bkkNow() helper · use in 3 logging spots.
// IDEMPOTENT: marker FB_BKK_TZ_FIX
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'server.js');
const BAK = FILE + '.bak-bkk-tz-' + new Date().toISOString().replace(/[:.]/g, '-');
const DRY_RUN = process.argv.includes('--dry-run');

const MARKER = 'FB_BKK_TZ_FIX';

// Edit 1: add bkkNow helper after first appendRow function
const HELPER_OLD = `async function logOutboundRow({ customerPsid, text, mid, extra = "" }) {
  try {
    const ts = new Date();`;

const HELPER_NEW = `// ${MARKER}: return BKK-time Date (UTC + 7 hr) for log/Sheet display
function bkkNow() { return new Date(Date.now() + 7 * 60 * 60 * 1000); }
function bkkFromEvent(eventTs) { return new Date((eventTs || Date.now()) + 7 * 60 * 60 * 1000); }

async function logOutboundRow({ customerPsid, text, mid, extra = "" }) {
  try {
    const ts = bkkNow();`;

// Edit 2: logOutboundImage uses bkkNow
const IMG_OLD = `async function logOutboundImage({ customerPsid, imageUrl, category }) {
  try {
    const ts = new Date();`;

const IMG_NEW = `async function logOutboundImage({ customerPsid, imageUrl, category }) {
  try {
    const ts = bkkNow();  // ${MARKER}`;

// Edit 3: inbound event timestamp uses bkkFromEvent
const IN_OLD = `  const ts = new Date(event.timestamp || Date.now());
  const date = ts.toISOString().slice(0, 10);
  const time = ts.toISOString().slice(11, 19);`;

const IN_NEW = `  const ts = bkkFromEvent(event.timestamp);  // ${MARKER}
  const date = ts.toISOString().slice(0, 10);
  const time = ts.toISOString().slice(11, 19);`;

function main() {
  const original = fs.readFileSync(FILE, 'utf8');
  console.log(`📖 Read ${FILE} (${original.length} bytes)`);

  if (original.includes(MARKER)) {
    console.log(`⏭️  ${MARKER} already present · NO-OP`);
    process.exit(0);
  }

  const anchors = [
    [HELPER_OLD, 'helper anchor'],
    [IMG_OLD, 'image anchor'],
    [IN_OLD, 'inbound anchor'],
  ];
  for (const [needle, label] of anchors) {
    if (!original.includes(needle)) {
      console.error(`❌ ${label} not found`);
      process.exit(1);
    }
  }

  let patched = original;
  patched = patched.replace(HELPER_OLD, HELPER_NEW);
  patched = patched.replace(IMG_OLD, IMG_NEW);
  patched = patched.replace(IN_OLD, IN_NEW);

  if (patched === original) {
    console.error(`❌ Replace returned identical`);
    process.exit(1);
  }

  console.log(`\n📐 Patch ready · adds ${patched.length - original.length} bytes`);
  console.log(`   1. add bkkNow() + bkkFromEvent() helpers`);
  console.log(`   2. logOutboundRow uses bkkNow()`);
  console.log(`   3. logOutboundImage uses bkkNow()`);
  console.log(`   4. inbound webhook uses bkkFromEvent()`);

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
    ['function bkknow()', 'bkkNow helper'],
    ['function bkkfromevent', 'bkkFromEvent helper'],
    ['ts = bkknow()', 'bkkNow used'],
    ['ts = bkkfromevent', 'bkkFromEvent used'],
  ];
  let pass = true;
  console.log(`\n🔍 Verifying:`);
  for (const [needle, label] of checks) {
    const ok = verify.includes(needle);
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) pass = false;
  }

  if (pass) {
    console.log(`\n🎉 FB BKK timezone fix applied. Next:`);
    console.log(`   git add server.js scripts/apply-fb-bkk-tz-fix.js`);
    console.log(`   git commit -m "fix(fb-tz): log + Sheet display BKK time (UTC+7)"`);
    console.log(`   git push  # Railway redeploy ~2 min`);
    console.log(`   New messages from now on will show BKK time in Sheet + logs`);
    console.log(`   Existing UTC rows stay UTC (historical · don't backfill)`);
  } else {
    console.error(`\n❌ Verification failed · restoring backup`);
    fs.copyFileSync(BAK, FILE);
    process.exit(1);
  }
}

main();
