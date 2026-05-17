/**
 * fb-chat-service — Facebook Messenger webhook → Google Sheet logger
 *
 * โครงสร้างเดียวกับ webhook-kohtalu (LINE) เพื่อให้ admin operate ได้เหมือนเดิม
 *
 * Endpoints:
 *   GET  /          → health
 *   GET  /webhook   → FB verification (hub.challenge)
 *   POST /webhook   → รับ messaging events จาก FB Page
 *
 * ENV required:
 *   FB_VERIFY_TOKEN              — เลือกเอง เช่น kohtalu_fb_2026
 *   FB_PAGE_ACCESS_TOKEN         — Page access token จาก Graph API
 *   FB_APP_SECRET                — App Secret (ใช้ verify x-hub-signature-256)
 *   GOOGLE_SHEET_ID              — Sheet ID
 *   GOOGLE_SERVICE_ACCOUNT_JSON  — Service account JSON (single-line, escaped \n in private_key)
 *   ANTHROPIC_API_KEY            — Claude Haiku API key (Stage 2+)
 *
 * ENV optional:
 *   BOT_ENABLED                  — "true" = อนุญาตให้บอท reply · ค่าอื่น = silent
 *   ECHO_ENABLED_PSIDS           — comma-separated allowlist (fallback ถ้า Sheet read fail)
 *   TEST_MODE_TAB                — Sheet tab name (default "TestMode")
 */

const express = require("express");
const crypto = require("crypto");
const { google } = require("googleapis");
const { generateReply } = require("./ai-reply");
const { isAllowed, getCacheStatus, invalidateCache } = require("./test-mode");

const app = express();

// ─── Config ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || "";
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN || "";
const FB_APP_SECRET = process.env.FB_APP_SECRET || "";
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || "";
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
const SHEET_TAB = process.env.SHEET_TAB || "Messages";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const TEST_MODE_TAB = process.env.TEST_MODE_TAB || "TestMode";

// ─── Safety gate (Stage 1.5 + Stage 3) ─────────────────────────────────────
// BOT_ENABLED: master kill-switch · "true" = อนุญาตให้บอท reply · ค่าอื่น = silent
// Stage 3: allowlist อ่านจาก Sheet "TestMode" tab (60s cache · admin แก้ได้ realtime)
// ECHO_ENABLED_PSIDS: fallback allowlist (env-based) ใช้เมื่อ Sheet read fail
const BOT_ENABLED = process.env.BOT_ENABLED === "true";
const ECHO_ENABLED_PSIDS = (process.env.ECHO_ENABLED_PSIDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ─── Capture raw body for signature verification ───────────────────────────
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ─── Google Sheets client (lazy init) ──────────────────────────────────────
let sheetsClient = null;
async function getSheets() {
  if (sheetsClient) return sheetsClient;
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");

  const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheetsClient = google.sheets({ version: "v4", auth: await auth.getClient() });
  return sheetsClient;
}

async function appendRow(values) {
  const sheets = await getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `${SHEET_TAB}!A:Z`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] },
  });
}

// ─── FB profile cache (avoid hammering Graph API) ──────────────────────────
const profileCache = new Map();
async function getSenderName(senderId) {
  if (profileCache.has(senderId)) return profileCache.get(senderId);
  if (!FB_PAGE_ACCESS_TOKEN) return "";
  try {
    const url = `https://graph.facebook.com/v19.0/${senderId}?fields=name,first_name,last_name&access_token=${FB_PAGE_ACCESS_TOKEN}`;
    const res = await fetch(url);
    if (!res.ok) return "";
    const data = await res.json();
    const name = data.name || `${data.first_name || ""} ${data.last_name || ""}`.trim();
    profileCache.set(senderId, name);
    return name;
  } catch (err) {
    console.warn("Failed to fetch sender profile:", err.message);
    return "";
  }
}

// ─── Send API (outbound to FB Messenger) ───────────────────────────────────
// Returns: { mid: string } on success · null on failure
async function sendFbMessage(psid, text) {
  if (!FB_PAGE_ACCESS_TOKEN) {
    console.warn("[Send] FB_PAGE_ACCESS_TOKEN missing — skip send");
    return null;
  }
  if (!psid || !text) return null;
  try {
    const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${FB_PAGE_ACCESS_TOKEN}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: psid },
        messaging_type: "RESPONSE",
        message: { text },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("[Send] Failed:", res.status, JSON.stringify(data));
      return null;
    }
    const preview = text.length > 60 ? text.slice(0, 60) + "..." : text;
    console.log(`[Send] → ${psid}: ${preview}`);
    return { mid: data.message_id || "" };
  } catch (err) {
    console.error("[Send] Error:", err.message);
    return null;
  }
}

