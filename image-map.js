/**
 * fb-chat-service image-map.js · v1.4.1
 *
 * Changes from v1.4.0:
 *   - Generic room regex: removed ^anchor · added "รูปห้อง" / "ห้อง.*หน่อย" / "ดูห้อง"
 *   - Moved restaurant detection ABOVE generic room to prevent "ห้องอาหาร" → manila_deluxe
 */

const IMAGE_HOST =
  process.env.IMAGE_HOST || "https://webhook-kohtalu-production.up.railway.app";

const CATALOG = {
  manila_deluxe: [
    `${IMAGE_HOST}/images/rooms/interior/D14/1.jpg`,
    `${IMAGE_HOST}/images/rooms/interior/D14/2.jpg`,
    `${IMAGE_HOST}/images/rooms/interior/D16/1.jpg`,
  ],
  thai_style_villa: [
    `${IMAGE_HOST}/images/rooms/interior/T1-T2/1.jpg`,
    `${IMAGE_HOST}/images/rooms/exterior/T1/1.jpg`,
    `${IMAGE_HOST}/images/rooms/interior/T13-14/1.jpg`,
  ],
  thai_style_single: [
    `${IMAGE_HOST}/images/rooms/interior/T5-6/1.jpg`,
    `${IMAGE_HOST}/images/rooms/interior/T9-10/1.jpg`,
  ],
  thai_style_studio: [
    `${IMAGE_HOST}/images/rooms/interior/T15-16/1.jpg`,
    `${IMAGE_HOST}/images/rooms/interior/T17-18/1.jpg`,
  ],
  home_chalet: [
    `${IMAGE_HOST}/images/rooms/interior/R26/1.jpg`,
    `${IMAGE_HOST}/images/rooms/interior/R27/1.jpg`,
  ],
  beach_chalet: [
    `${IMAGE_HOST}/images/rooms/interior/R10/1.jpg`,
    `${IMAGE_HOST}/images/rooms/interior/R12/1.jpg`,
    `${IMAGE_HOST}/images/rooms/interior/R13-15/1.jpg`,
  ],
  snorkeling: [
    `${IMAGE_HOST}/images/activity/snorkeling/1.jpg`,
    `${IMAGE_HOST}/images/activity/snorkeling/2.jpg`,
    `${IMAGE_HOST}/images/activity/snorkeling/3.jpg`,
  ],
  sailing: [
    `${IMAGE_HOST}/images/activity/sailing/1.jpg`,
    `${IMAGE_HOST}/images/activity/sailing/2.jpg`,
  ],
  kayaking: [
    `${IMAGE_HOST}/images/activity/kayaking/1.jpg`,
    `${IMAGE_HOST}/images/activity/kayaking/2.jpg`,
  ],
  sunset_fishing: [
    `${IMAGE_HOST}/images/activity/sunset-fishing/1.jpg`,
    `${IMAGE_HOST}/images/activity/sunset-fishing/2.jpg`,
  ],
  thai_massage: [
    `${IMAGE_HOST}/images/activity/thai-massage/1.jpg`,
  ],
  restaurant: [
    `${IMAGE_HOST}/images/activity/restaurant/1.jpg`,
    `${IMAGE_HOST}/images/activity/restaurant/2.jpg`,
    `${IMAGE_HOST}/images/activity/restaurant/3.jpg`,
  ],
  top_view: [
    `${IMAGE_HOST}/images/activity/top-view/1.jpg`,
    `${IMAGE_HOST}/images/activity/top-view/2.jpg`,
  ],
  mainland_pier: [
    `${IMAGE_HOST}/images/mainland-pier/line_oa_chat_260503_112722.jpg`,
  ],
  location: [
    `${IMAGE_HOST}/images/location/line_oa_chat_250110_073932.jpg`,
  ],
};

