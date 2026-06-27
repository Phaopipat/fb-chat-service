'use strict';
// image-map.js — maps customer queries → Railway image URLs
// BASE_URL is set via env or defaults to Railway service URL.
//
// PATCHED 2026-05-13 (Phase 2.5B Plan D MVP):
//   • ROOM_TO_GROUP expanded: D1-D16 unified to D14, D17-D18 = Honeymoon, T7-T8, R-series expanded
//   • TYPE_INTERIOR adds sub-types: thai_style_family/single/studio + honeymoon
//   • ACTIVITY adds: beach-volleyball + flyer-included + flyer-optional
//   • New LOCATION map: island + mainland-pier
//   • lookupByLocation() public function added
//   • matchImages() new branches: location/pier/flyer/sub-types
//   • isImageRequest() expanded patterns: ห้องพัก/ห้องน้ำ/family/honeymoon/studio/single/แผนที่/ท่าเรือ/flyer/volleyball
// Defensive: Railway's RAILWAY_STATIC_URL is hostname-only (no scheme).
// LINE Messaging API rejects URLs without https://. Force scheme.
const _BASE_URL_RAW = (process.env.SERVICE_URL || process.env.RAILWAY_STATIC_URL || process.env.BASE_URL || 'https://webhook-kohtalu-production.up.railway.app').replace(/\/$/, '');
const BASE_URL = /^https?:\/\//i.test(_BASE_URL_RAW) ? _BASE_URL_RAW : 'https://' + _BASE_URL_RAW;
console.log(`[image-map] BASE_URL=${BASE_URL}`);  // surface at startup for debugging
function url(p) { return `${BASE_URL}/images/${p}`; }
// Build URL arrays for each folder by counting files at startup.
// Falls back gracefully if a folder is missing (e.g. on fresh clone before copy-photos).
const fs = require('fs');
const path = require('path');
const PUBLIC = path.join(__dirname, 'public', 'images');
function folderUrls(relPath, prefix) {
  const dir = path.join(PUBLIC, relPath);
  try {
    return fs.readdirSync(dir)
      .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
      .sort((a, b) => parseInt(a) - parseInt(b))
      .map(f => url(`${prefix}/${f}`));
  } catch { return []; }
}
// ── Room Interior ─────────────────────────────────────────────────────────────
const INTERIOR = {
  'T1-T2':  folderUrls('rooms/interior/T1-T2',  'rooms/interior/T1-T2'),
  'T3-4':   folderUrls('rooms/interior/T3-4',   'rooms/interior/T3-4'),   // not in source but in exterior
  'T3':     folderUrls('rooms/interior/T3',     'rooms/interior/T3'),
  'T4':     folderUrls('rooms/interior/T4',     'rooms/interior/T4'),
  'T5-6':   folderUrls('rooms/interior/T5-6',   'rooms/interior/T5-6'),
  'T9-10':  folderUrls('rooms/interior/T9-10',  'rooms/interior/T9-10'),
  'T11-12': folderUrls('rooms/interior/T11-12', 'rooms/interior/T11-12'),
  'T13-14': folderUrls('rooms/interior/T13-14', 'rooms/interior/T13-14'),
  'T15-16': folderUrls('rooms/interior/T15-16', 'rooms/interior/T15-16'),
  'T17-18': folderUrls('rooms/interior/T17-18', 'rooms/interior/T17-18'),
  'D14':    folderUrls('rooms/interior/D14',    'rooms/interior/D14'),
  'D16':    folderUrls('rooms/interior/D16',    'rooms/interior/D16'),
  // Phase 2.5B Plan D: Honeymoon Ocean Front (different from D1-D16, private balcony)
  // ⚠️ Photos not yet taken — folder will be empty until admin uploads.
  'D17-18': folderUrls('rooms/interior/D17-18', 'rooms/interior/D17-18'),
  'R10':    folderUrls('rooms/interior/R10',    'rooms/interior/R10'),
  'R11':    folderUrls('rooms/interior/R11',    'rooms/interior/R11'),
  'R12':    folderUrls('rooms/interior/R12',    'rooms/interior/R12'),
  'R20':    folderUrls('rooms/interior/R20',    'rooms/interior/R20'),
  'R21':    folderUrls('rooms/interior/R21',    'rooms/interior/R21'),
  'R22-23': folderUrls('rooms/interior/R22-23', 'rooms/interior/R22-23'),
  'R24':    folderUrls('rooms/interior/R24',    'rooms/interior/R24'),
  'R25':    folderUrls('rooms/interior/R25',    'rooms/interior/R25'),
  'R26':    folderUrls('rooms/interior/R26',    'rooms/interior/R26'),
  'R27':    folderUrls('rooms/interior/R27',    'rooms/interior/R27'),
  'R28-31': folderUrls('rooms/interior/R28-31', 'rooms/interior/R28-31'),
  'R32-34': folderUrls('rooms/interior/R32-34', 'rooms/interior/R32-34'),
};
// ── Room Exterior ─────────────────────────────────────────────────────────────
const EXTERIOR = {
  'T1':     folderUrls('rooms/exterior/T1',     'rooms/exterior/T1'),
  'T3-4':   folderUrls('rooms/exterior/T3-4',   'rooms/exterior/T3-4'),
  'T12':    folderUrls('rooms/exterior/T12',    'rooms/exterior/T12'),
  'T13-14': folderUrls('rooms/exterior/T13-14', 'rooms/exterior/T13-14'),
  'D5-8':   folderUrls('rooms/exterior/D5-8',   'rooms/exterior/D5-8'),
  'D17-18': folderUrls('rooms/exterior/D17-18', 'rooms/exterior/D17-18'),
  'R10-12': folderUrls('rooms/exterior/R10-12', 'rooms/exterior/R10-12'),
  'R13-15': folderUrls('rooms/exterior/R13-15', 'rooms/exterior/R13-15'),
  'R22-23': folderUrls('rooms/exterior/R22-23', 'rooms/exterior/R22-23'),
  'R26':    folderUrls('rooms/exterior/R26',    'rooms/exterior/R26'),
  'R28-31': folderUrls('rooms/exterior/R28-31', 'rooms/exterior/R28-31'),
};
// ── Activity ──────────────────────────────────────────────────────────────────
const ACTIVITY = {
  kayaking:           folderUrls('activity/kayaking',         'activity/kayaking'),
  snorkeling:         folderUrls('activity/snorkeling',       'activity/snorkeling'),
  diving:             folderUrls('activity/snorkeling',       'activity/snorkeling'),
  sailing:            folderUrls('activity/sailing',          'activity/sailing'),
  'sunset-fishing':   folderUrls('activity/sunset-fishing',   'activity/sunset-fishing'),
  restaurant:         folderUrls('activity/restaurant',       'activity/restaurant'),
  massage:            folderUrls('activity/thai-massage',     'activity/thai-massage'),
  'top-view':         folderUrls('activity/top-view',         'activity/top-view'),
  landscape:          folderUrls('activity/landscape',        'activity/landscape'),
  // Phase 2.5B Plan D additions:
  'beach-volleyball': folderUrls('activity/beach-volleyball', 'activity/beach-volleyball'),
  'flyer-included':   folderUrls('activity/included-flyer',   'activity/included-flyer'),
  'flyer-optional':   folderUrls('activity/optional-flyer',   'activity/optional-flyer'),
  // Day 8 2026-06-06 additions:
  'beach-bar':        folderUrls('activity/beach-bar',        'activity/beach-bar'),
  'swimming-pool':    folderUrls('activity/swimming-pool',    'activity/swimming-pool'),
  // Day 13 2026-06-19 additions (Dive Center BU + Turtle nursing photos):
  'dive':             folderUrls('dive',                      'dive'),
  'turtle':           folderUrls('activity/turtle-activities','activity/turtle-activities'),
};
// ── Location / logistics (Phase 2.5B Plan D — new) ────────────────────────────
const LOCATION = {
  island:          folderUrls('location',       'location'),
  'mainland-pier': folderUrls('mainland-pier',  'mainland-pier'),
  'baan-maprao':   folderUrls('mainland/baan-maprao', 'mainland/baan-maprao'),  // Train pickup campaign 2026-06-15 · Day Use bungalow
};
// ── Room number → folder key ──────────────────────────────────────────────────
// Maps individual room number → which folder group it belongs to.
// PATCHED Phase 2.5B Plan D — cross-checked vs Excel "Koh Taluu (selected room)".
const ROOM_TO_GROUP = {
  // ─── Thai Style (อ่าวใหญ่) — T-series ─────────────────────────────
  T1:  'T1-T2',  T2:  'T1-T2',
  T3:  'T3',     T4:  'T4',
  T5:  'T5-6',   T6:  'T5-6',
  T7:  'T5-6',   T8:  'T5-6',     // Plan D: T7/T8 are Single rooms like T5/T6 — reuse photos
  T9:  'T9-10',  T10: 'T9-10',
  T11: 'T11-12', T12: 'T11-12',
  T13: 'T13-14', T14: 'T13-14',
  T15: 'T15-16', T16: 'T15-16',
  T17: 'T17-18', T18: 'T17-18',
  // ─── Manila Deluxe (อ่าวใหญ่) — D-series ───────────────────────────
  // Plan D + Phao 2026-05-13: D1-D16 interior-identical → all map to D14
  D1:  'D14',   D2:  'D14',   D3:  'D14',   D4:  'D14',
  D5:  'D14',   D6:  'D14',   D7:  'D14',   D8:  'D14',
  D9:  'D14',   D10: 'D14',   D11: 'D14',   D12: 'D14',
  D13: 'D14',   D14: 'D14',   D15: 'D14',   D16: 'D14',
  // D17-D18 = Honeymoon Ocean Front (different layout, private balcony)
  D17: 'D17-18', D18: 'D17-18',
  // ─── Beach Chalet / Home (อ่าวมุก) — R-series ──────────────────────
  // Beach Chalet 1/2/3 use three canonical layouts.
  // Phao 2026-06-18: BC1=BC2=BC3 · R13/R16=R10, R14/R17=R11, R15/R18=R12.
  R10: 'R10',    R11: 'R11',    R12: 'R12',
  R13: 'R10',    R14: 'R11',    R15: 'R12',
  R16: 'R10',    R17: 'R11',    R18: 'R12',
  // Two story house
  R22: 'R22-23', R23: 'R22-23',
  // Family Thai Style Villa / Biggest Room / grouped houses
  R20: 'R20',    R21: 'R21',
  R24: 'R24',    R25: 'R25',
  R28: 'R28-31', R29: 'R28-31', R30: 'R28-31', R31: 'R28-31',
  R32: 'R32-34', R33: 'R32-34', R34: 'R32-34',
  // Single rooms
  R26: 'R26',    R27: 'R27',
};
// Room type → list of all interior folder keys for that type
// Plan D: added sub-types for Thai Style (Family / Single / Studio) + Honeymoon
const TYPE_INTERIOR = {
  thai_style:        ['T1-T2','T3','T4','T5-6','T9-10','T11-12','T13-14','T15-16','T17-18'],
  thai_style_family: ['T1-T2','T3','T4'],         // T1-T4 = 2-King Family Villa
  thai_style_single: ['T5-6','T9-10','T11-12'],   // T5-T12 = Thai Style Single (T7-8 reuse T5-6 via ROOM_TO_GROUP)
  thai_style_studio: ['T13-14','T15-16','T17-18'], // T13-T18 = Studio variants
  manila_deluxe:     ['D14','D16'],
  honeymoon:         ['D17-18'],                  // D17-D18 Ocean Front (private balcony)
  // อ่าวมุก R-series · admin terminology distinguishes 4 types:
  beach_chalet:      ['R10','R11','R12'],           // R10-R18 = BC1/BC2/BC3, three canonical layouts
  family_villa_amuk: ['R20','R21'],                // R20-R21 = Family Thai Style Villa (อ่าวมุก)
  two_story_house:   ['R22-23'],                   // R22-R23 = Two Story House (TopRoom + BottomRoom)
  biggest_room:      ['R24','R25'],                // R24-R25 = Biggest Room (3 King · 3 pax)
  single_amuk:       ['R26'],                      // R26 = Single Room (อ่าวมุก)
  single_beachfront: ['R27'],                      // R27 = Single Room Beach Front
  house_4br_amuk:    ['R28-31'],                   // R28-R31 = connected 4BR house, 2 floors
  house_2story_amuk: ['R32-34'],                   // R32-R34 = 2-story house, shared upstairs bathroom
};
const TYPE_EXTERIOR = {
  thai_style:    ['T1','T3-4','T12','T13-14'],
  manila_deluxe: ['D5-8'],
  beach_chalet:  ['R10-12'],
  honeymoon:     ['D17-18'],
  two_story_house: ['R22-23'],
  single_amuk: ['R26'],
  house_4br_amuk: ['R28-31'],
};
// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Look up images for a specific room number.
 * Returns { interior: string[], exterior: string[] }
 */
