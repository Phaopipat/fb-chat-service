#!/usr/bin/env node
/**
 * setup-booking-hold-tab.js · Stage 5 (one-shot · idempotent)
 *
 * Creates "BookingHold" tab in iB Chatlog Sheet with 14-col header.
 *
 * Usage (จาก fb-chat-service folder):
 *   export GOOGLE_SHEET_ID='...'
 *   export GOOGLE_SERVICE_ACCOUNT_JSON='...'
 *   node setup-booking-hold-tab.js
 *
 * Schema:
 *   A=psid              B=displayName       C=bookingRef       D=expectedAmount
 *   E=tolerance         F=status            G=createdAt        H=confirmedAt
 *   I=matchedTransRef   J=matchedAmount     K=notes            L=expiresAt
 *   M=bookingPersonName N=customerEmail
 */

const { google } = require("googleapis");

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

if (!SHEET_ID || !SA_JSON) {
  console.error("❌ Missing env: GOOGLE_SHEET_ID or GOOGLE_SERVICE_ACCOUNT_JSON");
  console.error("\nUsage:");
  console.error("  export GOOGLE_SHEET_ID='...'");
  console.error("  export GOOGLE_SERVICE_ACCOUNT_JSON='...'");
  console.error("  node setup-booking-hold-tab.js");
  process.exit(1);
}

(async () => {
  console.log("🚀 Setting up BookingHold tab in iB Chatlog Sheet...");
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

  // 2. Create BookingHold tab if not exists
  if (existingTabs.includes("BookingHold")) {
    console.log('✅ Tab "BookingHold" already exists — skipping create');
  } else {
    console.log('   Creating tab "BookingHold"...');
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: "BookingHold",
                gridProperties: { rowCount: 1000, columnCount: 14 },
              },
            },
          },
        ],
      },
    });
    console.log('✅ Tab "BookingHold" created');
  }

  // 3. Read current rows
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "BookingHold!A:N",
  });
  const rows = existing.data.values || [];

  // 4. Write header if missing
  const HEADER = [
    "psid",
    "displayName",
    "bookingRef",
    "expectedAmount",
    "tolerance",
    "status",
    "createdAt",
    "confirmedAt",
    "matchedTransRef",
    "matchedAmount",
    "notes",
    "expiresAt",
    "bookingPersonName",
    "customerEmail",
  ];

  if (rows.length === 0 || (rows[0][0] || "").trim().toLowerCase() !== "psid") {
    console.log("   Writing header row...");
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "BookingHold!A1:N1",
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
    range: "BookingHold!A:N",
  });
  const finalRows = final.data.values || [];
  console.log(`\n📋 BookingHold tab now has ${finalRows.length} row(s)`);
  if (finalRows.length > 0) {
    console.log("   Header:", finalRows[0].join(" | "));
  }

  console.log("\n🎯 Done. View Sheet:");
  console.log(`   https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`);
  console.log("\n📝 Status values used by bot:");
  console.log("   - fb_pending_review  · FB slip received · admin to match with booking");
  console.log("   - pending            · LINE-style pending booking (admin pre-created)");
  console.log("   - confirmed          · slip matched + amount verified");
  console.log("   - mismatch           · amount mismatch · admin review");
})().catch((err) => {
  console.error("❌ Error:", err.message);
  if (err.response?.data?.error) {
    console.error("   API error:", JSON.stringify(err.response.data.error, null, 2));
  }
  process.exit(1);
});
