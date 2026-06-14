// Pre-upload all images to FB Messenger Attachments API · get permanent attachment_id
// Bypasses URL fetch on every send (works in Dev mode)
// Usage: node scripts/upload-fb-attachments.js [--dry-run]
//
// FB Attachments API: https://developers.facebook.com/docs/messenger-platform/send-messages/saving-assets/
// Returns attachment_id that's permanently valid · re-usable across sends

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const BASE_URL = process.env.SERVICE_URL || process.env.RAILWAY_STATIC_URL || process.env.BASE_URL || 'https://webhook-kohtalu-production.up.railway.app';
const STATIC_MAP_PATH = path.join(__dirname, '..', 'static-photo-map.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'attachment-id-map.json');

const DRY_RUN = process.argv.includes('--dry-run');

if (!FB_PAGE_ACCESS_TOKEN) {
  console.error('ERR · FB_PAGE_ACCESS_TOKEN missing in .env');
  process.exit(1);
}

const photoMap = JSON.parse(fs.readFileSync(STATIC_MAP_PATH, 'utf8'));
const existingMap = fs.existsSync(OUTPUT_PATH) ? JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8')) : {};

async function uploadImage(imageUrl) {
  const url = `https://graph.facebook.com/v19.0/me/message_attachments?access_token=${FB_PAGE_ACCESS_TOKEN}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        attachment: {
          type: 'image',
          payload: { url: imageUrl, is_reusable: true }
        }
      }
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { error: data.error || { message: 'Unknown error', code: res.status } };
  }
  return { attachment_id: data.attachment_id };
}

(async () => {
  console.log(DRY_RUN ? '🔍 DRY RUN' : '📤 UPLOADING');
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`Loaded ${Object.keys(photoMap).length} folders from static-photo-map.json`);
  console.log(`Existing mappings: ${Object.keys(existingMap).length}`);
  console.log('');

  let totalUrls = 0;
  let skipped = 0;
  let uploaded = 0;
  let failed = 0;
  const errors = [];

  for (const [folder, files] of Object.entries(photoMap)) {
    for (const file of files) {
      const fullUrl = `${BASE_URL}/images/${folder}/${file}`;
      totalUrls++;

      if (existingMap[fullUrl]) {
        skipped++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  would upload: ${folder}/${file}`);
        continue;
      }

      try {
        const result = await uploadImage(fullUrl);
        if (result.attachment_id) {
          existingMap[fullUrl] = result.attachment_id;
          uploaded++;
          console.log(`  ✅ ${folder}/${file} → ${result.attachment_id}`);
        } else {
          failed++;
          errors.push({ url: fullUrl, error: result.error });
          console.log(`  ❌ ${folder}/${file}: ${result.error.message} (code=${result.error.code} subcode=${result.error.error_subcode})`);
        }
        // Save progress every 5 uploads
        if (uploaded % 5 === 0) {
          fs.writeFileSync(OUTPUT_PATH, JSON.stringify(existingMap, null, 2));
        }
        // Rate limit · 200ms between uploads
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        failed++;
        errors.push({ url: fullUrl, error: { message: e.message } });
        console.log(`  ❌ ${folder}/${file}: ${e.message}`);
      }
    }
  }

  // Final save
  if (!DRY_RUN) {
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(existingMap, null, 2));
  }

  console.log('');
  console.log('═══ Summary ═══');
  console.log(`Total URLs: ${totalUrls}`);
  console.log(`Skipped (already cached): ${skipped}`);
  console.log(`Uploaded: ${uploaded}`);
  console.log(`Failed: ${failed}`);
  console.log(`Cached: ${Object.keys(existingMap).length} attachment_ids → ${OUTPUT_PATH}`);

  if (errors.length > 0) {
    console.log('');
    console.log('── First 5 errors ──');
    errors.slice(0, 5).forEach(e => {
      console.log(`  ${e.url.split('/').slice(-3).join('/')}: ${e.error.message}`);
    });
  }
})().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
