// fb-chat-service · booking-collector.js · Stage 6.6 (v1.8.0)
//
// Stage 6.6: Returns `notifyData` in finalize so server can push LINE group notification
//   (line-group-notifier wires `notifyBookingNamesCollected` from server.js · keeps
//    booking-collector decoupled from notifier dependency)
//
// Otherwise identical to Stage 6.5 v1.7.3.
//
// Public API (unchanged):
//   - startNameCollection({ psid, bookingRef, bookingPersonName, matchedAmount, rowIndex, slipData })
//   - isCollecting(psid)
//   - cancelCollection(psid)
//   - handleCollectorText({ psid, msgText, auth, sheets, sheetId })  → { handled, done?, replyText?, notifyData? }
//   - handleCollectorImage({ psid, attachmentUrl, apiKey })  → { handled, done?, replyText? }

"use strict";

const { google } = require("googleapis");
const { sendBookingConfirmation } = require("./email-sender");

const _state = new Map();
const COLLECT_TTL_MS = 30 * 60 * 1000;

const PHONE_RE = /(?:\+66|0)[689]\d[\d\s\-]{6,10}/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function startNameCollection({ psid, bookingRef, bookingPersonName, matchedAmount, rowIndex, slipData }) {
  _state.set(psid, {
    state: "awaiting_names",
    bookingRef: bookingRef || "",
    bookingPersonName: bookingPersonName || "",
    matchedAmount: matchedAmount || 0,
    rowIndex: rowIndex || null,
    slipData: slipData || null,
    names: [],
    phone: "",
    customerEmail: "",
    startedAt: Date.now(),
  });
}

function isCollecting(psid) {
  const s = _state.get(psid);
  if (!s) return false;
  if (Date.now() - s.startedAt > COLLECT_TTL_MS) {
    _state.delete(psid);
    return false;
  }
  return true;
}

function cancelCollection(psid) {
  _state.delete(psid);
}

function parseAllFields(text) {
  const phoneMatch = text.match(PHONE_RE);
  const phone = phoneMatch ? phoneMatch[0].replace(/[\s\-]/g, "") : "";

  const emailMatch = text.match(EMAIL_RE);
  const email = emailMatch ? emailMatch[0].toLowerCase() : "";

  let cleaned = text.replace(PHONE_RE, "");
  if (emailMatch) cleaned = cleaned.replace(EMAIL_RE, "");
  cleaned = cleaned.replace(/[,،、]/g, "\n");

  const names = cleaned
    .split("\n")
    .map((l) => l.replace(/^\s*\d+[\.\)\-]?\s*/, "").trim())
    .filter((l) => l.length >= 2 && l.length <= 80)
    .filter((l) => !/^(เบอร์|โทร|tel|phone|contact|email|อีเมล|e-mail)/i.test(l));

  return { names, phone, email };
}

async function ocrIdCardFromFB({ attachmentUrl, apiKey }) {
  try {
    const imgRes = await fetch(attachmentUrl);
    if (!imgRes.ok) {
      console.warn(`[collector] ocrIdCard: FB attachment fetch failed ${imgRes.status}`);
      return null;
    }
    const arrayBuf = await imgRes.arrayBuffer();
    const imgBase64 = Buffer.from(arrayBuf).toString("base64");
    const mediaType = imgRes.headers.get("content-type") || "image/jpeg";

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: imgBase64 } },
              {
                type: "text",
                text: 'นี่คือรูปบัตรประชาชนหรือ passport ของลูกค้า กรุณาอ่านชื่อ-นามสกุล (ทั้งไทยและอังกฤษถ้ามี) ออกมาเท่านั้น ตอบเป็น JSON: {"name_th":"...","name_en":"..."} ถ้าอ่านไม่ได้ให้ตอบ {"name_th":"","name_en":""}',
              },
            ],
          },
        ],
      }),
    });

    if (!claudeRes.ok) {
      console.warn(`[collector] ocrIdCard: Claude API ${claudeRes.status}`);
      return null;
    }
    const claudeData = await claudeRes.json();
    const text = claudeData.content?.[0]?.text || "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    const name = (parsed.name_th || parsed.name_en || "").trim();
    return name || null;
  } catch (err) {
    console.error("[collector] ocrIdCard error:", err.message);
    return null;
  }
}

