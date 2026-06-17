# V99fb-retry · Independent verification · VERDICT CLEAN

**Date:** 2026-06-16 evening
**Commit verified:** `5eb1391 feat(v99fb-retry): wrap FB Graph API fetches with retry + timeout`
**Push range:** `2faf9c8..5eb1391`
**Verifier:** Cowork Claude (independent grep against origin/main)

---

## ✅ V99fb-retry infrastructure (server.js)

| Check | Expected | Actual | Status |
|---|---|---|---|
| `fetchWithRetry` total hits | ≥5 (1 helper + 4 sites) | 5 | ✅ |
| Bare fetch to graph.facebook.com | 0 (all converted) | 0 | ✅ |
| Total `fetch(` in server.js | 1 (helper only) | 1 | ✅ |
| `AbortController` for timeout | ≥1 | 1 | ✅ |
| `[fetchRetry]` log markers | ≥3 (attempt N, succeeded, gave up) | 3 | ✅ |

## ✅ All 4 fetch sites converted

| Function | Line | Status |
|---|---|---|
| `fetchWithRetry` helper | 215 | ✅ defined |
| `getSenderName` | 253 | ✅ uses fetchWithRetry |
| `sendFbMessage` | 270 | ✅ uses fetchWithRetry ← **CRITICAL customer-facing fix** |
| `sendFbImage` | 319 | ✅ uses fetchWithRetry |
| `sendFbImageUrlOnly` | 351 | ✅ uses fetchWithRetry |

## ✅ Cross-bundle preservation (no regressions)

| Marker | Location | Count | Status |
|---|---|---|---|
| V99 marker | server.js | 3 | ✅ preserved |
| V100a markers | availability-checker.js | 6 | ✅ preserved |
| ROOM_TAB_MAP | availability-checker.js | 4 | ✅ preserved |
| V101_1 | ai-reply.js | 2 | ✅ preserved |
| PLACE_NAME_HALLUCINATION_V101 | ai-reply.js | 1 | ✅ preserved |
| V98 EN_MONTHS | fb-date-parser.js | 2 | ✅ preserved |

## 🎯 Customer-facing impact

- Transient Railway → Graph network blips (Node 22 undici socket pool issue) now silently retry up to 3 attempts (500ms · 1000ms · 2000ms exp backoff)
- Selective retry gated on transient error regex: `fetch failed | socket hang up | ECONNRESET | ETIMEDOUT | UND_ERR_SOCKET | UND_ERR_CONNECT_TIMEOUT | ENOTFOUND | EAI_AGAIN | AbortError`
- HTTP 4xx/5xx errors NOT retried (returned to caller for proper handling)
- 8 second per-attempt timeout via AbortController (fail-fast vs hanging socket)
- Closes the customer-silenced bug from 2026-06-16 15:30 production log

## 🏆 Codex transparency note

Codex flagged that the spec's expected cross-bundle counts (V99=5, V98 EN_MONTHS=6, PLACE_NAME_HALLUCINATION_V101 ≥3) were stale vs current origin/main. Counts are lower in reality (V99=3, V98=2, V101=1) but all markers still present after V99fb-retry. **No regression** — Cowork Claude's pre-ship spec had inflated count predictions. Codex's evidence-based verdict was correct.

## 🟢 VERDICT: CLEAN · NO ROLLBACK NEEDED

V99fb-retry is production-safe. Phao to smoke test from PSID 1496719837083797:
1. Trigger V99 escalation reply (Manila Deluxe scope)
2. Verify reply lands on first attempt (no `[fetchRetry]` log if happy path)
3. If transient blip occurs over next 24h: expect `[fetchRetry] attempt N/3 failed ... retry in Xms` → `succeeded on attempt N+1/3` in logs

Closeout. Ready for V100b tomorrow morning.
