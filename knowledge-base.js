'use strict';

// knowledge-base.js
// ─────────────────────────────────────────────────────────────────────────────
// K-Pro Knowledge Base module สำหรับ Koh Talu Resort LINE chatbot
// อ่าน/เขียน/ค้นหา KB entries ใน Google Sheets + capture team responses
// ─────────────────────────────────────────────────────────────────────────────

const axios = require('axios');

// ─── Constants ───────────────────────────────────────────────────────────────
const CAPTURE_IDLE_MS = 2 * 60 * 1000;   // 2 นาที idle timeout
const CAPTURE_MAX_MS  = 10 * 60 * 1000;  // 10 นาที hard timeout
const KB_CACHE_TTL    = 5 * 60 * 1000;   // 5 นาที cache TTL

// KB_DEBUG_LOG=true → verbose Stage 1/2/3 logs (set in Railway → มีผลทันที, default off)
const KB_DEBUG = process.env.KB_DEBUG_LOG === 'true';

// ─── Thai stop particles — stripped from customer message before KB scoring ────
// Sentence-ending question/politeness particles share substrings with KB pattern
// chunks, creating false Jaccard bridges. Stripping them from the customer message
// before scoring removes cross-KB false matches while preserving content words.
// Sorted longest-first so compound particles are stripped before their subsets.
const STOP_PARTICLES = [
  // Compound question particles (must precede singles they contain)
  'เป็นยังไง', 'เป็นอย่างไร', 'เป็นไปได้ไหม', 'ทำได้ไหม',
  'หรือเปล่า', 'หรือไม่',
  'ได้ไหม', 'ได้มั้ย',
  // Politeness compounds
  'นะครับ', 'นะคะ', 'นะจ้ะ',
  // V62: question-form suffixes (AREÉ_69 F-D evidence · 2026-05-28)
  // Prevent generic forms like "ได้กี่คน" from bridging unrelated topics.
  'ใช้เวลาแค่ไหน', 'ใช้เวลาเท่าไร',
  'นานแค่ไหน', 'นานเท่าไร',
  'ได้กี่คน', 'เป็นกี่คน',
  // Question words
  'เท่าไหร่', 'เท่าไร',
  'ยังไง', 'อย่างไร',
  'เมื่อไหร่', 'เมื่อไร',
  'ที่ไหน', 'ตรงไหน',
  'กี่คน',
  // Single question particles
  'ไหม', 'มั้ย',
  // Single politeness particles
  'ครับ', 'ค่ะ', 'คะ', 'จ้า', 'นะ',
];

function stripParticles(text) {
  if (!text) return '';
  let s = text;
  for (const p of STOP_PARTICLES) {
    if (s.includes(p)) s = s.split(p).join(' ');
  }
  return s.replace(/\s+/g, ' ').trim();
}

// ─── Module-level state ───────────────────────────────────────────────────────
// Cache สำหรับ KB entries — { data: [], at: timestamp }
let kbCacheStore = { data: [], at: 0 };

// Map สำหรับ capture windows (escalationId → window object)
const captureWindows = new Map();

// ─── KnowledgeBase tab column indices (0-based) ───────────────────────────────
// A:id B:question_pattern C:answer D:category E:volatility
// F:expires_at G:source_groupId H:source_team_msgIds I:created_by
// J:created_at K:updated_at L:usage_count M:confidence N:notes
const COL = {
  id: 0, question_pattern: 1, answer: 2, category: 3, volatility: 4,
  expires_at: 5, source_groupId: 6, source_team_msgIds: 7, created_by: 8,
  created_at: 9, updated_at: 10, usage_count: 11, confidence: 12, notes: 13,
  kb_mode: 14,
};