async function appendTravelersTab({
  sheets,
  sheetId,
  psid,
  bookingRef,
  bookingPersonName,
  names,
  phone,
  email,
  matchedAmount,
  source = "FB",
}) {
  if (!sheets || !sheetId || !names || names.length === 0) {
    return { ok: false, count: 0 };
  }

  const createdAt = new Date(Date.now() + 7 * 3600000)
    .toISOString()
    .replace("T", " ")
    .substring(0, 19);

  const rows = names.map((name) => [
    createdAt,
    psid,
    bookingRef || "",
    bookingPersonName || "",
    name,
    phone || "",
    email || "",
    matchedAmount != null ? String(matchedAmount) : "",
    source,
    "",
  ]);

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: "Travelers!A:J",
      valueInputOption: "RAW",
      requestBody: { values: rows },
    });
    console.log(`[collector] Travelers tab appended ${rows.length} row(s) for psid=${psid}`);
    return { ok: true, count: rows.length };
  } catch (err) {
    console.error("[collector] Travelers append error:", err.message);
    return { ok: false, count: 0, error: err.message };
  }
}

async function updateBookingHoldEmail({ sheets, sheetId, rowIndex, email }) {
  if (!sheets || !sheetId || !rowIndex || !email) return;
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `BookingHold!N${rowIndex}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[email]] },
    });
    console.log(`[collector] BookingHold col N updated: row ${rowIndex} email=${email}`);
  } catch (err) {
    console.error("[collector] col N update error:", err.message);
  }
}

function formatBookingSummary({
  bookingRef,
  bookingPersonName,
  names,
  phone,
  customerEmail,
  matchedAmount,
}) {
  const nameList = names.map((n, i) => `${i + 1}. ${n}`).join("\n");
  return [
    `📋 สรุปการจอง · ${bookingRef || "(รอ admin)"}`,
    `━━━━━━━━━━━━━━━━`,
    `ผู้จอง: ${bookingPersonName}`,
    `เบอร์โทร: ${phone || "(ยังไม่ได้รับ)"}`,
    `Email: ${customerEmail || "(ยังไม่ได้รับ)"}`,
    `มัดจำที่รับแล้ว: ${Number(matchedAmount).toLocaleString("th-TH")} บาท`,
    `━━━━━━━━━━━━━━━━`,
    `รายชื่อสมาชิก ${names.length} ท่าน:`,
    nameList,
  ].join("\n");
}

async function _finalize(psid, s, auth, sheets, sheetId) {
  if (s.customerEmail && s.rowIndex) {
    await updateBookingHoldEmail({ sheets, sheetId, rowIndex: s.rowIndex, email: s.customerEmail });
  }

  let travelersAppended = 0;
  if (sheets && sheetId && s.names.length > 0) {
    const r = await appendTravelersTab({
      sheets,
      sheetId,
      psid,
      bookingRef: s.bookingRef,
      bookingPersonName: s.bookingPersonName,
      names: s.names,
      phone: s.phone,
      email: s.customerEmail,
      matchedAmount: s.matchedAmount,
      source: "FB",
    });
    travelersAppended = r.count || 0;
  }

  if (s.slipData) {
    sendBookingConfirmation({
      booking: {
        bookingRef: s.bookingRef,
        displayName: s.bookingPersonName,
        bookingPersonName: s.bookingPersonName,
        customerEmail: s.customerEmail || "",
      },
      slipData: s.slipData,
      customerEmail: s.customerEmail || "",
    }).catch((err) => console.warn("[email] send error (non-blocking):", err.message));
  }

  const summary = formatBookingSummary({
    bookingRef: s.bookingRef,
    bookingPersonName: s.bookingPersonName,
    names: s.names,
    phone: s.phone,
    customerEmail: s.customerEmail,
    matchedAmount: s.matchedAmount,
  });

  const replyParts = [`ขอบคุณครับ ✅ ได้รับข้อมูลครบแล้วครับ 🙏`, ``, summary];
  if (travelersAppended > 0) {
    replyParts.push(`\n📋 บันทึก ${travelersAppended} ท่านลงระบบแล้วครับ`);
  }
  if (s.customerEmail) {
    replyParts.push(`\n📧 ส่ง confirmation email ไปที่ ${s.customerEmail} แล้วครับ`);
  } else {
    replyParts.push(`\n💡 ถ้าต้องการ confirmation email สำเนา · ส่ง email มาทีหลังก็ได้ครับ`);
  }

  const customerReply = replyParts.join("\n").trim();

  // Capture state for notifier BEFORE delete (defensive · slice arrays)
  const notifyData = {
    bookingRef: s.bookingRef,
    bookingPersonName: s.bookingPersonName,
    names: s.names.slice(),
    phone: s.phone,
    email: s.customerEmail,
    matchedAmount: s.matchedAmount,
  };

  _state.delete(psid);

  return {
    handled: true,
    done: true,
    replyText: customerReply,
    adminSummary: summary,
    travelersAppended,
    customerEmail: s.customerEmail,
    notifyData, // Stage 6.6: enables LINE group push by caller
  };
}

async function handleCollectorText({ psid, msgText, auth, sheets, sheetId }) {
  const s = _state.get(psid);
  if (!s) return { handled: false };
  if (Date.now() - s.startedAt > COLLECT_TTL_MS) {
    _state.delete(psid);
    return { handled: false };
  }

  if (s.state === "awaiting_names") {
    const { names, phone, email } = parseAllFields(msgText);

    if (names.length === 0) {
      return {
        handled: true,
        done: false,
        replyText:
          "ขอรายชื่อสมาชิกด้วยนะครับ (1 ชื่อต่อบรรทัด) พร้อมเบอร์โทร + email (ถ้ามี) สำหรับ confirmation 🙏",
      };
    }

    s.names = names;
    if (phone) s.phone = phone;
    if (email) s.customerEmail = email;

    if (!s.phone) {
      s.state = "awaiting_phone";
      return {
        handled: true,
        done: false,
        replyText: `ได้รับรายชื่อ ${names.length} ท่านแล้วครับ ✅\nขอเบอร์โทรติดต่อหลักด้วยนะครับ (พร้อม email ถ้าต้องการ confirmation สำเนา) 🙏`,
      };
    }

    return _finalize(psid, s, auth, sheets, sheetId);
  }

  if (s.state === "awaiting_phone") {
    const phoneMatch = msgText.match(PHONE_RE);
    if (!phoneMatch) {
      return {
        handled: true,
        done: false,
        replyText: "ขอเบอร์โทรติดต่อหลักด้วยนะครับ (เช่น 08x-xxx-xxxx) 🙏",
      };
    }
    s.phone = phoneMatch[0].replace(/[\s\-]/g, "");

    const emailMatch = msgText.match(EMAIL_RE);
    if (emailMatch) s.customerEmail = emailMatch[0].toLowerCase();

    return _finalize(psid, s, auth, sheets, sheetId);
  }

  return { handled: false };
}

async function handleCollectorImage({ psid, attachmentUrl, apiKey }) {
  const s = _state.get(psid);
  if (!s) return { handled: false };
  if (Date.now() - s.startedAt > COLLECT_TTL_MS) {
    _state.delete(psid);
    return { handled: false };
  }

  if (s.state !== "awaiting_names") return { handled: false };

  const name = await ocrIdCardFromFB({ attachmentUrl, apiKey });
  if (!name) {
    return {
      handled: true,
      done: false,
      replyText: "อ่านรูปไม่ได้ครับ ลองส่งรูปชัดขึ้น หรือพิมพ์ชื่อตรงๆ ได้เลยครับ 🙏",
    };
  }

  if (!s.names.includes(name)) s.names.push(name);
  return {
    handled: true,
    done: false,
    replyText: `อ่านชื่อได้ครับ: "${name}" ✅\nยังมีสมาชิกท่านอื่นอีกมั้ยครับ? ถ้าครบแล้วส่งเบอร์โทร + email (ถ้ามี) ด้วยนะครับ 🙏`,
  };
}

module.exports = {
  startNameCollection,
  isCollecting,
  cancelCollection,
  handleCollectorText,
  handleCollectorImage,
  formatBookingSummary,
  parseAllFields,
};
