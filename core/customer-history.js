// customer-history.js · V108a · CustomerHistory cross-ref module
//
// Loads full customer context across 4 systems:
//   1. BookingMaster (V107 series) · confirmed bookings linked by LINE userId
//   2. BookingHold (Phase 2d)      · pending slip records
//   3. HandoffLog (V107c)          · admin transfers linked via LP cross-ref
//   4. IssueLog (V107d)            · complaints · best-effort name match
//
// Returns aggregated CustomerHistory object · feeds V108b formatter for prompt injection.
//
// Spec: 2026-06-18-V108-customer-history-spec.md
'use strict';

// ─── In-memory cache ─────────────────────────────────────────────────────────
const CACHE_TTL_MS = 60 * 1000; // 60s
const _cache = new Map(); // userId → { data, fetchedAt }

let _ctxLoads = 0;
let _ctxCacheHits = 0;
let _ctxLoadErrors = 0;
let _ctxTimeouts = 0;

function getCustomerHistoryStats() {
  return {
    customerHistoryLoads: _ctxLoads,
    customerHistoryCacheHits: _ctxCacheHits,
    customerHistoryLoadErrors: _ctxLoadErrors,
    customerHistoryTimeouts: _ctxTimeouts,
    customerHistoryCacheSize: _cache.size,
  };
}

function _resetCache() {
  _cache.clear();
}

function invalidateCustomer(userId) {
  if (userId) _cache.delete(userId);
}

function getCustomerHistoryTimeoutMs() {
  const n = Number(process.env.CUSTOMER_HISTORY_TIMEOUT_MS || 2500);
  return Number.isFinite(n) && n > 0 ? n : 2500;
}

async function loadCustomerContextWithTimeout(args, opts = {}) {
  const configuredTimeout = opts.timeoutMs === undefined ? getCustomerHistoryTimeoutMs() : Number(opts.timeoutMs);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : getCustomerHistoryTimeoutMs();
  const loadPromise = loadCustomerContext(args);
  let timeoutId = null;
  const timeoutPromise = new Promise(resolve => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs);
    if (timeoutId.unref) timeoutId.unref();
  });

  const result = await Promise.race([loadPromise, timeoutPromise]);
  if (result === null) {
    _ctxTimeouts++;
    return null;
  }
  if (timeoutId) clearTimeout(timeoutId);
  return result;
}

// ─── Date helpers ────────────────────────────────────────────────────────────
function _daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function _isWithinDays(isoTs, days) {
  if (!isoTs) return false;
  const t = new Date(isoTs);
  if (isNaN(t.getTime())) return false;
  return t >= _daysAgo(days);
}

function _normalizePhone(s) {
  return String(s || '').replace(/[^\d]/g, '');
}

function _normalizeName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// ─── 1. BookingMaster finder ─────────────────────────────────────────────────
// BookingMaster schema (A:Q · 17 cols):
//   col O (index 14) = linkedLineUserId
async function findBookingMasterByLineUserId({ userId, sheets, spreadsheetId }) {
  if (!userId || !sheets || !spreadsheetId) return [];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'BookingMaster!A2:Q5000',
    });
    const rows = res.data.values || [];
    const matches = [];
    for (const r of rows) {
      const linkedLine = r[14] || '';
      if (linkedLine === userId) {
        matches.push({
          timestamp: r[0] || '',
          groupMsgId: r[1] || '',
          source: r[2] || 'unknown',
          reportedBy: r[3] || '',
          guestName: r[4] || '',
          phone: r[5] || '',
          paxAdults: Number(r[6]) || 0,
          paxChildren: Number(r[7]) || 0,
          checkinDate: r[8] || '',
          checkoutDate: r[9] || '',
          nights: Number(r[10]) || 0,
          roomType: r[11] || '',
          amount: Number(r[12]) || 0,
          deposit: Number(r[13]) || 0,
          modifyTrail: r[16] || '',
        });
      }
    }
    // newest first
    matches.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    return matches;
  } catch (e) {
    if (!/not found/i.test(e.message)) {
      console.warn('[V108] BookingMaster read failed:', e.message);
    }
    return [];
  }
}

