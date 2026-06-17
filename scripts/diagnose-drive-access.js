// scripts/diagnose-drive-access.js
// Day 11 root-cause diagnostic · FB SA Drive access issue
// Runs in FB repo · uses FB .env GOOGLE_SERVICE_ACCOUNT_JSON
// Tests EXACTLY what bot does at runtime to find sheets
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { google } = require('googleapis');

const RESET = '\x1b[0m', GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m';

(async () => {
  console.log(`\n${CYAN}🩺 FB SA Drive Diagnostic${RESET}\n`);

  // ── 1. SHOW WHAT SA IS ACTUALLY BEING USED ──
  let sa;
  try {
    sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    console.error(`${RED}❌ Cannot parse GOOGLE_SERVICE_ACCOUNT_JSON: ${e.message}${RESET}`);
    process.exit(1);
  }

  console.log(`${CYAN}═══ 1. Service Account Identity ═══${RESET}`);
  console.log(`  Email:       ${sa.client_email}`);
  console.log(`  Project ID:  ${sa.project_id}`);
  console.log(`  Client ID:   ${sa.client_id}`);
  console.log(`  Key ID:      ${sa.private_key_id?.substring(0, 16)}...`);
  console.log('');

  const expectedFb = 'kohtalu-fb-sheets@lineoa-chat-history.iam.gserviceaccount.com';
  if (sa.client_email === expectedFb) {
    console.log(`  ${GREEN}✅ Matches FB-expected SA${RESET}`);
  } else {
    console.log(`  ${YELLOW}⚠️  Differs from expected FB SA${RESET}`);
    console.log(`     Expected: ${expectedFb}`);
  }
  console.log('');

  // ── 2. AUTH + LIST ALL VISIBLE SPREADSHEETS ──
  const auth = new google.auth.GoogleAuth({
    credentials: sa,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  });
  const drive = google.drive({ version: 'v3', auth: await auth.getClient() });

  console.log(`${CYAN}═══ 2. ALL spreadsheets visible to this SA (any folder) ═══${RESET}`);
  try {
    const res = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
      fields: 'files(id,name,parents,owners,modifiedTime)',
      pageSize: 100,
      orderBy: 'modifiedTime desc',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      corpora: 'allDrives',
    });
    const files = res.data.files || [];
    console.log(`  Total visible: ${files.length}\n`);
    files.slice(0, 30).forEach((f, i) => {
      const isAvail = f.name.includes('2569') || f.name.includes('2570') || f.name.includes('ก.ค.') || f.name.includes('ส.ค.');
      const mark = isAvail ? '📅' : '  ';
      console.log(`  ${mark} ${(i+1).toString().padStart(2)}. ${f.name.padEnd(35)} · ${f.modifiedTime?.substring(0, 10)} · ${f.id}`);
    });
    if (files.length > 30) console.log(`     ... and ${files.length - 30} more`);
  } catch (e) {
    console.error(`${RED}  ❌ List failed: ${e.message}${RESET}`);
  }
  console.log('');

  // ── 3. TARGETED SEARCH (exactly what bot does) ──
  console.log(`${CYAN}═══ 3. Targeted search (mimics bot findSpreadsheetId) ═══${RESET}`);
  const targets = [
    '2569 ก.ค.(7)',           // bot's first try
    'New 2569 ก.ค.(7)',       // V100c fallback try
    '2569 ส.ค.(8)',           // August (probably missing)
    'New 2569 ส.ค.(8)',       // August with prefix
    '2569 ก.ย.(9)',
    'New 2569 ก.ย.(9)',
  ];
  for (const name of targets) {
    try {
      const res = await drive.files.list({
        q: `name='${name}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
        fields: 'files(id,name,parents)',
        pageSize: 5,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        corpora: 'allDrives',
      });
      const files = res.data.files || [];
      if (files.length) {
        console.log(`  ${GREEN}✅${RESET} "${name}" → ${files[0].id}`);
      } else {
        console.log(`  ${RED}❌${RESET} "${name}" → not found`);
      }
    } catch (e) {
      console.log(`  ${RED}⚠️${RESET}  "${name}" → ${e.message}`);
    }
  }
  console.log('');

  // ── 4. CHECK SPECIFIC FOLDER ACCESS ──
  console.log(`${CYAN}═══ 4. Availability folder access check ═══${RESET}`);
  const availFolderId = '1A_1gNvVbfuH3ohRaZ9vPhyxZq4cdlXLa';  // from Phao's URL
  try {
    const folderMeta = await drive.files.get({
      fileId: availFolderId,
      fields: 'id,name,mimeType,owners,permissions',
      supportsAllDrives: true,
    });
    console.log(`  ${GREEN}✅${RESET} Folder visible: "${folderMeta.data.name}"`);

    const filesInFolder = await drive.files.list({
      q: `'${availFolderId}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
      fields: 'files(id,name)',
      pageSize: 50,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    const files = filesInFolder.data.files || [];
    console.log(`  Files inside Availability folder visible to this SA: ${files.length}`);
    files.forEach((f, i) => {
      console.log(`    ${(i+1).toString().padStart(2)}. "${f.name}" → ${f.id}`);
    });
  } catch (e) {
    console.error(`  ${RED}❌ Folder access failed: ${e.message}${RESET}`);
  }
  console.log('');

  console.log(`${CYAN}═══ Diagnostic complete ═══${RESET}`);
  console.log('Paste output to Claude. Verdict will be clear from sections 1-4.\n');
})();
