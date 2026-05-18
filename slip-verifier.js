/**
 * fb-chat-service slip-verifier.js · Stage 6.5 (v1.7.0)
 *
 * Same as Stage 5 v1.5.0 EXCEPT:
 *   - saveSlipToBookingHold() now returns { ok, rowIndex } instead of true/false
 *     so booking-collector can update col N (customerEmail) later.
 *
 * BookingHold schema (iB Chatlog Sheet · 14 cols A:N):
 *   A=psid              B=displayName       C=bookingRef       D=expectedAmount
 *   E=tolerance         F=status            G=createdAt        H=confirmedAt
 *   I=matchedTransRef   J=matchedAmount     K=notes            L=expiresAt
 *   M=bookingPersonName N=customerEmail
 */

"use strict";

// ─── Helpers ─────────────────────────────────────────────────────────────────
function bkkNow() {
  return new Date(Date.now() + 7 * 3600000)
    .toISOString()
    .replace("T", " ")
    .substring(0, 19);
}

// ─── SlipOK config loader ────────────────────────────────────────────────────
function loadSlipOKBranches() {
  const branches = [];
  for (let i = 1; i <= 10; i++) {
    const id = process.env[`SLIPOK_BRANCH_${i}_ID`];
    const key = process.env[`SLIPOK_BRANCH_${i}_KEY`];
    const name = process.env[`SLIPOK_BRANCH_${i}_NAME`] || `Branch ${i}`;
    if (id && key) branches.push({ branchId: id, apiKey: key, name });
  }
  return branches;
}

// ─── FB CDN download ─────────────────────────────────────────────────────────
async function downloadFbAttachment(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw new Error(`FB CDN download failed: ${res.status} ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer;
}

// ─── SlipOK API call (single branch) ────────────────────────────────────────
async function callSlipOK(buffer, branch) {
  const form = new FormData();
  const blob = new Blob([buffer], { type: "image/jpeg" });
  form.append("files", blob, "slip.jpg");
  form.append("log", "true");

  const url = `https://api.slipok.com/api/line/apikey/${branch.branchId}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "x-authorization": branch.apiKey },
      body: form,
      signal: AbortSignal.timeout(20000),
    });

    const body = await res.json().catch(() => ({}));

    if (res.ok) {
      return { ok: true, data: body?.data || body, branch };
    }

    const code = body.code;
    const message = body.message;
    const slipData = body.data || null;

    if (code === 1014) return { ok: false, error: "wrong_receiver", code, message, data: slipData, branch };
    if (code === 1012) return { ok: false, error: "repeat", code, message, data: slipData, branch };
    if (code === 1013) return { ok: false, error: "wrong_amount", code, message, data: slipData, branch };
    if (code === 1010) return { ok: false, error: "bank_delay", code, message, data: slipData, branch };
    if (code === 1009) return { ok: false, error: "bank_down", code, message, branch };
    if (code === 1011) return { ok: false, error: "not_found", code, message, branch };
    if (code === 1002) return { ok: false, error: "key_error", code, message, branch };
    if (code === 1003 || code === 1004 || code === 1015) {
      return { ok: false, error: "quota_exhausted", code, message, branch };
    }
    if ([1005, 1006, 1007, 1008].includes(code)) {
      return { ok: false, error: "not_a_slip", code, message, branch };
    }
    return { ok: false, error: "api_error", code, message, branch };
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return { ok: false, error: "timeout", branch };
    }
    return { ok: false, error: "api_error", detail: err.message, branch };
  }
}

// ─── PUBLIC: verifySlip ──────────────────────────────────────────────────────
async function verifySlip({ fbAttachmentUrl, _slipokBranches }) {
  let buffer;
  try {
    buffer = await downloadFbAttachment(fbAttachmentUrl);
    console.log(`[slip] FB attachment downloaded · ${buffer.length} bytes`);
  } catch (err) {
    console.error("[slip] FB CDN download error:", err.message);
    return { ok: false, error: "api_error", detail: err.message };
  }

  const branches = Array.isArray(_slipokBranches) ? _slipokBranches : loadSlipOKBranches();
  if (branches.length === 0) {
    console.error("[slip] No SlipOK branches configured");
    return { ok: false, error: "config_error" };
  }

  let lastError = { ok: false, error: "api_error" };
  let slipDataFromError = null;

  for (const branch of branches) {
    console.log(`[slip] Trying branch: ${branch.name} (id=${branch.branchId})`);
    const result = await callSlipOK(buffer, branch);

    if (result.ok) {
      const sd = result.data;
      const amount = Number(sd?.amount) || 0;
      const ref = sd?.transRef || "";
      const time = sd?.transTimestamp || `${sd?.transDate || ""} ${sd?.transTime || ""}`.trim();
      const senderName = sd?.sender?.displayName || sd?.sender?.name || "";
      const receiverName = sd?.receiver?.displayName || sd?.receiver?.name || "";
      const receiverBank = sd?.receivingBank || "";
      const senderAcc = sd?.sender?.account?.value || "";
      const receiverAcc = sd?.receiver?.account?.value || "";
      console.log(
        `[slip] ✅ Verified by ${branch.name} amount=${amount} ref=${ref} sender=${senderName} → receiver=${receiverName} (${receiverAcc})`
      );
      return {
        ok: true,
        amount,
        ref,
        time,
        senderName,
        receiverName,
        receiverBank,
        senderAcc,
        receiverAcc,
        matchedBranch: branch.name,
      };
    }

    lastError = result;
    if (result.data) slipDataFromError = result.data;

    if (result.error === "wrong_receiver") {
      console.log(`[slip] ${branch.name} rejected (1014 wrong_receiver) — trying next branch`);
      continue;
    }

    console.warn(`[slip] ${branch.name} failed: ${result.error} (code ${result.code || "-"}) — stopping`);
    return result;
  }

  console.warn(`[slip] All ${branches.length} branches rejected (wrong_receiver)`);
  return {
    ok: false,
    error: "wrong_receiver",
    message: "Slip transferred to unknown account",
    data: slipDataFromError,
  };
}

