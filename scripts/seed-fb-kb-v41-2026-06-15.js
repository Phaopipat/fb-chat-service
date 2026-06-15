// scripts/seed-fb-kb-v41-2026-06-15.js (FB version · same 9 entries as LINE)
//
// Seeds same 9 KB entries to FB's own Sheet (KB_SHEET_ID env or fallback to GOOGLE_SHEET_ID).
// Mirrors webhook-kohtalu/scripts/seed-kb-v41-2026-06-15.js exactly.
//
// IDEMPOTENT: existing id skipped.
//
// Usage:
//   node scripts/seed-fb-kb-v41-2026-06-15.js --dry-run
//   node scripts/seed-fb-kb-v41-2026-06-15.js
'use strict';

require('dotenv').config();
const { google } = require('googleapis');

const SHEET_ID = process.env.KB_SHEET_ID || process.env.GOOGLE_SHEET_ID;
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const TODAY = '2026-06-15';
const DRY_RUN = process.argv.includes('--dry-run');

const mk = (id, keywords, answerLines, category, kbMode, notes) => ([
  id, keywords,
  Array.isArray(answerLines) ? answerLines.join('\n') : answerLines,
  category, 'stable', '',
  '', '', 'Phao', TODAY, TODAY, '0', 'verified',
  notes || 'V41 LINE OA admin pattern · ported to FB · Phao verified',
  kbMode || 'direct',
]);

