const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// —— ENV VARIABLES ——————————————————————————————————
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}';

// —— SERVICE ACCOUNT PARSER (with Railway double-escape fix) ————
function parseServiceAccount(raw) {
    if (!raw || raw === '{}') {
          console.error('❌ GOOGLE_SERVICE_ACCOUNT_JSON is empty or not set');
          return null;
    }
    try {
          const fixed = raw.replace(/\\\\n/g, '\\n');
          const creds = JSON.parse(fixed);
          if (!creds.client_email) {
                  console.error('❌ Service Account JSON is missing client_email');
                  return null;
          }
          if (!creds.private_key) {
                  console.error('❌ Service Account JSON is missing private_key');
                  return null;
          }
          console.log(`✅ Service Account loaded: ${creds.client_email}`);
          return creds;
    } catch (err) {
          console.error('❌ Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON:', err.message);
          return null;
    }
}

const serviceAccountCreds = parseServiceAccount(GOOGLE_SERVICE_ACCOUNT_JSON);

// —— GOOGLE SHEETS SETUP ————————————————————————————
let sheetsClient = null;

async function getSheetsClient() {
    if (sheetsClient) return sheetsClient;
    if (!serviceAccountCreds) return null;
    const auth = new google.auth.GoogleAuth({
          credentials: serviceAccountCreds,
          scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheetsClient = google.sheets({ version: 'v4', auth });
    return sheetsClient;
}

async function initSheet() {
    const sheets = await getSheetsClient();
    if (!sheets) return;
    try {
          const res = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
          const sheetNames = res.data.sheets.map(s => s.properties.title);
          if (!sheetNames.includes('FB-Messages')) {
                  await sheets.spreadsheets.batchUpdate({
                            spreadsheetId: SHEET_ID,
                            requestBody: {
                                        requests: [{ addSheet: { properties: { title: 'FB-Messages' } } }]
                            }
                  });
                  await sheets.spreadsheets.values.append({
                            spreadsheetId: SHEET_ID,
                            range: 'FB-Messages!A1',
                            valueInputOption: 'RAW',
                            requestBody: {
                                        values: [['Timestamp', 'SenderName', 'SenderId', 'Message', 'Sentiment', 'Topic', 'Summary', 'Priority', 'ConversationId']]
                            }
                  });
                  console.log('📋 Created FB-Messages sheet with headers');
          }
    } catch (err) {
          console.error('Sheet init error:', err.message);
    }
}

async function saveToSheets(data) {
    const sheets = await getSheetsClient();
    if (!sheets || !SHEET_ID) return;
    try {
          await sheets.spreadsheets.values.append({
                  spreadsheetId: SHEET_ID,
                  range: 'FB-Messages!A:I',
                  valueInputOption: 'RAW',
                  requestBody: {
                            values: [[data.timestamp, data.senderName, data.senderId, data.message, data.sentiment || '', data.topic || '', data.summary || '', data.priority || '', data.conversationId || '']]
                  }
          });
          console.log(`✅ Saved: ${data.senderName}: ${data.message.substring(0, 50)}`);
    } catch (err) {
          console.error('Sheet save error:', err.message);
    }
}

// —— CLAUDE ANALYSIS ————————————————————————————————
async function analyzeWithClaude(message, senderName) {
    if (!CLAUDE_API_KEY) return {};
    try {
          const res = await axios.post('https://api.anthropic.com/v1/messages', {
                  model: 'claude-sonnet-4-20250514',
                  max_tokens: 200,
                  messages: [{ role: 'user', content: `วิเคราะห์ข้อความจากลูกค้า ${senderName}: "${message}"\nตอบ JSON: {"sentiment":"positive/neutral/negative","topic":"จอง/สอบถาม/ร้องเรียน/ขอบคุณ/อื่นๆ","summary":"สรุปสั้นๆ","priority":"high/medium/low"}` }]
          }, { headers: { 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
          const text = res.data.content[0].text;
          const m = text.match(/\{[\s\S]*\}/);
          return m ? JSON.parse(m[0]) : {};
    } catch (err) {
          console.error('Claude error:', err.message);
          return {};
    }
}

// —— FACEBOOK GRAPH API POLLING ————————————————————
let lastPollTime = null;
const POLL_INTERVAL = 5 * 60 * 1000;
const processedIds = new Set();

async function getPageId() {
    try {
          const res = await axios.get(`https://graph.facebook.com/v19.0/me?access_token=${PAGE_ACCESS_TOKEN}`);
          return res.data.id;
    } catch (err) {
          console.error('❌ Page ID error:', err.response?.data?.error?.message || err.message);
          return null;
    }
}

async function fetchConversations(pageId) {
    try {
          const url = `https://graph.facebook.com/v19.0/${pageId}/conversations?fields=id,participants,messages.limit(10){message,from,created_time,id}&access_token=${PAGE_ACCESS_TOKEN}`;
          const res = await axios.get(url);
          return res.data.data || [];
    } catch (err) {
          const fbErr = err.response?.data?.error;
          if (fbErr) {
                  console.error(`❌ FB API: ${fbErr.message} (code:${fbErr.code})`);
                  if (fbErr.code === 10 || fbErr.error_subcode === 2018218) {
                            console.warn('⚠️ pages_messaging not approved — trying feed...');
                            return await fetchFeed(pageId);
                  }
          } else {
                  console.error('❌ Conversations error:', err.message);
          }
          return [];
    }
}

async function fetchFeed(pageId) {
    try {
          console.log('📡 Trying Page feed (posts + comments)...');
          const url = `https://graph.facebook.com/v19.0/${pageId}/feed?fields=id,message,from,created_time,comments.limit(20){message,from,created_time,id}&limit=10&access_token=${PAGE_ACCESS_TOKEN}`;
          const res = await axios.get(url);
          const posts = res.data.data || [];
          const results = [];
          for (const post of posts) {
                  if (post.comments && post.comments.data) {
                            for (const c of post.comments.data) {
                                        results.push({ id: c.id, message: c.message, from: c.from, created_time: c.created_time, source: 'comment', postId: post.id });
                            }
                  }
          }
          console.log(`📋 Found ${results.length} comments`);
          return results;
    } catch (err) {
          console.error('❌ Feed error:', err.response?.data?.error?.message || err.message);
          return [];
    }
}

async function pollFacebook() {
    if (!PAGE_ACCESS_TOKEN) { console.warn('⚠️ No token — skip poll'); return; }
    console.log(`\n📡 Polling Facebook... [${new Date().toISOString()}]`);
    const pageId = await getPageId();
    if (!pageId) return;
    console.log(`📄 Page: ${pageId}`);
    const convs = await fetchConversations(pageId);
    if (!convs.length) { console.log('📭 No data'); return; }
    let n = 0;
    for (const c of convs) {
          if (c.messages && c.messages.data) {
                  for (const m of c.messages.data) {
                            if (processedIds.has(m.id) || m.from.id === pageId) continue;
                            processedIds.add(m.id);
                            const a = await analyzeWithClaude(m.message || '', m.from.name || 'Unknown');
                            await saveToSheets({ timestamp: m.created_time, senderName: m.from.name || 'Unknown', senderId: m.from.id, message: m.message || '', conversationId: c.id, ...a });
                            n++;
                  }
          }
          if (c.source === 'comment') {
                  if (processedIds.has(c.id)) continue;
                  processedIds.add(c.id);
                  const a = await analyzeWithClaude(c.message || '', c.from?.name || 'Unknown');
                  await saveToSheets({ timestamp: c.created_time, senderName: c.from?.name || 'Unknown', senderId: c.from?.id || '', message: c.message || '', conversationId: c.postId || '', ...a });
                  n++;
          }
    }
    console.log(`✅ Poll done: ${n} new messages`);
    lastPollTime = new Date().toISOString();
}

// —— WEBHOOK (Facebook) ———————————————————————————
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) { console.log('✅ Webhook verified'); res.status(200).send(challenge); }
    else { res.sendStatus(403); }
});

app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const body = req.body;
    if (body.object !== 'page') return;
    for (const entry of body.entry || []) {
          for (const event of entry.messaging || []) {
                  if (!event.message || event.message.is_echo) continue;
                  const senderId = event.sender.id;
                  const text = event.message.text;
                  if (!text) continue;
                  let name = 'Unknown';
                  try { const r = await axios.get(`https://graph.facebook.com/v19.0/${senderId}?fields=name&access_token=${PAGE_ACCESS_TOKEN}`); name = r.data.name || 'Unknown'; } catch(e) {}
                  const a = await analyzeWithClaude(text, name);
                  await saveToSheets({ timestamp: new Date().toISOString(), senderName: name, senderId, message: text, conversationId: '', ...a });
          }
    }
});