function lookupByRoomNumber(roomNum) {
  const key = String(roomNum).toUpperCase().trim();  // "t15" → "T15"
  const group = ROOM_TO_GROUP[key];
  if (!group) return { interior: [], exterior: [] };
  let interior = INTERIOR[group] || [];
  let exterior = EXTERIOR[group] || EXTERIOR[key] || [];
  return { interior, exterior };
}
/**
 * Look up images by room type + category.
 * type: 'thai_style' | 'manila_deluxe' | 'beach_chalet' | 'thai_style_family'
 *       | 'thai_style_single' | 'thai_style_studio' | 'honeymoon'
 * category: 'interior' | 'exterior' | 'both'
 * Returns up to maxPerGroup images from each folder (avoids flooding chat).
 */
function lookupByRoomType(type, category = 'interior', maxPerGroup = 4) {
  const result = [];
  const typeKey = type.toLowerCase().replace(/\s+/g, '_');
  if (category === 'interior' || category === 'both') {
    const groups = TYPE_INTERIOR[typeKey] || [];
    groups.forEach(g => result.push(...(INTERIOR[g] || []).slice(0, maxPerGroup)));
  }
  if (category === 'exterior' || category === 'both') {
    const groups = TYPE_EXTERIOR[typeKey] || [];
    groups.forEach(g => result.push(...(EXTERIOR[g] || []).slice(0, maxPerGroup)));
  }
  return result;
}
/**
 * Look up activity images.
 * activity: 'kayaking' | 'snorkeling' | 'diving' | 'sailing' | 'sunset-fishing'
 *         | 'restaurant' | 'massage' | 'top-view' | 'landscape'
 *         | 'beach-volleyball' | 'flyer-included' | 'flyer-optional'
 * Returns up to max images.
 */
