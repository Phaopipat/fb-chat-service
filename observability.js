'use strict';
// FB_OBSERVABILITY_PORTED · 2026-06-15

// observability.js
// Lightweight runtime telemetry for Phase 1 stabilization.
// No external dependency, no PII, safe to expose via health endpoints.

const startedAt = new Date();

const counters = {
  webhookReceived: 0,
  webhookAccepted: 0,
  webhookRejected: 0,
  eventsProcessed: 0,
  eventsErrored: 0,
  sheetAppendOk: 0,
  sheetAppendError: 0,
  autoReplyErrored: 0,
  uncaughtException: 0,
  unhandledRejection: 0,
};

const recentErrors = [];
const RECENT_ERROR_LIMIT = 20;

function increment(name, by = 1) {
  counters[name] = (counters[name] || 0) + by;
}

function recordError(scope, err, extra = {}) {
  const entry = {
    at: new Date().toISOString(),
    scope,
    message: err && err.message ? err.message : String(err || 'unknown error'),
    code: err && (err.code || err.status || (err.response && err.response.status)) || '',
    ...extra,
  };
  recentErrors.push(entry);
  while (recentErrors.length > RECENT_ERROR_LIMIT) recentErrors.shift();
}

function getRuntimeSnapshot() {
  const now = Date.now();
  return {
    service: 'fb-chat-service',
    startedAt: startedAt.toISOString(),
    uptimeSec: Math.round((now - startedAt.getTime()) / 1000),
    nodeVersion: process.version,
    env: process.env.NODE_ENV || 'production',
    counters: { ...counters },
    recentErrors: [...recentErrors],
  };
}

function getConfigSnapshot() {
  return {
    fbVerifyTokenConfigured: !!process.env.FB_VERIFY_TOKEN,
    fbAppSecretConfigured: !!process.env.FB_APP_SECRET,
    fbPageTokenConfigured: !!process.env.FB_PAGE_ACCESS_TOKEN,
    sheetIdConfigured: !!process.env.GOOGLE_SHEET_ID,
    serviceAccountConfigured: !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    anthropicConfigured: !!process.env.ANTHROPIC_API_KEY,
    adminTokenConfigured: !!process.env.ADMIN_API_TOKEN,
    brevoConfigured: !!process.env.BREVO_API_KEY,
    botEnabled: (process.env.BOT_ENABLED || 'true').toLowerCase() !== 'false',
    testModeEnabled: (process.env.TEST_MODE_ENABLED || 'false').toLowerCase() === 'true',
    leadProfileEnabled: (process.env.LEAD_PROFILE_ENABLED || 'false').toLowerCase() === 'true',
    kbLookupEnabled: (process.env.KB_LOOKUP_ENABLED ?? 'true') !== 'false',
  };
}

module.exports = {
  increment,
  recordError,
  getRuntimeSnapshot,
  getConfigSnapshot,
};
