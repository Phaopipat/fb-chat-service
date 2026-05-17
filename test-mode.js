/**
 * fb-chat-service test-mode.js · Stage 3 (v1.3.0)
 *
 * Sheet-based allowlist for FB bot replies.
 * Tab: "TestMode" in iB Chatlog Sheet (same Sheet as Messages tab)
 * Schema: A=psid B=displayName C=mode D=addedAt E=notes
 *
 * Logic:
 *   - mode === "active"          → bot replies to this psid
 *   - mode === "inactive" / null → bot silent for this psid
 *   - Sheet unreachable          → fallback to ECHO_ENABLED_PSIDS env var
 *
 * Cache: 60s TTL · refresh on cache miss
 * Admin workflow: edit Sheet directly → effect within ≤60s · no redeploy needed
 */

const CACHE_TTL_MS = 60 * 1000;

let cache = {
  allowedSet: new Set(),
  fetchedAt: 0,
  fetchErrored: false,
};

/**
 * Refresh cache from Sheet · returns Set of active PSIDs · null if Sheet error
 */
async function refreshCache({ sheets, spreadsheetId, tabName = "TestMode" }) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tabName}!A:C`,
    });
    const rows = res.data.values || [];
    const allowedSet = new Set();
    let activeCount = 0;
    let inactiveCount = 0;
    for (const r of rows) {
      const psid = (r[0] || "").trim();
      const mode = (r[2] || "").trim().toLowerCase();
      // Skip header row variants
      if (!psid || psid === "psid" || psid === "userId" || psid === "user_id") continue;
      if (mode === "active") {
        allowedSet.add(psid);
        activeCount++;
      } else {
        inactiveCount++;
      }
    }
    cache = {
      allowedSet,
      fetchedAt: Date.now(),
      fetchErrored: false,
    };
    console.log(`[TestMode] ✅ Cache refreshed · ${activeCount} active · ${inactiveCount} inactive/empty`);
    return allowedSet;
  } catch (err) {
    console.warn(`[TestMode] ⚠️  Cache refresh failed: ${err.message}`);
    cache.fetchErrored = true;
    return null;
  }
}

/**
 * Check if a PSID is allowed to receive bot replies.
 *
 * Priority:
 *   1. Sheet TestMode tab (with 60s cache)
 *   2. fallbackPsids (ECHO_ENABLED_PSIDS env) if Sheet error
 *
 * @param {object} opts
 * @param {string} opts.psid                  Customer PSID to check
 * @param {object} opts.sheets                Google Sheets client
 * @param {string} opts.spreadsheetId         Sheet ID
 * @param {string} [opts.tabName="TestMode"]  Tab name
 * @param {string[]} [opts.fallbackPsids=[]]  Env fallback if Sheet fails
 * @returns {Promise<boolean>}
 */
async function isAllowed({
  psid,
  sheets,
  spreadsheetId,
  tabName = "TestMode",
  fallbackPsids = [],
}) {
  if (!psid) return false;

  const cacheAge = Date.now() - cache.fetchedAt;
  const cacheStale = cacheAge > CACHE_TTL_MS;

  // Refresh if stale OR if previous fetch errored (retry sooner)
  if (cacheStale || cache.fetchErrored) {
    const refreshed = await refreshCache({ sheets, spreadsheetId, tabName });
    if (!refreshed) {
      // Sheet read failed — fall back to env allowlist
      const envOk = fallbackPsids.includes(psid);
      console.warn(
        `[TestMode] Sheet unreachable · fallback to ECHO_ENABLED_PSIDS (${fallbackPsids.length} entries) · psid=${psid} allowed=${envOk}`
      );
      return envOk;
    }
  }

  return cache.allowedSet.has(psid);
}

/**
 * Manual cache invalidation (e.g. for /admin/refresh endpoint)
 */
function invalidateCache() {
  cache.fetchedAt = 0;
  cache.fetchErrored = false;
  console.log("[TestMode] Cache invalidated manually");
}

/**
 * Debug helper · returns current cache state
 */
function getCacheStatus() {
  return {
    allowedCount: cache.allowedSet.size,
    cacheAgeMs: Date.now() - cache.fetchedAt,
    cacheTTL: CACHE_TTL_MS,
    fetchErrored: cache.fetchErrored,
    allowedPsids: Array.from(cache.allowedSet),
  };
}

module.exports = {
  isAllowed,
  refreshCache,
  invalidateCache,
  getCacheStatus,
};