// แปลง row array → object
function rowToEntry(row) {
  return {
    id:               row[COL.id]               || '',
    question_pattern: row[COL.question_pattern] || '',
    answer:           row[COL.answer]           || '',
    category:         row[COL.category]         || '',
    volatility:       row[COL.volatility]       || '',
    expires_at:       row[COL.expires_at]       || '',
    kb_mode:          row[COL.kb_mode]          || 'direct',
    source_groupId:   row[COL.source_groupId]   || '',
    source_team_msgIds: row[COL.source_team_msgIds] || '',
    created_by:       row[COL.created_by]       || '',
    created_at:       row[COL.created_at]       || '',
    updated_at:       row[COL.updated_at]       || '',
    usage_count:      row[COL.usage_count]      || '0',
    confidence:       row[COL.confidence]       || '',
    notes:            row[COL.notes]            || '',
  };
}

// ─── readKB ───────────────────────────────────────────────────────────────────
/**
 * อ่าน KB entries จาก Google Sheets พร้อม cache 5 นาที
 * กรองเฉพาะ confidence === 'verified'
 */
async function readKB({ sheets, sheetId, category } = {}) {
  try {
    const now = Date.now();
    // ใช้ cache ถ้ายังไม่หมดอายุ
    if (kbCacheStore.at > 0 && now - kbCacheStore.at < KB_CACHE_TTL) {
      const cached = kbCacheStore.data;
      if (category) {
        return cached.filter(e => e.category === category);
      }
      return cached;
    }

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'KnowledgeBase!A2:O1000',
    });

    const rows = (res.data && res.data.values) ? res.data.values : [];
    const all = rows
      .filter(row => row && row.length > 0)
      .map(rowToEntry)
      .filter(e => e.confidence === 'verified');

    // อัพเดต cache
    kbCacheStore = { data: all, at: now };
    console.log(`[KB] loaded: ${all.length} entries (first 5: ${all.slice(0, 5).map(e => e.id).join(', ')})`);

    if (category) {
      return all.filter(e => e.category === category);
    }
    return all;
  } catch (err) {
    console.warn('[KB] readKB error:', err.message);
    return [];
  }
}

// ─── writeKBEntry ─────────────────────────────────────────────────────────────
/**
 * เขียน KB entry ใหม่ลง Google Sheets
 * ID format: KB-{YYYYMMDD}-{seq} (seq = zero-padded 3 digits)
 */
async function writeKBEntry({ sheets, sheetId, entry } = {}) {
  try {
    // อ่านจำนวน rows ปัจจุบันเพื่อสร้าง seq
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'KnowledgeBase!A2:A1000',
    });
    const existingRows = (res.data && res.data.values) ? res.data.values : [];
    const seq = existingRows.length + 1;

    // สร้าง ID
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm   = String(now.getMonth() + 1).padStart(2, '0');
    const dd   = String(now.getDate()).padStart(2, '0');
    const seqStr = String(seq).padStart(3, '0');
    const id = `KB-${yyyy}${mm}${dd}-${seqStr}`;

    const today = `${yyyy}-${mm}-${dd}`;

    // เตรียม row 14 columns (A:N)
    const row = [
      id,
      entry.question_pattern    || '',
      entry.answer              || '',
      entry.category            || '',
      entry.volatility          || 'stable',
      entry.expires_at          || '',
      entry.source_groupId      || '',
      entry.source_team_msgIds  || '',
      entry.created_by          || '',
      today,
      today,
      '0',
      entry.confidence          || 'pending',
      entry.notes               || '',
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'KnowledgeBase!A:N',
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });

    // Invalidate cache
    kbCacheStore.at = 0;

    return id;
  } catch (err) {
    console.warn('[KB] writeKBEntry error:', err.message);
    return null;
  }
}

// ─── incrementUsage ───────────────────────────────────────────────────────────
/**
 * เพิ่ม usage_count ของ KB entry ที่ตรงกับ kbId
 */
