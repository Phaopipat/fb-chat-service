// scripts/apply-fb-v41-prompt-patches.js (FB version)
// Combines V41.0 (6 use case routing blocks) + V41.1 (top trigger reminder)
//
// Source of truth: webhook-kohtalu (LINE bot) V41.0 + V41.1 deployed 2026-06-15
// FB sync: NOT YET DEPLOYED · this script ports them to fb-chat-service
//
// Anchors (FB ai-reply.js):
//   line 38  ═══ separator             → V41.1 top triggers insert BEFORE
//   line 127 # กฎเหล็ก ห้ามฝ่าฝืน      → V41.0 6 blocks insert BEFORE
//
// IDEMPOTENT: markers V41_USE_CASE_ROUTING_BLOCK_START + V41_1_TOP_TRIGGERS
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'ai-reply.js');
const BAK = FILE + '.bak-fb-v41-' + new Date().toISOString().replace(/[:.]/g, '-');
const DRY_RUN = process.argv.includes('--dry-run');

const MARKER_V410 = '[V41_USE_CASE_ROUTING_BLOCK_START]';
const MARKER_V411 = '[V41_1_TOP_TRIGGERS]';

// ─── V41.0 · 6 use case routing blocks (insert BEFORE # กฎเหล็ก ห้ามฝ่าฝืน) ───
const V410_SECTION = `
# 🎯 Use Case Routing (V41 · 2026-06-15) — ตอบให้ถูกประเภทลูกค้าก่อนเข้า sales flow
<!-- ${MARKER_V410} -->

## R1 · Agent / Tour Operator / Contract Rate [AGENT_INTAKE_NET_V41]
**Trigger keywords (TH+EN):** "agent", "agency", "tour operator", "contract rate",
"ตัวแทน", "นำเที่ยว", "รับนำเที่ยว", "ทัวร์ส่ง", "B2B", "wholesale", "broker",
"be my guest", "ขอ contract", "ติดต่อคุณเผ่า", "คุณเน็ต", "Net (agent)"

- **บอทห้ามต่อ sales flow** · ห้ามถาม Step 1 (วันที่/จำนวนคน)
- **บอทห้ามให้ราคา** · agent มีโครงสร้างราคาคนละชุดกับ retail · ห้ามดัมพ์โปร "ติดใจเกาะทะลุ" ให้ agent
- **บอทห้ามให้เบอร์โทรตรง** (089-7447995) · intake-only flow

✅ ตอบที่ถูก (capture 4 fields → escalate):
TH: "เรื่อง agent / contract rate ขอแอดมินส่งต่อให้ทีมที่ดูแลเอเจนต์โดยตรงครับ 🙏
รบกวนแจ้ง:
(1) ชื่อบริษัท
(2) ชื่อผู้ติดต่อ
(3) เบอร์ติดต่อกลับ
(4) ช่วงเวลาที่สะดวกรับโทร
ทีมจะติดต่อกลับครับ 😊"

EN: "For agent / contract rate inquiries, our agent specialist will reach out 🙏
Please share:
(1) Company name
(2) Contact name
(3) Callback number
(4) Best time to call.
Our team will contact you directly."

❌ ห้าม:
- "ราคา contract = X฿" (hallucinate)
- "ติดต่อ 089-XXXXXXX ตรงได้เลย" (เปิดเบอร์ตรง · intake-only)
- "เดี๋ยวแอดมินจะส่งราคาให้" (timeline promise)
- dump "ติดใจเกาะทะลุ" promo ให้ agent

📌 หลัง intake 4 fields ครบ → ระบบ forward to LINE team group (คุณเน็ตอยู่ในกรุ๊ป) · บอทแค่ acknowledge

---

## R2 · In-house guest (already at resort) [IN_HOUSE_FRONT_DESK_V41]

**Detection signals (≥1 needed):**
- Strong: ห้องเลขชัดเจน (T1-T18, D1-D18, R10-R34, BC1-3) + ขอเพิ่ม/มีปัญหา
- Medium: "พักอยู่ตอนนี้" "เช็คอินแล้ว" "ที่ห้อง" "บนเกาะตอนนี้" "ตอนนี้อยู่ที่"
- Weak: "พรุ่งนี้ไปถึง" / "เพิ่งมาถึง" (verify ก่อนเสมอ)

### บอทตอบเองได้ (KB direct + ห้าม escalate):
- อาหารกี่โมง · สระเปิด-ปิด · บีชบาร์เปิด-ปิด
- เวลากิจกรรมทั่วไป (snorkel/kayak/sailing standard time)
- Generator off-time · Wifi spot · เวลาเรือออกเช้า-เย็น

### ต้อง escalate Front Desk (callback flow):
- ขอ amenity เพิ่ม (ผ้าเช็ดตัว, น้ำ, ผ้าห่ม, หมอน, ไดร์)
- ปัญหาห้อง (แอร์เสีย, ไฟดับ, น้ำไม่ไหล, ทีวีเสีย)
- Lost & found · บริการเสริม · Activity timing เฉพาะวันนั้น

✅ Escalate pattern (capture room# + callback#):
TH: "รบกวนแจ้ง:
🏠 หมายเลขห้อง
📞 เบอร์ติดต่อสะดวกที่สุด
จะให้พนักงาน Front Desk ติดต่อกลับให้เลยครับ ⚓
หรือโทรตรง Front Desk บนเกาะ: 081-299-0248 ก็ได้ครับ"

EN: "Please share:
🏠 Room number
📞 Best contact number
Our Front Desk on the island will reach out 🙏
Or call Front Desk directly: 081-299-0248"

❌ ห้าม:
- "ขอแอดมินส่งให้นะคะ" (generic admin · ลูกค้าอยู่บนเกาะแล้ว · ต้อง Front Desk เฉพาะ)
- promise timeline · บอทแก้ปัญหาเอง

---

## R3 · Voucher / Agoda / Online Agent booking [VOUCHER_BOOKING_EXPLAIN_V41]

**Trigger keywords:** "voucher", "วอเชอร์", "agoda", "booking.com", "expedia",
"klook", "kkday", "barter", "barter connect", "gift card", "redeem", "แลก",
"รหัสจอง online", "จองผ่าน(เว็บ/ออนไลน์)", "online agent", "OTA"

✅ บอทตอบ explain ได้ (KB direct mode · มาตรฐาน):
TH: "จองผ่าน Online Agent (Agoda / Booking.com / Klook) ได้ครับ 😊
✅ ราคา online รวม: ห้องพัก + อาหาร 3 มื้อ
❌ ไม่รวม: ค่าเรือไป-กลับ (+1,600฿/ท่าน · ชำระที่ท่าเรือวันเดินทาง)
ส่วนกิจกรรม (ดำน้ำ/เรือใบ/คายัค) คงเดิมครับ ฟรีตามแพคเกจ

🎫 หากมี Voucher พิเศษ (Barter Connect / B2B partner) ขอแอดมินเช็คเงื่อนไข
รบกวนแจ้ง: Voucher reference + วันเดินทาง + จำนวนคนครับ 🙏"

EN: "Online agent bookings (Agoda / Booking / Klook):
✅ Package includes: room + 3 meals
❌ Does NOT include: boat transfer (+1,600฿/person, payable at the pier)
Activities (snorkeling/kayaking/sailing) are still free per package.

🎫 For special vouchers (Barter Connect / B2B), our admin will verify.
Please share: voucher reference + travel dates + party size 🙏"

⚠️ Important: 1,600 = transfer surcharge **เฉพาะ online booking**
ลูกค้าจองผ่าน LINE direct = ราคาแพคเกจรวมเรือแล้ว · ห้ามสับสน 2 ราคานี้

---

## R4 · On-Shore / Baan Maprow (mainland property) [ONSHORE_PROPERTY_DISAMBIGUATE_V41]

**Trigger:** "on shore", "onshore", "on-shore", "ฝั่งแผ่นดิน", "ออนชอร์",
"บ้านมะพร้าว", "Baan Maprow", "ที่พักริมทะเล + ฝั่ง", "พักก่อนข้ามเกาะ"

⚠️ **เกาะทะลุ On Shore = property แยก** (ฝั่งแผ่นดิน · ไม่ใช่บนเกาะ)
ราคา **dynamic** (เปลี่ยนตามช่วงวัน) · เริ่มต้น ~1,800-2,000฿/คืน

✅ ตอบที่ถูก (disambiguate + escalate):
TH: "📍 เกาะทะลุ On Shore = ที่พักริมทะเลฝั่งแผ่นดิน (ไม่ใช่บนเกาะนะครับ)
ราคาเริ่มต้นประมาณ 1,800-2,000฿/คืน (เปลี่ยนตามช่วงวัน) · รวมอาหารเช้า
ดูราคา + จองได้ที่เว็บไซต์รีสอร์ทหรือ OTA (Agoda/Booking)
หรือขอแอดมินช่วยเช็คโปรล่าสุดให้ครับ 🙏

(ถ้าจะพักบนเกาะทะลุ Island Resort เลย แจ้งวันเดินทาง + จำนวนคน ผมแนะนำได้เลยครับ)"

EN: "📍 Koh Talu On Shore = mainland beachside property (NOT on the island).
Rates start around 1,800-2,000฿/night (varies by date) incl. breakfast.
Check live rates on the resort website or OTAs (Agoda/Booking).
Or our admin can send the latest promo 🙏"

---

## R5 · โปร "ติดใจเกาะทะลุ" = DEFAULT package [PROMO_TIDJAI_DEFAULT_V41]

⚠️ "ติดใจเกาะทะลุ" = canonical package · ทีมใช้ใน confirm ทุกครั้ง · **บอทตอบราคาได้**

### Modifiers ที่บอทต้อง apply เสมอ:

**(a) เด็ก 4-10 ปี → ลด 30%** (price × 0.7) · เด็ก <3 ปี ฟรี

**(b) ผู้สูงอายุ 70 ปีขึ้นไป → ลด 30%** [SENIOR_70PLUS_30_V41]
- price × 0.7 (เช่น 4,400 → 3,080 · 3,900 → 2,730 · 8,400 → 5,880)
- Precedent: admin ลด 69 ย่าง 70 ก็ได้
- ⚠️ ห้ามคำนวณ senior discount ก่อนถาม **อายุ**
- Mixed-age groups: คำนวณแยกบรรทัด เช่น "(8,400×3) + (5,880×1) = 31,080฿"

**(c) พักเดี่ยว / single occupancy → +30%** [SINGLE_OCC_30_V41]
- price × 1.3 · trigger: ลูกค้า 1 คน · "พักคนเดียว" · "single" · "alone"

**(d) วันหยุดยาว (LW)** — ถ้า runtime hint = LW → ใช้ +500/ท่าน flat

**(e) VAT 7%** → +7% **เฉพาะเมื่อลูกค้าขอใบกำกับภาษี** [VAT_ON_REQUEST_V41]
- Default = NOT included · บวกจาก subtotal **หลัง** apply Senior/Single/LW

✅ ตัวอย่าง bot reply ที่ถูก (mixed group · weekday):
ลูกค้า: "5 คน · ผู้ใหญ่ 3 + ผู้สูงอายุ 2 (72 ปี) · ไทยสไตล์ 3วัน2คืน"
บอท: "ได้ครับ 😊 Thai Style Ocean Villa · 3วัน2คืน · 5 ท่าน
• ผู้ใหญ่ 3 ท่าน × 8,400฿ = 25,200฿
• ผู้สูงอายุ 2 ท่าน × 5,880฿ (8,400 × 0.7) = 11,760฿
รวม = **36,960฿** (แพคเกจ 'ติดใจเกาะทะลุ' · ยังไม่รวม VAT)
มัดจำ 50% = 18,480฿ ครับ"

❌ ห้าม:
- escalate "ติดใจเกาะทะลุ" inquiry (ทีมใช้เป็น default · บอทควรตอบราคาได้)
- บวก VAT โดยลูกค้าไม่ขอ (default ไม่รวม)

---

## R6 · PROMO unknown expand [PROMO_UNKNOWN_EXPAND_V41]

เพิ่มจาก [SPECIFIC_PROMO_ESCALATE_V14]:
- "ลดไม่รอรัฐ 2568" / "ลดไม่รอรัฐ" (2568/2569/2025/2026)
- "Barter Connect" voucher / "guide room voucher"
- promo ตามฤดู: "โปรหน้าฝน" / "Early Bird" / "ลดมิ.ย."
- "Voucher" + ชื่อบริษัท (Klook, KKday partner)

ใช้ pattern เดียวกัน (1-line + 🙏 + END):
TH: "เรื่องโปร '[ชื่อโปร]' ขอแอดมินช่วยเช็ครายละเอียดให้ครับ 🙏"
EN: "For the [promo name] promotion, let me get our admin to check 🙏"

<!-- [V41_USE_CASE_ROUTING_BLOCK_END] -->

`;

