// scripts/apply-fb-v41-3-cancel-force.js (FB version)
// V41.3 · force-load KB-005 on cancel context — FB simplified (no V83 guard exists)
//
// LINE bot has a V83 guard (getKbRoutingGuardDecision) that V41.2 had to bypass.
// FB bot has NO V83 guard · so we go straight to V41.3 force-load.
//
// What it does:
//   1. Add readKB to knowledge-base import
//   2. Add inline isCancelContext detector function (FB doesn't have this)
//   3. Inject force-load block BEFORE the lookupKB call (~line 1206)
//
// IDEMPOTENT: marker V41_3_FORCE_CANCEL_KB_FB
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'ai-reply.js');
const BAK = FILE + '.bak-fb-v41-3-' + new Date().toISOString().replace(/[:.]/g, '-');
const DRY_RUN = process.argv.includes('--dry-run');

const MARKER = 'V41_3_FORCE_CANCEL_KB_FB';
const CANCEL_KB_ID = 'KB-20260615-005';

// Edit 1: add readKB to import + inline isCancelContext helper
const IMPORT_OLD = `const { lookupKB, incrementUsage: kbIncrementUsage } = require('./knowledge-base');`;
const IMPORT_NEW = `const { lookupKB, incrementUsage: kbIncrementUsage, readKB: _readKBForV41_3 } = require('./knowledge-base');  // ${MARKER}

// ${MARKER} · cancel/refund context detector (mirrors LINE V83_CANCEL_CONTEXT_RE)
const _V41_3_CANCEL_RE = /ยกเลิก|แคนเซิล|cancel(?:lation|led)?|refund|คืนเงิน|เลื่อน(?:วัน|จอง|booking|เข้าพัก)?|เปลี่ยน(?:วัน|จอง|booking|ห้อง)?|ขอเลื่อน|ขอเปลี่ยน|แก้(?:วัน|ไขวัน|ไขการจอง)|ย้ายวัน|postpone|reschedul/i;
function _isCancelContextV41_3(text) { return _V41_3_CANCEL_RE.test(String(text || '')); }`;

// Edit 2: inject force-load block right BEFORE the existing kbLookup call
const HOOK_OLD = `  // FB Phase F (2026-06-14): KB lookup before AI gen
  // Uses KB_SHEET_ID (LINE Sheet · cross-Sheet read) for shared KnowledgeBase content.
  const KB_SHEET_ID = process.env.KB_SHEET_ID || spreadsheetId;
  let kbHintContext = '';
  try {
    if (process.env.KB_LOOKUP_ENABLED !== 'false' && KB_SHEET_ID && sheets) {
      const kbHit = await lookupKB({`;

const HOOK_NEW = `  // FB Phase F (2026-06-14): KB lookup before AI gen
  // Uses KB_SHEET_ID (LINE Sheet · cross-Sheet read) for shared KnowledgeBase content.
  const KB_SHEET_ID = process.env.KB_SHEET_ID || spreadsheetId;
  let kbHintContext = '';
  try {
    // ── ${MARKER} — force KB-${CANCEL_KB_ID} on cancel context ──
    // LINE production evidence (2026-06-15): "ขอ refund" hits 8-way 0.500 Jaccard tie
    // KB-005 misses top3 alphabetically · judge returns null · falls to standby
    // Bypass Jaccard tie by direct-loading KB-${CANCEL_KB_ID} when cancel context detected.
    if (_isCancelContextV41_3(text) && process.env.KB_LOOKUP_ENABLED !== 'false' && KB_SHEET_ID && sheets) {
      try {
        const _allKbs = await _readKBForV41_3({ sheets, sheetId: KB_SHEET_ID });
        const _cancelKB = _allKbs.find(e => e.id === '${CANCEL_KB_ID}');
        if (_cancelKB) {
          console.log(\`[V41.3-FB] cancel context · force-load \${_cancelKB.id} · bypass Jaccard tie\`);
          // Mimic the kbHit shape that downstream KB direct logic expects
          const kbHit = { ..._cancelKB, _confidence: 1.0, _isHint: false };
          const kbMode = 'direct';
          console.log(\`[KB] hit \${kbHit.id} conf=\${kbHit._confidence} mode=\${kbMode}\`);
          if (kbIncrementUsage) {
            kbIncrementUsage({ sheets, sheetId: KB_SHEET_ID, id: kbHit.id }).catch(() => {});
          }
          return { text: kbHit.answer || kbHit.text, mode: 'kb_answer', kbId: kbHit.id, attachments: [] };
        }
        console.warn(\`[V41.3-FB] cancel context but KB-${CANCEL_KB_ID} not in cache\`);
      } catch (_v413err) {
        console.warn(\`[V41.3-FB] force-load error:\`, _v413err.message);
      }
    }
    // ── end ${MARKER} ──

    if (process.env.KB_LOOKUP_ENABLED !== 'false' && KB_SHEET_ID && sheets) {
      const kbHit = await lookupKB({`;