async function incrementUsage({ sheets, sheetId, kbId } = {}) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'KnowledgeBase!A2:L1000',
    });
    const rows = (res.data && res.data.values) ? res.data.values : [];
    const rowIdx = rows.findIndex(r => r[0] === kbId);
    if (rowIdx === -1) return false;

    const currentCount = parseInt(rows[rowIdx][COL.usage_count] || '0', 10);
    const sheetRow = rowIdx + 2; // +2 เพราะ A2 = index 0, header ที่ row 1

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `KnowledgeBase!L${sheetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[String(currentCount + 1)]] },
    });

    return true;
  } catch (err) {
    console.warn('[KB] incrementUsage error:', err.message);
    return false;
  }
}

// ─── flagKBEntry ──────────────────────────────────────────────────────────────
/**
 * Flag KB entry ว่าข้อมูลผิด — อัพเดต updated_at, confidence, notes
 */
async function flagKBEntry({ sheets, sheetId, kbId, reason } = {}) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'KnowledgeBase!A2:N1000',
    });
    const rows = (res.data && res.data.values) ? res.data.values : [];
    const rowIdx = rows.findIndex(r => r[0] === kbId);
    if (rowIdx === -1) return false;

    const sheetRow = rowIdx + 2;
    const today = new Date().toISOString().split('T')[0];

    // update updated_at (col K = index 10, sheet col K)
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `KnowledgeBase!K${sheetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[today]] },
    });

    // update confidence → 'flagged_wrong' (col M = index 12)
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `KnowledgeBase!M${sheetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [['flagged_wrong']] },
    });

    // update notes (col N = index 13)
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `KnowledgeBase!N${sheetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[reason || '']] },
    });

    return true;
  } catch (err) {
    console.warn('[KB] flagKBEntry error:', err.message);
    return false;
  }
}

// ─── tokenize ────────────────────────────────────────────────────────────────
/**
 * Tokenize text สำหรับ keyword matching
 * รองรับภาษาไทยและ alphanumeric
 */
function tokenize(text) {
  if (!text) return new Set();
  const lower = text.toLowerCase();
  // เก็บเฉพาะอักขระไทย + alphanumeric + spaces
  const cleaned = lower.replace(/[^฀-๿a-z0-9\s]/g, ' ');
  const tokens = cleaned.split(/\s+/).filter(t => t.length >= 2);
  return new Set(tokens);
}

// ─── softMatch (module-level for reuse + debug) ───────────────────────────────
// Min common-substring = 7 to block Thai question-particle suffixes (ได้ไหม = 6
// chars, มั้ยครับ = 7 — but those are never unique enough to score alone).
// 7 ensures the shared fragment is a content word, not a function particle.
// NOTE: short content words like "แอร์" (4 chars) are handled by the includes
// path above, not this loop — so raising to 7 does not break those matches.
function softMatch(a, b) {
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer  = a.length <= b.length ? b : a;
  for (let start = 0; start <= shorter.length - 7; start++) {
    for (let end = start + 7; end <= shorter.length; end++) {
      if (longer.includes(shorter.slice(start, end))) return true;
    }
  }
  return false;
}

// ─── _jaccardScore ────────────────────────────────────────────────────────────
// Jaccard similarity between customer message and a SINGLE pattern chunk (no |).
// Extracted so keywordOverlap can score each chunk independently.
function _jaccardScore(customerMsg, singleChunk) {
  const setA = tokenize(customerMsg);
  const setB = tokenize(singleChunk);
  if (setA.size === 0 || setB.size === 0) return 0;

  const matchedFromA = new Set();
  const matchedFromB = new Set();
  for (const a of setA) {
    for (const b of setB) {
      if (softMatch(a, b)) {
        matchedFromA.add(a);
        matchedFromB.add(b);
      }
    }
  }

  const intersectionSize = Math.min(matchedFromA.size, matchedFromB.size);
  const unionSize = setA.size + setB.size - intersectionSize;
  if (unionSize <= 0) return 0;
  return intersectionSize / unionSize;
}

