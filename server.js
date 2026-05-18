/**
 * fb-chat-service — Facebook Messenger webhook → Google Sheet logger
 * v1.5.0 Stage 5 · Slip Verification (SlipOK API · multi-branch fallback)
 *
 * Endpoints:
 *   GET  /                              → health
 *   GET  /webhook                       → FB verification (hub.challenge)
 *   POST /webhook                       → รับ messaging events
 *   POST /admin/refresh-testmode-cache  → manual TestMode cache refresh
 *   GET  /admin/slipok-quotas           → check SlipOK quota for each branch
 *
 * ENV required:
 *   FB_VERIFY_TOKEN, FB_PAGE_ACCESS_TOKEN, FB_APP_SECRET
 *   GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON
 *   ANTHROPIC_API_KEY
 *   SLIPOK_BRANCH_{1,2}_{ID,KEY,NAME}  (Stage 5)
 *
 * ENV optional:
 *   BOT_ENABLED (default false)
 *   ECHO_ENABLED_PSIDS (fallback allowlist)
 *   TEST_MODE_TAB (default "TestMode")
 *   IMAGE_HOST (default https://webhook-kohtalu-production.up.railway.app)
 */

const express = require("express");
const crypto = require("crypto");
const { google } = require("googleapis");
const { generateReply } = require("./ai-reply");
const { isAllowed, getCacheStatus, invalidateCache } = require("./test-mode");
const { isImageRequest, matchImages } = require("./image-map");
const { lintReply } = require("./image-lint");
const {
  verifySlip,
  saveSlipToBookingHold,
  formatSlipReply,
  loadSlipOKBranches,
} = require("./slip-verifier");

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

// ─── FB profile cache ──────────────────────────────────────────────────────
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

// ─── Send API ──────────────────────────────────────────────────────────────
async function sendFbMessage(psid, text) {
  if (!FB_PAGE_ACCESS_TOKEN) return null;
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

async function sendFbImage(psid, imageUrl) {
  if (!FB_PAGE_ACCESS_TOKEN) return null;
  if (!psid || !imageUrl) return null;
  try {
    const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${FB_PAGE_ACCESS_TOKEN}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: psid },
        messaging_type: "RESPONSE",
        message: {
          attachment: { type: "image", payload: { url: imageUrl, is_reusable: true } },
        },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("[SendImage] Failed:", res.status, JSON.stringify(data));
      return null;
    }
    console.log(`[SendImage] → ${psid}: ${imageUrl.split("/").slice(-3).join("/")}`);
    return { mid: data.message_id || "" };
  } catch (err) {
    console.error("[SendImage] Error:", err.message);
    return null;
  }
}

async function sendFbImages(psid, imageUrls) {
  const sent = [];
  for (const url of imageUrls) {
    const r = await sendFbImage(psid, url);
    if (r) sent.push(url);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return sent;
}

// ─── Log helpers ───────────────────────────────────────────────────────────
async function logOutboundRow({ customerPsid, text, mid, extra = "" }) {
  try {
    const ts = new Date();
    await appendRow([
      ts.toISOString(),
      ts.toISOString().slice(0, 10),
      ts.toISOString().slice(11, 19),
      customerPsid,
      "(Page Bot)",
      "text",
      text,
      extra,
      mid || "",
      "outbound",
    ]);
  } catch (err) {
    console.error("[Log] outbound row error:", err.message);
  }
}

async function logOutboundImage({ customerPsid, imageUrl, category }) {
  try {
    const ts = new Date();
    await appendRow([
      ts.toISOString(),
      ts.toISOString().slice(0, 10),
      ts.toISOString().slice(11, 19),
      customerPsid,
      "(Page Bot)",
      "image",
      `[image:${category}]`,
      JSON.stringify({ url: imageUrl, category }),
      "",
      "outbound",
    ]);
  } catch (err) {
    console.error("[Log] outbound image row error:", err.message);
  }
}

// ─── Signature verification ────────────────────────────────────────────────
function isValidSignature(req) {
  if (!FB_APP_SECRET) return true;
  const sig = req.get("x-hub-signature-256");
  if (!sig) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", FB_APP_SECRET).update(req.rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── Routes ────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  const cacheStatus = getCacheStatus();
  const slipokBranches = loadSlipOKBranches();
  res.json({
    service: "fb-chat-service",
    status: "ok",
    version: "1.5.0",
    bot_enabled: BOT_ENABLED,
    test_mode_tab: TEST_MODE_TAB,
    test_mode_allowed_count: cacheStatus.allowedCount,
    test_mode_cache_age_seconds: Math.round(cacheStatus.cacheAgeMs / 1000),
    test_mode_fetch_errored: cacheStatus.fetchErrored,
    echo_allowlist_fallback_count: ECHO_ENABLED_PSIDS.length,
    image_host: process.env.IMAGE_HOST || "https://webhook-kohtalu-production.up.railway.app",
    slipok_branches_configured: slipokBranches.length,
    slipok_branches: slipokBranches.map((b) => b.name),
    anthropic_api_key: ANTHROPIC_API_KEY ? "✅ set" : "❌ missing",
    fb_verify_token: FB_VERIFY_TOKEN ? "✅ set" : "❌ missing",
    fb_page_token: FB_PAGE_ACCESS_TOKEN ? "✅ set" : "❌ missing",
    fb_app_secret: FB_APP_SECRET ? "✅ set" : "⚠️  optional, missing",
    sheet_id: GOOGLE_SHEET_ID ? "✅ set" : "❌ missing",
    service_account: GOOGLE_SERVICE_ACCOUNT_JSON ? "✅ set" : "❌ missing",
  });
});