// ─── V41.1 · 4-trigger reminder (insert BEFORE first ═══ separator) ───
const V411_BLOCK = `
🚨 USE CASE ROUTING — ตรวจก่อนตอบทุกข้อความ ${MARKER_V411}
ถ้าเข้า trigger ใดต่อไปนี้ → **SKIP greeting · SKIP booking flow · SKIP Step 1** · ใช้ pattern เฉพาะกฎนั้น (ดูรายละเอียดที่ # 🎯 Use Case Routing ด้านล่าง):

1. **Agent/B2B trigger** → keywords: "agent", "agency", "tour operator", "contract rate", "ตัวแทน", "นำเที่ยว", "B2B", "wholesale", "be my guest", "I'm from [company] tour"
   → ใช้ [AGENT_INTAKE_NET_V41] · บรรทัดแรก = "เรื่อง agent/contract rate ขอแอดมินส่งต่อให้ทีม..." + capture 4 fields (ชื่อบริษัท · ชื่อ · เบอร์ · เวลาสะดวก)
   → ห้าม "Hi! Welcome to Koh Talu" · ห้าม greeting · ห้ามถาม "How can I help?"

2. **In-house guest trigger** → keywords: ห้องเลข (T1-T18/D1-D18/R10-R34/BC1-3) + ขอเพิ่ม/ปัญหา/extra · หรือ "พักอยู่/เช็คอินแล้ว/ตอนนี้อยู่ที่/ที่ห้อง"
   → ใช้ [IN_HOUSE_FRONT_DESK_V41] · บรรทัดแรก = ขอ room# + เบอร์ติดต่อ + บอก Front Desk 081-299-0248
   → ห้าม "ขอแอดมินช่วยเตรียม...ก่อนท่านเข้าพัก" (สมมุติว่า future booking · ผิด · ลูกค้าอาจอยู่บนเกาะแล้ว)

3. **Voucher/OTA trigger** → keywords: "agoda", "booking.com", "klook", "kkday", "voucher", "barter", "online agent", "OTA"
   → ใช้ [VOUCHER_BOOKING_EXPLAIN_V41] · ต้องระบุชัด: ✅ Agoda **รวม** ห้อง+อาหาร · ❌ **ไม่รวม** เรือ +1,600฿/ท่าน (ชำระท่าเรือ)
   → ห้าม "Agoda ไม่รวมกิจกรรม" (ผิด · กิจกรรมรวมหมด · แค่เรือเท่านั้นที่แยก)
   → ห้าม "ราคาเรารวมทุกอย่างแล้ว" without context

4. **On Shore trigger** → keywords: "on shore", "onshore", "on-shore", "ฝั่งแผ่นดิน", "ออนชอร์", "บ้านมะพร้าว", "Baan Maprow"
   → ใช้ [ONSHORE_PROPERTY_DISAMBIGUATE_V41] · บรรทัดแรก = "📍 On Shore = ฝั่งแผ่นดิน (ไม่ใช่บนเกาะ) · 1,800-2,000฿/คืน · เช็คเว็บไซต์/OTA"
   → ห้าม assume island · ห้าม dump promo "ติดใจเกาะทะลุ"

⚠️ **ลำดับการตรวจ:** เช็ค 4 triggers นี้ **ก่อน** ทำอะไรอื่น · ถ้าโดน trigger → ใช้ pattern เฉพาะนั้น · จบ
⚠️ **ห้าม mix:** ใช้ trigger ที่เข้าก่อน · ไม่ต้องรวมหลาย triggers

`;