// ─── keywordOverlap ───────────────────────────────────────────────────────────
/**
 * Score customer message against a KB question pattern.
 * Pattern may contain multiple variants separated by `|`.
 * Scores each variant independently and returns the MAX score.
 *
 * Why per-chunk: Thai messages have no word-boundary spaces → single big token.
 * Merging all | chunks into one token set inflates setB size → Jaccard = 1/N.
 * Per-chunk scoring isolates the best-matching variant → score = up to 1.0.
 *
 * @returns {number} 0-1
 */
function keywordOverlap(customerMsg, kbQuestion) {
  const chunks = kbQuestion.split('|').map(s => s.trim()).filter(Boolean);
  let best = 0;
  for (const chunk of chunks) {
    const s = _jaccardScore(customerMsg, chunk);
    if (s > best) best = s;
  }
  return best;
}

// ─── findBestMatch ────────────────────────────────────────────────────────────
/**
 * ใช้ Claude haiku ตัดสินว่า KB entry ไหน match คำถามลูกค้าดีที่สุด
 */
async function findBestMatch({ apiKey, customerMessage, candidates } = {}) {
  if (!apiKey || !candidates || candidates.length === 0) {
    return { best_match_id: null, confidence: 0 };
  }

  try {
    const top = candidates.slice(0, 3);
    // Format Q variants as "Q1 / Q2 / Q3" (not raw | pattern) — cleaner for the judge model
    const numberedList = top
      .map((c, i) => {
        const variants = c.question_pattern.split('|').map(s => s.trim()).join(' / ');
        return `${i + 1}. [${c.id}]\n   Q variants: ${variants}\n   A: ${c.answer.slice(0, 250)}`;
      })
      .join('\n\n');

    const prompt = `You are a Q&A matcher for a Thai island resort chatbot. Pick the BEST FAQ entry for the customer's message, or null if none applies.

Customer message: "${customerMessage}"

FAQ candidates:
${numberedList}

Rules:
- Choose the entry whose Q variants best match what the customer is asking
- A match is valid even if the answer is indirect (e.g. ownership info answers "is it private?")
- If a Q variant directly contains or paraphrases the customer's question, that entry wins

TOPIC-SPECIFICITY RULES (V71):
- If the customer message mentions a SPECIFIC room type, prefer the entry that matches that room type — even if its raw score is lower. Room types: "Thai Style" / "ไทย" / "Manila" / "มะนิลา" / "Beach Chalet" / "Home Chalet" / "ห้องริมหาด" / "อ่าวมุก" / "อ่าวใหญ่".
- If the customer message mentions a SPECIFIC activity, prefer the entry that matches that activity — even if its raw score is lower. Activities: "Turtle Hero" / "พี่เลี้ยงเต่า" / "Sailing" / "เรือใบ" / "Skindiving" / "ดำน้ำ" / "Oyster Hunting" / "ตกหอย".
- DO NOT pick a Manila entry for a Thai Style query (and vice versa). DO NOT pick a generic entry when a room/activity-specific entry is in the candidate list.

Return null ONLY if NO entry is even tangentially relevant.

Respond ONLY with valid JSON (no explanation, no markdown):
{"best_match_id": "<copy the exact id string from the list above>" or null, "confidence": 0.00}`;

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 250,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 10000,
      }
    );

    const rawText = response.data.content[0].text;
    if (KB_DEBUG) console.log('[KB-DEBUG] Stage 3 judge raw:', rawText);
    // แกะ JSON ออกจาก markdown fence ถ้ามี
    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) return { best_match_id: null, confidence: 0 };

    const parsed = JSON.parse(match[0]);
    const result = {
      best_match_id: parsed.best_match_id || null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    };
    if (KB_DEBUG) console.log(`[KB-DEBUG] Stage 3 decision: ${result.best_match_id} conf=${result.confidence}`);
    return result;
  } catch (err) {
    console.warn('[KB] findBestMatch error:', err.message);
    return { best_match_id: null, confidence: 0 };
  }
}

// ─── lookupKB ─────────────────────────────────────────────────────────────────
/**
 * ค้นหา KB entry ที่ตรงกับคำถามลูกค้าด้วย 3 ขั้นตอน:
 * 1. อ่าน KB (กรอง category ถ้ามี)
 * 2. Score ด้วย keyword overlap → top 3
 * 3. Claude judge → return ถ้า confidence > 0.85
 */
