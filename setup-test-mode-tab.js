#!/usr/bin/env node
/**
 * setup-test-mode-tab.js · Stage 3 (one-shot · idempotent)
 *
 * Creates "TestMode" tab in iB Chatlog Sheet with header row + adds Phao as first active PSID.
 *
 * Usage (จาก fb-chat-service folder ที่มี Railway env หรือ local .env):
 *   node setup-test-mode-tab.js
 *
 * Required env:
 *   GOOGLE_SHEET_ID
 *   GOOGLE_SERVICE_ACCOUNT_JSON
 *
 * Or run with explicit env:
 *   GOOGLE_SHEET_ID="..." GOOGLE_SERVICE_ACCOUNT_JSON="..." node setup-test-mode-tab.js
 *
 * This script is idempotent · safe to run multiple times:
 *   - If tab exists → skip create
 *   - If header exists → skip header write
 *   - If Phao row exists → skip add (matches by PSID column A)
 */

const { google } = require("googleapis");

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

const PHAO_PSID = "1496719837083797";
const PHAO_NAME = "เผ่าพิพัธ เจริญพักตร์";

if (!SHEET_ID || !SA_JSON) {
  console.error("❌ Missing env: GOOGLE_SHEET_ID or GOOGLE_SERVICE_ACCOUNT_JSON");
  console.error("");
  console.error("Easiest way to run this:");
  console.error("  1. cd to fb-chat-service folder (where Railway env vars are set)");
  console.error("  2. Use Railway CLI: railway run node setup-test-mode-tab.js");
  console.error("  3. OR export env from .env: source .env && node setup-test-mode-tab.js");
  process.exit(1);
}

(async () => {
  console.log("🚀 Setting up TestMode tab in iB Chatlog Sheet...");
  console.log(`   Sheet ID: ${SHEET_ID.slice(0, 20)}...`);

  const credentials = JSON.parse(SA_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });

  // 1. List existing tabs
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existingTabs = meta.data.sheets.map((s) => s.properties.title);
  console.log(`   Existing tabs: ${existingTabs.join(", ")}`);

  // 2. Create TestMode tab if not exists
  if (existingTabs.includes("TestMode")) {
    console.log('✅ Tab "TestMode" already exists — skipping create');
  } else {
    console.log('   Creating tab "TestMode"...');
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: "TestMode",
                gridProperties: { rowCount: 100, columnCount: 5 },
              },
            },
          },
        ],
      },
    });
    console.log('✅ Tab "TestMode" created');
  }

  // 3. Read current rows
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "TestMode!A:E",
  });
  const rows = existing.data.values || [];

  // 4. Write header if missing
  const HEADER = ["psid", "displayName", "mode", "addedAt", "notes"];
  if (rows.length === 0 || (rows[0][0] || "").trim().toLowerCase() !== "psid") {
    console.log("   Writing header row...");
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "TestMode!A1:E1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [HEADER] },
    });
    console.log("✅ Header row written");
  } else {
    console.log("✅ Header row already present");
  }

  // 5. Re-read after header write
  const after = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "TestMode!A:E",
  });
  const allRows = after.data.values || [];

  // 6. Check if Phao already in tab (by PSID match)
  const hasPhao = allRows.some(
    (r, idx) => idx > 0 && (r[0] || "").trim() === PHAO_PSID
  );

  if (hasPhao) {
    console.log(`✅ Phao (${PHAO_PSID}) already in TestMode — skipping`);
  } else {
    console.log(`   Adding Phao row (${PHAO_PSID})...`);
    const phaoRow = [
      PHAO_PSID,
      PHAO_NAME,
      "active",
      new Date().toISOString(),
      "Owner · added by setup-test-mode-tab.js · 2026-05-17",
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "TestMode!A:E",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [phaoRow] },
    });
    console.log("✅ Phao row added with mode=active");
  }

  // 7. Final state
  const final = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "TestMode!A:E",
  });
  const finalRows = final.data.values || [];
  console.log(`\n📋 TestMode tab now has ${finalRows.length} row(s):`);
  for (const r of finalRows) {
    console.log("   " + (r.join(" | ") || "(empty row)"));
  }

  console.log("\n🎯 Done. View Sheet:");
  console.log(`   https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`);
  console.log("\n📝 To add more testers later:");
  console.log("   - Open Sheet → TestMode tab → add row:");
  console.log("     psid | displayName | active | <ISO timestamp> | notes");
  console.log("   - Bot picks up new entries within 60 seconds (no redeploy)");
})().catch((err) => {
  console.error("❌ Error:", err.message);
  if (err.response?.data?.error) {
    console.error("   API error:", JSON.stringify(err.response.data.error, null, 2));
  }
  process.exit(1);
});
