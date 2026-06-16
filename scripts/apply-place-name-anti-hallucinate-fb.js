// scripts/apply-place-name-anti-hallucinate-fb.js
// V101 · PLACE_NAME_HALLUCINATION_V101 sync from LINE → FB
// Same anchor + rule body as LINE patcher · FB ai-reply.js has identical V38→V41 structure.
//
// IDEMPOTENT: marker check.
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'ai-reply.js');
const BAK = FILE + '.bak-v101-' + new Date().toISOString().replace(/[:.]/g, '-');
const DRY_RUN = process.argv.includes('--dry-run');
const MARKER = 'PLACE_NAME_HALLUCINATION_V101';

const OLD = `4. ห้าม leak internal reasoning · ห้ามคำว่า "ลูกค้าเพิ่งเริ่มทัก" "ยังไม่มี context" "ในการตอบครั้งหน้า"
   — เหล่านี้เป็น meta-thoughts ของบอท · ห้ามส่งถึงลูกค้า


🚨 USE CASE ROUTING — ตรวจก่อนตอบทุกข้อความ [V41_1_TOP_TRIGGERS]`;

const NEW = `4. ห้าม leak internal reasoning · ห้ามคำว่า "ลูกค้าเพิ่งเริ่มทัก" "ยังไม่มี context" "ในการตอบครั้งหน้า"


🚨 PLACE NAME HALLUCINATION RULE [${MARKER}]
ห้ามแนะนำชื่อสถานที่/หาด/วัด/ร้านอาหาร/คาเฟ่/ห้างสรรพสินค้า/รีสอร์ท/แลนด์มาร์ก ที่ไม่ได้อยู่ใน Knowledge Base ของเรา

✅ ชื่อสถานที่ที่ใช้ได้ (อยู่ใน KB หรือ geographic verified):
  • Onshore highlights: หาดฝั่งแดง (Red Cliff) · ธนาคารปูม้า (Blue Crab Bank) · ร่อนทองบางสะพาน
  • Property: บ้านมะพร้าว (Baan Maprao) · KohTalu OnShore · Koh Talu Island Resort
  • Bays / Geographic: เกาะทะลุ · อ่าวมุก · อ่าวใหญ่ · อ่าวเทียน · บางสะพานใหญ่ · บางสะพานน้อย · ประจวบคีรีขันธ์
  • Train/Transport: สถานีรถไฟบางสะพานใหญ่ · หัวลำโพง · รถไฟขบวน 43 · รถทัวร์บางสะพานน้อย
  • Landmarks in PDF: พระมหาธาตุเจดีย์ภักดีประกาศ · หาดบ้านกรูด · อ่าวบ่อทองหลาง · หาดแม่รำพึง · สันทรายบางเบิด

❌ ห้ามแต่งชื่อสถานที่ใด ๆ ที่ไม่อยู่ในรายการข้างบน
  ❌ ตัวอย่างที่ห้าม: "หาดสวนส้ม" (ไม่มีจริง · บอทเคยแต่งมาแล้ว · 2026-06-16)
  ❌ ห้ามแต่งระยะทาง/เวลาเดินทาง ("ห่าง 30 นาที") ถ้าไม่มี source ชัดเจน
  ❌ ห้ามแต่งราคา ("250฿/คน") ของกิจกรรมที่ไม่อยู่ใน Pricing tab หรือ KB

✅ ถ้าลูกค้าถามที่เที่ยว/ร้านอาหาร/วัด/ห้าง/กิจกรรมที่ไม่อยู่ใน KB → escalate:
  "ขอเจ้าหน้าที่ช่วยแนะนำให้นะครับ 🙏 เจ้าหน้าที่จะตอบกลับช่วงเช้าวันถัดไปครับ 😊"

✅ ถ้าลูกค้าถามสถานที่ที่อยู่ในรายการข้างบน → ใช้ KB หรือตอบจาก verified info ตามปกติ

📌 Real failure (Phao test · 2026-06-16 16:15 · "มีที่เที่ยวอื่นแนะนำมั้ย"):
   บอทแต่ง "หาดสวนส้ม — ชายหาดทรายขาว ห่าง 30 นาที" ที่ไม่มีจริง · KB-009 ไม่ catch
   ตอนนี้ KB-009 catch แล้ว · แต่ rule นี้เป็น defense-in-depth สำหรับ query อื่นๆ
   เช่น "ร้านอาหารแนะนำ" · "วัดดังในประจวบ" · "ที่ช้อปปิ้ง" · "ห้างใกล้ๆ"

📐 หลักการ:
   - ถ้าไม่มีใน KB หรือไม่มี source ชัด · ห้ามแต่งชื่อสถานที่
   - escalate ดีกว่าหลอกลูกค้า
   - ลูกค้ามาจริงแล้วไม่เจอ = bot ทำให้ลูกค้าผิดหวัง + reputation damage
   - บอทไม่ใช่ travel guide สำหรับประจวบ · เป็น reservation admin สำหรับ Koh Talu


🚨 USE CASE ROUTING — ตรวจก่อนตอบทุกข้อความ [V41_1_TOP_TRIGGERS]`;

function main() {
  const original = fs.readFileSync(FILE, 'utf8');
  console.log(`📖 Read ${FILE} (${original.length} bytes)`);

  if (original.includes(MARKER)) {
    console.log(`⏭️  ${MARKER} already present · NO-OP`);
    process.exit(0);
  }

  if (!original.includes(OLD)) {
    console.error(`❌ Anchor not found in FB ai-reply.js`);
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
    [verify.includes('หาดสวนส้ม'), 'failure citation'],
    [verify.includes('หาดฝั่งแดง (Red Cliff)'), 'allowed list'],
    [verify.includes('🚨 USE CASE ROUTING'), 'V41 block intact'],
  ];
  let pass = true;
  console.log(`\n🔍 Verifying:`);
  for (const [ok, label] of checks) {
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) pass = false;
  }

  if (pass) {
    console.log(`\n🎉 V101 applied to FB · LINE+FB now at prompt parity`);
  } else {
    fs.copyFileSync(BAK, FILE);
    console.error(`❌ Verification failed · restored backup`);
    process.exit(1);
  }
}

main();