async function lookupKB({ sheets, sheetId, customerMessage, topic, apiKey, today } = {}) {
  if (!sheets || !sheetId || !customerMessage) return null;

  try {
    // Stage 1: อ่าน KB
    let candidates = await readKB({ sheets, sheetId, category: topic });
    if (candidates.length === 0) {
      // fallback: อ่านทั้งหมดโดยไม่กรอง category
      candidates = await readKB({ sheets, sheetId });
    }
    if (candidates.length === 0) return null;

    if (KB_DEBUG) {
      console.log(`[KB-DEBUG] Stage 1 — message: "${customerMessage}"`);
      console.log(`[KB-DEBUG] Stage 1 — total candidates: ${candidates.length}`);
    }

    // Strip Thai particles before scoring — prevents cross-KB bridges via shared
    // sentence-ending substrings (e.g. "เป็นยังไง" matching both weather and food entries).
    // If stripping leaves < 5 content chars, the query is essentially particle-only →
    // no KB entry can give a meaningful answer → fall to AI.
    const strippedMsg = stripParticles(customerMessage);
    const contentLen  = strippedMsg.replace(/\s+/g, '').length;
    if (contentLen < 4) {
      if (KB_DEBUG) console.log(`[KB-DEBUG] Stage 1 skip — stripped "${strippedMsg}" (${contentLen} chars) → fall to AI`);
      return null;
    }
    if (KB_DEBUG && strippedMsg !== customerMessage) {
      console.log(`[KB-DEBUG] Stage 1 stripped: "${customerMessage}" → "${strippedMsg}"`);
    }

    // Stage 2: keyword overlap scoring — use STRIPPED message to prevent particle bridges
    // (judge in Stage 3 still receives original message for full semantic context)
    const withScores = candidates.map(c => {
      const score = keywordOverlap(strippedMsg, c.question_pattern);
      if (KB_DEBUG && score > 0) {
        // Only log non-zero scorers to avoid flooding
        const msgTokens = [...tokenize(strippedMsg)];
        const chunks = c.question_pattern.split('|').map(s => s.trim()).filter(Boolean);
        const bestChunk = chunks.reduce((best, ch) => {
          const s = _jaccardScore(customerMessage, ch);
          return s > best.s ? { s, ch } : best;
        }, { s: 0, ch: '' });
        console.log(`[KB-DEBUG] Stage 2 — ${c.id} score=${score.toFixed(3)} best_chunk="${bestChunk.ch}"`);
        console.log(`[KB-DEBUG]   msg_tokens: [${msgTokens.join(', ')}]`);
      }
      return { ...c, _score: score };
    });

    const allScores = withScores.map(c => `${c.id}=${c._score.toFixed(3)}`).join(' ');
    if (KB_DEBUG) console.log('[KB-DEBUG] Stage 2 — all scores:', allScores);

    const top5 = withScores
      .filter(c => c._score > 0)
      .sort((a, b) => {
        if (b._score !== a._score) return b._score - a._score;
        // Tie-break 1: fewer "|" alternatives = more specific pattern
        const altA = a.question_pattern.split('|').length;
        const altB = b.question_pattern.split('|').length;
        if (altA !== altB) return altA - altB;
        // Tie-break 2: shorter total pattern = more concise/specific
        return a.question_pattern.length - b.question_pattern.length;
      })
      .slice(0, 5);

    if (KB_DEBUG) console.log('[KB-DEBUG] Stage 2 — top5:', top5.map(c => `${c.id}=${c._score.toFixed(3)}`).join(' '));

    const scored = top5.slice(0, 3);
    if (KB_DEBUG) console.log('[KB-DEBUG] Stage 2 — top3 sent to judge:', scored.map(c => c.id).join(', '));
    if (scored.length === 0) return null;

    // Stage 2.5 — bypass Stage 3 when top-1 is unambiguous (saves Haiku call + avoids judge false-negative)
    // Conditions: score ≥ 0.95 AND gap ≥ 0.3 above top-2 (i.e. clear winner, not a tie)
    const top1Score = scored[0]._score;
    const top2Score = scored.length > 1 ? scored[1]._score : 0;
    const isUnambiguous = top1Score >= 0.95 && (top2Score === 0 || top1Score - top2Score >= 0.3);
    if (isUnambiguous) {
      if (KB_DEBUG) console.log(`[KB-DEBUG] Stage 3 bypass — ${scored[0].id} score=${top1Score.toFixed(3)} gap=${(top1Score - top2Score).toFixed(3)}`);
      const entry = scored[0];
      if (entry.volatility === 'volatile') return null;
      if (entry.volatility === 'seasonal' && entry.expires_at && today && entry.expires_at < today) return null;
      // kb_mode override: respect 'hint' mode even in unambiguous early-exit path
      const unambiguousIsHint = entry.kb_mode === 'hint';
      return { ...entry, _confidence: top1Score, ...(unambiguousIsHint ? { _isHint: true } : {}) };
    }

    // Stage 3: Claude judge (disambiguation when multiple candidates have similar scores)
    const judgement = await findBestMatch({ apiKey, customerMessage, candidates: scored });

    if (!judgement.best_match_id || judgement.confidence < 0.65) {
      console.log(`[KB] Stage 3 miss — msg="${customerMessage.slice(0, 40)}" top3=[${scored.map(c => `${c.id}=${c._score.toFixed(2)}`).join(',')}] judge=${JSON.stringify(judgement)}`);
      // If judge returned null (not low-confidence), fall back to tie-break winner when score is high
      // AND when top-1 has a clear gap above top-2 (≥0.3, same as Stage 2.5 bypass).
      // Without the gap check, score-1.00 ties produced arbitrary picks (e.g. #75
      // "กำลังตกลงกันเรื่องวันเดินทาง" → KB-20260505-003 over judge null · probe 2026-06-03).
      if (!judgement.best_match_id && scored[0]._score >= 0.95) {
        const fbTop2 = scored.length > 1 ? scored[1]._score : 0;
        const fbGap = scored[0]._score - fbTop2;
        if (fbGap < 0.3) {
          console.log(`[KB] Stage 3 null → tie-break SKIP (gap=${fbGap.toFixed(3)} < 0.3): respect judge null`);
          return null;
        }
        const fb = scored[0];
        console.log(`[KB] Stage 3 null → tie-break fallback: ${fb.id} score=${fb._score.toFixed(3)} gap=${fbGap.toFixed(3)}`);
        if (fb.volatility === 'volatile') return null;
        if (fb.volatility === 'seasonal' && fb.expires_at && today && fb.expires_at < today) return null;
        // kb_mode override: respect 'hint' mode even in tie-break fallback path
        const fbIsHint = fb.kb_mode === 'hint';
        return { ...fb, _confidence: fb._score, ...(fbIsHint ? { _isHint: true } : {}) };
      }
      return null;
    }

    const matched = scored.find(c => c.id === judgement.best_match_id);
    if (!matched) return null;

    // กรอง volatile entries
    if (matched.volatility === 'volatile') return null;

    // กรอง seasonal ที่หมดอายุ
    if (matched.volatility === 'seasonal' && matched.expires_at && today) {
      if (matched.expires_at < today) return null;
    }

    // ≥0.85 = direct KB answer · 0.65-0.85 = hint (AI uses as context, no verbatim reply)
    // kb_mode override (Sheet col O): entries marked 'hint' always force hint mode regardless of confidence
    const isHint = matched.kb_mode === 'hint' || judgement.confidence < 0.85;
    return { ...matched, _confidence: judgement.confidence, ...(isHint ? { _isHint: true } : {}) };
  } catch (err) {
    console.warn('[KB] lookupKB error:', err.message);
    return null;
  }
}

