// scripts/convert-availability-files.js
// One-shot · convert all .xlsx files in "Availability" Drive folder to Google Sheets format
//
// Why: availability-checker.js queries Drive for mimeType='application/vnd.google-apps.spreadsheet'
//      Existing files are .xlsx (Excel binary) · query returns null · checker fails silently
//      Converting to Google Sheets fixes both LINE + FB bots permanently
//
// SAFE: creates NEW files (Google Sheets format) · does NOT modify or delete originals
//       Customer can manually verify + delete old .xlsx after testing
//
// Auth: uses FB SA (has full drive scope · LINE SA has drive.readonly which can't copy)
//
// Usage:
//   node scripts/convert-availability-files.js --dry-run   # preview
//   node scripts/convert-availability-files.js              # commit (create Sheets copies)
'use strict';

require('dotenv').config();
const { google } = require('googleapis');

const DRY_RUN = process.argv.includes('--dry-run');
const FOLDER_NAME = 'Availability';

async function main() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const drive = google.drive({ version: 'v3', auth });

  // 1. Find Availability folder
  console.log(`📁 Finding folder "${FOLDER_NAME}"…`);
  const folderRes = await drive.files.list({
    q: `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id,name,owners(emailAddress))',
    pageSize: 5,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    corpora: 'allDrives',
  });
  const folders = folderRes.data.files || [];
  if (folders.length === 0) {
    console.error(`❌ Folder "${FOLDER_NAME}" not found · SA may not have access`);
    process.exit(1);
  }
  if (folders.length > 1) {
    console.warn(`⚠️  Multiple folders named "${FOLDER_NAME}" found · using first:`);
    folders.forEach((f, i) => console.warn(`   [${i}] ${f.id} owner=${(f.owners?.[0]?.emailAddress) || '?'}`));
  }
  const folder = folders[0];
  console.log(`✅ Folder: ${folder.id}\n`);

  // 2. List .xlsx files in folder
  console.log(`📋 Listing .xlsx files in folder…`);
  const xlsxRes = await drive.files.list({
    q: `'${folder.id}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
    fields: 'files(id,name,size,modifiedTime)',
    pageSize: 100,
    orderBy: 'name',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  });
  const xlsxFiles = xlsxRes.data.files || [];
  console.log(`   Found ${xlsxFiles.length} .xlsx files\n`);

  if (xlsxFiles.length === 0) {
    console.log(`✅ No .xlsx files to convert · nothing to do.`);
    process.exit(0);
  }

  // 3. List existing Google Sheets in folder (to detect already-converted)
  const sheetsRes = await drive.files.list({
    q: `'${folder.id}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
    fields: 'files(id,name)',
    pageSize: 100,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  });
  const existingSheetsByName = new Map((sheetsRes.data.files || []).map(f => [f.name, f.id]));
  console.log(`📝 Existing Google Sheets in folder: ${existingSheetsByName.size}\n`);

  // 4. Plan conversions
  console.log(`📐 Conversion plan:`);
  const plan = [];
  for (const f of xlsxFiles) {
    const newName = f.name.replace(/\.xlsx$/i, '');
    const skip = existingSheetsByName.has(newName);
    plan.push({ source: f, newName, skip });
    console.log(`  ${skip ? '⏭️ ' : '➕'} ${f.name}  →  ${newName}${skip ? '  (Sheets exists · skip)' : ''}`);
  }
  const toConvert = plan.filter(p => !p.skip);
  console.log(`\n  Convert: ${toConvert.length} · Skip: ${plan.length - toConvert.length}\n`);

  if (DRY_RUN) {
    console.log(`💡 Dry run · no changes. Re-run without --dry-run to convert.`);
    process.exit(0);
  }

  if (toConvert.length === 0) {
    console.log(`✅ Nothing to do · all files already have Sheets versions.`);
    process.exit(0);
  }

  // 5. Convert each .xlsx → Google Sheets
  console.log(`✍️  Converting ${toConvert.length} files…\n`);
  let ok = 0, fail = 0;
  for (const p of toConvert) {
    try {
      const copied = await drive.files.copy({
        fileId: p.source.id,
        requestBody: {
          name: p.newName,
          mimeType: 'application/vnd.google-apps.spreadsheet',
          parents: [folder.id],
        },
        fields: 'id,name,mimeType',
        supportsAllDrives: true,
      });
      console.log(`  ✅ ${p.source.name}  →  ${copied.data.name}  (id: ${copied.data.id.substring(0, 12)}…)`);
      ok++;
    } catch (err) {
      console.error(`  ❌ ${p.source.name}: ${err.message}`);
      fail++;
    }
  }

  console.log(`\n─── Summary ───`);
  console.log(`  ✅ converted: ${ok}`);
  console.log(`  ❌ failed:    ${fail}`);
  console.log(`\n📌 Originals (.xlsx) NOT deleted · verify new Sheets first.`);
  console.log(`📌 Manual cleanup: open Drive → Availability folder → delete old .xlsx files (optional).\n`);
  console.log(`🎯 Now test bot:`);
  console.log(`   📱 "30 มิ.ย. ห้องว่างมั้ย"`);
  console.log(`   Expect Railway log: [availability] Resolved "2569 มิ.ย.(6)" → <new-sheets-id>`);
  console.log(`   Expect bot to actually return real availability data (not all-unknown).`);
}

main().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
