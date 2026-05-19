// fb-chat-service · bot-pause.js · Stage 6.8 (v1.9.0)
//
// In-memory bot pause registry. When admin manually replies via FB Messenger UI
// (is_echo event from Page), we pause auto-replies for that customer's PSID
// for PAUSE_DURATION_MS (default 2 hours). Sensitive-keyword admin alerts
// still fire — only the bot's customer-facing reply is suppressed.
//
// Auto-resume:
//   - After PAUSE_DURATION_MS with no new admin echo, bot resumes
//   - Each new admin echo resets the window (sliding · not fixed)
//
// Public API:
//   - pauseBot(psid, reason?)         · mark as paused
//   - isBotPaused(psid)               · check + auto-cleanup if expired
//   - resumeBot(psid)                 · manual resume (admin command)
//   - getPauseInfo(psid)              · debug: { pausedAt, expiresAt, reason }
//   - getActivePauseCount()           · for /health
//   - getConfigStatus()               · for /health
//
// No persistence: Railway restart → all pauses cleared (bot resumes for all).
// This is acceptable for the SME use case (low FB volume · short downtime windows).

"use strict";

const PAUSE_DURATION_MS = Number(process.env.BOT_PAUSE_DURATION_MS) || 2 * 60 * 60 * 1000; // 2 hours default

const _paused = new Map(); // psid → { pausedAt, expiresAt, reason, echoCount }

function pauseBot(psid, reason = "admin_echo") {
  if (!psid) return;

  const existing = _paused.get(psid);
  const now = Date.now();
  const expiresAt = now + PAUSE_DURATION_MS;

  if (existing) {
    // Sliding window — extend expiry, increment echoCount
    existing.expiresAt = expiresAt;
    existing.echoCount = (existing.echoCount || 1) + 1;
    console.log(
      `[bot-pause] Extended pause for psid=${psid} reason=${reason} · echoCount=${existing.echoCount} · expires in ${Math.round(
        PAUSE_DURATION_MS / 1000 / 60
      )} min`
    );
  } else {
    _paused.set(psid, {
      pausedAt: now,
      expiresAt,
      reason,
      echoCount: 1,
    });
    console.log(
      `[bot-pause] Bot paused for psid=${psid} reason=${reason} · expires in ${Math.round(
        PAUSE_DURATION_MS / 1000 / 60
      )} min`
    );
  }
}

function isBotPaused(psid) {
  const entry = _paused.get(psid);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    _paused.delete(psid);
    console.log(`[bot-pause] Pause expired naturally for psid=${psid}`);
    return false;
  }
  return true;
}

function resumeBot(psid) {
  const entry = _paused.get(psid);
  if (!entry) return false;
  _paused.delete(psid);
  console.log(`[bot-pause] Bot manually resumed for psid=${psid}`);
  return true;
}

function getPauseInfo(psid) {
  const entry = _paused.get(psid);
  if (!entry) return null;
  return {
    pausedAt: new Date(entry.pausedAt).toISOString(),
    expiresAt: new Date(entry.expiresAt).toISOString(),
    minutesRemaining: Math.round((entry.expiresAt - Date.now()) / 60000),
    reason: entry.reason,
    echoCount: entry.echoCount,
  };
}

function getActivePauseCount() {
  // GC expired entries while counting
  const now = Date.now();
  for (const [psid, entry] of _paused.entries()) {
    if (now > entry.expiresAt) _paused.delete(psid);
  }
  return _paused.size;
}

function getConfigStatus() {
  return {
    pause_duration_seconds: Math.round(PAUSE_DURATION_MS / 1000),
    active_pauses: getActivePauseCount(),
  };
}

// Periodic GC (every 30 min · keeps memory bounded under high churn)
setInterval(() => {
  const before = _paused.size;
  getActivePauseCount(); // side effect: cleans expired
  const after = _paused.size;
  if (before !== after) {
    console.log(`[bot-pause] GC removed ${before - after} expired entries (now ${after} active)`);
  }
}, 30 * 60 * 1000);

module.exports = {
  pauseBot,
  isBotPaused,
  resumeBot,
  getPauseInfo,
  getActivePauseCount,
  getConfigStatus,
};