// ─── classifyAnswer ───────────────────────────────────────────────────────────
/**
 * ใช้ Claude haiku จัดประเภทคำตอบของทีม เพื่อเก็บลง Knowledge Base
 */
async function classifyAnswer({ apiKey, customerQuestion, teamResponse } = {}) {
  if (!apiKey) return null;

  try {
    const prompt = `ทีมงาน Koh Talu Resort ตอบคำถามลูกค้าใน LINE group:

# คำถามจากลูกค้า
"${customerQuestion}"

# คำตอบจากทีม
"${teamResponse}"

# งานของคุณ
จัดประเภทคำตอบนี้สำหรับเก็บใน Knowledge Base:
1. category: location / activity / policy / schedule / pricing / transport / food / room / conservation / other
2. volatility: stable / seasonal / volatile
3. expires_in_days: ถ้า seasonal → 60-180, ถ้า stable → null
4. confidence: 0-1
5. should_save: true/false (volatile → false เสมอ)

Output JSON เท่านั้น:
{"category":"...","volatility":"...","expires_in_days":null,"confidence":0.0,"should_save":true,"normalized_question":"...","reasoning":"..."}`;

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 12000,
      }
    );

    const rawText = response.data.content[0].text;
    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]);

    // Enforce: volatile → should_save = false เสมอ
    if (parsed.volatility === 'volatile') {
      parsed.should_save = false;
    }

    return parsed;
  } catch (err) {
    console.warn('[KB] classifyAnswer error:', err.message);
    return null;
  }
}