const ENTRIES = [
  mk('KB-20260615-001',
    'ผ้าห่ม|ผ้าห่มเสริม|ขอผ้าห่ม|extra blanket|additional blanket|blanket charge',
    ['ผ้าห่มเสริม 200฿/ผืนครับ 🛏️', 'แจ้งจำนวนผืน + ห้องที่พักได้เลยครับ'],
    'amenity', 'direct',
    'V41 · admin NOK precedent: "เพิ่มผ้าห่ม 200.- /ผืนค่ะ"'),

  mk('KB-20260615-002',
    'รถมารับสถานี|รถไฟ.*มารับ|มารับ.*รถไฟ|สถานีรถไฟ.*มารับ|แจ้งรถ.*ล่วงหน้า|รถรับจากสถานี|train.*pickup|station.*pickup',
    ['รถรับจากสถานีรถไฟบางสะพานใหญ่ครับ 🚗',
     '✅ ราคา 200฿/ท่าน (ไป-กลับสถานี ↔ ท่าเรือ)',
     '⏰ รบกวนแจ้งล่วงหน้า 2 วัน',
     '📞 เบอร์ท่าเรือ 086-0877675 · 089-8103092'],
    'transport', 'direct',
    'V41 · admin NOK precedent: "2วันค่ะ" + "เบอร์ท่าเรือ 086-0877675"'),

  mk('KB-20260615-003',
    'บัตรเครดิต|payment link|รูดบัตร|credit card|ตัดบัตร|ทำลิ้งค์.*บัตร|paylink|3%',
    ['รับชำระบัตรเครดิตได้ครับ 💳',
     '✅ ทำลิ้งค์ตัดบัตรล่วงหน้าได้ (+3% ค่าธรรมเนียมธนาคาร)',
     '✅ รูดบัตรที่เกาะวันเช็คอินก็ได้ (+3% เหมือนกัน)',
     'แจ้งแอดมินทำลิ้งค์ตัดบัตรได้เลยครับ 🙏'],
    'payment', 'direct',
    'V41 · admin precedent: "+3% ค่าธรรมเนียมธนาคารค่ะ"'),

  mk('KB-20260615-004',
    'จ่ายส่วนเหลือ|ส่วนเหลือ.*ที่ไหน|เก็บ.*ที่เกาะ|จ่ายตอน.*เช็คอิน|จ่ายที่รีสอร์ต|จ่.*ที่ท่าเรือ|remaining.*payment|balance.*pay',
    ['ส่วนที่เหลือ (50%) ชำระวันเช็คอินครับ 💰',
     '📍 ชำระได้ที่: ท่าเรือก่อนขึ้นเรือ หรือ Front Desk บนเกาะ',
     '💳 บัตรเครดิตที่เกาะ +3% ค่าธรรมเนียม',
     '💵 เงินสด/โอน ไม่มีค่าธรรมเนียม'],
    'payment', 'direct',
    'V41 · admin precedent confirmed'),

  mk('KB-20260615-005',
    'ยกเลิก|เลื่อนวัน|refund|คืนเงิน|change.*date|cancel.*booking|reschedule|postpone|ขอเปลี่ยนวัน',
    ['เลื่อนวันหรือขอคืนเงินได้ตามเงื่อนไขครับ 🙏',
     'รายละเอียดเงื่อนไข (ระยะเวลาก่อนเดินทาง · % คืน) ขอแอดมินช่วยเช็คให้ครับ',
     'รบกวนแจ้งวันที่จองเดิม + วันที่ต้องการเลื่อน/ยกเลิกครับ'],
    'cancellation', 'direct',
    'V41 · admin sirichai precedent · paired with V41.3-FB force-load'),

  mk('KB-20260615-006',
    'เด็ก 11|เด็ก 12|11 ขวบ|12 ขวบ|11 ปี|12 ปี|child.*11|child.*12|teenager|วัยรุ่น.*ราคา',
    ['เด็กอายุ 11 ปีขึ้นไป = ราคาผู้ใหญ่ปกติครับ 👦',
     'ส่วนลดเด็ก:',
     '• เด็ก 4-10 ปี: ลด 30%',
     '• เด็ก < 3 ปี: ฟรี (ไม่มีเตียง)',
     '• เด็ก 3 ขวบ-10 ปี: ลด 30%'],
    'pricing', 'direct',
    'V41 · admin precedent: "เด็ก 9 ปี ราคา 3080" (4400×0.7)'),

  mk('KB-20260615-007',
    'VAT|ภาษี|ใบกำกับภาษี|tax invoice|7%|E-tax|ขอใบกำกับ|ใบเสร็จ.*ภาษี',
    ['ราคาแพคเกจยังไม่รวม VAT ครับ',
     'หากต้องการใบกำกับภาษี (E-tax invoice) จะ +7% จากราคาในโปรครับ',
     'รบกวนแจ้ง:',
     '• ชื่อบริษัท / นิติบุคคล',
     '• ที่อยู่',
     '• เลขประจำตัวผู้เสียภาษี',
     '• เบอร์ติดต่อ + อีเมล',
     'แอดมินจะออก E-tax invoice ให้ครับ 🙏'],
    'billing', 'direct',
    'V41 · admin NOK precedent: "+7%" only on request'),

  mk('KB-20260615-008',
    'กระติกน้ำแข็ง|ice bucket|ไดร์เป่าผม|hair dryer|กาต้มน้ำ|kettle|พัดลม.*เพิ่ม|adapter|อะแดปเตอร์|ปลั๊ก.*เพิ่ม',
    ['🛏️ ในห้องพักมีให้:',
     '• กาต้มน้ำ + ชุดชา-กาแฟ',
     '• ไดร์เป่าผม (≤1000W)',
     '• ทีวี + แอร์ + ตู้เย็น + เครื่องทำน้ำอุ่น',
     '',
     '🛒 ที่ Lobby อ่าวใหญ่:',
     '• ไดร์ที่กำลังสูงกว่า ยืมได้ที่ Front Desk',
     '',
     '❄️ กระติกน้ำแข็ง: ไม่มีบริการให้ครับ · นำติดตัวมาเองได้'],
    'amenity', 'direct',
    'V41 · admin precedents combined'),

  mk('KB-20260615-009',
    'เบอร์ท่าเรือ|เบอร์รีสอร์ท|เบอร์ติดต่อ|เบอร์โทร.*รีสอร์ท|พิเศษ.*โทร|front desk number|pier phone|resort phone',
    ['📞 เบอร์ติดต่อ:',
     '• ท่าเรือ (จอง/รถรับส่ง/เรือ): 086-0877675 · 089-8103092',
     '• Front Desk (บนเกาะ · ลูกค้าที่พักอยู่แล้ว): 081-299-0248',
     '',
     'ติดต่อในเวลา 8:00-20:00 ได้ครับ 🙏'],
    'contact', 'direct',
    'V41 · pier + Front Desk numbers'),
];