app.get('/poll', async (req, res) => {
    try { await pollFacebook(); res.json({ status: 'ok', lastPoll: lastPollTime, cached: processedIds.size }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'KohTalu FB Chat Logger', mode: 'Graph API Polling + Webhook', lastPoll: lastPollTime, cached: processedIds.size, time: new Date().toISOString() });
});

// —— START ————————————————————————————————————————
app.listen(PORT, async () => {
    console.log(`🚀 KohTalu FB Chat Logger on port ${PORT}`);
    const env = { FB_VERIFY_TOKEN: VERIFY_TOKEN ? '✅' : '⚠️', FB_PAGE_ACCESS_TOKEN: PAGE_ACCESS_TOKEN ? '✅' : '❌', ANTHROPIC_API_KEY: CLAUDE_API_KEY ? '✅' : '⚠️', GOOGLE_SHEET_ID: SHEET_ID ? '✅' : '❌', GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccountCreds ? '✅' : '❌' };
    console.log('—— Env Check ——');
    for (const [k, v] of Object.entries(env)) console.log(`  ${k}: ${v}`);
    console.log('————————————————');
    if (SHEET_ID && serviceAccountCreds) { await initSheet(); console.log('📊 Sheet connected'); }
    if (PAGE_ACCESS_TOKEN) { console.log('📡 Starting poll (every 5 min)...'); await pollFacebook(); setInterval(pollFacebook, POLL_INTERVAL); }
    else { console.warn('⚠️ No token — webhook-only mode'); }
});
