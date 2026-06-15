// scripts/apply-fb-step2-lead-profile-wiring.js
// Step 2 · wire Lead Profile load/classify/save into FB server.js
//
// Adds:
//   1. require('./lead-profile') with destructured imports
//   2. load + classify BEFORE generateReply
//   3. save AFTER reply success
//   4. Pass _leadProfile to intent shadow (replace null)
//
// IDEMPOTENT: marker FB_STEP2_LEAD_PROFILE_WIRED
// Gated by env: LEAD_PROFILE_ENABLED=true
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'server.js');
const BAK = FILE + '.bak-step2-' + new Date().toISOString().replace(/[:.]/g, '-');
const DRY_RUN = process.argv.includes('--dry-run');

const MARKER = 'FB_STEP2_LEAD_PROFILE_WIRED';

// Edit 1: add lead-profile require near top (after intent-shadow-log)
const REQUIRE_OLD = `const { logShadowDecision: _logShadowFB } = require("./intent-shadow-log");  // FB_STEP3_SHADOW_WIRED`;
const REQUIRE_NEW = `const { logShadowDecision: _logShadowFB } = require("./intent-shadow-log");  // FB_STEP3_SHADOW_WIRED
const {
  isLeadProfileEnabled: _isLPEnabledFB,
  loadLeadProfile: _loadLPFB,
  classifyMessage: _classifyLPMsgFB,
  saveLeadProfile: _saveLPFB,
} = require("./lead-profile");  // ${MARKER}`;

// Edit 2: insert load+classify BEFORE shadow block (replaces null leadProfile)
const HOOK_OLD = `  try {
    // ── FB_STEP3_SHADOW_WIRED (Step 3 A.3 + A.3.5) ──`;

const HOOK_NEW = `  // ── ${MARKER} (Step 2) ──
  // Load + classify lead profile (gated on LEAD_PROFILE_ENABLED) · before reply
  let _leadProfileFB = null;
  let _leadMutationsFB = null;
  if (_isLPEnabledFB() && messageType === "text") {
    try {
      _leadProfileFB = await _loadLPFB(senderId, "FB");
      if (senderName && _leadProfileFB.displayName !== senderName) {
        _leadProfileFB.displayName = senderName;
      }
      _leadMutationsFB = _classifyLPMsgFB(text, _leadProfileFB);
      Object.assign(_leadProfileFB, _leadMutationsFB);
    } catch (err) {
      console.warn("[LP-FB] load/classify error:", err.message);
      _leadProfileFB = null;
    }
  }
  // ── end ${MARKER} (Step 2 load) ──

  try {
    // ── FB_STEP3_SHADOW_WIRED (Step 3 A.3 + A.3.5) ──`;

// Edit 3: pass leadProfileFB to shadow classify (was null)
const SHADOW_OLD = `        const _intentDecision = _classifyIntentShadowFB(text, null);  // leadProfile null until Lead Profile ported`;
const SHADOW_NEW = `        const _intentDecision = _classifyIntentShadowFB(text, _leadProfileFB);  // ${MARKER}: pass lead profile`;

// Edit 4: pass leadProfileFB to shadow log (was null)
const SHADOW_LOG_OLD = `          leadProfile: null,
        }).catch(_e => console.warn('[IR-SHADOW-LOG] async error:', _e.message));`;
const SHADOW_LOG_NEW = `          leadProfile: _leadProfileFB,  // ${MARKER}: pass lead profile for stage column
        }).catch(_e => console.warn('[IR-SHADOW-LOG] async error:', _e.message));`;

// Edit 5: save after successful reply (fire-and-forget)
const SAVE_OLD = `    const finalText = lintReply(reply, imagesSent.length > 0);
    if (finalText && finalText.trim()) {
      await sendAndLog(senderId, finalText);
    }
  } catch (err) {`;

