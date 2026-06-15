/**
 * fb-chat-service — Facebook Messenger webhook
 * v1.9.0 Stage 6.8 · Bidirectional bot toggle (admin manual takeover via is_echo)
 *
 * What's new vs v1.8.1 (Stage 6.7):
 *   - is_echo (admin replied via Messenger UI) → pauseBot(customerPsid) for 2 hours
 *   - All subsequent customer messages: bot does NOT auto-reply for paused PSIDs
 *     · BUT: sensitive keyword alerts to LINE group still fire (admin still gets visibility)
 *   - Sliding window: each admin echo extends pause by another 2h
 *   - Auto-resume after 2h of no echo (configurable BOT_PAUSE_DURATION_MS)
 *   - Per-PSID in-memory state · no Sheet persistence (Railway restart = all resume)
 *
 * Carried over:
 *   - Stage 6.7: Customer waiting timer (still fires · pause cancels timer too)
 *   - Stage 6.6: LINE group notifier · dedupe · PII redact · sensitive keyword detection
 *
 * New ENV (optional):
 *   BOT_PAUSE_DURATION_MS  — milliseconds (default 7200000 = 2 hours)
 *
 * Existing ENV:
 *   LINE_PUSH_TOKEN, LINE_GROUP_ID, WAITING_THRESHOLD_MS · all unchanged
 */

const express = require("express");
const crypto = require("crypto");
const { google } = require("googleapis");
const { generateReply } = require("./ai-reply");
const { classifyIntent: _classifyIntentShadowFB } = require("./intent-router");  // FB_STEP3_SHADOW_WIRED
const { logShadowDecision: _logShadowFB } = require("./intent-shadow-log");  // FB_STEP3_SHADOW_WIRED
const {
  isLeadProfileEnabled: _isLPEnabledFB,
  loadLeadProfile: _loadLPFB,
  classifyMessage: _classifyLPMsgFB,
  saveLeadProfile: _saveLPFB,
} = require("./lead-profile");  // FB_STEP2_LEAD_PROFILE_WIRED
// FB_AVAILABILITY_WIRED
const { checkBayAvailability: _checkBayAvailFB, validateDates: _validateDatesFB, SELECTED_ROOMS: _SELECTED_ROOMS_FB } = require("./availability-checker");
const { parseThaiDateRange: _parseThaiDateRangeFB } = require("./fb-date-parser");

