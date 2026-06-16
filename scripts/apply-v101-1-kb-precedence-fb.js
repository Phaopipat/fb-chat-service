// scripts/apply-v101-1-kb-precedence.js
// V101.1 · Fix V101 over-aggressive escalation that overrode KB hint content
//
// Problem: V101 made bot escalate even when KB-009 (hint mode) provided allow-listed places
//          (ปูม้า · ร่อนทอง · ฝั่งแดง) — regression vs. earlier successful test
//
// Fix: Add DECISION TREE with KB precedence
//   1. KB content in context → use it
//   2. No KB content AND would invent → escalate
//   3. Allow-list places → answer normally
//
// IDEMPOTENT: marker V101_1
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'ai-reply.js');
const BAK = FILE + '.bak-v101-1-' + new Date().toISOString().replace(/[:.]/g, '-');
const DRY_RUN = process.argv.includes('--dry-run');
const MARKER = 'V101_1';

const OLD = `✅ ถ้าลูกค้าถามที่เที่ยว/ร้านอาหาร/วัด/ห้าง/กิจกรรมที่ไม่อยู่ใน KB → escalate:
  "ขอเจ้าหน้าที่ช่วยแนะนำให้นะครับ 🙏 เจ้าหน้าที่จะตอบกลับช่วงเช้าวันถัดไปครับ 😊"

✅ ถ้าลูกค้าถามสถานที่ที่อยู่ในรายการข้างบน → ใช้ KB หรือตอบจาก verified info ตามปกติ`;

const NEW = `✅ DECISION TREE [${MARKER} · KB precedence] — ตรวจตามลำดับ:

  **1. มี KB hint หรือ direct content ใน conversation context?**
     (สังเกตจาก "KB-XXXXXXXX-XXX" ใน prompt · หรือ context มีรายชื่อสถานที่จาก allow list แล้ว · หรือ KB hint/answer text มาด้วย)
     → **ใช้ content นั้นตามปกติ · ห้าม escalate** · KB content ชนะ V101 เสมอ
     ✅ ตัวอย่าง: KB-009 hint มี "ธนาคารปูม้า · ร่อนทอง · หาดฝั่งแดง" → AI rephrase ใช้ 3 ชื่อนี้ตามปกติ
     ❌ ห้ามตอบ "ขอเจ้าหน้าที่ช่วยแนะนำ..." เมื่อ KB ให้ content มาแล้ว

  **2. ไม่มี KB content AND ลูกค้าถามชื่อสถานที่ใหม่นอก allow list?**
     (เช่น "ร้านอาหารแนะนำใกล้ๆ" "วัดดังในประจวบ" "ห้างใกล้ๆ" — ไม่มี KB entry · ไม่มีใน allow list)
     → escalate: "ขอเจ้าหน้าที่ช่วยแนะนำให้นะครับ 🙏 เจ้าหน้าที่จะตอบกลับช่วงเช้าวันถัดไปครับ 😊"
     ❌ ห้ามแต่งชื่อร้าน/วัด/ห้าง/หาด/แลนด์มาร์ก

  **3. ลูกค้าถามสถานที่ที่อยู่ใน allow list ข้างบน?**
     (เช่น "ฝั่งแดง" "ปูม้า" "ร่อนทอง" "บ้านมะพร้าว" "อ่าวมุก")
     → ตอบจาก KB หรือ verified info ตามปกติ

⚠️ **หลักการ ${MARKER}:** V101 fires เฉพาะตอนกำลังจะ **แต่งชื่อสถานที่ใหม่ที่ไม่อยู่ใน allow list** · ห้าม override KB hint/direct ที่มีอยู่แล้ว
⚠️ **Anti-regression:** KB-009 (Onshore umbrella) ต้องตอบ 3 highlights เสมอ · ห้าม escalate · ทดสอบยืนยันแล้ว 2026-06-16 16:36 ก่อน V101`;

function main() {
  const original = fs.readFileSync(FILE, 'utf8');
  console.log(`📖 Read ${FILE} (${original.length} bytes)`);

  if (original.includes(MARKER)) {
    console.log(`⏭️  ${MARKER} already present · NO-OP`);
    process.exit(0);
  }

  if (!original.includes(OLD)) {
    console.error(`❌ Anchor not found (V101 block may have been modified or not applied)`);
    process.exit(1);
  }

  const patched = original.replace(OLD, NEW);
  console.log(`\n📐 Patch ready · adds ${patched.length - original.length} bytes`);

  if (DRY_RUN) { console.log(`\n💡 Dry run`); process.exit(0); }

  fs.writeFileSync(BAK, original);
  fs.writeFileSync(FILE, patched);
  console.log(`✍️  Wrote ${FILE} · backup: ${BAK}`);

  const verify = fs.readFileSync(FILE, 'utf8');
  const checks = [
    [verify.includes(MARKER), 'marker'],
    [verify.includes('KB content ชนะ V101 เสมอ'), 'precedence rule'],
    [verify.includes('DECISION TREE'), 'decision tree header'],
    [verify.includes('KB-009 hint มี "ธนาคารปูม้า'), 'positive example present'],
    [verify.includes('PLACE_NAME_HALLUCINATION_V101'), 'V101 marker still present'],
    [verify.includes('🚨 USE CASE ROUTING'), 'V41 block still intact'],
  ];
  let pass = true;
  console.log(`\n🔍 Verifying:`);
  for (const [ok, label] of checks) {
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) pass = false;
  }

  if (pass) {
    console.log(`\n🎉 V101.1 applied. Smoke test after Railway redeploy:`);
    console.log(`   "มีที่เที่ยวอื่น"          → expect KB-009 (3 highlights · NOT escalate)`);
    console.log(`   "ร้านอาหารแนะนำใกล้ๆ"      → expect escalate (no KB hit)`);
    console.log(`   "ห้างใกล้ๆ"                → expect escalate`);
    console.log(`   "ฝั่งแดง"                   → expect KB-010 (sunrise tour)`);
  } else {
    fs.copyFileSync(BAK, FILE);
    console.error(`❌ Verification failed · restored backup`);
    process.exit(1);
  }
}

main();
