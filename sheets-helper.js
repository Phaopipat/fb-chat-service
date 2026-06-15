// FB_SHEETS_HELPER_PORTED · 2026-06-15
/**
 * sheets-helper.js
 * ─────────────────────────────────────────────────────────────────────────
 * Drop-in helper สำหรับแก้ปัญหา Google Sheets API quota
 * "Resource has been exhausted (e.g. check quota)"
 *
 * วิธีใช้:
 *   1. Upload ไฟล์นี้ขึ้น repo `webhook-kohtalu` (root level)
 *   2. ใน server.js เปลี่ยนการเรียก sheets.spreadsheets.values.append(...)
 *      มาเป็น appendWithRetry(sheets, { ... })
 *   3. Commit & push → Railway auto-redeploy
 *
 * Features:
 *   ✅ Exponential backoff retry (1s, 2s, 4s, 8s, 16s, 32s)
 *   ✅ Detect quota errors (429, "exhausted", "rate limit") → retry only those
 *   ✅ Dead-letter queue ใน memory (เก็บ message ที่ retry หมดแล้วยัง fail)
 *   ✅ Auto-flush dead-letter queue ทุก 60 วินาที
 *   ✅ Concurrency limiter (max 5 parallel writes) ป้องกันยิง burst
 *   ✅ Log ที่อ่านง่าย: 🔄 retry / ✅ logged / ⏳ queued / ☠️ dropped
 *
 * Backwards compatible — ฟีเจอร์เดิม (sentiment / log) ใช้งานได้ปกติ
 */

const MAX_ATTEMPTS = 6;          // 6 ครั้ง รวม wait ~63 วินาที
const BASE_BACKOFF_MS = 1000;    // 1s, 2s, 4s, 8s, 16s, 32s
const MAX_CONCURRENT = 5;        // เขียน Sheet พร้อมกันสูงสุด 5
const DEAD_LETTER_FLUSH_MS = 60000;  // ลอง re-flush dead-letter ทุก 1 นาที
const DEAD_LETTER_MAX_AGE_MS = 30 * 60 * 1000;  // เก็บไม่เกิน 30 นาที

// ─── Concurrency limiter ─────────────────────────────────────────────────
let activeWrites = 0;
const pendingWrites = [];

function acquireSlot() {
  return new Promise((resolve) => {
    if (activeWrites < MAX_CONCURRENT) {
      activeWrites++;
      return resolve();
    }
    pendingWrites.push(resolve);
  });
}

function releaseSlot() {
  activeWrites--;
  const next = pendingWrites.shift();
  if (next) {
    activeWrites++;
    next();
  }
}

// ─── Dead-letter queue ────────────────────────────────────────────────────
const deadLetterQueue = [];

function enqueueDeadLetter(payload) {
  deadLetterQueue.push({
    payload,
    queuedAt: Date.now(),
    attempts: 0,
  });
  console.warn(`⏳ Queued to dead-letter (size=${deadLetterQueue.length})`);
}

function isQuotaError(err) {
  if (!err) return false;
  const code = err.code || err.status || (err.response && err.response.status);
  if (code === 429 || code === 503) return true;
  const msg = (err.message || "").toLowerCase();
  return /exhausted|rate.?limit|quota|too many requests/.test(msg);
}

// ─── Main append-with-retry function ─────────────────────────────────────
/**
 * @param {object} sheets — google.sheets({ version: "v4", auth }) instance
 * @param {object} request — same params as sheets.spreadsheets.values.append()
 *                           e.g. { spreadsheetId, range, valueInputOption, requestBody }
 * @returns {Promise<void>}
 */
async function appendWithRetry(sheets, request) {
  await acquireSlot();
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        await sheets.spreadsheets.values.append(request);
        if (attempt > 0) {
          console.log(`✅ Sheet append succeeded after ${attempt} retry(s)`);
        }
        return;
      } catch (err) {
        if (!isQuotaError(err)) {
          // ไม่ใช่ quota error → throw ออกไปให้ caller handle
          console.error("Sheet append non-quota error:", err.message);
          throw err;
        }
        const wait = BASE_BACKOFF_MS * 2 ** attempt;
        console.warn(
          `🔄 Quota hit (attempt ${attempt + 1}/${MAX_ATTEMPTS}), ` +
          `retry in ${wait}ms — ${err.message}`
        );
        await sleep(wait);
      }
    }
    // หมด retry แล้วยังไม่สำเร็จ → ใส่ dead-letter
    console.error(`☠️ Sheet append failed after ${MAX_ATTEMPTS} attempts`);
    enqueueDeadLetter(request);
  } finally {
    releaseSlot();
  }
}

// ─── Background dead-letter re-flush ─────────────────────────────────────
async function flushDeadLetterQueue(sheets) {
  if (deadLetterQueue.length === 0) return;
  console.log(`📤 Flushing dead-letter queue (size=${deadLetterQueue.length})`);

  const now = Date.now();
  // ตัดของเก่าที่เกิน max age ทิ้ง (กันบวมไม่จบ)
  while (deadLetterQueue.length && now - deadLetterQueue[0].queuedAt > DEAD_LETTER_MAX_AGE_MS) {
    const dropped = deadLetterQueue.shift();
    console.error(`☠️ Dropped stale entry (age=${Math.round((now - dropped.queuedAt) / 1000)}s)`);
  }

  // พยายาม flush ทีละตัว — ถ้า fail ใส่กลับเข้า queue
  const batch = deadLetterQueue.splice(0, deadLetterQueue.length);
  for (const item of batch) {
    item.attempts++;
    try {
      await acquireSlot();
      try {
        await sheets.spreadsheets.values.append(item.payload);
        console.log(`✅ Dead-letter entry recovered (was queued ${Math.round((now - item.queuedAt) / 1000)}s ago)`);
      } finally {
        releaseSlot();
      }
    } catch (err) {
      if (isQuotaError(err)) {
        // ใส่กลับเข้า queue
        deadLetterQueue.push(item);
      } else {
        console.error(`☠️ Dead-letter entry permanently failed: ${err.message}`);
      }
    }
  }
}

function startDeadLetterWorker(sheets) {
  setInterval(() => {
    flushDeadLetterQueue(sheets).catch((err) =>
      console.error("Dead-letter worker error:", err)
    );
  }, DEAD_LETTER_FLUSH_MS);
  console.log(`📋 Dead-letter worker started (flush every ${DEAD_LETTER_FLUSH_MS / 1000}s)`);
}

// ─── Health/stats ────────────────────────────────────────────────────────
function getStats() {
  return {
    activeWrites,
    pendingWrites: pendingWrites.length,
    deadLetterSize: deadLetterQueue.length,
    deadLetterOldestAgeSec:
      deadLetterQueue.length > 0
        ? Math.round((Date.now() - deadLetterQueue[0].queuedAt) / 1000)
        : 0,
  };
}

// ─── Utils ───────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  appendWithRetry,
  startDeadLetterWorker,
  getStats,
};