// ─── Log outbound row to Sheet (for history continuity) ────────────────────
// ใช้ customer PSID ใน column D (ไม่ใช่ Page ID) เพื่อให้ getFbHistory ค้นเจอ
async function logOutboundRow({ customerPsid, text, mid }) {
  try {
    const ts = new Date();
    await appendRow([
      ts.toISOString(),
      ts.toISOString().slice(0, 10),
      ts.toISOString().slice(11, 19),
      customerPsid,           // D: customer PSID (consistent with inbound rows)
      "(Page Bot)",           // E: sender name marker
      "text",                 // F: messageType
      text,                   // G: messageText
      "",                     // H: extra
      mid || "",              // I: messageId
      "outbound",             // J: direction
    ]);
  } catch (err) {
    console.error("[Log] outbound row error:", err.message);
  }
}

// ─── Signature verification (x-hub-signature-256) ──────────────────────────
function isValidSignature(req) {
  if (!FB_APP_SECRET) return true; // skip if not configured (dev only)
  const sig = req.get("x-hub-signature-256");
  if (!sig) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", FB_APP_SECRET).update(req.rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── Routes ────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  const cacheStatus = getCacheStatus();
  res.json({
    service: "fb-chat-service",
    status: "ok",
    version: "1.3.0",
    bot_enabled: BOT_ENABLED,
    test_mode_tab: TEST_MODE_TAB,
    test_mode_allowed_count: cacheStatus.allowedCount,
    test_mode_cache_age_seconds: Math.round(cacheStatus.cacheAgeMs / 1000),
    test_mode_fetch_errored: cacheStatus.fetchErrored,
    echo_allowlist_fallback_count: ECHO_ENABLED_PSIDS.length,
    anthropic_api_key: ANTHROPIC_API_KEY ? "✅ set" : "❌ missing",
    fb_verify_token: FB_VERIFY_TOKEN ? "✅ set" : "❌ missing",
    fb_page_token: FB_PAGE_ACCESS_TOKEN ? "✅ set" : "❌ missing",
    fb_app_secret: FB_APP_SECRET ? "✅ set" : "⚠️  optional, missing",
    sheet_id: GOOGLE_SHEET_ID ? "✅ set" : "❌ missing",
    service_account: GOOGLE_SERVICE_ACCOUNT_JSON ? "✅ set" : "❌ missing",
  });
});

// Manual cache invalidation endpoint (no auth — local-only utility)
app.post("/admin/refresh-testmode-cache", (_req, res) => {
  invalidateCache();
  res.json({ ok: true, message: "TestMode cache invalidated" });
});

// FB webhook verification (one-time setup)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === FB_VERIFY_TOKEN) {
    console.log("✅ Webhook verified by Meta");
    return res.status(200).send(challenge);
  }
  console.warn("❌ Webhook verification failed:", { mode, tokenMatch: token === FB_VERIFY_TOKEN });
  return res.sendStatus(403);
});

// FB messaging events
app.post("/webhook", async (req, res) => {
  // ACK to FB ASAP — Meta retries if response > 20s
  res.sendStatus(200);

  if (!isValidSignature(req)) {
    console.warn("❌ Invalid x-hub-signature-256 — ignoring payload");
    return;
  }

  const body = req.body;
  if (body.object !== "page") return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      try {
        await handleMessagingEvent(event);
      } catch (err) {
        console.error("Error handling event:", err);
      }
    }
  }
});