// ─── 2. BookingHold finder ───────────────────────────────────────────────────
// BookingHold schema:
//   col A=userId · B=displayName · C=bookingRef · D=expectedAmount · E=tolerance
//   F=status · G=createdAt · H=confirmedAt · I=matchedTransRef · J=matchedAmount
//   K=notes · L=expiresAt · M=bookingPersonName · N=customerEmail
async function findBookingHoldsByUserId({ userId, sheets, spreadsheetId, opts = {} }) {
  if (!userId || !sheets || !spreadsheetId) return [];
  const includeAll = !!opts.includeAll;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'BookingHold!A2:N5000',
    });
    const rows = res.data.values || [];
    const matches = [];
    for (const r of rows) {
      if (r[0] !== userId) continue;
      const status = String(r[5] || '').toLowerCase().trim();
      const createdAt = r[6] || '';
      const hold = {
        userId: r[0] || '',
        displayName: r[1] || '',
        bookingRef: r[2] || '',
        expectedAmount: Number(r[3]) || 0,
        status,
        createdAt,
        confirmedAt: r[7] || '',
        matchedTransRef: r[8] || '',
        matchedAmount: Number(r[9]) || 0,
        notes: r[10] || '',
        expiresAt: r[11] || '',
        bookingPersonName: r[12] || '',
        customerEmail: r[13] || '',
      };
      // Filter: pending always OR confirmed within last 30 days OR includeAll
      if (includeAll) {
        matches.push(hold);
      } else if (status === 'pending') {
        matches.push(hold);
      } else if (status === 'confirmed' && _isWithinDays(createdAt, 30)) {
        matches.push(hold);
      }
    }
    matches.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return matches;
  } catch (e) {
    if (!/not found/i.test(e.message)) {
      console.warn('[V108] BookingHold read failed:', e.message);
    }
    return [];
  }
}

// ─── 3. HandoffLog finder ────────────────────────────────────────────────────
// HandoffLog schema (V107c · 10 cols A:J):
//   col A=timestamp · B=groupMsgId · C=fromAdmin · D=toAdmin · E=customerRef
//   F=reason · G=status · H=linkedBookingMasterMsgId · I=linkedLeadProfileUserId · J=rawSnippet
async function findHandoffLogsByLpUserId({ userId, sheets, spreadsheetId, daysBack = 14 }) {
  if (!userId || !sheets || !spreadsheetId) return [];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'HandoffLog!A2:J5000',
    });
    const rows = res.data.values || [];
    const matches = [];
    for (const r of rows) {
      const linkedLp = r[8] || '';
      if (linkedLp !== userId) continue;
      const ts = r[0] || '';
      if (!_isWithinDays(ts, daysBack)) continue;
      matches.push({
        timestamp: ts,
        groupMsgId: r[1] || '',
        fromAdmin: r[2] || '',
        toAdmin: r[3] || '',
        customerRef: r[4] || '',
        reason: r[5] || '',
        status: r[6] || 'open',
        linkedBookingMasterMsgId: r[7] || '',
        linkedLeadProfileUserId: r[8] || '',
        rawSnippet: r[9] || '',
      });
    }
    matches.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    return matches;
  } catch (e) {
    if (!/not found/i.test(e.message)) {
      console.warn('[V108] HandoffLog read failed:', e.message);
    }
    return [];
  }
}

// ─── 4. IssueLog finder ──────────────────────────────────────────────────────
// IssueLog schema (V107d · 11 cols A:K):
//   col A=timestamp · B=groupMsgId · C=reportedBy · D=customerRef · E=severity
//   F=category · G=description · H=assignedAdmin · I=status · J=resolutionNote
//   K=linkedBookingMasterMsgId
//
// NOTE: V107d does not have linkedLeadProfileUserId column yet (deferred to V108d).
// V108a uses best-effort match on customerRef (name fuzzy) using LP displayName/phone.
async function findIssueLogsByLp({ leadProfile, sheets, spreadsheetId, daysBack = 30 }) {
  if (!leadProfile || !sheets || !spreadsheetId) return [];
  const displayName = _normalizeName(leadProfile.displayName);
  const phone = _normalizePhone(leadProfile.phone);
  if (!displayName && !phone) return [];

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'IssueLog!A2:K5000',
    });
    const rows = res.data.values || [];
    const matches = [];
    for (const r of rows) {
      const ts = r[0] || '';
      if (!_isWithinDays(ts, daysBack)) continue;
      const customerRef = _normalizeName(r[3]);
      if (!customerRef) continue;
      let isMatch = false;
      // Name substring match (both directions · short displayName risks false match · require ≥ 4 chars)
      if (displayName.length >= 4) {
        if (customerRef.includes(displayName) || displayName.includes(customerRef.split(',')[0].trim())) {
          isMatch = true;
        }
      }
      if (isMatch) {
        matches.push({
          timestamp: ts,
          groupMsgId: r[1] || '',
          reportedBy: r[2] || '',
          customerRef: r[3] || '',
          severity: r[4] || 'low',
          category: r[5] || 'other',
          description: r[6] || '',
          assignedAdmin: r[7] || '',
          status: r[8] || 'open',
          resolutionNote: r[9] || '',
          linkedBookingMasterMsgId: r[10] || '',
        });
      }
    }
    matches.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    return matches;
  } catch (e) {
    if (!/not found/i.test(e.message)) {
      console.warn('[V108] IssueLog read failed:', e.message);
    }
    return [];
  }
}

