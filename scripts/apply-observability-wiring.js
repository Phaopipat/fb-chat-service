'use strict';

/**
 * scripts/apply-observability-wiring.js
 *
 * Idempotent patcher for FB server.js to wire observability counters.
 * Adds:
 *   - require("./observability") at top of imports
 *   - process.on uncaughtException / unhandledRejection hooks (before app.listen)
 *   - webhookReceived counter at start of /webhook POST handler
 *   - sheetAppendOk / sheetAppendError counters in appendRow
 *
 * Marker: FB_OBSERVABILITY_WIRED
 *
 * Usage: node scripts/apply-observability-wiring.js
 *        node scripts/apply-observability-wiring.js --dry-run
 */

const fs = require('fs');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const MARKER = 'FB_OBSERVABILITY_WIRED';
const DRY = process.argv.includes('--dry-run');

function read() {
  return fs.readFileSync(SERVER_PATH, 'utf8');
}

function write(content) {
  if (DRY) {
    console.log('[dry-run] would write', SERVER_PATH);
    return;
  }
  const backup = `${SERVER_PATH}.bak-observability-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(SERVER_PATH, backup);
  fs.writeFileSync(SERVER_PATH, content);
  console.log('✅ wrote', SERVER_PATH);
  console.log('   backup:', backup);
}

function main() {
  let src = read();

  if (src.includes(MARKER)) {
    console.log(`ℹ️  ${MARKER} already present — skipping`);
    return;
  }

  const changes = [];

  // ─── 1. Add require at top (after existing requires near line 26-28) ───
  if (!/require\(["']\.\/observability["']\)/.test(src)) {
    // Insert after the `const { generateReply } = require("./ai-reply");` line
    const reqLine = 'const { generateReply } = require("./ai-reply");';
    if (src.includes(reqLine)) {
      src = src.replace(
        reqLine,
        reqLine + '\nconst observability = require("./observability");  // ' + MARKER
      );
      changes.push('added require("./observability")');
    } else {
      throw new Error('Could not find ai-reply require line — bailing');
    }
  }

  // ─── 2. process.on hooks (insert just before "app.listen") ───
  if (!/process\.on\(["']uncaughtException["'],\s*\(err\)\s*=>\s*observability\.recordError/.test(src)) {
    const listenLine = '// ─── Boot ──────────────────────────────────────────────────────────────────';
    const hooks = `// ─── ${MARKER} — process error hooks ──────────────────────────────────────\nprocess.on("uncaughtException", (err) => {\n  observability.increment("uncaughtException");\n  observability.recordError("uncaughtException", err);\n  console.error("[observability] uncaughtException:", err && err.message);\n});\nprocess.on("unhandledRejection", (err) => {\n  observability.increment("unhandledRejection");\n  observability.recordError("unhandledRejection", err);\n  console.error("[observability] unhandledRejection:", err && err.message);\n});\n\n`;

    if (src.includes(listenLine)) {
      src = src.replace(listenLine, hooks + listenLine);
      changes.push('added process.on hooks (before app.listen)');
    } else {
      throw new Error('Could not find "─── Boot ───" header — bailing');
    }
  }

  // ─── 3. webhookReceived counter in app.post("/webhook") ───
  const webhookSig = 'app.post("/webhook", async (req, res) => {\n  res.sendStatus(200);';
  const webhookSigWithCounter =
    'app.post("/webhook", async (req, res) => {\n  observability.increment("webhookReceived");  // ' +
    MARKER +
    '\n  res.sendStatus(200);';
  if (src.includes(webhookSig) && !src.includes('observability.increment("webhookReceived")')) {
    src = src.replace(webhookSig, webhookSigWithCounter);
    changes.push('added webhookReceived counter in /webhook handler');
  }

  // ─── 4. appendRow success + error counter ───
  // Original:
  //   async function appendRow(values) {
  //     const sheets = await getSheets();
  //     await sheets.spreadsheets.values.append({...});
  //   }
  // Replace with try/catch and counters.
  const oldAppendRow =
    'async function appendRow(values) {\n' +
    '  const sheets = await getSheets();\n' +
    '  await sheets.spreadsheets.values.append({\n' +
    '    spreadsheetId: GOOGLE_SHEET_ID,\n' +
    '    range: `${SHEET_TAB}!A:Z`,\n' +
    '    valueInputOption: "USER_ENTERED",\n' +
    '    requestBody: { values: [values] },\n' +
    '  });\n' +
    '}';

  const newAppendRow =
    'async function appendRow(values) {\n' +
    '  // ' + MARKER + ' — counters on success/error\n' +
    '  try {\n' +
    '    const sheets = await getSheets();\n' +
    '    await sheets.spreadsheets.values.append({\n' +
    '      spreadsheetId: GOOGLE_SHEET_ID,\n' +
    '      range: `${SHEET_TAB}!A:Z`,\n' +
    '      valueInputOption: "USER_ENTERED",\n' +
    '      requestBody: { values: [values] },\n' +
    '    });\n' +
    '    observability.increment("sheetAppendOk");\n' +
    '  } catch (err) {\n' +
    '    observability.increment("sheetAppendError");\n' +
    '    observability.recordError("sheetAppend", err);\n' +
    '    throw err;\n' +
    '  }\n' +
    '}';

  if (src.includes(oldAppendRow)) {
    src = src.replace(oldAppendRow, newAppendRow);
    changes.push('wrapped appendRow with try/catch + counters');
  } else if (!src.includes('observability.increment("sheetAppendOk")')) {
    console.warn('⚠️  appendRow signature did not match expected shape — counters NOT added to appendRow');
  }

  if (changes.length === 0) {
    console.log(`ℹ️  No changes needed`);
    return;
  }

  console.log('Changes:');
  changes.forEach((c) => console.log('  - ' + c));

  write(src);
  console.log(`\nMarker "${MARKER}" should now appear ${(src.match(new RegExp(MARKER, 'g')) || []).length}x in server.js`);
}

main();