function main() {
  const original = fs.readFileSync(FILE, 'utf8');
  console.log(`📖 Read ${FILE} (${original.length} bytes)`);

  if (original.includes(MARKER)) {
    console.log(`⏭️  ${MARKER} already present · NO-OP`);
    process.exit(0);
  }

  if (!original.includes(IMPORT_OLD)) {
    console.error(`❌ Import anchor not found:\n  ${IMPORT_OLD}`);
    process.exit(1);
  }
  if (!original.includes(HOOK_OLD)) {
    console.error(`❌ Hook anchor not found (kbLookup gate)`);
    process.exit(1);
  }

  let patched = original.replace(IMPORT_OLD, IMPORT_NEW);
  patched = patched.replace(HOOK_OLD, HOOK_NEW);

  if (patched === original) {
    console.error(`❌ Replace returned identical · patch failed silently`);
    process.exit(1);
  }

  console.log(`\n📐 Patch ready · adds ${patched.length - original.length} bytes`);
  console.log(`   1. add readKB to import + inline isCancelContext helper`);
  console.log(`   2. inject force-load block before lookupKB call`);

  if (DRY_RUN) {
    console.log(`\n💡 Dry run.`);
    process.exit(0);
  }

  fs.writeFileSync(BAK, original);
  console.log(`💾 Backup: ${BAK}`);

  fs.writeFileSync(FILE, patched);
  console.log(`✍️  Wrote ${FILE}`);

  // Verify (lowercase compare)
  const verify = fs.readFileSync(FILE, 'utf8').toLowerCase();
  const checks = [
    [MARKER.toLowerCase(), 'V41.3-FB marker'],
    ['_readkbforv41_3', 'readKB import alias'],
    ['_iscancelcontextv41_3', 'isCancelContext helper'],
    [CANCEL_KB_ID.toLowerCase(), 'KB-005 id ref'],
    ['[v41.3-fb]', 'log tag'],
  ];
  let pass = true;
  console.log(`\n🔍 Verifying:`);
  for (const [needle, label] of checks) {
    const ok = verify.includes(needle);
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) pass = false;
  }

  if (pass) {
    console.log(`\n🎉 FB V41.3 applied. Next:`);
    console.log(`   1. node scripts/seed-fb-kb-v41-2026-06-15.js  # seed 9 KBs to FB Sheet`);
    console.log(`   2. git add ai-reply.js scripts/apply-fb-v41-3-cancel-force.js`);
    console.log(`   3. git commit -m "fix(fb-v41.3): force-load KB-005 on cancel context"`);
    console.log(`   4. git push  # Railway deploy`);
  } else {
    console.error(`\n❌ Verification failed · restoring backup`);
    fs.copyFileSync(BAK, FILE);
    process.exit(1);
  }
}

main();