// ─── Orchestrator · loadCustomerContext ──────────────────────────────────────
async function loadCustomerContext({ userId, leadProfile, sheets, spreadsheetId, opts = {} }) {
  if (!userId) {
    return { userId: '', leadProfile: null, bookings: [], bookingHolds: [], handoffs: [], issues: [], loadedAt: Date.now(), cacheHit: false, empty: true };
  }

  _ctxLoads++;

  // Cache check
  if (!opts.cacheBust) {
    const cached = _cache.get(userId);
    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
      _ctxCacheHits++;
      return { ...cached.data, cacheHit: true };
    }
  }

  // Parallel reads · graceful degradation
  let bookings = [];
  let bookingHolds = [];
  let handoffs = [];
  let issues = [];

  try {
    const results = await Promise.allSettled([
      findBookingMasterByLineUserId({ userId, sheets, spreadsheetId }),
      findBookingHoldsByUserId({ userId, sheets, spreadsheetId }),
      findHandoffLogsByLpUserId({ userId, sheets, spreadsheetId }),
      findIssueLogsByLp({ leadProfile, sheets, spreadsheetId }),
    ]);
    bookings = results[0].status === 'fulfilled' ? results[0].value : [];
    bookingHolds = results[1].status === 'fulfilled' ? results[1].value : [];
    handoffs = results[2].status === 'fulfilled' ? results[2].value : [];
    issues = results[3].status === 'fulfilled' ? results[3].value : [];
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        _ctxLoadErrors++;
        console.warn(`[V108] source ${i} failed:`, results[i].reason?.message);
      }
    }
  } catch (e) {
    _ctxLoadErrors++;
    console.warn('[V108] loadCustomerContext error:', e.message);
  }

  const data = {
    userId,
    leadProfile: leadProfile || null,
    bookings,
    bookingHolds,
    handoffs,
    issues,
    loadedAt: Date.now(),
    cacheHit: false,
    empty: (bookings.length + bookingHolds.length + handoffs.length + issues.length) === 0,
  };

  _cache.set(userId, { data, fetchedAt: Date.now() });
  return data;
}

// ─── V108b · formatCustomerHistoryForPrompt ──────────────────────────────────
// Builds a prompt context block from CustomerHistory object.
// Smart truncation respects MAX_LEN budget (default 2000 chars · ~500 tokens).
//
// Priority order (most relevant first):
//   1. Confirmed bookings (top 3 newest)
//   2. Pending slip (if any)
//   3. Recent admin discussions (handoffs + issues · top 5 newest mixed)
//
// Truncation order when over budget:
//   a. Drop booking modify trail (verbose)
//   b. Drop older bookings (keep only newest)
//   c. Drop low-severity issues
//   d. Drop resolved/done handoffs
//   e. Hard cut at MAX_LEN with '…'

function _humanSinceSimple(isoTs) {
  if (!isoTs) return '?';
  try {
    const diffMs = Date.now() - new Date(isoTs).getTime();
    if (diffMs < 0) return 'soon';
    const mins = Math.floor(diffMs / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 48) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `${days}d`;
  } catch (_) {
    return '?';
  }
}

function _bookingLine(b, opts = {}) {
  const parts = [];
  if (b.checkinDate) parts.push(b.checkinDate);
  if (b.roomType) parts.push(b.roomType);
  if (b.amount > 0) parts.push(`${b.amount.toLocaleString('en-US')}฿`);
  if (b.source) parts.push(`(${b.source})`);
  let line = `- ${parts.join(' · ')}`;
  if (opts.includeModifyTrail && b.modifyTrail) {
    // Compact modify trail · last 3 lines · joined
    const lines = b.modifyTrail.split('\n').filter(Boolean).slice(-3);
    if (lines.length > 0) {
      line += `\n  Notes: ${lines.join(' · ').substring(0, 250)}`;
    }
  }
  return line;
}

function _holdLine(h) {
  const parts = [];
  parts.push(`expected ${(h.expectedAmount || 0).toLocaleString('en-US')}฿`);
  if (h.bookingRef) parts.push(`ref ${h.bookingRef}`);
  if (h.bookingPersonName) parts.push(`name ${h.bookingPersonName}`);
  return parts.join(' · ');
}