// ─── Event handler ─────────────────────────────────────────────────────────
async function handleMessagingEvent(event) {
  const senderId = event.sender?.id;
  const recipientId = event.recipient?.id;
  if (!senderId) return;

  // ⚠️ FB ส่ง echo ของข้อความที่ Page ส่งออกด้วย ถ้าเปิด field "message_echoes"
  // Skip is_echo entirely — เรา log outbound เองหลัง Send API (ดู logOutboundRow)
  const isEcho = event.message?.is_echo === true;
  if (isEcho) {
    console.log("[Webhook] Skipping is_echo event (logged via Send API path)");
    return;
  }
  const direction = "inbound";

  const ts = new Date(event.timestamp || Date.now());
  const date = ts.toISOString().slice(0, 10);
  const time = ts.toISOString().slice(11, 19);

  const senderName = await getSenderName(senderId);

  let messageType = "unknown";
  let text = "";
  let extra = "";

  if (event.message) {
    if (event.message.text) {
      messageType = "text";
      text = event.message.text;
    } else if (event.message.attachments?.length) {
      messageType = event.message.attachments[0].type;
      extra = JSON.stringify(event.message.attachments[0].payload || {});
    } else if (event.message.sticker_id) {
      messageType = "sticker";
      extra = String(event.message.sticker_id);
    }
  } else if (event.postback) {
    messageType = "postback";
    text = event.postback.title || "";
    extra = event.postback.payload || "";
  } else if (event.delivery || event.read) {
    return;
  }

  console.log(`[${date} ${time}] ${direction} ${senderId} (${senderName}) ${messageType}: ${text}`);

  // Log inbound row (Schema: timestamp|date|time|senderId|name|type|text|extra|messageId|direction)
  await appendRow([
    ts.toISOString(),
    date,
    time,
    senderId,
    senderName,
    messageType,
    text,
    extra,
    event.message?.mid || "",
    direction,
  ]);

  // ─── Stage 3: AI Reply (allowlist via Sheet TestMode tab) ────────────────
  // Reply only to inbound text · safety gate via Sheet (with env fallback)
  if (messageType === "text" && text) {
    if (!BOT_ENABLED) {
      console.log(`[AI] Skipped — BOT_ENABLED=false (silent mode)`);
    } else {
      // Stage 3: check TestMode tab allowlist (cached 60s)
      const sheets = await getSheets();
      const allowed = await isAllowed({
        psid: senderId,
        sheets,
        spreadsheetId: GOOGLE_SHEET_ID,
        tabName: TEST_MODE_TAB,
        fallbackPsids: ECHO_ENABLED_PSIDS,
      });

      if (!allowed) {
        console.log(`[AI] Skipped — ${senderId} not in TestMode (active) · also not in ECHO_ENABLED_PSIDS fallback`);
      } else {
        try {
          const reply = await generateReply({
            apiKey: ANTHROPIC_API_KEY,
            senderId,
            displayName: senderName,
            text,
            sheets,
            spreadsheetId: GOOGLE_SHEET_ID,
            sheetTab: SHEET_TAB,
          });
          if (reply) {
            const sendResult = await sendFbMessage(senderId, reply);
            if (sendResult) {
              await logOutboundRow({
                customerPsid: senderId,
                text: reply,
                mid: sendResult.mid,
              });
            }
          } else {
            console.warn("[AI] No reply generated — silent");
          }
        } catch (err) {
          console.error("[AI] handleMessagingEvent error:", err.message);
        }
      }
    }
  }
}

// ─── Boot ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("\n🚀 fb-chat-service v1.3.0 (Stage 3: Sheet-based TestMode allowlist + 60s cache)");
  console.log(`Listening on port ${PORT}`);
  console.log("— Environment Check —");
  console.log("  FB_VERIFY_TOKEN:        ", FB_VERIFY_TOKEN ? "✅ set" : "❌ MISSING");
  console.log("  FB_PAGE_ACCESS_TOKEN:   ", FB_PAGE_ACCESS_TOKEN ? "✅ set" : "❌ MISSING");
  console.log("  FB_APP_SECRET:          ", FB_APP_SECRET ? "✅ set" : "⚠️  optional, missing");
  console.log("  GOOGLE_SHEET_ID:        ", GOOGLE_SHEET_ID ? "✅ set" : "❌ MISSING");
  console.log("  GOOGLE_SERVICE_ACCOUNT: ", GOOGLE_SERVICE_ACCOUNT_JSON ? "✅ valid" : "❌ MISSING");
  console.log("  SHEET_TAB:              ", SHEET_TAB);
  console.log("  TEST_MODE_TAB:          ", TEST_MODE_TAB);
  console.log("  BOT_ENABLED:            ", BOT_ENABLED ? "✅ true" : "🔇 false (silent — no replies)");
  console.log("  ECHO_ENABLED_PSIDS:     ", ECHO_ENABLED_PSIDS.length > 0 ? `✅ ${ECHO_ENABLED_PSIDS.length} PSID(s) · fallback only` : "(empty fallback)");
  console.log("  ANTHROPIC_API_KEY:      ", ANTHROPIC_API_KEY ? "✅ set" : "❌ MISSING (AI replies will fallback to standby)");
  console.log("  ℹ️  TestMode allowlist: refreshed lazily on first message (60s cache)");
});