// ─── Save slip to BookingHold · NOW RETURNS rowIndex ─────────────────────────
// Stage 6.5 change: parse updatedRange "BookingHold!A37:N37" → rowIndex=37
// so booking-collector can update col N (customerEmail) at row N{rowIndex} later
async function saveSlipToBookingHold({ sheets, spreadsheetId, psid, displayName, slipData }) {
  try {
    const row = [
      psid,
      displayName || "",
      "",
      "",
      "",
      "fb_pending_review",
      bkkNow(),
      "",
      slipData.ref || "",
      String(slipData.amount || 0),
      `FB slip · sender=${slipData.senderName} · receiver=${slipData.receiverName} · branch=${slipData.matchedBranch}`,
      "",
      slipData.senderName || "",
      "",
    ];
    const appendRes = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "BookingHold!A:N",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });

    // Parse rowIndex from updatedRange · e.g., "BookingHold!A37:N37" → 37
    let rowIndex = null;
    const updatedRange = appendRes.data?.updates?.updatedRange || "";
    const m = updatedRange.match(/!A(\d+):/);
    if (m) rowIndex = Number(m[1]);

    console.log(
      `[slip] Saved to BookingHold (FB · status=fb_pending_review · row=${rowIndex || "?"}) · ref=${slipData.ref} amount=${slipData.amount}`
    );
    return { ok: true, rowIndex };
  } catch (err) {
    console.error("[slip] saveSlipToBookingHold error:", err.message);
    return { ok: false, rowIndex: null };
  }
}

// ─── Format reply text สำหรับลูกค้า ─────────────────────────────────────────
function formatSlipReply(result) {
  if (result.ok) {
    const amount = result.amount.toLocaleString("th-TH", { maximumFractionDigits: 2 });
    return (
      `ตรวจสลิปสำเร็จครับ ✅\n` +
      `จำนวน: **${amount}฿**\n` +
      `อ้างอิง: ${result.ref}\n` +
      `เวลา: ${result.time}`
    );
  }

  switch (result.error) {
    case "repeat":
      return "สลิปนี้เคยส่งมาแล้วครับ 🙏 หากเป็นการจองใหม่ ขอสลิปอันใหม่ครับ (ส่ง 1 สลิป/1 รายการ)";
    case "wrong_receiver":
      return (
        "สลิปนี้โอนผิดบัญชีครับ 🙏\n" +
        "กรุณาตรวจสอบบัญชีที่ถูกต้องกับเจ้าหน้าที่ก่อนโอนใหม่"
      );
    case "wrong_amount":
      return "จำนวนเงินไม่ตรงกับที่ระบุไว้ครับ 🙏 ขอเจ้าหน้าที่ช่วยตรวจสอบนะครับ";
    case "not_a_slip":
      return null;
    case "bank_delay":
      return "ระบบธนาคารดีเลย์ครับ 🙏 ขอเจ้าหน้าที่ตรวจสอบให้นะครับ (BBL/SCB บางครั้งมีการดีเลย์)";
    case "bank_down":
    case "timeout":
    case "api_error":
      return "ระบบตรวจสลิปไม่ตอบสนองตอนนี้ครับ 🙏 ขอเจ้าหน้าที่ตรวจสอบสลิปด้วยตัวเองนะครับ";
    case "not_found":
      return "ไม่พบข้อมูลสลิปในระบบครับ 🙏 ขอเจ้าหน้าที่ตรวจสอบให้นะครับ";
    case "quota_exhausted":
      return "ระบบตรวจสลิปครบ quota วันนี้ครับ 🙏 ขอเจ้าหน้าที่ตรวจสอบสลิปด้วยตัวเองนะครับ";
    case "key_error":
    case "config_error":
      return "ระบบตรวจสลิปยังไม่พร้อมครับ 🙏 ขอเจ้าหน้าที่ตรวจสอบสลิปด้วยตัวเองนะครับ";
    default:
      return "ขอเจ้าหน้าที่ช่วยตรวจสอบสลิปให้นะครับ 🙏";
  }
}

module.exports = {
  verifySlip,
  saveSlipToBookingHold,
  formatSlipReply,
  loadSlipOKBranches,
};