// Format availability result as customer-facing reply
function _formatAvailabilityReplyFB(parsed, result) {
  // FB_AVAIL_V2_SERVER_HOTFIX + FB_AVAIL_V3_UNKNOWN: parsed dates + smart unknown handling
  const { bays, totalAvailable, hasUnknown } = result;
  const checkIn = parsed.checkIn;
  const checkOut = parsed.checkOut;
  const oneNight = (new Date(checkOut).getTime() - new Date(checkIn).getTime()) === 86_400_000;
  const dateStr = oneNight ? checkIn : `${checkIn} ถึง ${checkOut}`;

  // FB_AVAIL_V6_FALLTHROUGH: when Drive read returns 0/unknown, return null → caller falls through to generateReply
  // This matches LINE bot's graceful AI-driven conversation (asks nights/pax/bay clarification)
  if (totalAvailable === 0 && hasUnknown) {
    console.warn(`[AVAIL-FB] uncertain · totalAvailable=0 + hasUnknown=true · fall through to AI · dates=${dateStr}`);
    return null;  // signal caller to skip direct send + use generateReply instead
  }

  if (totalAvailable === 0) {
    return `ช่วง ${dateStr} ห้องเต็มแล้วครับ 😔 ขอแอดมินช่วยเช็ควันอื่นใกล้เคียงให้ครับ 🙏`;
  }

  const parts = [`ช่วง ${dateStr} ครับ 😊`];
  const bayNames = ['อ่าวมุก', 'อ่าวใหญ่'];
  for (const bay of bayNames) {
    const b = bays[bay];
    if (!b) continue;
    if (b.available.length > 0) {
      const emoji = bay === 'อ่าวมุก' ? '🛖' : '🏠';
      parts.push(`${emoji} ${bay}: ยังมีห้องว่างครับ`);
    } else if (b.booked.length > 0) {
      const emoji = bay === 'อ่าวมุก' ? '🛖' : '🏠';
      parts.push(`${emoji} ${bay}: เต็มแล้ว`);
    }
  }
  parts.push('มาทั้งหมดกี่ท่านครับ? ผมจะแนะนำห้องที่เหมาะสมให้');
  return parts.join('\n');
}
const { isAllowed, getCacheStatus, invalidateCache } = require("./test-mode");
const { isImageRequest, matchImages } = require("./image-map");
const { lintReply } = require("./image-lint");
const { getKBCacheStats } = require("./knowledge-base");
const { getPricingCacheStats } = require("./pricing-loader");
const {
  verifySlip,
  saveSlipToBookingHold,
  formatSlipReply,
  loadSlipOKBranches,
} = require("./slip-verifier");
const {
  startNameCollection,
  isCollecting,
  cancelCollection,
  handleCollectorText,
  handleCollectorImage,
} = require("./booking-collector");
const {
  notifySlipVerified,
  notifyBookingNamesCollected,
  notifySensitiveKeyword,
  detectSensitiveKeyword,
  startWaitingTimer,
  clearWaitingTimer,
  getConfigStatus: getNotifierStatus,
} = require("./line-group-notifier");
const {
  pauseBot,
  isBotPaused,
  resumeBot,
  getPauseInfo,
  getConfigStatus: getPauseStatus,
} = require("./bot-pause");

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

const BREVO_API_KEY = process.env.BREVO_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "";
const EMAIL_RESERVATION = process.env.EMAIL_RESERVATION || "";

const LINE_PUSH_TOKEN = process.env.LINE_PUSH_TOKEN || "";
const LINE_GROUP_ID = process.env.LINE_GROUP_ID || "";

const BOT_ENABLED = process.env.BOT_ENABLED === "true";
const ECHO_ENABLED_PSIDS = (process.env.ECHO_ENABLED_PSIDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ─── Raw body capture for signature verification ───────────────────────────
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ─── Google auth + clients (lazy init) ─────────────────────────────────────
let _authClient = null;
let _sheetsClient = null;

async function getGoogleAuth() {
  if (_authClient) return _authClient;
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
  const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive",
    ],
  });
  _authClient = await auth.getClient();
  return _authClient;
}