const SAVE_NEW = `    const finalText = lintReply(reply, imagesSent.length > 0);
    if (finalText && finalText.trim()) {
      await sendAndLog(senderId, finalText);
    }

    // ── ${MARKER} (Step 2 save) ──
    // Persist lead profile mutations after reply · queued · non-blocking
    if (_isLPEnabledFB() && _leadProfileFB && messageType === "text") {
      try {
        const nowIso = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString();
        const replyContainsPrice = /\\d{1,3}(?:,\\d{3})+\\s*(?:฿|บาท|baht)|\\d{4,5}\\s*(?:฿|บาท|baht)/i.test(reply || '');
        const saveMutations = {
          ...(_leadMutationsFB || {}),
          platform: "FB",
          displayName: senderName,
          last_inbound: nowIso,
          updated_at: nowIso,
          inbound_count:   (_leadProfileFB.inbound_count   || 0) + 1,
          bot_reply_count: (_leadProfileFB.bot_reply_count || 0) + 1,
        };
        if (!_leadProfileFB.first_contact) saveMutations.first_contact = nowIso;
        if (replyContainsPrice) {
          saveMutations.bot_last_quote_at = nowIso;
          if (!["booking", "won", "lost"].includes(_leadProfileFB.stage)) {
            saveMutations.stage = "quoting";
          }
        }
        _saveLPFB(senderId, saveMutations).catch(err =>
          console.warn("[LP-FB] saveLeadProfile error:", err.message)
        );
      } catch (err) {
        console.warn("[LP-FB] post-reply save error:", err.message);
      }
    }
    // ── end ${MARKER} (Step 2 save) ──
  } catch (err) {`;

function main() {
  const original = fs.readFileSync(FILE, 'utf8');
  console.log(`📖 Read ${FILE} (${original.length} bytes)`);

  if (original.includes(MARKER)) {
    console.log(`⏭️  ${MARKER} already present · NO-OP`);
    process.exit(0);
  }

  const anchors = [
    [REQUIRE_OLD, 'require anchor'],
    [HOOK_OLD, 'load anchor'],
    [SHADOW_OLD, 'shadow classify anchor'],
    [SHADOW_LOG_OLD, 'shadow log anchor'],
    [SAVE_OLD, 'save anchor'],
  ];
  for (const [needle, label] of anchors) {
    if (!original.includes(needle)) {
      console.error(`❌ ${label} not found`);
      process.exit(1);
    }
  }

  let patched = original;
  patched = patched.replace(REQUIRE_OLD, REQUIRE_NEW);
  patched = patched.replace(HOOK_OLD, HOOK_NEW);
  patched = patched.replace(SHADOW_OLD, SHADOW_NEW);
  patched = patched.replace(SHADOW_LOG_OLD, SHADOW_LOG_NEW);
  patched = patched.replace(SAVE_OLD, SAVE_NEW);

  console.log(`\n📐 Patch ready · adds ${patched.length - original.length} bytes`);
  console.log(`   1. require lead-profile module`);
  console.log(`   2. load + classify before reply`);
  console.log(`   3. pass leadProfile to intent shadow`);
  console.log(`   4. save after successful reply`);

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
    ['_islpenabledfb', 'isLeadProfileEnabled alias'],
    ['_loadlpfb', 'loadLeadProfile alias'],
    ['_classifylpmsgfb', 'classifyMessage alias'],
    ['_savelpfb', 'saveLeadProfile alias'],
    ['_leadprofilefb', 'profile variable'],
    ['platform: "fb"', 'platform tag'],
  ];
  let pass = true;
  console.log(`\n🔍 Verifying:`);
  for (const [needle, label] of checks) {
    const ok = verify.includes(needle);
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) pass = false;
  }

  if (pass) {
    console.log(`\n🎉 FB Step 2 Lead Profile wiring applied. Next:`);
    console.log(`   1. node scripts/setup-lead-profile-tab.js     # create LeadProfile tab`);
    console.log(`   2. node scripts/backfill-lead-profile-fb.js   # dry-run preview`);
    console.log(`   3. node scripts/backfill-lead-profile-fb.js --write  # commit backfill`);
    console.log(`   4. git add lead-profile.js server.js scripts/...js`);
    console.log(`   5. git commit -m "feat(fb-step2): Lead Profile load+classify+save"`);
    console.log(`   6. git push  # Railway deploy`);
    console.log(`   7. Railway → Variables → LEAD_PROFILE_ENABLED = true`);
  } else {
    console.error(`\n❌ Verification failed · restoring backup`);
    fs.copyFileSync(BAK, FILE);
    process.exit(1);
  }
}

main();