app.post("/admin/refresh-testmode-cache", (_req, res) => {
  invalidateCache();
  res.json({ ok: true, message: "TestMode cache invalidated" });
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === FB_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  if (!isValidSignature(req)) {
    console.warn("❌ Invalid signature");
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
  if (!senderId) return;

  const isEcho = event.message?.is_echo === true;
  if (isEcho) {
    console.log("[Webhook] Skipping is_echo event");
    return;
  }

  const ts = new Date(event.timestamp || Date.now());
  const date = ts.toISOString().slice(0, 10);
  const time = ts.toISOString().slice(11, 19);

  const senderName = await getSenderName(senderId);

  let messageType = "unknown";
  let text = "";
  let extra = "";
  let attachmentUrl = "";

  if (event.message) {
    if (event.message.text) {
      messageType = "text";
      text = event.message.text;
    } else if (event.message.attachments?.length) {
      const att = event.message.attachments[0];
      messageType = att.type; // image, audio, video, file, location, fallback
      extra = JSON.stringify(att.payload || {});
      attachmentUrl = att.payload?.url || "";
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

  console.log(`[${date} ${time}] inbound ${senderId} (${senderName}) ${messageType}: ${text || "(attachment)"}`);

  // Log inbound row (ทุก message)
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
    "inbound",
  ]);

  // ─── Master kill switch ──────────────────────────────────────────────────
  if (!BOT_ENABLED) {
    console.log(`[Bot] Skipped — BOT_ENABLED=false`);
    return;
  }

  // ─── TestMode allowlist ───────────────────────────────────────────────────
  const sheets = await getSheets();
  const allowed = await isAllowed({
    psid: senderId,
    sheets,
    spreadsheetId: GOOGLE_SHEET_ID,
    tabName: TEST_MODE_TAB,
    fallbackPsids: ECHO_ENABLED_PSIDS,
  });

  if (!allowed) {
    console.log(`[Bot] Skipped — ${senderId} not in TestMode (active)`);
    return;
  }

  // ─── Stage 5: Slip verification (image attachments) ─────────────────────
  if (messageType === "image" && attachmentUrl) {
    console.log(`[Slip] Image received · trying slip verification`);
    try {
      const slipResult = await verifySlip({ fbAttachmentUrl: attachmentUrl });

      if (slipResult.ok) {
        // ✅ Verified slip — save to BookingHold + reply
        await saveSlipToBookingHold({
          sheets,
          spreadsheetId: GOOGLE_SHEET_ID,
          psid: senderId,
          displayName: senderName,
          slipData: slipResult,
        });

        const replyText = formatSlipReply(slipResult);
        if (replyText) {
          const sendResult = await sendFbMessage(senderId, replyText);
          if (sendResult) {
            await logOutboundRow({
              customerPsid: senderId,
              text: replyText,
              mid: sendResult.mid,
              extra: JSON.stringify({
                slip_amount: slipResult.amount,
                slip_ref: slipResult.ref,
                slip_branch: slipResult.matchedBranch,
              }),
            });
          }
        }
        return;
      }

      // ❌ Slip verification failed
      console.log(`[Slip] Verification failed: ${slipResult.error}`);

      // not_a_slip → not a slip image · skip (don't reply · just log)
      if (slipResult.error === "not_a_slip") {
        console.log(`[Slip] Not a slip image · silent (admin can review via Messages tab)`);
        return;
      }

      // Other errors → reply with appropriate message
      const errorReply = formatSlipReply(slipResult);
      if (errorReply) {
        const sendResult = await sendFbMessage(senderId, errorReply);
        if (sendResult) {
          await logOutboundRow({
            customerPsid: senderId,
            text: errorReply,
            mid: sendResult.mid,
            extra: JSON.stringify({ slip_error: slipResult.error }),
          });
        }
      }
      return;
    } catch (err) {
      console.error("[Slip] Unexpected error:", err.message);
      const fallback = "ขอเจ้าหน้าที่ช่วยตรวจสอบสลิปให้นะครับ 🙏";
      const sendResult = await sendFbMessage(senderId, fallback);
      if (sendResult) {
        await logOutboundRow({ customerPsid: senderId, text: fallback, mid: sendResult.mid });
      }
      return;
    }
  }

  // ─── Text-only AI reply (Stages 2-4) ────────────────────────────────────
  if (messageType !== "text" || !text) return;

  // Stage 4: Image matching
  let matchedImages = null;
  if (isImageRequest(text)) {
    matchedImages = matchImages(text);
    if (matchedImages) {
      console.log(`[Image] Matched category=${matchedImages.category} · ${matchedImages.urls.length} url(s)`);
    } else {
      console.log(`[Image] isImageRequest=true but no match · will escalate via lint`);
    }
  }

  // Generate AI reply
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

    if (!reply) {
      console.warn("[AI] No reply generated");
      return;
    }

    let imagesSent = [];
    if (matchedImages?.urls?.length) {
      imagesSent = await sendFbImages(senderId, matchedImages.urls);
      for (const url of imagesSent) {
        await logOutboundImage({
          customerPsid: senderId,
          imageUrl: url,
          category: matchedImages.category,
        });
      }
    }

    const finalText = lintReply(reply, imagesSent.length > 0);
    if (finalText && finalText.trim()) {
      const sendResult = await sendFbMessage(senderId, finalText);
      if (sendResult) {
        await logOutboundRow({
          customerPsid: senderId,
          text: finalText,
          mid: sendResult.mid,
        });
      }
    }
  } catch (err) {
    console.error("[AI] handleMessagingEvent error:", err.message);
  }
}

// ─── Boot ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const slipokBranches = loadSlipOKBranches();
  console.log("\n🚀 fb-chat-service v1.5.0 (Stage 5: Slip verification · SlipOK multi-branch)");
  console.log(`Listening on port ${PORT}`);
  console.log("— Environment Check —");
  console.log("  FB_VERIFY_TOKEN:        ", FB_VERIFY_TOKEN ? "✅ set" : "❌ MISSING");
  console.log("  FB_PAGE_ACCESS_TOKEN:   ", FB_PAGE_ACCESS_TOKEN ? "✅ set" : "❌ MISSING");
  console.log("  FB_APP_SECRET:          ", FB_APP_SECRET ? "✅ set" : "⚠️  optional, missing");
  console.log("  GOOGLE_SHEET_ID:        ", GOOGLE_SHEET_ID ? "✅ set" : "❌ MISSING");
  console.log("  GOOGLE_SERVICE_ACCOUNT: ", GOOGLE_SERVICE_ACCOUNT_JSON ? "✅ valid" : "❌ MISSING");
  console.log("  SHEET_TAB:              ", SHEET_TAB);
  console.log("  TEST_MODE_TAB:          ", TEST_MODE_TAB);
  console.log("  BOT_ENABLED:            ", BOT_ENABLED ? "✅ true" : "🔇 false");
  console.log("  ECHO_ENABLED_PSIDS:     ", ECHO_ENABLED_PSIDS.length > 0 ? `(fallback) ${ECHO_ENABLED_PSIDS.length} PSID(s)` : "(empty)");
  console.log("  ANTHROPIC_API_KEY:      ", ANTHROPIC_API_KEY ? "✅ set" : "❌ MISSING");
  console.log("  IMAGE_HOST:             ", process.env.IMAGE_HOST || "(default LINE)");
  console.log("  SLIPOK BRANCHES:        ", slipokBranches.length > 0 ? `✅ ${slipokBranches.length} (${slipokBranches.map((b) => b.name).join(", ")})` : "❌ NONE");
});
