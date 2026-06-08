// Regression test for Day 9 PM hallucination defense
// Run: node scripts/test-anti-hallucination.js
// No Anthropic API calls - unit tests only

const { sanitizeReply } = require('../ai-reply.js');

const cases = [
  [
    'Strip ดินแดนหวานใจ',
    'ที่พักมีห้องแต่งพิเศษสำหรับดินแดนหวานใจไหม',
    r => !/ดินแดนหวานใจ/.test(r),
  ],
  [
    'Replace Home Chalet -> Home (เรือนไทย)',
    'ห้องบ้านไทย (Home Chalet) อ่าวมุก',
    r => /Home \(เรือนไทย\)/.test(r) && !/Home Chalet/.test(r),
  ],
  [
    'Catch multi-query clarification -> standby',
    'ขอชี้แจงหน่อยครับ\n1. รูปห้องฮันนีมูน - แต่งพิเศษ\n2. รายละเอียดแพ็กเก็ต',
    r => /รอแป๊บนึงนะครับ/.test(r),
  ],
  [
    'Strip ลูกค้าเพิ่งเริ่ม leak',
    'สวัสดี\nลูกค้าเพิ่งเริ่มทัก ยังไม่มี context · ขอให้ลูกค้าบอก',
    r => !/ลูกค้าเพิ่งเริ่ม/.test(r) && !/ยังไม่มี/.test(r),
  ],
  [
    'Strip markdown **bold**',
    '**โปรแกรม** 2วัน1คืน เริ่ม **3,900฿**',
    r => !/\*\*/.test(r),
  ],
  [
    'Strip ห้องแต่งพิเศษสำหรับ',
    'รูปห้องฮันนีมูน ห้องแต่งพิเศษสำหรับคู่รัก',
    r => !/ห้องแต่งพิเศษสำหรับ/.test(r),
  ],
  [
    'Normal reply unchanged',
    'สวัสดีครับ 😊 ยินดีต้อนรับครับ',
    r => /สวัสดีครับ/.test(r) && /ยินดีต้อนรับ/.test(r),
  ],
];

let pass = 0;
cases.forEach(([label, input, check]) => {
  const out = sanitizeReply(input);
  const ok = check(out);
  console.log((ok ? 'PASS' : 'FAIL'), label);
  if (!ok) console.log('     in :', JSON.stringify(input).slice(0, 100));
  if (!ok) console.log('     out:', JSON.stringify(out).slice(0, 100));
  if (ok) pass++;
});
console.log('TOTAL', pass, '/', cases.length);
process.exit(pass === cases.length ? 0 : 1);