// ─── appendKBLearningRow ──────────────────────────────────────────────────────
/**
 * บันทึก learning row ลง KBLearning tab
 * KBLearning cols A:K (11 cols)
 */
async function appendKBLearningRow({
  sheets, sheetId, escalationId, customerQuestion, teamResponse, classification,
} = {}) {
  try {
    const status = (classification && classification.should_save) ? 'pending' : 'rejected';
    const now = new Date().toISOString();

    const row = [
      escalationId          || '',
      customerQuestion      || '',
      teamResponse          || '',
      classification?.category          || '',
      classification?.volatility        || '',
      classification?.expires_in_days   != null ? String(classification.expires_in_days) : '',
      classification?.confidence        != null ? String(classification.confidence) : '',
      status,
      '',  // reviewed_by — ว่างไว้ให้มนุษย์กรอก
      '',  // reviewed_at
      '',  // resulting_kb_id
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'KBLearning!A:K',
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });
  } catch (err) {
    console.warn('[KB] appendKBLearningRow error:', err.message);
  }
}

// ─── openCaptureWindow ────────────────────────────────────────────────────────
/**
 * เปิด capture window สำหรับเก็บ team responses หลัง escalation
 * Idempotent — ถ้ามี window อยู่แล้วจะ return ทันที
 */
function openCaptureWindow({ escalationId, customerQuestion } = {}) {
  if (captureWindows.has(escalationId)) return;

  const win = {
    startAt: Date.now(),
    customerQuestion,
    messages: [],
    hardTimeoutId: null,
    idleTimeoutId: null,
    _closeArgs: null,
  };

  // Hard timeout: ปิดหลัง 10 นาทีไม่ว่าจะเกิดอะไรขึ้น
  win.hardTimeoutId = setTimeout(() => {
    closeCaptureWindow(escalationId, win._closeArgs || {});
  }, CAPTURE_MAX_MS);

  captureWindows.set(escalationId, win);
}

// ─── recordTeamMessage ────────────────────────────────────────────────────────
/**
 * บันทึก message จากทีมงานลง capture window
 * Reset idle timeout ทุกครั้งที่มี message ใหม่
 */
