/**
 * fb-chat-service slip-verifier.js · Stage 5 (v1.5.0)
 *
 * Port จาก webhook-kohtalu slip-verifier.js (Phase 2d v2)
 * Adapted สำหรับ FB Messenger:
 *   - LINE downloadLineContent(messageId, lineToken) → FB downloadFbAttachment(url)
 *   - Native fetch + FormData (Node 18+) แทน axios + form-data package
 *   - SlipOK API call: unchanged structure (POST FormData · x-authorization header)
 *
 * Env vars required (SAME as LINE bot):
 *   SLIPOK_BRANCH_1_ID, SLIPOK_BRANCH_1_KEY, SLIPOK_BRANCH_1_NAME (optional)
 *   SLIPOK_BRANCH_2_ID, SLIPOK_BRANCH_2_KEY, SLIPOK_BRANCH_2_NAME (optional)
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
// FB attachment URL is on scontent.xx.fbcdn.net domain · time-limited but accessible
async function downloadFbAttachment(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`FB CDN download failed: ${res.status} ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer;
}

// ─── SlipOK API call (single branch) ────────────────────────────────────────
// Returns:
//   { ok: true, data: <slip-data>, branch }
//   { ok: false, error: '<category>', code, message, data?, branch }
//
// Error category mapping (per SlipOK error codes 1000-1015):
//   1002 → 'key_error'
//   1003,1004,1015 → 'quota_exhausted'
//   1005-1008 → 'not_a_slip'
//   1009 → 'bank_down'
//   1010 → 'bank_delay'
//   1011 → 'not_found'
//   1012 → 'repeat'
//   1013 → 'wrong_amount'
//   1014 → 'wrong_receiver'
async function callSlipOK(buffer, branch) {
  const form = new FormData();
  // Convert Buffer → Blob (Node 18+ has Blob)
  const blob = new Blob([buffer], { type: "image/jpeg" });
  form.append("files", blob, "slip.jpg");
  form.append("log", "true");

  const url = `https://api.slipok.com/api/line/apikey/${branch.branchId}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-authorization": branch.apiKey,
      },
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
// Tries each configured SlipOK branch in order · stops on first success
// Continues to next branch ONLY on 1014 (wrong_receiver — try another bank)
//
// @param {string} fbAttachmentUrl  URL from event.message.attachments[0].payload.url
// @returns {object} {ok, amount, ref, time, senderName, receiverName, ...} or {ok:false, error}
async function verifySlip({ fbAttachmentUrl, _slipokBranches }) {
  // 1. Download image from FB CDN
  let buffer;
  try {
    buffer = await downloadFbAttachment(fbAttachmentUrl);
    console.log(`[slip] FB attachment downloaded · ${buffer.length} bytes`);
  } catch (err) {
    console.error("[slip] FB CDN download error:", err.message);
    return { ok: false, error: "api_error", detail: err.message };
  }

  // 2. Load branches
  const branches = Array.isArray(_slipokBranches) ? _slipokBranches : loadSlipOKBranches();
  if (branches.length === 0) {
    console.error("[slip] No SlipOK branches configured");
    return { ok: false, error: "config_error" };
  }

  // 3. Try each branch
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

// ─── Save slip to BookingHold (FB MVP — no pending booking lookup) ──────────
// Each verified slip → new row with status="fb_pending_review"
// Admin manually matches to actual booking in BookingHold tab
async function saveSlipToBookingHold({ sheets, spreadsheetId, psid, displayName, slipData }) {
  try {
    const row = [
      psid,                                     // A: psid
      displayName || "",                        // B: displayName
      "",                                       // C: bookingRef (admin fills)
      "",                                       // D: expectedAmount (admin fills)
      "",                                       // E: tolerance
      "fb_pending_review",                      // F: status — FB-specific status
      bkkNow(),                                 // G: createdAt
      "",                                       // H: confirmedAt (admin fills when matched)
      slipData.ref || "",                       // I: matchedTransRef
      String(slipData.amount || 0),             // J: matchedAmount
      `FB slip · sender=${slipData.senderName} · receiver=${slipData.receiverName} · branch=${slipData.matchedBranch}`,  // K: notes
      "",                                       // L: expiresAt
      slipData.senderName || "",                // M: bookingPersonName (use sender name)
      "",                                       // N: customerEmail (admin or future flow)
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "BookingHold!A:N",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });
    console.log(`[slip] Saved to BookingHold (FB · status=fb_pending_review) · ref=${slipData.ref} amount=${slipData.amount}`);
    return true;
  } catch (err) {
    console.error("[slip] saveSlipToBookingHold error:", err.message);
    return false;
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
      `เวลา: ${result.time}\n\n` +
      `ขอเจ้าหน้าที่ตรวจสอบและยืนยันการจองนะครับ 🙏`
    );
  }

  // Error cases
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
      // Don't reply — let normal AI flow handle (it's probably not a slip image)
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
