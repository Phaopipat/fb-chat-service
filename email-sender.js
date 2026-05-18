// fb-chat-service email-sender.js · Stage 6 (v1.6.0)
//
// Port จาก webhook-kohtalu email-sender.js (Phase 3 v3)
// Same Brevo REST API · native fetch · same env vars
// FB-specific change: email template says "ลูกค้า (FB)" instead of "(LINE)"
//
// Env vars (สามารถ share env เดียวกับ LINE):
//   BREVO_API_KEY        = xkeysib-xxxxxxxxxxxxxxxx
//   EMAIL_FROM           = "Koh Talu Resort <reservation@taluisland.com>"
//   EMAIL_RESERVATION    = reservation@taluisland.com
//
// Free tier: 300 emails/day forever

"use strict";

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

function parseSender(senderStr) {
  if (!senderStr) return null;
  const m = senderStr.match(/^(.+?)\s*<(.+?)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  return { email: senderStr.trim() };
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── HTML template ─────────────────────────────────────────────────────────
function buildEmailHTML({ booking, slipData }) {
  const amount = Number(slipData.amount || 0).toLocaleString("th-TH");
  const transTime = slipData.time || "-";
  const transRef = slipData.ref || "-";
  const senderName = slipData.senderName || "-";
  const receiverName = slipData.receiverName || "-";
  const receiverBank = slipData.receiverBank || "-";
  const senderAcc = slipData.senderAcc || "";
  const receiverAcc = slipData.receiverAcc || "";
  const matchedBranch = slipData.matchedBranch || "-";

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: -apple-system, "Segoe UI", "Sukhumvit Set", Tahoma, sans-serif; line-height: 1.6; color: #333; max-width: 640px; margin: 0 auto; padding: 24px; background: #fafafa; }
  .header { background: linear-gradient(135deg, #0a6e7c, #1a8a9b); color: white; padding: 24px; border-radius: 12px 12px 0 0; text-align: center; }
  .header h1 { margin: 0; font-size: 22px; }
  .header p { margin: 4px 0 0; opacity: 0.9; font-size: 14px; }
  .badge { display: inline-block; background: rgba(255,255,255,0.2); padding: 4px 12px; border-radius: 16px; font-size: 12px; margin-top: 8px; }
  .body { background: white; padding: 28px; border-radius: 0 0 12px 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); }
  .section { margin: 20px 0; }
  .section h2 { font-size: 16px; color: #0a6e7c; margin: 0 0 12px; border-bottom: 2px solid #e0e0e0; padding-bottom: 6px; }
  .row { display: flex; padding: 6px 0; }
  .label { width: 140px; color: #666; font-size: 14px; }
  .value { flex: 1; font-weight: 500; color: #222; font-size: 14px; }
  .amount { color: #0a6e7c; font-size: 18px; font-weight: 700; }
  .upsell { background: #fff8e1; border-left: 4px solid #ffa726; padding: 16px 20px; margin: 24px 0; border-radius: 0 8px 8px 0; }
  .upsell h2 { color: #e65100; margin: 0 0 12px; font-size: 16px; }
  .upsell ul { padding-left: 20px; margin: 8px 0; }
  .upsell li { margin: 6px 0; font-size: 14px; }
  .upsell .price { color: #e65100; font-weight: 600; }
  .warning { background: #fff3cd; border: 1px solid #ffeaa7; padding: 12px 16px; border-radius: 8px; margin: 20px 0; font-size: 13px; color: #856404; }
  .channel-badge { display: inline-block; background: #1877f2; color: white; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; margin-left: 4px; }
  .footer { text-align: center; padding: 20px 0; color: #888; font-size: 12px; }
  .footer a { color: #0a6e7c; text-decoration: none; }
</style>
</head>
<body>
  <div class="header">
    <h1>🏝️ Koh Talu Island Resort</h1>
    <p>ยืนยันการรับมัดจำ · Booking Confirmation</p>
    <span class="badge">✅ ห้องของท่านล็อคแล้ว</span>
  </div>

  <div class="body">
    <div class="section">
      <h2>📋 รายละเอียดการจอง</h2>
      <div class="row"><div class="label">Booking Ref:</div><div class="value">${escapeHtml(booking.bookingRef || "(รอ admin กรอก)")}</div></div>
      <div class="row"><div class="label">ลูกค้า:</div><div class="value">${escapeHtml(booking.displayName || "-")} <span class="channel-badge">FB Messenger</span></div></div>
      <div class="row"><div class="label">ผู้จอง:</div><div class="value">${escapeHtml(booking.bookingPersonName || "-")}</div></div>
      <div class="row"><div class="label">เวลายืนยัน:</div><div class="value">${escapeHtml(new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }))}</div></div>
    </div>

    <div class="section">
      <h2>💳 รายละเอียดการโอนเงิน</h2>
      <div class="row"><div class="label">จำนวน:</div><div class="value"><span class="amount">${amount} บาท</span></div></div>
      <div class="row"><div class="label">วันเวลา:</div><div class="value">${escapeHtml(transTime)}</div></div>
      <div class="row"><div class="label">เลขอ้างอิง:</div><div class="value" style="font-family: monospace;">${escapeHtml(transRef)}</div></div>
      <div class="row"><div class="label">จาก:</div><div class="value">${escapeHtml(senderName)} ${senderAcc ? '<br><small style="color:#999">' + escapeHtml(senderAcc) + "</small>" : ""}</div></div>
      <div class="row"><div class="label">เข้าบัญชี:</div><div class="value">${escapeHtml(matchedBranch)} (${escapeHtml(receiverBank)}) ${receiverAcc ? '<br><small style="color:#999">' + escapeHtml(receiverAcc) + "</small>" : ""}</div></div>
    </div>

    <div class="warning">
      ⚠️ <strong>ลูกค้าจาก FB Messenger</strong> — กรุณาตรวจสอบรายละเอียดข้างต้น หากไม่ถูกต้อง โปรดติดต่อลูกค้ากลับผ่าน Messenger ก่อน Check-in
    </div>

    <div class="upsell">
      <h2>🎯 กิจกรรมเสริมในเกาะ — จองพร้อมห้องล็อคคิวได้</h2>
      <ul>
        <li>🐠 <strong>Skindiving (ดำน้ำตื้น)</strong> — <span class="price">3,500 บาท/คน</span> (ลดจาก 5,200฿ เมื่อพักค้างคืน · 2 dives · รวมอุปกรณ์)</li>
        <li>⛵ <strong>Sailing (เรือใบ)</strong> — <span class="price">1,500 บาท/เรือ</span> (1-3 คน)</li>
        <li>🌅 <strong>Sunset Cruise & Squid Fishing</strong> — บรรยากาศตกหมึกชมพระอาทิตย์ตก</li>
        <li>🐢 <strong>Turtle Nursing (CSR)</strong> — <span class="price">200 บาท/คน</span> ดูแลเต่ากระในบ่ออนุบาล</li>
        <li>💆 <strong>Thai Massage</strong> — นวดแผนไทยริมหาด</li>
      </ul>
      <p style="margin: 12px 0 0; font-size: 13px; color: #666;">→ แจ้งทีมงานผ่าน FB Messenger เพื่อ pre-book ก่อนถึงเกาะ · capacity จำกัด</p>
    </div>

    <div class="section">
      <p style="font-size: 13px; color: #666;">
        🙏 ขอบคุณที่จองพักกับ Koh Talu Resort<br>
        เจ้าหน้าที่จะติดต่อกลับผ่าน FB Messenger เพื่อยืนยันรายละเอียดเช็คอินและการเดินทาง
      </p>
    </div>
  </div>

  <div class="footer">
    Koh Talu Island Resort · บางสะพานน้อย ประจวบฯ<br>
    FB: <a href="https://www.facebook.com/kohtaluresort">Koh Talu Island Resort</a> · <a href="https://taluisland.com">taluisland.com</a><br>
    <small>This is an automated confirmation from FB Messenger booking. Reply to this email to reach our reservation team.</small>
  </div>
</body>
</html>`;
}

// ─── Plain text fallback ────────────────────────────────────────────────────
function buildEmailText({ booking, slipData }) {
  const amount = Number(slipData.amount || 0).toLocaleString("th-TH");
  return `
🏝️ Koh Talu Island Resort — ยืนยันการรับมัดจำ (FB Messenger)
══════════════════════════════════════════════

✅ ห้องของท่านล็อคเรียบร้อยแล้ว

📋 รายละเอียดการจอง
  Booking Ref     : ${booking.bookingRef || "(รอ admin กรอก)"}
  ลูกค้า          : ${booking.displayName || "-"} [FB Messenger]
  ผู้จอง          : ${booking.bookingPersonName || "-"}
  เวลายืนยัน      : ${new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })}

💳 รายละเอียดการโอนเงิน
  จำนวน           : ${amount} บาท
  วันเวลา         : ${slipData.time || "-"}
  เลขอ้างอิง      : ${slipData.ref || "-"}
  จาก             : ${slipData.senderName || "-"} ${slipData.senderAcc || ""}
  เข้าบัญชี       : ${slipData.matchedBranch || "-"} (${slipData.receiverBank || "-"}) ${slipData.receiverAcc || ""}

⚠️ ลูกค้าจาก FB Messenger — ตรวจสอบรายละเอียด · ติดต่อกลับผ่าน Messenger ก่อน Check-in

──────────────────────────────────────────────
🎯 กิจกรรมเสริมในเกาะ — Pre-book พร้อมห้องได้
──────────────────────────────────────────────
  🐠 Skindiving       : 3,500 บาท/คน (ลดจาก 5,200฿ เมื่อค้างคืน)
  ⛵ Sailing          : 1,500 บาท/เรือ (1-3 คน)
  🌅 Sunset Cruise & Squid Fishing
  🐢 Turtle Nursing   : 200 บาท/คน (CSR)
  💆 Thai Massage

→ แจ้งทีมงานผ่าน FB Messenger เพื่อ pre-book ก่อนถึงเกาะ

══════════════════════════════════════════════
Koh Talu Island Resort
บางสะพานน้อย ประจวบฯ
FB: Koh Talu Island Resort · taluisland.com
══════════════════════════════════════════════
`;
}

// ─── Public API ──────────────────────────────────────────────────────────────
async function sendBookingConfirmation({ booking, slipData, customerEmail }) {
  if (!booking || !slipData) {
    return { ok: false, error: "Missing booking or slipData" };
  }

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn("[email] BREVO_API_KEY not set — skipping confirmation email");
    return { ok: false, error: "config_missing" };
  }

  const reservationEmail = process.env.EMAIL_RESERVATION;
  if (!reservationEmail) {
    console.warn("[email] EMAIL_RESERVATION not set — skipping confirmation email");
    return { ok: false, error: "config_missing" };
  }

  const fromStr = process.env.EMAIL_FROM || "Koh Talu Resort <reservation@taluisland.com>";
  const sender = parseSender(fromStr) || { name: "Koh Talu Resort", email: reservationEmail };

  const cc = customerEmail || booking.customerEmail;

  const subject = `[FB] ยืนยันการจอง Koh Talu Resort · ${booking.bookingRef || "Booking"} · ${Number(slipData.amount || 0).toLocaleString("th-TH")} บาท`;
  const htmlContent = buildEmailHTML({ booking, slipData });
  const textContent = buildEmailText({ booking, slipData });

  const payload = {
    sender,
    to: [{ email: reservationEmail }],
    subject,
    htmlContent,
    textContent,
    replyTo: { email: reservationEmail, name: "Koh Talu Reservation" },
  };
  if (cc) payload.cc = [{ email: cc }];

  console.log("[email] Brevo client initialized (FB)");

  try {
    const response = await fetch(BREVO_ENDPOINT, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const errMsg = data.message || data.code || `HTTP ${response.status}`;
      console.error("[email] ❌ Brevo error:", JSON.stringify(data));
      return { ok: false, error: errMsg };
    }

    const id = data.messageId || "";
    console.log(`[email] ✅ FB confirmation sent · to=${reservationEmail}${cc ? " cc=" + cc : ""} · id=${id}`);
    return { ok: true, messageId: id };
  } catch (err) {
    console.error("[email] ❌ Send failed:", err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  sendBookingConfirmation,
  buildEmailHTML,
  buildEmailText,
};