async function getSheets() {
  if (_sheetsClient) return _sheetsClient;
  const auth = await getGoogleAuth();
  _sheetsClient = google.sheets({ version: "v4", auth });
  return _sheetsClient;
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
  if (!FB_PAGE_ACCESS_TOKEN || !psid || !text) return null;
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

// Day 9 PM Bug #15: Try attachment_id first (bypasses URL fetch in Dev mode)
// Fall back to URL if attachment_id not in cache
const fs = require("fs");
const path = require("path");
let ATTACHMENT_ID_MAP = {};
try {
  ATTACHMENT_ID_MAP = JSON.parse(
    fs.readFileSync(path.join(__dirname, "attachment-id-map.json"), "utf8")
  );
  console.log(`[server] attachment-id-map loaded · ${Object.keys(ATTACHMENT_ID_MAP).length} cached`);
} catch (e) {
  console.warn("[server] attachment-id-map.json not found · will use URL fallback");
}

async function sendFbImage(psid, imageUrl) {
  if (!FB_PAGE_ACCESS_TOKEN || !psid || !imageUrl) return null;

  // Try attachment_id first (works in Dev mode)
  const cachedId = ATTACHMENT_ID_MAP[imageUrl];
  const payload = cachedId
    ? { attachment_id: cachedId }
    : { url: imageUrl, is_reusable: true };
  const method = cachedId ? "attachment_id" : "url";

  try {
    const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${FB_PAGE_ACCESS_TOKEN}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: psid },
        messaging_type: "RESPONSE",
        message: {
          attachment: { type: "image", payload },
        },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[SendImage] Failed via ${method}:`, res.status, JSON.stringify(data));
      // If attachment_id failed, try URL fallback once
      if (cachedId) {
        console.warn(`[SendImage] attachment_id failed · retry with URL`);
        return sendFbImageUrlOnly(psid, imageUrl);
      }
      return null;
    }
    console.log(`[SendImage] → ${psid} via ${method}: ${imageUrl.split("/").slice(-3).join("/")}`);
    return { mid: data.message_id || "" };
  } catch (err) {
    console.error("[SendImage] Error:", err.message);
    return null;
  }
}

async function sendFbImageUrlOnly(psid, imageUrl) {
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
      console.error("[SendImage URL fallback] Failed:", res.status, JSON.stringify(data));
      return null;
    }
    return { mid: data.message_id || "" };
  } catch (err) {
    console.error("[SendImage URL fallback] Error:", err.message);
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
// FB_BKK_TZ_FIX: return BKK-time Date (UTC + 7 hr) for log/Sheet display
function bkkNow() { return new Date(Date.now() + 7 * 60 * 60 * 1000); }
function bkkFromEvent(eventTs) { return new Date((eventTs || Date.now()) + 7 * 60 * 60 * 1000); }

async function logOutboundRow({ customerPsid, text, mid, extra = "" }) {
  try {
    const ts = bkkNow();
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
    const ts = bkkNow();  // FB_BKK_TZ_FIX
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

async function sendAndLog(psid, text, extra = "") {
  const sendResult = await sendFbMessage(psid, text);
  if (sendResult) {
    await logOutboundRow({ customerPsid: psid, text, mid: sendResult.mid, extra });
  }
  return sendResult;
}

// ─── Booking-collector prompt template ──────────────────────────────────────
const COLLECTOR_KICKOFF_PROMPT =
  "เพื่อให้ confirmation ครบถ้วน ขอข้อมูลเพิ่มเติมหน่อยครับ 🙏\n\n" +
  "1️⃣ รายชื่อสมาชิกที่เข้าพัก (1 ชื่อต่อบรรทัด)\n" +
  "2️⃣ เบอร์โทรติดต่อหลัก\n" +
  "3️⃣ Email สำหรับ confirmation (ถ้าต้องการสำเนา)\n\n" +
  "ส่งมาในข้อความเดียวกันได้เลยครับ หรือถ่ายรูปบัตรประชาชน/passport ส่งมาก็ได้ครับ 📸";

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
  const notifierStatus = getNotifierStatus();
  const pauseStatus = getPauseStatus();
  res.json({
    service: "fb-chat-service",
    status: "ok",
    version: "1.9.0",
    stage: "Stage 6.8 · Bidirectional bot toggle (admin manual takeover)",
    bot_enabled: BOT_ENABLED,
    test_mode_tab: TEST_MODE_TAB,
    test_mode_allowed_count: cacheStatus.allowedCount,
    test_mode_cache_age_seconds: Math.round(cacheStatus.cacheAgeMs / 1000),
    test_mode_fetch_errored: cacheStatus.fetchErrored,
    kb_cache: getKBCacheStats(),
    pricing_cache: getPricingCacheStats(),
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
    email_brevo_api_key: BREVO_API_KEY ? "✅ set" : "⚠️  missing (email disabled)",
    email_from: EMAIL_FROM ? "✅ set" : "⚠️  default will be used",
    email_reservation: EMAIL_RESERVATION ? "✅ set" : "⚠️  missing (email disabled)",
    line_push_token: notifierStatus.line_push_token,
    line_group_id: notifierStatus.line_group_id,
    line_dedupe_cache_size: notifierStatus.dedupe_cache_size,
    line_active_waiting_timers: notifierStatus.active_waiting_timers,
    line_waiting_threshold_seconds: notifierStatus.waiting_threshold_seconds,
    bot_pause_duration_seconds: pauseStatus.pause_duration_seconds,
    bot_active_pauses: pauseStatus.active_pauses,
  });
});

// E11_FB_ADMIN_AUTH: gate admin endpoints with Bearer ADMIN_API_TOKEN (parity w/ LINE bot E11)
// Pattern: `Authorization: Bearer $ADMIN_API_TOKEN` · 401 if mismatch · 503 if env unset
function requireAdminToken(req, res, next) {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) {
    console.warn("[E11] ADMIN_API_TOKEN not set · /admin/* will 503");
    return res.status(503).json({ error: "ADMIN_API_TOKEN not configured" });
  }
  const auth = req.headers.authorization || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (provided !== token) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.post("/admin/refresh-testmode-cache", requireAdminToken, (_req, res) => {
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

// V97 — after-hours mode: time-window gate via BOT_ACTIVE_HOURS env var
// Format: "22-06" = active 22:00 to 06:00 BKK (overnight wrap)
// Format: "9-17" = active 09:00 to 17:00 BKK (same-day)
// Default unset: always-on (backward compatible)
function isWithinActiveHours() {
  const cfg = (process.env.BOT_ACTIVE_HOURS || "").trim();
  if (!cfg) return true;
  const m = cfg.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return true;
  const start = parseInt(m[1], 10);
  const end = parseInt(m[2], 10);
  const bkkHourStr = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Bangkok",
    hour: "numeric",
    hour12: false,
  });
  const h = parseInt(bkkHourStr, 10);
  if (start < end) return h >= start && h < end;
  return h >= start || h < end;
}

// ─── Event handler ─────────────────────────────────────────────────────────
async function handleMessagingEvent(event) {
  const senderId = event.sender?.id;
  if (!senderId) return;

  if (event.message?.is_echo === true) {
    // Stage 6.7/6.8: Admin manually replied via FB Messenger UI
    // For echo events, recipient.id = customer PSID (sender.id = Page ID)
    const customerPsid = event.recipient?.id;
    if (customerPsid) {
      // Clear customer's waiting timer (Stage 6.7) — admin has responded
      const cleared = clearWaitingTimer(customerPsid, "admin_echo");
      if (cleared) {
        console.log(`[Webhook] is_echo · cleared waiting timer for customer ${customerPsid}`);
      }
      // Pause bot for this customer (Stage 6.8) — admin is taking over
      pauseBot(customerPsid, "admin_echo");
    }
    console.log("[Webhook] is_echo processed (pause + clear-timer)");
    return;
  }

  const ts = bkkFromEvent(event.timestamp);  // FB_BKK_TZ_FIX
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
      messageType = att.type;
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

  console.log(
    `[${date} ${time}] inbound ${senderId} (${senderName}) ${messageType}: ${text || "(attachment)"}`
  );

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

  if (!BOT_ENABLED) {
    console.log(`[Bot] Skipped — BOT_ENABLED=false`);
    return;
  }

  const sheets = await getSheets();
  const auth = await getGoogleAuth();
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

  // V97 — after-hours gate (silent during admin team active hours)
  if (!isWithinActiveHours()) {
    console.log(`[V97] outsideActiveHours · psid=${senderId.substring(0, 8)}`);
    return;
  }

  // ─── Stage 6.7: Clear customer's waiting timer (they sent a new inbound) ──
  // If they were waiting for admin and now sent a follow-up, assume they got
  // helped (or they're moving on). Clear timer to prevent stale alerts.
  clearWaitingTimer(senderId, "customer_followup");

  // ─── Stage 6.6: Sensitive keyword detection (TEXT messages only) ────────
  // Fire-and-forget · doesn't block AI reply or collector flow
  if (messageType === "text" && text) {
    const reason = detectSensitiveKeyword(text);
    if (reason) {
      console.log(`[Group] Sensitive keyword detected: ${reason} (psid=${senderId})`);
      notifySensitiveKeyword({
        senderName,
        psid: senderId,
        customerMessage: text,
        reason,
      }).catch((err) => console.warn("[Group] Notify error:", err.message));

      // Stage 6.7: Start 15-min waiting timer (auto-cleared on next customer
      // message or admin is_echo). If neither happens, alert LINE group.
      startWaitingTimer({
        psid: senderId,
        senderName,
        lastMessage: text,
        reason,
      });
    }
  }

  // ─── Stage 6.8: Bot pause check ─────────────────────────────────────────
  // If admin has manually replied recently via FB Messenger UI, skip auto-reply.
  // Customer messages are still logged + sensitive alerts still fire (above).
  // Customer's existing collector session is preserved · just no NEW bot output.
  if (isBotPaused(senderId)) {
    const info = getPauseInfo(senderId);
    console.log(
      `[Bot] PAUSED — ${senderId} (admin took over · ${info?.minutesRemaining || "?"} min remaining · echoCount=${info?.echoCount || "?"})`
    );
    return;
  }

  // ─── Stage 6.5: Booking-collector takes priority if in session ──────────
  if (isCollecting(senderId)) {
    console.log(`[Collector] Active for ${senderId} · routing to handleCollector*`);

    let collectorResult = null;
    if (messageType === "text" && text) {
      collectorResult = await handleCollectorText({
        psid: senderId,
        msgText: text,
        auth,
        sheets,
        sheetId: GOOGLE_SHEET_ID,
      });
    } else if (messageType === "image" && attachmentUrl) {
      collectorResult = await handleCollectorImage({
        psid: senderId,
        attachmentUrl,
        apiKey: ANTHROPIC_API_KEY,
      });
    }

    if (collectorResult?.handled && collectorResult.replyText) {
      const extraMeta = collectorResult.done
        ? JSON.stringify({
            collector: "finalized",
            customerEmail: collectorResult.customerEmail || "",
          })
        : JSON.stringify({ collector: "in_progress" });
      await sendAndLog(senderId, collectorResult.replyText, extraMeta);

      // ─── Stage 6.6: On collector finalize → notify LINE group ───────────
      if (collectorResult.done && collectorResult.notifyData) {
        notifyBookingNamesCollected({
          senderName,
          psid: senderId,
          ...collectorResult.notifyData,
        }).catch((err) => console.warn("[Group] Notify error:", err.message));
      }
      return;
    }

    if (!collectorResult?.handled) {
      console.log(`[Collector] Not handled · session active but message type ${messageType} ignored`);
      return;
    }
  }

  // ─── Stage 5: Slip verification (image attachments · NOT in collector) ──
  if (messageType === "image" && attachmentUrl) {
    console.log(`[Slip] Image received · trying slip verification`);
    try {
      const slipResult = await verifySlip({ fbAttachmentUrl: attachmentUrl });

      if (slipResult.ok) {
        const saveResult = await saveSlipToBookingHold({
          sheets,
          spreadsheetId: GOOGLE_SHEET_ID,
          psid: senderId,
          displayName: senderName,
          slipData: slipResult,
        });
        const rowIndex = saveResult?.rowIndex || null;

        const replyText = formatSlipReply(slipResult);
        if (replyText) {
          await sendAndLog(
            senderId,
            replyText,
            JSON.stringify({
              slip_amount: slipResult.amount,
              slip_ref: slipResult.ref,
              slip_branch: slipResult.matchedBranch,
              row_index: rowIndex,
            })
          );
        }

        // ─── Stage 6.6: Notify LINE group about verified slip ─────────────
        notifySlipVerified({
          senderName,
          psid: senderId,
          amount: slipResult.amount,
          ref: slipResult.ref,
          branch: slipResult.matchedBranch,
        }).catch((err) => console.warn("[Group] Notify error:", err.message));

        startNameCollection({
          psid: senderId,
          bookingRef: "",
          bookingPersonName: slipResult.senderName || senderName || "",
          matchedAmount: slipResult.amount,
          rowIndex,
          slipData: slipResult,
        });
        console.log(`[Collector] Session started for ${senderId} · row=${rowIndex}`);

        await sendAndLog(senderId, COLLECTOR_KICKOFF_PROMPT, JSON.stringify({ collector: "kickoff" }));
        return;
      }

      console.log(`[Slip] Verification failed: ${slipResult.error}`);

      if (slipResult.error === "not_a_slip") {
        console.log(`[Slip] Not a slip image · silent (admin can review via Messages tab)`);
        return;
      }

      const errorReply = formatSlipReply(slipResult);
      if (errorReply) {
        await sendAndLog(senderId, errorReply, JSON.stringify({ slip_error: slipResult.error }));
      }
      return;
    } catch (err) {
      console.error("[Slip] Unexpected error:", err.message);
      await sendAndLog(senderId, "ขอเจ้าหน้าที่ช่วยตรวจสอบสลิปให้นะครับ 🙏");
      return;
    }
  }

  // ─── Text-only AI reply (Stages 2-4) ────────────────────────────────────
  if (messageType !== "text" || !text) return;

  let matchedImages = null;
  if (isImageRequest(text)) {
    matchedImages = matchImages(text);
    if (matchedImages) {
      // Day 9 PM Bug #12 fix: LINE image-map returns {images, caption} not {urls, category}
      // Map to FB-expected shape for downstream send logic
      matchedImages.urls = matchedImages.images || [];
      matchedImages.category = matchedImages.caption || 'images';
      console.log(`[Image] Matched caption=${matchedImages.caption} · ${matchedImages.urls.length} url(s)`);
    } else {
      console.log(`[Image] isImageRequest=true but no match · will escalate via lint`);
    }
  }

  // ── FB_STEP2_LEAD_PROFILE_WIRED (Step 2) ──
  // Load + classify lead profile (gated on LEAD_PROFILE_ENABLED) · before reply
  let _leadProfileFB = null;
  let _leadMutationsFB = null;
  if (_isLPEnabledFB() && messageType === "text") {
    try {
      _leadProfileFB = await _loadLPFB(senderId, "FB");
      if (senderName && _leadProfileFB.displayName !== senderName) {
        _leadProfileFB.displayName = senderName;
      }
      _leadMutationsFB = _classifyLPMsgFB(text, _leadProfileFB);
      Object.assign(_leadProfileFB, _leadMutationsFB);
    } catch (err) {
      console.warn("[LP-FB] load/classify error:", err.message);
      _leadProfileFB = null;
    }
  }
  // ── end FB_STEP2_LEAD_PROFILE_WIRED (Step 2 load) ──

  try {
    // ── FB_STEP3_SHADOW_WIRED (Step 3 A.3 + A.3.5) ──
    // Shadow mode · log router decision · persist to IntentShadow Sheet · no behavior change
    if (process.env.INTENT_ROUTER_SHADOW === 'true') {
      try {
        const _intentDecision = _classifyIntentShadowFB(text, _leadProfileFB);  // FB_STEP2_LEAD_PROFILE_WIRED: pass lead profile
        console.log(`[IR-SHADOW] psid=${senderId.substring(0, 8)} intent=${_intentDecision.intent}${_intentDecision.sub ? '/' + _intentDecision.sub : ''} handler=${_intentDecision.handler} conf=${_intentDecision.confidence} reason="${_intentDecision.reason}"`);
        // Fire-and-forget Sheet write · never blocks reply
        _logShadowFB({
          sheets,
          sheetId: GOOGLE_SHEET_ID,
          userId: senderId,
          msgText: text,
          decision: _intentDecision,
          leadProfile: _leadProfileFB,  // FB_STEP2_LEAD_PROFILE_WIRED: pass lead profile for stage column
        }).catch(_e => console.warn('[IR-SHADOW-LOG] async error:', _e.message));
      } catch (_irErr) {
        console.warn('[IR-SHADOW] classify error:', _irErr.message);
      }
    }
    // ── end FB_STEP3_SHADOW_WIRED ──

    // ── FB_AVAILABILITY_WIRED + FB_AVAIL_V2_SERVER_HOTFIX — availability check before AI gen ──
    if (process.env.AVAILABILITY_CHECK_ENABLED !== 'false' && messageType === 'text') {
      try {
        const _availIntent = _classifyIntentShadowFB(text, _leadProfileFB);
        // FB_AVAIL_V2_SERVER_HOTFIX: widen trigger — fire on explicit AVAILABILITY OR (date + booking verb) OR (date + FREE_FORM)
        const _hasBookingVerb = /พัก|ค้าง|จอง|อยาก(?:ไป|มา|พัก)?|ไปเที่ยว|มาเที่ยว|stay|book/i.test(text);
        const _parsedProbe = _parseThaiDateRangeFB(text);
        const _shouldCheckAvail = _availIntent.intent === 'AVAILABILITY' ||
          (_parsedProbe && (_hasBookingVerb || (_availIntent.intent === 'FREE_FORM' && /\d/.test(text))));
        if (_shouldCheckAvail) {
          const _parsed = _parsedProbe || _parseThaiDateRangeFB(text);
          if (_parsed) {
            const _vd = _validateDatesFB(_parsed.checkIn, _parsed.checkOut);
            if (_vd.ok) {
              console.log(`[AVAIL-FB] intent=${_availIntent.intent} dates=${_parsed.checkIn}..${_parsed.checkOut} hint="${_parsed.hint}"`);
              const _auth = await getGoogleAuth();
              // FB_AVAIL_V5_BAY_ARG: checkBayAvailability signature is (auth, bay, checkIn, checkOut) — pass 'any' for all bays
              const _result = await _checkBayAvailFB(_auth, 'any', _parsed.checkIn, _parsed.checkOut);
              // FB_AVAIL_V4_RELAXED: detailed per-bay log for Excel parsing diagnosis
              const _bayDebug = Object.fromEntries(Object.entries(_result.bays || {}).map(([k, v]) => [k, {
                a: (v.available || []).length, b: (v.booked || []).length, u: (v.unknown || []).length,
                ids: { a: (v.available || []).slice(0,3), b: (v.booked || []).slice(0,3), u: (v.unknown || []).slice(0,3) },
              }]));
              console.log(`[AVAIL-FB] result · totalAvailable=${_result.totalAvailable} hasUnknown=${_result.hasUnknown}`);
              console.log(`[AVAIL-FB] bays detail: ${JSON.stringify(_bayDebug)}`);
              const _availReply = _formatAvailabilityReplyFB(_parsed, _result);
              if (_availReply) {
                await sendAndLog(senderId, _availReply);
                return;  // skip generateReply
              }
              // FB_AVAIL_V6_FALLTHROUGH: null from formatter → fall through to generateReply for AI conversation
              console.log('[AVAIL-FB] formatter returned null · fall through to AI gen');
            } else {
              console.log(`[AVAIL-FB] dates invalid: ${_vd.reason} · fall through to AI`);
            }
          } else {
            console.log(`[AVAIL-FB] no parseable dates in "${text.substring(0, 50)}" · fall through to AI`);
          }
        }
      } catch (_availErr) {
        console.warn('[AVAIL-FB] error · falling through:', _availErr.message);
      }
    }
    // ── end FB_AVAILABILITY_WIRED ──

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
      await sendAndLog(senderId, finalText);
    }

    // ── FB_STEP2_LEAD_PROFILE_WIRED (Step 2 save) ──
    // Persist lead profile mutations after reply · queued · non-blocking
    if (_isLPEnabledFB() && _leadProfileFB && messageType === "text") {
      try {
        const nowIso = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString();
        const replyContainsPrice = /\d{1,3}(?:,\d{3})+\s*(?:฿|บาท|baht)|\d{4,5}\s*(?:฿|บาท|baht)/i.test(reply || '');
        const saveMutations = {
          ...(_leadMutationsFB || {}),
          platform: "FB",
          displayName: senderName,
          last_inbound: nowIso,
          updated_at: nowIso,
          inbound_count:   (_leadProfileFB.inbound_count   || 0) + 1,
          bot_reply_count: (_leadProfileFB.bot_reply_count || 0) + 1,
        };
        if (!_leadProfileFB.first_contact) saveMutations.first_contact = nowIso;
        if (replyContainsPrice) {
          saveMutations.bot_last_quote_at = nowIso;
          if (!["booking", "won", "lost"].includes(_leadProfileFB.stage)) {
            saveMutations.stage = "quoting";
          }
        }
        _saveLPFB(senderId, saveMutations).catch(err =>
          console.warn("[LP-FB] saveLeadProfile error:", err.message)
        );
      } catch (err) {
        console.warn("[LP-FB] post-reply save error:", err.message);
      }
    }
    // ── end FB_STEP2_LEAD_PROFILE_WIRED (Step 2 save) ──
  } catch (err) {
    console.error("[AI] handleMessagingEvent error:", err.message);
  }
}

// ─── Boot ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const slipokBranches = loadSlipOKBranches();
  console.log(
    "\n🚀 fb-chat-service v1.9.0 (Stage 6.8: Bidirectional bot toggle · admin manual takeover)"
  );
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
  console.log(
    "  ECHO_ENABLED_PSIDS:     ",
    ECHO_ENABLED_PSIDS.length > 0 ? `(fallback) ${ECHO_ENABLED_PSIDS.length} PSID(s)` : "(empty)"
  );
  console.log("  ANTHROPIC_API_KEY:      ", ANTHROPIC_API_KEY ? "✅ set" : "❌ MISSING");
  console.log("  IMAGE_HOST:             ", process.env.IMAGE_HOST || "(default LINE)");
  console.log(
    "  SLIPOK BRANCHES:        ",
    slipokBranches.length > 0
      ? `✅ ${slipokBranches.length} (${slipokBranches.map((b) => b.name).join(", ")})`
      : "❌ NONE"
  );
  console.log("  BREVO_API_KEY:          ", BREVO_API_KEY ? "✅ set" : "⚠️  MISSING (email disabled)");
  console.log("  EMAIL_FROM:             ", EMAIL_FROM || "(default)");
  console.log("  EMAIL_RESERVATION:      ", EMAIL_RESERVATION ? "✅ set" : "⚠️  MISSING (email disabled)");
  console.log("  LINE_PUSH_TOKEN:        ", LINE_PUSH_TOKEN ? "✅ set" : "⚠️  MISSING (LINE group notifications disabled)");
  console.log("  LINE_GROUP_ID:          ", LINE_GROUP_ID ? "✅ set" : "⚠️  MISSING (LINE group notifications disabled)");
  const waitingThresholdSec = Math.round(
    (Number(process.env.WAITING_THRESHOLD_MS) || 15 * 60 * 1000) / 1000
  );
  console.log("  WAITING_THRESHOLD:      ", `${waitingThresholdSec}s (${Math.round(waitingThresholdSec / 60)} min)`);
  const pauseDurationSec = Math.round(
    (Number(process.env.BOT_PAUSE_DURATION_MS) || 2 * 60 * 60 * 1000) / 1000
  );
  console.log("  BOT_PAUSE_DURATION:     ", `${pauseDurationSec}s (${Math.round(pauseDurationSec / 60)} min)`);
});
