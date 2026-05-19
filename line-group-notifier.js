// fb-chat-service · line-group-notifier.js · Stage 6.6 (v1.8.0)
//
// Push FB escalation events into the LINE admin group via LINE Push API.
// Admin team monitors LINE group only · doesn't need to watch another channel.
//
// Same format as LINE bot's group-handler.js notifications:
//   📬 [FB] ลูกค้าต้องการแอดมิน
//   👤 displayName (PSID:xxx)
//   💬 "preview..."
//   📋 เหตุผล: <reason>
//   ⏰ HH:MM น.
//
// Env vars:
//   LINE_PUSH_TOKEN  — LINE OA Channel Access Token (same as webhook-kohtalu uses)
//   LINE_GROUP_ID    — Target admin group ID
//
// Dedupe: 5-min rolling window keyed by `${reason}:${psid}` (no spam on retries)
// PII redact: phone → 08X-XXX-XXXX · ref → N***-***-*******-***-****1234

"use strict";

const LINE_PUSH_API = "https://api.line.me/v2/bot/message/push";

const LINE_GROUP_ID = process.env.LINE_GROUP_ID || "";
const LINE_PUSH_TOKEN = process.env.LINE_PUSH_TOKEN || "";

// ─── Dedupe ────────────────────────────────────────────────────────────────
const _dedupe = new Map();
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

function shouldDedupe(reason, psid) {
  const key = `${reason}:${psid}`;
  const last = _dedupe.get(key);
  if (last && Date.now() - last < DEDUPE_WINDOW_MS) {
    console.log(`[group] Deduped ${key} (last push ${Math.round((Date.now() - last) / 1000)}s ago)`);
    return true;
  }
  _dedupe.set(key, Date.now());
  return false;
}

// Garbage-collect dedupe map every 30 min (keeps memory bounded)
setInterval(() => {
  const cutoff = Date.now() - DEDUPE_WINDOW_MS;
  for (const [key, ts] of _dedupe.entries()) {
    if (ts < cutoff) _dedupe.delete(key);
  }
}, 30 * 60 * 1000);

// ─── PII redact ────────────────────────────────────────────────────────────
function redactPhone(p) {
  if (!p) return "";
  const digits = String(p).replace(/[^\d]/g, "");
  if (digits.length < 7) return digits;
  return `${digits.slice(0, 3)}-XXX-${digits.slice(-4)}`;
}

function redactRef(r) {
  if (!r) return "";
  const s = String(r);
  if (s.length < 4) return s;
  return `N***-***-*******-***-****${s.slice(-4)}`;
}

function shortPsid(psid) {
  if (!psid) return "";
  return String(psid).slice(-8);
}

function bkkTime() {
  return (
    new Date(Date.now() + 7 * 3600000).toISOString().substring(11, 16) + " น."
  );
}