function lookupByActivity(activity, max = 6) {
  const key = activity.toLowerCase().replace(/\s+/g, '-');
  return (ACTIVITY[key] || []).slice(0, max);
}
/**
 * Look up location/logistics images (Phase 2.5B Plan D — new).
 * key: 'island' | 'mainland-pier'
 */
function lookupByLocation(key, max = 5) {
  const k = key.toLowerCase().trim();
  return (LOCATION[k] || []).slice(0, max);
}
/**
 * Parse a customer message and return matching image URLs.
 * Returns { images: string[], caption: string } or null if no match.
 */
function matchImages(text) {
  const t = text;
  // V58c (Bug 7): bathroom-specific query without explicit photo intent → return null
  // Prevents returning bedroom photos when customer asks about bathroom amenities.
  // Lets V64 ROOM_AMENITY_CANONICAL_V64 prompt rule handle bathroom text reply.
  if (/ห้องน้ำ/i.test(t) && !/(?:รูป|ภาพ|photo|picture|image|ดู.*รูป|ดู.*ภาพ)/i.test(t)) {
    return null;
  }
  // อ่าวมุก room-specific routes (each different · explicit caption required per admin)
  if (/two[\s-]?story|2[\s-]?story|toproom|bottomroom|\br22\b|\br23\b/i.test(t)) {
    const images = lookupByRoomType('two_story_house', 'interior');
    if (images.length) return { images: images.slice(0, 4), caption: 'รูปห้อง Two Story House (R22-R23 · อ่าวมุก · ห้องบน+ห้องล่าง คล้ายกัน) ครับ 🛖' };
  }
  if (/\br26\b|single.*อ่าวมุก|single.*ao\s*muk/i.test(t)) {
    const images = lookupByRoomType('single_amuk', 'interior');
    if (images.length) return { images: images.slice(0, 4), caption: 'รูปห้อง Single Room R26 (อ่าวมุก) ครับ 🛖' };
  }
  if (/\br27\b|beach[\s-]?front|บีชฟร้อนท์|หน้าหาด/i.test(t)) {
    const images = lookupByRoomType('single_beachfront', 'interior');
    if (images.length) return { images: images.slice(0, 4), caption: 'รูปห้อง Single Room Beach Front R27 (อ่าวมุก) ครับ 🛖' };
  }
  if (/\br20\b/i.test(t)) {
    const { interior } = lookupByRoomNumber('R20');
    if (interior.length) return { images: interior.slice(0, 5), caption: 'ห้อง Family Thai Style Villa R20 (อ่าวมุก · 3 ท่าน) ครับ 🛖' };
  }
  if (/\br21\b/i.test(t)) {
    const { interior } = lookupByRoomNumber('R21');
    if (interior.length) return { images: interior.slice(0, 5), caption: 'ห้อง Family Thai Style Villa R21 (อ่าวมุก) ครับ 🛖' };
  }
  if (/family.*(?:อ่าวมุก|ao\s*muk)|(?:อ่าวมุก|ao\s*muk).*family/i.test(t)) {
    const images = lookupByRoomType('family_villa_amuk', 'interior');
    if (images.length) return { images: images.slice(0, 6), caption: 'ห้อง Family Thai Style Villa R20-R21 (อ่าวมุก) ครับ 🛖' };
  }
  if (/\br24\b/i.test(t)) {
    const { interior } = lookupByRoomNumber('R24');
    if (interior.length) return { images: interior.slice(0, 5), caption: 'ห้อง Biggest Room R24 (อ่าวมุก · 3 King · 3 ท่าน) ครับ 🛖' };
  }
  if (/\br25\b/i.test(t)) {
    const { interior } = lookupByRoomNumber('R25');
    if (interior.length) return { images: interior.slice(0, 5), caption: 'ห้อง Biggest Room R25 (อ่าวมุก · 3 King · 3 ท่าน) ครับ 🛖' };
  }
  if (/biggest\s*room|ห้องใหญ่สุด|biggest/i.test(t)) {
    const images = lookupByRoomType('biggest_room', 'interior');
    if (images.length) return { images: images.slice(0, 6), caption: 'ห้อง Biggest Room R24-R25 (อ่าวมุก · 3 King · 3 ท่าน) ครับ 🛖' };
  }
  if (/\br2[89]\b|\br3[01]\b|4\s*ห้อง|four[\s-]?bed|4br|บ้าน.*4/i.test(t)) {
    const images = lookupByRoomType('house_4br_amuk', 'interior');
    if (images.length) return { images: images.slice(0, 6), caption: 'บ้าน 4 ห้องนอนเชื่อมกัน 2 ชั้น (อ่าวมุก · R28-29 ชั้นล่าง · R30-31 ชั้นบน) ครับ 🛖' };
  }
  if (/\br3[2-4]\b|r32[\s-]*34|บ้าน.*2\s*ชั้น|2\s*ชั้น.*อ่าวมุก/i.test(t)) {
    const images = lookupByRoomType('house_2story_amuk', 'interior');
    if (images.length) return { images: images.slice(0, 6), caption: 'บ้าน 2 ชั้น (อ่าวมุก · R32 ชั้นล่าง · R33-34 ชั้นบน · ห้องน้ำรวมชั้นบน) ครับ 🛖' };
  }
  // ── Specific room number query ────────────────────────────────────────────
  // "ห้อง T15", "ดูรูป T15-16", "room T15 ภายใน"
  const roomMatch = t.match(/(?:ห้อง|room\s*)?([TDRtdr]\d{1,2})(?:\s|$)/i);
  if (roomMatch) {
    const roomNum = roomMatch[1].toUpperCase();
    const wantsExterior = /ภายนอก|exterior|นอก|หน้าห้อง|outside/i.test(t);
    const wantsInterior = /ภายใน|interior|ใน|inside/i.test(t) || !wantsExterior;
    const { interior, exterior } = lookupByRoomNumber(roomNum);
    const images = wantsExterior
      ? (exterior.length ? exterior : interior)
      : interior;
    if (images.length) {
      const catLabel = wantsExterior ? 'ภายนอก' : 'ภายใน';
      return { images: images.slice(0, 5), caption: `รูปห้อง ${roomNum} (${catLabel})` };
    }
  }
  // ── Room type query ───────────────────────────────────────────────────────
  const isThai    = /thai\s*style|ไทยสไตล์|ทรงไทย/i.test(t);
  const isDeluxe  = /manila|deluxe|มะนิลา|มะลิลา|มานิลา|ดีลักซ์|ดีลัก|เดอลุกซ์/i.test(t);
  const isChalet  = /beach\s*chalet|ชาเลต์?|chalet|บีชชาเล/i.test(t);
  // Day 9 PM Bug #14 follow-up: "Home" alone routes to Beach Chalet (closest match · อ่าวมุก)
  const isHomeGeneric = /\bhome\b|เรือนไทย|รูป\s*Home/i.test(t) && !isThai && !isDeluxe;
  const wantsExtCategory = /ภายนอก|exterior|นอก|หน้าห้อง/i.test(t);
  const cat = wantsExtCategory ? 'exterior' : 'interior';
  // ── Multi room-type query (Bug #21) ───────────────────────────────────────
  // When a customer names ≥2 room types in one message (e.g. "ขอรูป Manila กับ Home",
  // "อยากดูห้อง Manila Deluxe และ Beach Chalet", "รูป มะนิลา ไทยสไตล์ บีชชาเล่ต์")
  // we must return images for EVERY type mentioned — not just the first one matched.
  // Historically the single-type branches below `return` on the first match, so only
  // one type ever surfaced. This block aggregates across all named types first.
  //
  // Order: detection order is fixed (Thai → Manila → Beach Chalet/Home) so output is
  // stable & deterministic regardless of how the customer ordered them in the message.
  // "Home" is treated as Beach Chalet (อ่าวมุก) per existing isHomeGeneric semantics,
  // and is de-duplicated against an explicit Beach Chalet mention.
  // Cap: LINE allows 5 images/message; we cap the COMBINED set at MULTI_TYPE_CAP (6,
  // matching the single-type branches) and slice per type so each named type appears.
  {
    const MULTI_TYPE_CAP = 6;
    // Raw "Home" signal — independent of isHomeGeneric's single-type suppression
    // clause (which is false whenever Thai/Manila also appears). For multi-type we
    // WANT "Home" to count even alongside Manila (e.g. "ขอรูป Manila กับ Home").
    const mentionsHome = /\bhome\b|เรือนไทย|รูป\s*Home/i.test(t);
    const wantedTypes = [];       // [{ key, label }] in fixed detection order
    if (isThai)                          wantedTypes.push({ key: 'thai_style',   label: 'Thai Style' });
    if (isDeluxe)                        wantedTypes.push({ key: 'manila_deluxe', label: 'Manila Deluxe' });
    if (isChalet || mentionsHome)        wantedTypes.push({ key: 'beach_chalet',  label: isChalet ? 'Beach Chalet' : 'Home / Beach Chalet' });
    if (wantedTypes.length >= 2) {
      // Distribute the cap across the named types so each one is represented.
      const perType = Math.max(1, Math.floor(MULTI_TYPE_CAP / wantedTypes.length));
      const seen = new Set();
      const images = [];
      const labels = [];
      for (const { key, label } of wantedTypes) {
        const typeImgs = lookupByRoomType(key, cat, perType);
        if (typeImgs.length) labels.push(label);
        for (const u of typeImgs) {
          if (images.length >= MULTI_TYPE_CAP) break;
          if (seen.has(u)) continue;   // dedup (same folder named twice / Home==Chalet)
          seen.add(u);
          images.push(u);
        }
      }
      if (images.length) {
        const catLabel = cat === 'exterior' ? 'ภายนอก' : 'ภายใน';
        return {
          images: images.slice(0, MULTI_TYPE_CAP),
          caption: `รูปห้องพัก ${labels.join(' · ')} (${catLabel}) ครับ 🏠`,
        };
      }
    }
  }
  if (isThai) {
    const images = lookupByRoomType('thai_style', cat);
    if (images.length) return { images: images.slice(0, 6), caption: `รูป Thai Style (${cat === 'exterior' ? 'ภายนอก' : 'ภายใน'})` };
  }
  if (isDeluxe) {
    const images = lookupByRoomType('manila_deluxe', cat);
    if (images.length) return { images: images.slice(0, 6), caption: `รูป Manila Deluxe (${cat === 'exterior' ? 'ภายนอก' : 'ภายใน'})` };
  }
  if (isChalet) {
    const images = lookupByRoomType('beach_chalet', cat);
    if (images.length) return { images: images.slice(0, 6), caption: `รูป Beach Chalet R10-R18 (${cat === 'exterior' ? 'ภายนอก' : 'ภายใน'})` };
  }
  // Day 9 PM Bug #14 follow-up: "Home" → show อ่าวมุก samples now that R20-R34 photos are available
  if (isHomeGeneric) {
    const images = [
      ...lookupByRoomType('beach_chalet', cat, 1),
      ...lookupByRoomType('family_villa_amuk', 'interior', 1),
      ...lookupByRoomType('biggest_room', 'interior', 1),
      ...lookupByRoomType('house_4br_amuk', 'interior', 1),
      ...lookupByRoomType('house_2story_amuk', 'interior', 1),
    ].filter(Boolean);
    if (images.length) return { images: images.slice(0, 5), caption: 'รูป Home / Beach Chalet ฝั่งอ่าวมุกครับ 🛖 — มีหลายแบบ เช่น Beach Chalet, Family Villa, Biggest Room และบ้าน 2 ชั้นครับ' };
  }
  // V58b: "ห้องพักทุกแบบ" / "ห้องพักทั้งหมด" / "ทุกห้อง" → return one sample from each main type
  if (!/กิจกรรม|activity/i.test(t) && /ทุก(?:ห้อง|แบบ|อย่าง)|ห้องพัก(?:ทุก|ทั้งหมด)|ทั้งหมด.*ห้องพัก|ห้องพักมี(?:อะไร|ไหน)บ้าง/i.test(t)) {
    // V58c (Bug 8): 1 image per type · all 3 visible · LINE max 5 with budget for cooperation.
    const thaiSample = lookupByRoomType('thai_style', 'interior').slice(0, 1);
    const manilaSample = lookupByRoomType('manila_deluxe', 'interior').slice(0, 1);
    const chaletSample = lookupByRoomType('beach_chalet', 'interior').slice(0, 1);
    const images = [...thaiSample, ...manilaSample, ...chaletSample];
    if (images.length) {
      return {
        images: images.slice(0, 5),  // safe under LINE limit
        caption: 'รูปห้องพักรวมทุกแบบครับ 🏠\n1️⃣ Thai Style Ocean Villa (อ่าวใหญ่)\n2️⃣ Manila Deluxe Chalet (อ่าวใหญ่)\n3️⃣ Home / Beach Chalet (อ่าวมุก)',
      };
    }
  }
  // ── Sub-type queries (Phase 2.5B Plan D) ──────────────────────────────────
  if (/family\s*villa|family\s*room|\bfamily\b|ห้อง.*family|family.*ห้อง|วิลล่าครอบครัว/i.test(t)) {
    const images = lookupByRoomType('thai_style_family', 'interior');
    if (images.length) return { images: images.slice(0, 6), caption: 'รูป Thai Style Family Villa (อ่าวใหญ่) ครับ' };
  }
  if (/honeymoon|ฮันนีมูน|ocean\s*front|private\s*balcony|ระเบียงส่วนตัว/i.test(t)) {
    const isExt = /ภายนอก|exterior|ด้านนอก|รอบนอก|outside/i.test(t);
    const cat = isExt ? 'exterior' : 'interior';
    const images = lookupByRoomType('honeymoon', cat);
    const caption = isExt
      ? 'รูป Honeymoon Ocean Front (ภายนอก · อ่าวใหญ่) ครับ 🌅'
      : 'รูป Honeymoon Ocean Front (อ่าวใหญ่) ครับ 🌅';
    if (images.length) return { images: images.slice(0, 6), caption };
    // Honeymoon photos missing → return null so caller escalates instead of fabricating
  }
  if (/studio|สตูดิโอ/i.test(t)) {
    const images = lookupByRoomType('thai_style_studio', 'interior');
    if (images.length) return { images: images.slice(0, 6), caption: 'รูป Thai Style Studio (อ่าวใหญ่) ครับ' };
  }
  if (/single\s*room|ห้องเดี่ยว|ห้องสำหรับ\s*1\s*คน|ห้องเล็ก|พักเดี่ยว/i.test(t)) {
    const images = lookupByRoomType('thai_style_single', 'interior');
    if (images.length) return { images: images.slice(0, 6), caption: 'รูปห้องบ้านไทย ห้องเล็ก (อ่าวใหญ่) ครับ 🏡' };
  }
  // ── Activity query ────────────────────────────────────────────────────────
  // Day 13 2026-06-19: Dive Center BU (scuba) — must precede snorkeling branch
  // Routes scuba-specific terms (Try Dive · Fun Dive · OW · Skin Diving · ดำน้ำลึก)
  // away from snorkeling (which is the free-in-package ดำน้ำตื้น activity).
  if (/try\s*dive|fun\s*dive|open\s*water|\bow\s*course\b|\baow\b|advance\s*ow|scuba|skin\s*div|ดำน้ำลึก|สกินไดฟ์|สกินไดฟ?วิ่ง|คอร์ส.*ดำน้ำ|ดำน้ำ.*คอร์ส/i.test(t)) {
    const images = lookupByActivity('dive');
    if (images.length) return { images, caption: 'รูปกิจกรรม Dive Center (Scuba · Try Dive · Fun Dive · Open Water) ครับ 🤿' };
  }
  if (/ดำน้ำ|snorkel|diving|ดำน้ำตื้น/i.test(t)) {
    const images = lookupByActivity('snorkeling');
    if (images.length) return { images, caption: 'รูปกิจกรรมดำน้ำตื้น / Snorkeling & Diving' };
  }
  if (/คายัค|kayak/i.test(t)) {
    const images = lookupByActivity('kayaking');
    if (images.length) return { images, caption: 'รูปกิจกรรม Kayaking' };
  }
  if (/เรือใบ|sail/i.test(t)) {
    const images = lookupByActivity('sailing');
    if (images.length) return { images, caption: 'รูปกิจกรรม Sailing' };
  }
  if (/ตกปลา|sunset|ชมพระอาทิตย์ตก/i.test(t)) {
    const images = lookupByActivity('sunset-fishing');
    if (images.length) return { images, caption: 'รูป Sunset Cruise & Fishing' };
  }
  if (/บาร์|beach\s*bar|\bbar\b/i.test(t)) {
    const images = lookupByActivity('beach-bar');
    if (images.length) return { images, caption: 'รูป Beach Bar' };
  }
  if (/สระ(?:ว่ายน้ำ)?|swimming\s*pool|\bpool\b/i.test(t)) {
    const images = lookupByActivity('swimming-pool');
    if (images.length) return { images, caption: 'รูป Swimming Pool' };
  }
  if (/ร้านอาหาร|big bay|อาหาร|restaurant/i.test(t)) {
    const images = lookupByActivity('restaurant');
    if (images.length) return { images, caption: 'รูป Big Bay Restaurant' };
  }
  if (/นวด|massage/i.test(t)) {
    const images = lookupByActivity('massage');
    if (images.length) return { images, caption: 'รูป Thai Massage' };
  }
  if (/top\s*view|มุมสูง|วิว|ทิวทัศน์/i.test(t)) {
    const images = lookupByActivity('top-view');
    if (images.length) return { images, caption: 'รูป Koh Talu Top View' };
  }
  // ── Location / map / how-to-get-here (Phase 2.5B Plan D) ──────────────────
  if (/แผนที่|ที่ตั้ง|เกาะอยู่ที่ไหน|location|map|ทำเล/i.test(t)) {
    const images = lookupByLocation('island');
    if (images.length) return { images, caption: 'รูปแสดงที่ตั้งเกาะทะลุครับ 📍' };
  }
  // ── Baan Maprao bungalow (mainland Day Use room) — Train pickup campaign 2026-06-15 ──
  // Must come BEFORE pier branch · disambiguates Day Use bungalow from boat pier
  if (/บ้านมะพร้าว.*(?:day\s*use|day-use|รายวัน|บังกะโล|พักรอ|พัก|ห้องพัก|รอ\s*รถ)|baan\s*maprao|ห้องบ้านมะพร้าว|บังกะโลฝั่ง|ฝั่งแผ่นดิน.*ห้อง/i.test(t)) {
    const images = lookupByLocation('baan-maprao');
    if (images.length) return { images: images.slice(0, 5), caption: 'รูปบ้านมะพร้าว · ห้องพักริมทะเลฝั่งแผ่นดิน (Day Use) ครับ 🌊🌴' };
  }
  // ── Mainland pier / ท่าเรือ ───────────────────────────────────────────────
  if (/ท่าเรือ|บ้านมะพร้าว|จุดขึ้นเรือ|pier|mainland|ขึ้นเรือ/i.test(t)) {
    const images = lookupByLocation('mainland-pier');
    if (images.length) return { images, caption: 'รูปท่าเรือบ้านมะพร้าว (จุดขึ้นเรือ) ครับ ⛴️' };
  }
  // ── Activity flyer (welcome pack / itinerary) ─────────────────────────────
  if (/flyer|ใบปลิว|ตารางกิจกรรม|รายการกิจกรรม|กิจกรรม(?:ที่)?รวม|กิจกรรม(?:เสริม|พิเศษ|เพิ่ม)|กิจกรรม(?:ทุก|ทั้งหมด)|ทุก(?:กิจกรรม|อย่าง|แบบ)|optional/i.test(t)) {
    const wantsOptional = /optional|เสริม|พิเศษ|เพิ่ม/i.test(t);
    const images = lookupByActivity(wantsOptional ? 'flyer-optional' : 'flyer-included');
    if (images.length) {
      const caption = wantsOptional
        ? 'รูปกิจกรรมเสริม (Optional) ครับ'
        : 'รูปกิจกรรมที่รวมในแพ็กเกจครับ';
      return { images, caption };
    }
  }
  // ── Beach volleyball ──────────────────────────────────────────────────────
  if (/วอลเลย์|volleyball|วอลเลย์บอล/i.test(t)) {
    const images = lookupByActivity('beach-volleyball');
    if (images.length) return { images, caption: 'รูปกิจกรรม Beach Volleyball ครับ 🏐' };
  }
  // ─── Tier 4 branches ──────────────────────────────────────────────────────
  // Atmosphere / scenery / view — combine top-view + landscape for fuller experience
  if (/บรรยากาศ|scenery|atmosphere|ทิวทัศน์|วิวเกาะ|วิวรอบ/i.test(t)) {
    const topViewPics = lookupByActivity('top-view').slice(0, 3);
    const landscapePics = lookupByActivity('landscape').slice(0, 2);
    const images = [...topViewPics, ...landscapePics];
    if (images.length) return { images, caption: 'รูปบรรยากาศเกาะทะลุครับ 🌴' };
  }
  // Food / menu / meals — use restaurant folder (mixed food + ambience)
  if (/อาหาร|เมนู|มื้อ|\bfood\b|\bmenu\b|breakfast|dinner|lunch/i.test(t)) {
    const images = lookupByActivity('restaurant').slice(0, 5);
    if (images.length) return { images, caption: 'รูปอาหารและห้องอาหาร Big Bay ครับ 🍽️' };
  }
  // ── Bay-level + generic room photo request (Phao 2026-06-27 · "1+2" fix) ──
  // Reaching here = an image request that matched NO specific room type/number/activity.
  // If it names a BAY or is a generic room ask, show real room samples instead of letting
  // the caller escalate (image_no_match→standby). _roomCtx requires a room word but excludes
  // ห้องน้ำ (bathroom→null per V58c) and ห้องอาหาร (restaurant, matched earlier) so food/
  // turtle/activity image asks still fall through to null and escalate honestly.
  const _roomCtx = /ห้อง(?!น้ำ|อาหาร)|ที่พัก|บ้านพัก|บ้านปูน|บ้านไม้|\broom\b|accommodation/i.test(t);
  if (_roomCtx && /อ่าวใหญ่|big\s*bay/i.test(t) && !/อ่าวมุก|pearl\s*bay/i.test(t)) {
    const images = [
      ...lookupByRoomType('thai_style', 'interior', 2),
      ...lookupByRoomType('manila_deluxe', 'interior', 2),
    ].filter(Boolean);
    if (images.length) return { images: images.slice(0, 5), caption: 'รูปห้องพักฝั่งอ่าวใหญ่ครับ 🏠\n• Thai Style Ocean Villa\n• Manila Deluxe Chalet\n— อยากดูแบบไหนเพิ่ม บอกได้เลยครับ' };
  }
  if (_roomCtx && /อ่าวมุก|pearl\s*bay/i.test(t) && !/อ่าวใหญ่|big\s*bay/i.test(t)) {
    const images = [
      ...lookupByRoomType('beach_chalet', 'interior', 2),
      ...lookupByRoomType('family_villa_amuk', 'interior', 1),
      ...lookupByRoomType('biggest_room', 'interior', 1),
    ].filter(Boolean);
    if (images.length) return { images: images.slice(0, 5), caption: 'รูปห้องพักฝั่งอ่าวมุกครับ 🛖\n• Beach Chalet · Family Villa · Biggest Room · บ้าน 2 ชั้น\n— อยากดูแบบไหนเพิ่ม บอกได้เลยครับ' };
  }
  // Defer the existing "all-types" phrasings (ทุกแบบ/ทั้ง N แบบ/บ้านพัก/ที่พัก/ห้องพัก$…) to
  // their original V58 branch below (keeps those captions unchanged); we only catch the
  // genuinely-uncovered generic asks ("ขอดูรูปห้อง", "มีรูปห้องไหม", "ขอรูปห้องพักหน่อย").
  if (_roomCtx && !/ทุก\s*แบบ|ทั้ง\s*\d*\s*แบบ|บ้านพัก|ที่พัก|ห้องพัก.*แบบไหน|ห้องพัก$|ห้องพักทั้ง/i.test(t)) {
    const images = [
      ...lookupByRoomType('thai_style', 'interior').slice(0, 1),
      ...lookupByRoomType('manila_deluxe', 'interior').slice(0, 1),
      ...lookupByRoomType('beach_chalet', 'interior').slice(0, 1),
    ].filter(Boolean);
    if (images.length) return { images: images.slice(0, 5), caption: 'รูปห้องพักของเกาะทะลุครับ 🏠\n1️⃣ Thai Style Ocean Villa (อ่าวใหญ่)\n2️⃣ Manila Deluxe Chalet (อ่าวใหญ่)\n3️⃣ Home / Beach Chalet (อ่าวมุก)\n— อยากดูห้องไหนละเอียดเพิ่ม บอกได้เลยครับ' };
  }
  // ─── V58 fallback branches for generic image queries ─────────────────────
  // Evidence: M A M_K A M O N 2026-05-28 · generic room/activity image asks
  // fell to standby because no specific room/activity branch matched.
  if (/ทุก\s*แบบ|ทั้ง\s*\d*\s*แบบ|บ้านพัก|ที่พัก|ห้องพัก.*แบบไหน|ห้องพัก$|ห้องพักทั้ง/i.test(t)) {
    const trio = [
      ...lookupByRoomType('thai_style', 'exterior').slice(0, 1),
      ...lookupByRoomType('manila_deluxe', 'exterior').slice(0, 1),
      ...lookupByRoomType('beach_chalet', 'exterior').slice(0, 1),
    ].filter(Boolean);
    if (trio.length) {
      return {
        images: trio,
        caption: 'ห้องพักที่มีของเราครับ 😊 มี 3 type หลัก: Thai Style Ocean Villa · Manila Deluxe Chalet · Beach Chalet · ดูภายในห้องไหนเพิ่มเติม บอกได้เลยครับ',
      };
    }
  }
  if (/รูป\s*กิจกรรม|กิจกรรม.*อื่น|อยากได้.*กิจกรรม|กิจกรรมมี.*ภาพ|ภาพ.*กิจกรรม/i.test(t)) {
    const grid = [
      ...lookupByActivity('snorkeling').slice(0, 1),
      ...lookupByActivity('kayaking').slice(0, 1),
      ...lookupByActivity('sailing').slice(0, 1),
      ...lookupByActivity('sunset-fishing').slice(0, 1),
    ].filter(Boolean);
    if (grid.length) {
      return {
        images: grid,
        caption: 'รูปกิจกรรมหลักของเราครับ ⚓ — ดำน้ำตื้น · คายัค · เรือใบ · ล่องแพดูพระอาทิตย์ตก · สนใจดูเพิ่มกิจกรรมไหน บอกได้เลยครับ',
      };
    }
  }
  // Day 13 2026-06-19: Turtle nursing program photos now available (10 photos · KB-022 backing)
  if (/เต่า|turtle|บ่อเต่า|ดูเต่า|เต่ากระ|ปล่อยเต่า|turtle\s*nursing/i.test(t)) {
    const images = lookupByActivity('turtle');
    if (images.length) return { images, caption: 'รูปบ่ออนุบาลเต่ากระ (อ่าวใหญ่) ครับ 🐢 โครงการอนุบาลเต่าทะเล' };
    // Fallback if photos missing at runtime · keep honest escalation
    return {
      images: [],
      caption: 'รูปเต่าตอนนี้ไม่มีให้ดูใน LINE OA ครับ 🐢 ขอแอดมินช่วยส่งให้ครับ 🙏',
      escalate: true,
    };
  }
  return null;
}
const V87_VISUAL_INTENT_PATTERNS = [
  /ขอ\s*(?:ดู\s*)?(?:รูป|ภาพ|map|แผนที่)/i,
  /ขอดู\s*(?:รูป|ภาพ|map|แผนที่)/i,
  /ส่ง\s*(?:รูป|ภาพ|map|แผนที่)/i,
  /อยาก\s*ดู\s*(?:รูป|ภาพ)/i,
  /รูป\s*(?:ห้อง|ท่าเรือ|ภายใน|ภายนอก|กิจกรรม|อาหาร|ดำน้ำ|ดำน้ำตื้น|คายัค|kayak|snorkel|เรือใบ|sail|ตกปลา|ร้านอาหาร|นวด|massage|วิว|view|บรรยากาศ|สระ|บาร์|เมนู|menu|ทะเล|beach|วอลเลย์|volleyball|ดำน้ำลึก|diving|try\s*dive|fun\s*dive|scuba|skin\s*div|open\s*water|เต่า|turtle|บ่อเต่า|เต่ากระ)/i,
  // Day 9 PM Bug #14: V87 expand for Day 8-9 room types + admin terminology
  /รูป\s*(?:ห้อง\s*)?(?:two[\s-]?story|Two[\s-]?Story|บ้าน\s*2\s*ชั้น|สอง\s*ชั้น|2\s*ชั้น|toproom|bottomroom|single[\s_]*room|beach[\s-]?front|Beach\s*Chalet|บีชชาเล|Manila|มะลิลา|Thai\s*Style|ไทย\s*สไตล์|honeymoon|ฮันนีมูน|Home|เรือนไทย|family|biggest|4br|R\d{1,2})/i,
  /แผนที่/i,
  /\bphoto(?:s)?\b/i,
  /\bpicture(?:s)?\b/i,
  /\bimage(?:s)?\b/i,
  /\bpics?\b/i,
  /\bmap\b/i,
  /show\s*(?:me\s*)?(?:photo|photos|picture|pictures|image|images|map)/i,
  // V96 — V87 visual intent extension · covers ขอดู+topic / ภาพ+topic / มีภาพ / ห้องพักทุก
  /(?:ขอ|อยาก)\s*ดู\s*(?:กิจกรรม|ภายใน|ภายนอก|ห้องพัก|ห้องน้ำ|บรรยากาศ|ที่พัก|บ้านพัก)/i,
  // Day 13 2026-06-19: reverse order "<KEYWORD> รูป" + "ขอดู <KEYWORD>" (Dive Center BU + Turtle)
  /(?:try\s*dive|fun\s*dive|scuba|skin\s*div|open\s*water|advance\s*ow|\baow\b|ดำน้ำลึก|สกินไดฟ์|เต่า|turtle|บ่อเต่า|เต่ากระ)\s*(?:รูป|ภาพ)/i,
  /ขอ\s*ดู\s*(?:try\s*dive|fun\s*dive|scuba|skin\s*div|open\s*water|advance\s*ow|\baow\b|ดำน้ำลึก|สกินไดฟ์|เต่า|turtle|บ่อเต่า|เต่ากระ)/i,
  /ภาพ(?:ห้อง|ท่าเรือ|ภายใน|ภายนอก|กิจกรรม|อาหาร|ดำน้ำ|คายัค|kayak|snorkel|เรือใบ|sail|ตกปลา|ร้านอาหาร|นวด|massage|วิว|view|บรรยากาศ|สระ|บาร์|เมนู|menu|ทะเล|beach|วอลเลย์|volleyball)/i,
  /(?:มี|มีให้ดู)\s*(?:รูป|ภาพ)\s*(?:ไหม|มั้ย|หรือ|ให้ดู|บ้าง)?/i,
  /ห้องพัก\s*(?:ทุก|ทั้งหมด|แบบ|ที่มี)/i,
];