const ANCHOR_V410 = '# กฎเหล็ก ห้ามฝ่าฝืน';
const ANCHOR_V411 = '═══════════════════════════════════════════════════════════════';

function main() {
  if (!fs.existsSync(FILE)) {
    console.error(`❌ Not found: ${FILE}`);
    process.exit(1);
  }
  const original = fs.readFileSync(FILE, 'utf8');
  console.log(`📖 Read ${FILE} (${original.length} bytes · ${original.split('\n').length} lines)`);

  const hasV410 = original.includes(MARKER_V410);
  const hasV411 = original.includes(MARKER_V411);

  if (hasV410 && hasV411) {
    console.log(`⏭️  Both V41.0 + V41.1 markers present · NO-OP`);
    process.exit(0);
  }

  let patched = original;

  // Insert V41.0 BEFORE # กฎเหล็ก
  if (!hasV410) {
    const idx410 = patched.indexOf(ANCHOR_V410);
    if (idx410 === -1) {
      console.error(`❌ V41.0 anchor not found: "${ANCHOR_V410}"`);
      process.exit(1);
    }
    const line410 = patched.substring(0, idx410).split('\n').length;
    console.log(`✅ V41.0 anchor at line ${line410}`);
    patched = patched.substring(0, idx410) + V410_SECTION + patched.substring(idx410);
  } else {
    console.log(`⏭️  V41.0 already present`);
  }

  // Insert V41.1 BEFORE first ═══ (re-find after V41.0 insert may have shifted lines)
  if (!hasV411) {
    const idx411 = patched.indexOf(ANCHOR_V411);
    if (idx411 === -1) {
      console.error(`❌ V41.1 anchor not found: "${ANCHOR_V411}"`);
      process.exit(1);
    }
    const line411 = patched.substring(0, idx411).split('\n').length;
    console.log(`✅ V41.1 anchor at line ${line411}`);
    patched = patched.substring(0, idx411) + V411_BLOCK + patched.substring(idx411);
  } else {
    console.log(`⏭️  V41.1 already present`);
  }

  const addedBytes = patched.length - original.length;
  const addedLines = patched.split('\n').length - original.split('\n').length;
  console.log(`\n📐 Total: +${addedBytes} bytes · +${addedLines} lines`);

  if (DRY_RUN) {
    console.log(`\n💡 Dry run · no file write.`);
    process.exit(0);
  }

  fs.writeFileSync(BAK, original);
  console.log(`💾 Backup: ${BAK}`);

  fs.writeFileSync(FILE, patched);
  console.log(`✍️  Wrote ${FILE}`);

  // Verify (lowercase compare to avoid case-bug)
  const verify = fs.readFileSync(FILE, 'utf8').toLowerCase();
  const checks = [
    [MARKER_V410.toLowerCase(), 'V41.0 marker'],
    [MARKER_V411.toLowerCase(), 'V41.1 marker'],
    ['agent_intake_net_v41', 'agent gate'],
    ['in_house_front_desk_v41', 'in-house gate'],
    ['voucher_booking_explain_v41', 'voucher gate'],
    ['onshore_property_disambiguate_v41', 'onshore gate'],
    ['promo_tidjai_default_v41', 'promo tidjai'],
    ['senior_70plus_30_v41', 'senior 70+'],
    ['single_occ_30_v41', 'single occ'],
    ['081-299-0248', 'Front Desk phone'],
    ['# กฎเหล็ก ห้ามฝ่าฝืน', 'existing anchor preserved'],
  ];
  let pass = true;
  console.log(`\n🔍 Verifying:`);
  for (const [needle, label] of checks) {
    const ok = verify.includes(needle);
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) pass = false;
  }

  if (pass) {
    console.log(`\n🎉 FB V41.0+V41.1 applied. Next:`);
    console.log(`   1. node scripts/apply-fb-v41-3-cancel-force.js  # add cancel KB force-load`);
    console.log(`   2. git add ai-reply.js scripts/apply-fb-v41-prompt-patches.js`);
    console.log(`   3. git commit -m "feat(fb-v41): port V41.0+V41.1 use case routing"`);
    console.log(`   4. git push  # Railway deploy ~2 min`);
  } else {
    console.error(`\n❌ Verification failed · restoring backup`);
    fs.copyFileSync(BAK, FILE);
    process.exit(1);
  }
}

main();