// ─── Core push ─────────────────────────────────────────────────────────────
async function pushLineGroup(text) {
  if (!LINE_GROUP_ID || !LINE_PUSH_TOKEN) {
    console.warn(
      "[group] LINE_GROUP_ID or LINE_PUSH_TOKEN missing · skipping push"
    );
    return { ok: false, error: "config_missing" };
  }
  try {
    const res = await fetch(LINE_PUSH_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LINE_PUSH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: LINE_GROUP_ID,
        messages: [{ type: "text", text }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error("[group] LINE Push failed:", res.status, errText);
      return { ok: false, error: errText };
    }
    const preview = text.slice(0, 50).replace(/\n/g, " · ");
    console.log(`[group] LINE Push ✅ · ${preview}`);
    return { ok: true };
  } catch (err) {
    console.error("[group] LINE Push exception:", err.message);
    return { ok: false, error: err.message };
  }
}

// ─── Notification builders ─────────────────────────────────────────────────

// Reason: slip_confirmed
async function notifySlipVerified({ senderName, psid, amount, ref, branch }) {
  if (shouldDedupe("slip_confirmed", psid)) return;
  const text = [
    `📬 [FB] ลูกค้าต้องการแอดมิน`,
    `👤 ${senderName || "(no name)"} (PSID:${shortPsid(psid)}…)`,
    `💬 "✅ สลิปผ่าน! โอน ${amount} บาท | ref: ${redactRef(ref)}${branch ? " | " + branch : ""}"`,
    `📋 เหตุผล: slip_confirmed`,
    `⏰ ${bkkTime()}`,
  ].join("\n");
  await pushLineGroup(text);
}

// Reason: booking_names_collected
async function notifyBookingNamesCollected({
  senderName,
  psid,
  bookingPersonName,
  names,
  phone,
  email,
  matchedAmount,
}) {
  if (shouldDedupe("booking_names_collected", psid)) return;
  const nameList = (names || [])
    .slice(0, 6)
    .map((n, i) => `   ${i + 1}. ${n}`)
    .join("\n");
  const moreLine = (names || []).length > 6 ? `   …และอีก ${names.length - 6} ท่าน` : "";

  const text = [
    `📬 [FB] ลูกค้าต้องการแอดมิน`,
    `👤 ${senderName || "(no name)"} (PSID:${shortPsid(psid)}…)`,
    `💬 "👥 รายชื่อผู้เดินทาง: ${(names || []).length} ท่าน`,
    nameList,
    moreLine,
    `📧 ${email || "(ยังไม่มี email)"}`,
    `☎️ ${redactPhone(phone)}`,
    `💰 มัดจำ ${matchedAmount || 0} บาท | ผู้จอง: ${bookingPersonName || "-"}"`,
    `📋 เหตุผล: booking_names_collected`,
    `⏰ ${bkkTime()}`,
  ]
    .filter(Boolean)
    .join("\n");

  await pushLineGroup(text);
}

// Reason: customer_waiting (sent when bot can't reply or fallback timeout)
async function notifyCustomerWaiting({ senderName, psid, lastMessage }) {
  if (shouldDedupe("customer_waiting", psid)) return;
  const preview = (lastMessage || "").slice(0, 80);
  const ellipsis = (lastMessage || "").length > 80 ? "…" : "";
  const text = [
    `⏰ [FB] เตือน: ลูกค้า ${senderName || shortPsid(psid) + "…"} ยังรอคำตอบอยู่ครับ 🙏`,
    `💬 "${preview}${ellipsis}"`,
    `📋 เหตุผล: customer_waiting`,
    `⏰ ${bkkTime()}`,
  ].join("\n");
  await pushLineGroup(text);
}

// Reason: arbitrary (e.g. quote_request, complaint, admin_request, cancellation)
async function notifySensitiveKeyword({
  senderName,
  psid,
  customerMessage,
  reason,
}) {
  if (shouldDedupe(reason, psid)) return;
  const preview = (customerMessage || "").slice(0, 80);
  const ellipsis = (customerMessage || "").length > 80 ? "…" : "";
  const text = [
    `📬 [FB] ลูกค้าต้องการแอดมิน`,
    `👤 ${senderName || "(no name)"} (PSID:${shortPsid(psid)}…)`,
    `💬 "${preview}${ellipsis}"`,
    `📋 เหตุผล: ${reason}`,
    `⏰ ${bkkTime()}`,
  ].join("\n");
  await pushLineGroup(text);
}

// ─── Sensitive keyword detector ────────────────────────────────────────────
// Returns the reason string if matched · null otherwise
const SENSITIVE_PATTERNS = [
  { regex: /ขอใบเสนอราคา|invoice|receipt|ใบเสร็จ|quote/i, reason: "quote_request" },
  { regex: /คอมเพลน|complain|ผิดหวัง|แย่มาก|ไม่พอใจ/i, reason: "complaint" },
  { regex: /ติดต่อเจ้าหน้าที่|คุยกับแอดมิน|คนจริง|พูดกับคน|talk.*admin|human|real.*person/i, reason: "admin_request" },
  { regex: /ยกเลิก.*จอง|cancel.*book|refund|คืนเงิน|คืนมัดจำ/i, reason: "cancellation" },
  { regex: /โกง|หลอก|scam|fraud|ฉ้อโกง/i, reason: "trust_concern" },
  { regex: /ฉุกเฉิน|emergency|urgent|ด่วน(?:มาก|สุด)/i, reason: "urgent" },
];

function detectSensitiveKeyword(text) {
  if (!text) return null;
  for (const p of SENSITIVE_PATTERNS) {
    if (p.regex.test(text)) return p.reason;
  }
  return null;
}

// ─── Stage 6.7: Customer waiting timer ─────────────────────────────────────
// When customer triggers an event that needs admin attention (sensitive keyword,
// collector stuck, etc.), start a per-PSID timer. If admin doesn't intervene
// (or customer doesn't send a new message) within WAITING_THRESHOLD_MS,
// push `notifyCustomerWaiting` as a reminder to the LINE admin group.
//
// Behavior:
//   - startWaitingTimer({ psid, senderName, lastMessage, reason })
//       → clears any existing timer for this psid · starts fresh
//   - clearWaitingTimer(psid)
//       → called when customer sends new inbound · or is_echo received (admin replied)
//   - Timer fires → notifyCustomerWaiting + auto-clears entry

const WAITING_THRESHOLD_MS = Number(process.env.WAITING_THRESHOLD_MS) || 15 * 60 * 1000; // 15 min default

const _waitingTimers = new Map(); // psid → { handle, startedAt, lastMessage, senderName, reason }

function startWaitingTimer({ psid, senderName, lastMessage, reason }) {
  if (!psid) return;

  // Clear any prior timer for this psid
  const existing = _waitingTimers.get(psid);
  if (existing) {
    clearTimeout(existing.handle);
    console.log(`[group] Replacing existing waiting timer for psid=${psid}`);
  }

  const handle = setTimeout(() => {
    notifyCustomerWaiting({ senderName, psid, lastMessage })
      .catch((err) => console.warn("[group] waiting-timer notify error:", err.message));
    _waitingTimers.delete(psid);
  }, WAITING_THRESHOLD_MS);

  _waitingTimers.set(psid, {
    handle,
    startedAt: Date.now(),
    lastMessage,
    senderName,
    reason,
  });

  console.log(
    `[group] Started waiting timer for psid=${psid} reason=${reason} · fires in ${Math.round(
      WAITING_THRESHOLD_MS / 1000
    )}s`
  );
}

function clearWaitingTimer(psid, reason = "manual") {
  const entry = _waitingTimers.get(psid);
  if (!entry) return false;
  clearTimeout(entry.handle);
  _waitingTimers.delete(psid);
  const elapsedSec = Math.round((Date.now() - entry.startedAt) / 1000);
  console.log(
    `[group] Cleared waiting timer for psid=${psid} reason=${reason} · was ${elapsedSec}s old`
  );
  return true;
}

function getActiveWaitingCount() {
  return _waitingTimers.size;
}

// ─── Config check (for /health) ────────────────────────────────────────────
function getConfigStatus() {
  return {
    line_group_id: LINE_GROUP_ID ? "✅ set" : "⚠️  missing (notifications disabled)",
    line_push_token: LINE_PUSH_TOKEN ? "✅ set" : "⚠️  missing (notifications disabled)",
    dedupe_cache_size: _dedupe.size,
    active_waiting_timers: _waitingTimers.size,
    waiting_threshold_seconds: Math.round(WAITING_THRESHOLD_MS / 1000),
  };
}

module.exports = {
  pushLineGroup,
  notifySlipVerified,
  notifyBookingNamesCollected,
  notifyCustomerWaiting,
  notifySensitiveKeyword,
  detectSensitiveKeyword,
  // Stage 6.7: waiting timer
  startWaitingTimer,
  clearWaitingTimer,
  getActiveWaitingCount,
  getConfigStatus,
  // exports for unit testing
  _internal: { shouldDedupe, redactPhone, redactRef, bkkTime },
};
