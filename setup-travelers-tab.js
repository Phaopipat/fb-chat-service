#!/usr/bin/env node
/**
 * setup-travelers-tab.js · Stage 6.5 v1.7.2 (one-shot · idempotent)
 *
 * Creates "Travelers" tab in iB Chatlog Sheet with 10-col header.
 *
 * Usage (จาก fb-chat-service folder):
 *   export GOOGLE_SHEET_ID='...'
 *   export GOOGLE_SERVICE_ACCOUNT_JSON='...'
 *   node setup-travelers-tab.js
 *
 * Schema:
 *   A=createdAt         B=psid              C=bookingRef       D=bookingPersonName
 *   E=travelerName      F=phone             G=email            H=matchedAmount
 *   I=source            J=notes
 *
 * One row per traveler · so 3-name booking = 3 rows appended
 */

const { google } = require("googleapis");

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

if (!SHEET_ID || !SA_JSON) {
  console.error("❌ Missing env: GOOGLE_SHEET_ID or GOOGLE_SERVICE_ACCOUNT_JSON");
  console.error("\nUsage:");
  console.error("  export GOOGLE_SHEET_ID='...'");
  console.error("  export GOOGLE_SERVICE_ACCOUNT_JSON='...'");
  console.error("  node setup-travelers-tab.js");
  process.exit(1);
}

(async () => {
  console.log("🚀 Setting up Travelers tab in iB Chatlog Sheet...");
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

  // 2. Create Travelers tab if not exists
  if (existingTabs.includes("Travelers")) {
    console.log('✅ Tab "Travelers" already exists — skipping create');
  } else {
    console.log('   Creating tab "Travelers"...');
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: "Travelers",
                gridProperties: { rowCount: 5000, columnCount: 10 },
              },
            },
          },
        ],
      },
    });
    console.log('✅ Tab "Travelers" created');
  }

  // 3. Read current rows
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Travelers!A:J",
  });
  const rows = existing.data.values || [];

  // 4. Write header if missing
  const HEADER = [
    "createdAt",
    "psid",
    "bookingRef",
    "bookingPersonName",
    "travelerName",
    "phone",
    "email",
    "matchedAmount",
    "source",
    "notes",
  ];

  if (rows.length === 0 || (rows[0][0] || "").trim().toLowerCase() !== "createdat") {
    console.log("   Writing header row...");
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "Travelers!A1:J1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [HEADER] },
    });
    console.log("✅ Header row written");
  } else {
    console.log("✅ Header row already present");
  }

  // 5. Final state
  const final = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Travelers!A:J",
  });
  const finalRows = final.data.values || [];
  console.log(`\n📋 Travelers tab now has ${finalRows.length} row(s)`);
  if (finalRows.length > 0) {
    console.log("   Header:", finalRows[0].join(" | "));
  }

  console.log("\n🎯 Done. View Sheet:");
  console.log(`   https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`);
  console.log("\n📝 How collector uses this tab:");
  console.log("   - After slip + names collected → append 1 row per traveler");
  console.log("   - 3-name booking → 3 rows");
  console.log("   - Source = 'FB' (LINE/TikTok will use different value)");
  console.log("   - Filter by psid to see one customer's travelers");
})().catch((err) => {
  console.error("❌ Error:", err.message);
  if (err.response?.data?.error) {
    console.error("   API error:", JSON.stringify(err.response.data.error, null, 2));
  }
  process.exit(1);
});
