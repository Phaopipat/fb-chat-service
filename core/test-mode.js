'use strict';

// test-mode.js
// ─────────────────────────────────────────────────────────────────────────────
// TestMode infrastructure — safe per-user feature gating for production testing
//
// Priority chain (caller enforces layer 1, this module enforces layers 2-3):
//   1. BOT_ENABLED=false        → silent (master kill) — checked in server.js first
//   2. TEST_MODE_ENABLED=true   → only users in TestMode Sheet tab get replies
//   3. TEST_MODE_ENABLED=false  → production normal (everyone served)
//
// Env vars:
//   TEST_MODE_ENABLED  — "true" | "false" (default false)
//   GOOGLE_SHEET_ID    — Sheet ID (same as rest of app)
//   GOOGLE_SERVICE_ACCOUNT_JSON — service account (same as rest of app)
// ─────────────────────────────────────────────────────────────────────────────

const { google } = require('googleapis');

const CACHE_TTL_MS = 60 * 1000; // 60s — same as BotToggle

// ─── Module state ──────────────────────────────────────────────────────────
let _testModeCache = { data: new Map(), at: 0 };
let _sheetsClient  = null;

// ─── isTestModeEnabled ────────────────────────────────────────────────────
// Read dynamically so tests can mutate process.env between test cases.
function isTestModeEnabled() {
  return (process.env.TEST_MODE_ENABLED || 'false').toLowerCase() === 'true';
}

// ─── _getSheetsClient (lazy, cached) ──────────────────────────────────────
async function _getSheetsClient() {
  if (_sheetsClient) return _sheetsClient;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}';
  const creds = JSON.parse(raw.replace(/\\\\n/g, '\\n'));
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  _sheetsClient = google.sheets({ version: 'v4', auth });
  return _sheetsClient;
}

// ─── getTestModeUsers ─────────────────────────────────────────────────────
// Returns Map<userId, {displayName, mode, addedAt, notes}> — cached 60s.
// On Sheet error → warn + return empty Map (fail-open = treat as TEST_MODE off).
async function getTestModeUsers() {
  const now = Date.now();
  if (_testModeCache.at > 0 && now - _testModeCache.at < CACHE_TTL_MS) {
    return _testModeCache.data;
  }

  const sheetId = process.env.GOOGLE_SHEET_ID || '';
  try {
    const sheets = await _getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'TestMode!A2:E1000',
    });
    const m = new Map();
    for (const row of (res.data.values || [])) {
      const uid = (row[0] || '').trim();
      if (!uid) continue;
      m.set(uid, {
        displayName: row[1] || '',
        mode:        row[2] || 'active',
        addedAt:     row[3] || '',
        notes:       row[4] || '',
      });
    }
    _testModeCache = { data: m, at: now };
    return m;
  } catch (err) {
    // Don't cache on error — allow retry next call.
    // Throw so checkTestModeGate can decide to fail-open.
    throw err;
  }
}

// ─── getUserTestMode ──────────────────────────────────────────────────────
// Returns entry object if userId is in TestMode tab, null otherwise.
async function getUserTestMode(userId) {
  const users = await getTestModeUsers();
  return users.get(userId) || null;
}

// ─── checkTestModeGate ────────────────────────────────────────────────────
// Main gate — returns { allow: boolean, reason: string }.
//
// Checks (in order):
//   BOT_ENABLED=false       → { allow: false, reason: 'bot_disabled' }
//   TEST_MODE_ENABLED=false → { allow: true,  reason: 'production' }
//   user in TestMode tab    → { allow: true,  reason: 'test_mode_allowed' }
//   user NOT in TestMode    → { allow: false, reason: 'not_in_test_mode' }
//   Sheet read error        → { allow: true,  reason: 'test_mode_error_failopen' }
//
// Note: BOT_ENABLED is also checked in server.js before this is called.
// The check here provides defense-in-depth for callers in ai-reply.js.
async function checkTestModeGate(userId) {
  // (1) Master kill
  const botEnabled = (process.env.BOT_ENABLED || 'true').toLowerCase() !== 'false';
  if (!botEnabled) return { allow: false, reason: 'bot_disabled' };

  // (2) Production normal — gate is off
  if (!isTestModeEnabled()) return { allow: true, reason: 'production' };

  // (3) TestMode is on — check Sheet
  try {
    const userEntry = await getUserTestMode(userId);
    if (userEntry) return { allow: true, reason: 'test_mode_allowed' };
    return { allow: false, reason: 'not_in_test_mode' };
  } catch (err) {
    // Sheet error while checking individual user — fail open
    console.warn('[TestMode] checkTestModeGate error — fail open:', err.message);
    return { allow: true, reason: 'test_mode_error_failopen' };
  }
}

// ─── getFeatureFlag ───────────────────────────────────────────────────────
// Stub for Phase 2c per-feature gating.
// Future: read from TestMode!F+ columns or a FeatureFlags tab.
// eslint-disable-next-line no-unused-vars
function getFeatureFlag(userId, flagName) {
  return false;
}

// ─── Test helpers ─────────────────────────────────────────────────────────
function _resetCache() {
  _testModeCache = { data: new Map(), at: 0 };
  _sheetsClient  = null;
}

// ─── Exports ──────────────────────────────────────────────────────────────
module.exports = {
  isTestModeEnabled,
  getTestModeUsers,
  getUserTestMode,
  checkTestModeGate,
  getFeatureFlag,
  _resetCache,
};