function _adminAction(item) {
  // Unified shape for handoff or issue
  const since = _humanSinceSimple(item.timestamp);
  if (item._type === 'handoff') {
    return `- ${since} ago [handoff]: ${item.fromAdmin} → ${item.toAdmin}: ${item.reason} (${item.status})`;
  }
  if (item._type === 'issue') {
    const desc = (item.description || '').substring(0, 100);
    return `- ${since} ago [issue]: [${item.severity}] ${item.category}: ${desc} (${item.status})`;
  }
  return `- ${since} ago: ${JSON.stringify(item).substring(0, 100)}`;
}

function _truncate(str, max) {
  if (!str || str.length <= max) return str;
  return str.substring(0, max - 1) + '…';
}

function formatCustomerHistoryForPrompt(ctx, options = {}) {
  const MAX_LEN = options.maxLen || 2000;
  if (!ctx || ctx.empty) return '';
  if (
    (!ctx.bookings || ctx.bookings.length === 0) &&
    (!ctx.bookingHolds || ctx.bookingHolds.length === 0) &&
    (!ctx.handoffs || ctx.handoffs.length === 0) &&
    (!ctx.issues || ctx.issues.length === 0)
  ) {
    return '';
  }

  // Build sections in priority order
  // Strategy: try full · if over budget, progressively trim
  function buildBlock({ topBookings, includeModifyTrail, topActions, dropLowSeverityIssues, dropResolvedHandoffs }) {
    const sections = [];
    sections.push('[CUSTOMER FULL CONTEXT — use to personalize reply, do not reveal raw field names]');

    const bookings = (ctx.bookings || []).slice(0, topBookings);
    if (bookings.length > 0) {
      sections.push(`Confirmed bookings (${ctx.bookings.length}):`);
      for (const b of bookings) {
        sections.push(_bookingLine(b, { includeModifyTrail }));
      }
    }

    // Pending slip · first pending hold only
    const pending = (ctx.bookingHolds || []).find(h => h.status === 'pending');
    if (pending) {
      sections.push('');
      sections.push(`Pending slip: ${_holdLine(pending)}`);
    }

    // Admin discussions · merge handoffs + issues with type tag · sort by time
    const handoffs = (ctx.handoffs || []).filter(h => {
      if (dropResolvedHandoffs && (h.status === 'done' || h.status === 'resolved')) return false;
      return true;
    }).map(h => ({ ...h, _type: 'handoff' }));
    const issues = (ctx.issues || []).filter(i => {
      if (dropLowSeverityIssues && i.severity === 'low') return false;
      return true;
    }).map(i => ({ ...i, _type: 'issue' }));
    const merged = [...handoffs, ...issues]
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
      .slice(0, topActions);

    if (merged.length > 0) {
      sections.push('');
      sections.push('Recent admin discussions:');
      for (const item of merged) {
        sections.push(_adminAction(item));
      }
    }

    return sections.join('\n');
  }

  // Attempt 1: full detail
  let block = buildBlock({ topBookings: 3, includeModifyTrail: true, topActions: 5 });
  if (block.length <= MAX_LEN) return block;

  // Attempt 2: drop modify trail
  block = buildBlock({ topBookings: 3, includeModifyTrail: false, topActions: 5 });
  if (block.length <= MAX_LEN) return block;

  // Attempt 3: keep only newest booking
  block = buildBlock({ topBookings: 1, includeModifyTrail: false, topActions: 5 });
  if (block.length <= MAX_LEN) return block;

  // Attempt 4: drop low-severity issues
  block = buildBlock({ topBookings: 1, includeModifyTrail: false, topActions: 5, dropLowSeverityIssues: true });
  if (block.length <= MAX_LEN) return block;

  // Attempt 5: drop resolved handoffs too
  block = buildBlock({ topBookings: 1, includeModifyTrail: false, topActions: 3, dropLowSeverityIssues: true, dropResolvedHandoffs: true });
  if (block.length <= MAX_LEN) return block;

  // Final: hard cut
  return _truncate(block, MAX_LEN);
}

// ─── Enable flag ─────────────────────────────────────────────────────────────
function isCustomerHistoryEnabled() {
  return (process.env.CUSTOMER_HISTORY_ENABLED || 'false').toLowerCase() === 'true';
}

module.exports = {
  loadCustomerContext,
  loadCustomerContextWithTimeout,
  findBookingMasterByLineUserId,
  findBookingHoldsByUserId,
  findHandoffLogsByLpUserId,
  findIssueLogsByLp,
  invalidateCustomer,
  isCustomerHistoryEnabled,
  getCustomerHistoryStats,
  getCustomerHistoryTimeoutMs,
  // V108b · prompt formatter
  formatCustomerHistoryForPrompt,
  // Test helpers
  _resetCache,
  _isWithinDays,
  _normalizePhone,
  _normalizeName,
  _humanSinceSimple,
};