function hasV87VisualIntent(text) {
  if (!text) return false;
  return V87_VISUAL_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * V87 baseline: old topic-only routing. Kept for observability so we count only
 * messages V87 newly blocks.
 */
function wouldBeImageRequestBeforeV87(text) {
  if (!text) return false;
  // General photo keywords
  if (/ดูรูป|รูปห้อง|รูปภาพ|ขอรูป|รูปถ่าย|รูปร้าน|รูปกิจกรรม|photo|picture|image|ภายใน|ภายนอก/.test(text)) return true;
  // Activity photo keywords: "รูปดำน้ำ", "รูปคายัค", etc. (space-tolerant for EN terms · Day 13 2026-06-19)
  if (/รูป\s*(?:ดำน้ำ|คายัค|kayak|snorkel|ดำน้ำตื้น|เรือใบ|sail|ตกปลา|ร้านอาหาร|นวด|massage|top view|วิว)/.test(text)) return true;
  // Day 13 2026-06-19: Dive Center BU + Turtle nursing topics (visual intent gate)
  if (/(?:try\s*dive|fun\s*dive|scuba|skin\s*div|open\s*water|\baow\b|ดำน้ำลึก|สกินไดฟ์|เต่า|turtle|บ่อเต่า|เต่ากระ)/i.test(text)) return true;
  // "ห้อง T15" or "room D14" (with optional space)
  if (/(?:ห้อง|room)\s*[TDRtdr]\d{1,2}/i.test(text)) return true;
  // "ห้อง T15 เป็นยังไง / ลักษณะ / แบบไหน"
  if (/(?:ห้อง|room)\s+[TDRtdr]?\d*\s*(?:เป็นยังไง|หน้าตา|แบบไหน|ลักษณะ|look like)/i.test(text)) return true;
  // Standalone room number with context word: "T15 ภายใน"
  if (/[TDRtdr]\d{1,2}\s+(?:ภายใน|ภายนอก|interior|exterior)/i.test(text)) return true;
  // ─── Phase 2.5B Plan D additions ─────────────────────────────────────────
  // Sub-type room queries
  if (/(?:family\s*villa|family\s*room|family|biggest\s*room|biggest|4br|four[\s-]?bed|honeymoon|studio|สตูดิโอ|single\s*room|ห้องครอบครัว|ฮันนีมูน|ห้องเดี่ยว|ห้องเล็ก|พักเดี่ยว|บ้านไทย|บ้าน\s*2\s*ชั้น|two[\s-]?story|สองชั้น|toproom|bottomroom|\br\d{1,2}\b|beach[\s-]?front|หน้าหาด|Manila|มะลิลา|Thai\s*Style|ไทย\s*สไตล์|Home|เรือนไทย|Beach\s*Chalet|บีชชาเล)/i.test(text)) return true;
  // Location / pier
  if (/(?:แผนที่|ที่ตั้ง|location|map|ท่าเรือ|บ้านมะพร้าว|pier|mainland)/i.test(text)) return true;
  // Flyer / itinerary
  if (/(?:flyer|ใบปลิว|ตารางกิจกรรม|รายการกิจกรรม)/i.test(text)) return true;
  // Beach volleyball
  if (/(?:วอลเลย์|volleyball)/i.test(text)) return true;
  // Generic "ห้องพัก" / "ห้องน้ำ" — these were the CAL-010 / CAL-015 misses
  if (/(?:รูปห้องพัก|รูปห้องน้ำ|ห้องพักหน้าตา|ห้องพักทุกแบบ|ห้องพักทั้งหมด|ทุกห้อง)/i.test(text)) return true;
  // V58c: bathroom "what is it like?" alone is content question · fall through to AI/V64 text.
  // Only explicit "รูป" / "ภาพ" + "ห้องน้ำ" should trigger image.
  // V58b: explicit interior/exterior + "ทุก" trigger
  if (/(?:ภายในห้อง|ภายนอกห้อง|ขอดู.*ห้อง.*ภายใน|ขอดู.*ภายในห้อง)/i.test(text)) return true;
  if (/(?:กิจกรรมทุกอย่าง|กิจกรรมทั้งหมด|ทุกกิจกรรม|กิจกรรมที่มี|มีกิจกรรมอะไร)/i.test(text)) return true;
  // V58 generic image fallbacks: ภาพ alone · บ้านพัก/ที่พัก · all room/activity variants
  if (/(?:ภาพ|บ้านพัก|ที่พัก|ทุก\s*แบบ|ทุก\s*type|กิจกรรม.*ภาพ|ภาพ.*กิจกรรม)/i.test(text)) return true;
  // ─── Tier 4 additions ─────────────────────────────────────────────────────
  // "มีรูป X" / "ส่งรูป X ให้" / "อยากดูรูป" (without ขอ/ดู prefix)
  if (/(?:มี|ส่ง|อยาก)(?:ดู|ได้)?\s*(?:รูป|ภาพ)/i.test(text)) return true;
  // "รูป + facility/food/menu/atmosphere word"
  if (/รูป(?:สระ|บาร์|อาหาร|เมนู|มื้อ|pool|bar|food|menu|breakfast|dinner|lunch|บรรยากาศ|วิว|วิดีโอ|วีดีโอ|video)/i.test(text)) return true;
  // "บรรยากาศ" / "อาหาร" alone with mention of photos
  if (/(?:บรรยากาศ|อาหาร|เมนู|menu|food).*(?:เป็นไง|ยังไง|how|like|มี)/i.test(text)) return true;
  return false;
}

/**
 * V87: image routing requires visual intent + an existing image-relevant topic.
 */
function isImageRequest(text) {
  return hasV87VisualIntent(text) && wouldBeImageRequestBeforeV87(text);
}

module.exports = {
  matchImages,
  isImageRequest,
  wouldBeImageRequestBeforeV87,
  _hasV87VisualIntent: hasV87VisualIntent,
  lookupByRoomNumber,
  lookupByRoomType,
  lookupByActivity,
  lookupByLocation,  // Phase 2.5B Plan D — new
};
