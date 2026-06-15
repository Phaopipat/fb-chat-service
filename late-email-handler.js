// FB_LATE_EMAIL_PORTED · 2026-06-15
// late-email-handler.js — Phase 3.6.2 (FB port from LINE)
//
// When a customer sends a message containing an email AFTER their collector
// flow has closed (or never started), this module:
//   1. Detects the email pattern in their text
//   2. Finds their most recent BookingHold row (status ∈ {fb_pending_review,
//      confirmed}) with empty col N (within last 30 days)
//   3. Updates col N with the email
//   4. Triggers sendBookingConfirmation (CC the customer)
//   5. Bot acknowledges: "ได้รับ email ... booking XXX แล้วครับ"
//
// FB notes (differs from LINE):
//   - psid (16-digit numeric) replaces LINE userId
//   - BookingHold status in FB stays "fb_pending_review" (admin doesn't
//     elevate to "confirmed"). Accept both for forward-compat.
//   - col C bookingRef may be empty (admin fills later) → use fallback text
//   - confirmedAt (col H) may be empty too → fall back to createdAt (col G)
//
// Should be called in server.js AFTER isCollecting check (active collector
// flow handles email itself) and BEFORE slip image / handleAutoReply.
//
// Public API:
//   tryLateEmailCapture({ senderId, msgText, auth, sheetId })
//     → { handled: true,  replyText, bookingRef }     when email captured
//     → { handled: false }                              otherwise

'use strict';

const { google } = require('googleapis');
const { sendBookingConfirmation } = require('./email-sender');

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const LATE_ARRIVAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const ACCEPTED_STATUSES = new Set(['confirmed', 'fb_pending_review']);

// Parse "YYYY-MM-DD HH:mm:ss" Bangkok local time → UTC ms
function parseBangkokTimestamp(s) {
  if (!s) return 0;
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return 0;
  const [, y, mo, d, h, mi, se] = m;
  // Bangkok = UTC+7 → convert local time to UTC
  return Date.UTC(+y, +mo - 1, +d, +h - 7, +mi, +(se || 0));
}

async function tryLateEmailCapture({ senderId, msgText, auth, sheetId }) {
  if (!senderId || !msgText || !auth || !sheetId) return { handled: false };

  // 1. Detect email in text
  const emailMatch = msgText.match(EMAIL_RE);
  if (!emailMatch) return { handled: false };
  const email = emailMatch[0].toLowerCase();

  let sheetsApi;
  try {
    sheetsApi = google.sheets({ version: 'v4', auth });
  } catch (err) {
    console.warn('[late-email] sheets API init failed:', err.message);
    return { handled: false };
  }

  // 2. Read BookingHold to find matching row
  let rows;
  try {
    const res = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'BookingHold!A2:N5000',
    });
    rows = res.data.values || [];
  } catch (err) {
    console.warn('[late-email] BookingHold read failed:', err.message);
    return { handled: false };
  }

  const cutoffMs = Date.now() - LATE_ARRIVAL_WINDOW_MS;
  let bestRow = null;
  let bestRowIndex = -1;
  let bestTsMs = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 8) continue;
    if ((r[0] || '').trim() !== senderId) continue;
    const status = (r[5] || '').trim().toLowerCase();
    if (!ACCEPTED_STATUSES.has(status)) continue;
    if (r[13] && r[13].trim()) continue; // col N already has email

    // Prefer confirmedAt (col H), fall back to createdAt (col G) for FB rows
    const confirmedMs = parseBangkokTimestamp(r[7]);
    const createdMs = parseBangkokTimestamp(r[6]);
    const tsMs = confirmedMs || createdMs;
    if (!tsMs || tsMs < cutoffMs) continue; // too old

    if (tsMs > bestTsMs) {
      bestTsMs = tsMs;
      bestRow = r;
      bestRowIndex = i + 2; // +2 for header + 1-indexed
    }
  }

  if (!bestRow) return { handled: false };

  const bookingRef        = bestRow[2]  || '';
  const bookingPersonName = bestRow[12] || '';
  const matchedTransRef   = bestRow[8]  || '';
  const matchedAmount     = Number(bestRow[9]) || 0;
  const confirmedAt       = bestRow[7]  || bestRow[6] || '';

  // 3. Update col N
  try {
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range:         `BookingHold!N${bestRowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody:   { values: [[email]] },
    });
    console.log(`[late-email] col N updated: row ${bestRowIndex} email=${email} booking=${bookingRef || '(no ref)'}`);
  } catch (err) {
    console.error('[late-email] col N update failed:', err.message);
    return { handled: false };
  }

  // 4. Send confirmation email (CC customer)
  //    Reconstruct minimal slipData from BookingHold cols for email template
  const slipData = {
    amount:        matchedAmount,
    ref:           matchedTransRef,
    time:          confirmedAt,
    senderName:    '(ลูกค้า)',
    receiverName:  'Koh Talu Resort',
    receiverBank:  'KBANK',
    matchedBranch: 'Koh Talu Resort',
    senderAcc:     '',
    receiverAcc:   '',
  };

  // Fire-and-forget — don't block on email send
  sendBookingConfirmation({
    booking: {
      bookingRef,
      displayName:       bookingPersonName,
      bookingPersonName,
      customerEmail:     email,
    },
    slipData,
  }).catch(err => console.warn('[late-email] send error (non-blocking):', err.message));

  const refDisplay = bookingRef ? `booking ${bookingRef}` : 'การจอง';
  return {
    handled:    true,
    replyText:  `✅ ได้รับ email สำหรับ${bookingRef ? ' ' : ''}${refDisplay} แล้วครับ ส่ง confirmation ไปที่ ${email} เรียบร้อย 📧🙏`,
    bookingRef,
    email,
  };
}

module.exports = { tryLateEmailCapture };