function isImageRequest(text) {
  if (!text) return false;
  return /ขอรูป|ดูรูป|มีรูป|ส่งรูป|รูปห้อง|รูปอาหาร|รูปเกาะ|รูปบรรยากาศ|รูปกิจกรรม|รูป.*หน่อย|รูป.*ครับ|รูป.*ค่ะ|รูปไหม|photo|picture|\bpic\b|image|show.*pic|see.*pic|see.*photo/i.test(
    text
  );
}

function matchImages(text) {
  if (!text) return null;

  // Specific room types FIRST
  if (/beach[\s-]?chalet|บีชชาเล่|บีชชาเลย์|เบียช.*ชาเล่/i.test(text))
    return { category: "beach_chalet", urls: CATALOG.beach_chalet };
  if (/home[\s-]?chalet|เรือนไทย|home$|^home\b/i.test(text))
    return { category: "home_chalet", urls: CATALOG.home_chalet };
  if (/manila|มะนิลา|มานิลา|deluxe|ดีลัก|ดีลักซ์/i.test(text))
    return { category: "manila_deluxe", urls: CATALOG.manila_deluxe };

  // Thai Style sub-types
  if (/thai[\s-]?style[\s-]?(studio|connecting)|studio.*ห้อง/i.test(text))
    return { category: "thai_style_studio", urls: CATALOG.thai_style_studio };
  if (/thai[\s-]?style[\s-]?(single|เดี่ยว|1\s*คน)/i.test(text))
    return { category: "thai_style_single", urls: CATALOG.thai_style_single };
  if (/thai[\s-]?style|ไทยสไตล์|ไทย[\s]?style|ocean[\s-]?villa|ocean.*family/i.test(text))
    return { category: "thai_style_villa", urls: CATALOG.thai_style_villa };

  // Activities
  if (/snorkel|ดำน้ำตื้น|ดำน้ำ|ปะการัง|coral|skin[\s-]?dive/i.test(text))
    return { category: "snorkeling", urls: CATALOG.snorkeling };
  if (/sailing|เรือใบ|ล่องเรือใบ/i.test(text))
    return { category: "sailing", urls: CATALOG.sailing };
  if (/kayak|คายัค|คายัก|paddle|sup\b|stand[\s-]?up/i.test(text))
    return { category: "kayaking", urls: CATALOG.kayaking };
  if (/ตกหมึก|หมึก|squid|fishing|พระอาทิตย์ตก|sunset|sunset[\s-]?cruise/i.test(text))
    return { category: "sunset_fishing", urls: CATALOG.sunset_fishing };
  if (/นวด.*ไทย|thai[\s-]?massage|spa|สปา|นวด/i.test(text))
    return { category: "thai_massage", urls: CATALOG.thai_massage };

  // Location/scenic
  if (/บรรยากาศ|ทิวทัศน์|วิวเกาะ|top[\s-]?view|จุดชมวิว|landscape|scenic/i.test(text))
    return { category: "top_view", urls: CATALOG.top_view };
  if (/ท่าเรือ|pier|บ้านมะพร้าว|mainland|จุดขึ้นเรือ/i.test(text))
    return { category: "mainland_pier", urls: CATALOG.mainland_pier };
  if (/แผนที่|map|location|พิกัด|directions/i.test(text))
    return { category: "location", urls: CATALOG.location };

  // ⚠️ Restaurant/food MUST come BEFORE generic room (so "ห้องอาหาร" matches restaurant)
  if (/ห้องอาหาร|อาหาร|ร้านอาหาร|restaurant|food|menu|เมนู|ของกิน/i.test(text))
    return { category: "restaurant", urls: CATALOG.restaurant };

  // v1.4.1: Generic room request — removed ^anchor · expanded keywords
  // Now matches "ขอรูปห้อง", "ห้องไหน", "ห้องพัก", "ดูห้อง", "room", etc.
  if (/รูปห้อง|ห้องพัก|ห้องไหน|ดูห้อง|ห้อง.*หน่อย|มีห้อง|ห้องอะไร|room|accommodation/i.test(text))
    return { category: "manila_deluxe", urls: CATALOG.manila_deluxe };

  return null;
}

module.exports = { isImageRequest, matchImages, IMAGE_HOST, CATALOG };
