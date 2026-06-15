// scripts/apply-fb-availability-wiring.js
// Wire availability checker into FB server.js
//
// Flow:
//   1. After intent shadow log · if intent=AVAILABILITY:
//   2. Parse Thai dates from message
//   3. Validate dates (not past · within booking window)
//   4. checkBayAvailability(dates) → group result by bay
//   5. Format reply directly · send · skip generateReply
//
// If date parse fails → falls through to generateReply (existing behavior)
//
// IDEMPOTENT: marker FB_AVAILABILITY_WIRED
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'server.js');
const BAK = FILE + '.bak-avail-' + new Date().toISOString().replace(/[:.]/g, '-');
const DRY_RUN = process.argv.includes('--dry-run');

const MARKER = 'FB_AVAILABILITY_WIRED';

// Edit 1: add requires (after intent-shadow-log require)
const REQUIRE_OLD = `const {
  isLeadProfileEnabled: _isLPEnabledFB,
  loadLeadProfile: _loadLPFB,
  classifyMessage: _classifyLPMsgFB,
  saveLeadProfile: _saveLPFB,
} = require("./lead-profile");  // FB_STEP2_LEAD_PROFILE_WIRED`;

const REQUIRE_NEW = `const {
  isLeadProfileEnabled: _isLPEnabledFB,
  loadLeadProfile: _loadLPFB,
  classifyMessage: _classifyLPMsgFB,
  saveLeadProfile: _saveLPFB,
} = require("./lead-profile");  // FB_STEP2_LEAD_PROFILE_WIRED
// ${MARKER}
const { checkBayAvailability: _checkBayAvailFB, validateDates: _validateDatesFB, SELECTED_ROOMS: _SELECTED_ROOMS_FB } = require("./availability-checker");
const { parseThaiDateRange: _parseThaiDateRangeFB } = require("./fb-date-parser");

// Format availability result as customer-facing reply
function _formatAvailabilityReplyFB(parsed, result) {
  const { checkIn, checkOut, bays, totalAvailable } = result;
  const dateStr = checkIn === checkOut || (new Date(checkOut) - new Date(checkIn)) === 86_400_000
    ? checkIn
    : \`\${checkIn} ถึง \${checkOut}\`;

  if (totalAvailable === 0) {
    return \`ช่วง \${dateStr} ห้องเต็มแล้วครับ 😔 ขอแอดมินช่วยเช็ควันอื่นใกล้เคียงให้ครับ 🙏\`;
  }

  const parts = [\`ช่วง \${dateStr} ครับ 😊\`];
  const bayNames = ['อ่าวมุก', 'อ่าวใหญ่'];
  for (const bay of bayNames) {
    const b = bays[bay];
    if (!b) continue;
    if (b.available.length > 0) {
      const emoji = bay === 'อ่าวมุก' ? '🛖' : '🏠';
      parts.push(\`\${emoji} \${bay}: ยังมีห้องว่างครับ\`);
    } else if (b.booked.length > 0) {
      const emoji = bay === 'อ่าวมุก' ? '🛖' : '🏠';
      parts.push(\`\${emoji} \${bay}: เต็มแล้ว\`);
    }
  }
  parts.push('มาทั้งหมดกี่ท่านครับ? ผมจะแนะนำห้องที่เหมาะสมให้');
  return parts.join('\\n');
}`;

// Edit 2: insert availability handler RIGHT AFTER shadow log block (before generateReply)
const HOOK_OLD = `    // ── end FB_STEP3_SHADOW_WIRED + STEP3_SHADOW_SHEET_WIRED ──

    const reply = await generateReply({`;

const HOOK_NEW = `    // ── end FB_STEP3_SHADOW_WIRED + STEP3_SHADOW_SHEET_WIRED ──

    // ── ${MARKER} — availability check before AI gen ──
    if (process.env.AVAILABILITY_CHECK_ENABLED !== 'false' && messageType === 'text') {
      try {
        const _availIntent = _classifyIntentShadowFB(text, _leadProfileFB);
        if (_availIntent.intent === 'AVAILABILITY') {
          const _parsed = _parseThaiDateRangeFB(text);
          if (_parsed) {
            const _vd = _validateDatesFB(_parsed.checkIn, _parsed.checkOut);
            if (_vd.ok) {
              console.log(\`[AVAIL-FB] intent=AVAILABILITY dates=\${_parsed.checkIn}..\${_parsed.checkOut} hint="\${_parsed.hint}"\`);
              const _auth = await getGoogleAuth();
              const _result = await _checkBayAvailFB(_auth, _parsed.checkIn, _parsed.checkOut);
              const _availReply = _formatAvailabilityReplyFB(_parsed, _result);
              await sendAndLog(senderId, _availReply);
              return;  // skip generateReply
            } else {
              console.log(\`[AVAIL-FB] dates invalid: \${_vd.reason} · fall through to AI\`);
            }
          } else {
            console.log(\`[AVAIL-FB] no parseable dates in "\${text.substring(0, 50)}" · fall through to AI\`);
          }
        }
      } catch (_availErr) {
        console.warn('[AVAIL-FB] error · falling through:', _availErr.message);
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
    console.error(`❌ hook anchor not found`);
    process.exit(1);
  }

  let patched = original.replace(REQUIRE_OLD, REQUIRE_NEW);
  patched = patched.replace(HOOK_OLD, HOOK_NEW);

  if (patched === original) {
    console.error(`❌ Replace returned identical`);
    process.exit(1);
  }

  console.log(`\n📐 Patch ready · adds ${patched.length - original.length} bytes`);
  console.log(`   1. require availability-checker + fb-date-parser`);
  console.log(`   2. _formatAvailabilityReplyFB helper`);
  console.log(`   3. availability check before generateReply`);
  console.log(`   4. Gated by AVAILABILITY_CHECK_ENABLED (default ON)`);

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
    ['_checkbayavailfb', 'checkBayAvailability alias'],
    ['_parsethaidaterangefb', 'date parser alias'],
    ['_formatavailabilityreplyfb', 'reply formatter'],
    ['availability_check_enabled', 'env gate'],
    ['[avail-fb]', 'log tag'],
  ];
  let pass = true;
  console.log(`\n🔍 Verifying:`);
  for (const [needle, label] of checks) {
    const ok = verify.includes(needle);
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) pass = false;
  }

  if (pass) {
    console.log(`\n🎉 FB availability wiring applied. Next:`);
    console.log(`   ⚠️ IMPORTANT prerequisite: share Drive 'Availability/' folder with FB SA`);
    console.log(`      kohtalu-fb-sheets@lineoa-chat-history.iam.gserviceaccount.com (Viewer)`);
    console.log(``);
    console.log(`   1. git add availability-checker.js fb-date-parser.js server.js scripts/apply-fb-availability-wiring.js`);
    console.log(`   2. git commit -m "feat(fb-avail): availability check integration · close last parity gap"`);
    console.log(`   3. git push  # Railway deploy ~2 min`);
    console.log(`   4. Smoke test: "30 มิ.ย. ห้องว่างมั้ย" · "15-17 ก.ค."`);
  } else {
    console.error(`\n❌ Verification failed · restoring backup`);
    fs.copyFileSync(BAK, FILE);
    process.exit(1);
  }
}

main();