async function main() {
  if (!SHEET_ID || !SA_JSON) {
    console.error('❌ GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON must be set in .env');
    process.exit(1);
  }
  const creds = JSON.parse(SA_JSON.replace(/\\\\n/g, '\\n'));
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  console.log(`📖 FB V41 KB seed (${ENTRIES.length} entries)${DRY_RUN ? ' · DRY RUN' : ''}`);
  console.log(`   Target Sheet: ${SHEET_ID === process.env.KB_SHEET_ID ? 'KB_SHEET_ID (shared with LINE)' : 'FB own Sheet (GOOGLE_SHEET_ID fallback)'}`);
  console.log(`   Sheet ID: ${SHEET_ID}\n`);

  // Check tab exists
  console.log(`📖 Checking for KnowledgeBase tab…`);
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets.properties' });
  const tabExists = (meta.data.sheets || []).some(s => s.properties.title === 'KnowledgeBase');
  if (!tabExists) {
    console.error(`❌ KnowledgeBase tab does not exist in this Sheet`);
    console.error(`   You may need to run setup-knowledge-base.js first (port from LINE bot)`);
    process.exit(1);
  }
  console.log(`   ✅ tab exists\n`);

  // Read existing IDs
  console.log(`📖 Reading existing entries…`);
  const readRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'KnowledgeBase!A2:O1000',
  });
  const rows = readRes.data.values || [];
  const existingIds = new Set(rows.map(r => r[0]).filter(Boolean));
  console.log(`   → ${rows.length} rows · ${existingIds.size} unique IDs\n`);

  let toAppend = 0, toSkip = 0;
  for (const entry of ENTRIES) {
    const id = entry[0];
    if (existingIds.has(id)) {
      console.log(`⏭️  ${id} already exists · SKIP`);
      toSkip++;
      continue;
    }
    console.log(`➕ ${id} (${entry[3]} · mode=${entry[14]})`);
    toAppend++;
  }

  console.log(`\n─── Summary ───`);
  console.log(`  to append: ${toAppend} · skip: ${toSkip}`);

  if (DRY_RUN) {
    console.log('\n💡 Dry run · no Sheet writes.');
    process.exit(0);
  }
  if (toAppend === 0) {
    console.log('\n✅ Nothing to append.');
    process.exit(0);
  }

  console.log(`\n✍️  Writing ${toAppend} entries…`);
  const entriesToWrite = ENTRIES.filter(e => !existingIds.has(e[0]));
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'KnowledgeBase!A:O',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: entriesToWrite },
  });

  console.log('🔍 Verifying…');
  const res2 = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: 'KnowledgeBase!A:A',
  });
  const allIds = new Set((res2.data.values || []).map(r => r[0]).filter(Boolean));
  const missing = ENTRIES.map(e => e[0]).filter(id => !allIds.has(id));

  if (missing.length === 0) {
    console.log(`  ✅ all ${ENTRIES.length} V41 KB IDs present`);
    console.log('\n🎉 Done. Next:');
    console.log('   git add scripts/seed-fb-kb-v41-2026-06-15.js');
    console.log('   git commit -m "feat(fb-v41-kb): seed 9 KB entries to FB Sheet"');
    console.log('   git push');
    process.exit(0);
  } else {
    console.error(`  ❌ missing: ${missing.join(', ')}`);
    process.exit(1);
  }
}

main().catch(err => { console.error('❌', err); process.exit(1); });
