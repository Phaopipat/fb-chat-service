// scripts/apply-fb-step3-shadow-wiring.js
// Step 3 A.3 + A.3.5 — wire intent-router + shadow logger into FB server.js
//
// Adds:
//   1. require('./intent-router') + require('./intent-shadow-log')
//   2. classifyIntent + logShadowDecision call RIGHT BEFORE generateReply
//   3. Gated by env INTENT_ROUTER_SHADOW=true
//
// IDEMPOTENT: marker FB_STEP3_SHADOW_WIRED
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'server.js');
const BAK = FILE + '.bak-step3-' + new Date().toISOString().replace(/[:.]/g, '-');
const DRY_RUN = process.argv.includes('--dry-run');

const MARKER = 'FB_STEP3_SHADOW_WIRED';

const REQUIRE_OLD = `const { generateReply } = require("./ai-reply");`;
const REQUIRE_NEW = `const { generateReply } = require("./ai-reply");
const { classifyIntent: _classifyIntentShadowFB } = require("./intent-router");  // ${MARKER}
const { logShadowDecision: _logShadowFB } = require("./intent-shadow-log");  // ${MARKER}`;

// Insert shadow block right BEFORE generateReply call
const HOOK_OLD = `  try {
    const reply = await generateReply({`;

const HOOK_NEW = `  try {
    // ── ${MARKER} (Step 3 A.3 + A.3.5) ──
    // Shadow mode · log router decision · persist to IntentShadow Sheet · no behavior change
    if (process.env.INTENT_ROUTER_SHADOW === 'true') {
      try {
        const _intentDecision = _classifyIntentShadowFB(text, null);  // leadProfile null until Lead Profile ported
        console.log(\`[IR-SHADOW] psid=\${senderId.substring(0, 8)} intent=\${_intentDecision.intent}\${_intentDecision.sub ? '/' + _intentDecision.sub : ''} handler=\${_intentDecision.handler} conf=\${_intentDecision.confidence} reason="\${_intentDecision.reason}"\`);
        // Fire-and-forget Sheet write · never blocks reply
        _logShadowFB({
          sheets,
          sheetId: GOOGLE_SHEET_ID,
          userId: senderId,
          msgText: text,
          decision: _intentDecision,
          leadProfile: null,
        }).catch(_e => console.warn('[IR-SHADOW-LOG] async error:', _e.message));
      } catch (_irErr) {
        console.warn('[IR-SHADOW] classify error:', _irErr.message);
      }
    }
    // ── end ${MARKER} ──

    const reply = await generateReply({`;

function main() {
  const original = fs.readFileSync(FILE, 'utf8');
  console.log(`📖 Read ${FILE} (${original.length} bytes)`);

  if (original.includes(MARKER)) {
    console.log(`⏭️  ${MARKER} already present · NO-OP`);
    process.exit(0);
  }

  if (!original.includes(REQUIRE_OLD)) {
    console.error(`❌ require anchor not found`);
    process.exit(1);
  }
  if (!original.includes(HOOK_OLD)) {
    console.error(`❌ generateReply hook anchor not found`);
    process.exit(1);
  }

  let patched = original.replace(REQUIRE_OLD, REQUIRE_NEW);
  patched = patched.replace(HOOK_OLD, HOOK_NEW);

  if (patched === original) {
    console.error(`❌ Replace returned identical`);
    process.exit(1);
  }

  console.log(`\n📐 Patch ready · adds ${patched.length - original.length} bytes`);
  console.log(`   1. require intent-router + intent-shadow-log`);
  console.log(`   2. classifyIntent + logShadowDecision before generateReply`);
  console.log(`   3. Gated by INTENT_ROUTER_SHADOW=true`);

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
    ['require("./intent-router")', 'intent-router require'],
    ['require("./intent-shadow-log")', 'shadow-log require'],
    ['process.env.intent_router_shadow', 'env gate'],
    ['[ir-shadow]', 'log tag'],
    ['_logshadowfb', 'logger alias'],
  ];
  let pass = true;
  console.log(`\n🔍 Verifying:`);
  for (const [needle, label] of checks) {
    const ok = verify.includes(needle);
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) pass = false;
  }

  if (pass) {
    console.log(`\n🎉 FB Step 3 shadow wiring applied. Next:`);
    console.log(`   1. node scripts/setup-fb-intent-shadow-tab.js  # create tab`);
    console.log(`   2. git add intent-router.js intent-shadow-log.js server.js scripts/setup-fb-intent-shadow-tab.js scripts/apply-fb-step3-shadow-wiring.js`);
    console.log(`   3. git commit -m "feat(fb-step3): intent router + IntentShadow persistence"`);
    console.log(`   4. git push  # Railway deploy ~2 min`);
    console.log(`   5. Railway → Variables → INTENT_ROUTER_SHADOW = true`);
  } else {
    console.error(`\n❌ Verification failed · restoring backup`);
    fs.copyFileSync(BAK, FILE);
    process.exit(1);
  }
}

main();