function recordTeamMessage({ escalationId, message, displayName, msgId } = {}) {
  const win = captureWindows.get(escalationId);
  if (!win) return false;

  win.messages.push({
    text: message,
    by: displayName,
    msgId,
    at: Date.now(),
  });

  // Reset idle timeout
  if (win.idleTimeoutId) clearTimeout(win.idleTimeoutId);
  win.idleTimeoutId = setTimeout(() => {
    closeCaptureWindow(escalationId, win._closeArgs || {});
  }, CAPTURE_IDLE_MS);

  return true;
}

// ─── setCaptureCloseArgs ──────────────────────────────────────────────────────
/**
 * Set args ที่จะส่งไปให้ closeCaptureWindow เมื่อ timeout
 */
function setCaptureCloseArgs(escalationId, args) {
  const win = captureWindows.get(escalationId);
  if (!win) return;
  win._closeArgs = args;
}

// ─── closeCaptureWindow ───────────────────────────────────────────────────────
/**
 * ปิด capture window — process messages, classify, เขียน KB ถ้า should_save
 */
async function closeCaptureWindow(escalationId, { sheets, sheetId, apiKey } = {}) {
  const win = captureWindows.get(escalationId);
  if (!win) return;

  // Delete ทันที (ก่อน await) เพื่อป้องกัน race condition
  captureWindows.delete(escalationId);

  // Clear both timeouts
  if (win.hardTimeoutId) clearTimeout(win.hardTimeoutId);
  if (win.idleTimeoutId) clearTimeout(win.idleTimeoutId);

  if (win.messages.length === 0) {
    console.log(`[KB] capture window ${escalationId}: no team response`);
    return;
  }

  if (!sheets || !apiKey) {
    console.warn(`[KB] closeCaptureWindow ${escalationId}: missing sheets/apiKey, cannot process`);
    return;
  }

  // รวม messages เป็น string เดียว
  const teamResponse = win.messages
    .map(m => `${m.by}: ${m.text}`)
    .join('\n');

  // Classify คำตอบของทีม
  const classification = await classifyAnswer({
    apiKey,
    customerQuestion: win.customerQuestion,
    teamResponse,
  });

  // บันทึก learning row เสมอ (ไม่ว่า should_save จะเป็น true/false)
  await appendKBLearningRow({
    sheets, sheetId,
    escalationId,
    customerQuestion: win.customerQuestion,
    teamResponse,
    classification,
  });

  // บันทึก KB entry ถ้า should_save && confidence สูงพอ
  if (classification && classification.should_save && classification.confidence > 0.7) {
    const today = new Date().toISOString().split('T')[0];
    let expires_at = '';
    if (classification.volatility === 'seasonal' && classification.expires_in_days) {
      const expDate = new Date();
      expDate.setDate(expDate.getDate() + classification.expires_in_days);
      expires_at = expDate.toISOString().split('T')[0];
    }

    await writeKBEntry({
      sheets,
      sheetId,
      entry: {
        question_pattern: classification.normalized_question || win.customerQuestion,
        answer: teamResponse,
        category: classification.category || 'other',
        volatility: classification.volatility || 'stable',
        expires_at,
        confidence: 'pending',
        notes: `auto-captured from escalation ${escalationId}`,
      },
    });
  }
}

// ─── _resetCache (test helper) ────────────────────────────────────────────────
function _resetCache() {
  kbCacheStore = { data: [], at: 0 };
}

// ─── getKBCacheStats ──────────────────────────────────────────────────────────
function getKBCacheStats() {
  return {
    kbEntries: kbCacheStore.data.length,
    kbCacheAgeSec: kbCacheStore.at ? Math.floor((Date.now() - kbCacheStore.at) / 1000) : null,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  readKB,
  writeKBEntry,
  incrementUsage,
  flagKBEntry,
  tokenize,
  _jaccardScore,
  keywordOverlap,
  findBestMatch,
  lookupKB,
  classifyAnswer,
  appendKBLearningRow,
  openCaptureWindow,
  recordTeamMessage,
  setCaptureCloseArgs,
  closeCaptureWindow,
  captureWindows,
  CAPTURE_IDLE_MS,
  _resetCache,
  getKBCacheStats,
};
