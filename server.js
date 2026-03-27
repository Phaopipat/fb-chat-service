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
                                                  requests: [{
                                                                  addSheet: { properties: { title: 'FB-Messages' } }
                                                  }]
                                    }
                        });
                        await sheets.spreadsheets.values.append({
                                    spreadsheetId: SHEET_ID,
                                    range: 'FB-Messages!A1',
                                    valueInputOption: 'RAW',
                                    requestBody: {
                                                  values: [['Timestamp', 'SenderName', 'SenderId', 'SenderRole', 'Message', 'Sentiment', 'Topic', 'Summary', 'Priority', 'ConversationId']]
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
                        range: 'FB-Messages!A:J',
                        valueInputOption: 'RAW',
                        requestBody: {
                                    values: [[
                                                  data.timestamp,
                                                  data.senderName,
                                                  data.senderId,
                                                  data.senderRole || '',
                                                  data.message,
                                                  data.sentiment || '',
                                                  data.topic || '',
                                                  data.summary || '',
                                                  data.priority || '',
                                                  data.conversationId || ''
                                                ]]
                        }
              });
              console.log(`✅ Saved to sheet: ${data.senderName}: ${data.message.substring(0, 50)}`);
      } catch (err) {
              console.error('Sheet save error:', err.message);
      }
}

// —— CLAUDE ANALYSIS ————————————————————————————————
async function analyzeWithClaude(message, senderName) {
      if (!CLAUDE_API_KEY) return {};
      try {
              const res = await axios.post('https://api.anthropic.com/v1/messages', {
                        model: 'claude-haiku-4-5-20251001',
                        max_tokens: 200,
                        messages: [{
                                    role: 'user',
                                    content: `วิเคราะห์ข้อความนี้จากลูกค้าชื่อ ${senderName}:
                                    "${message}"

                                    ตอบเป็น JSON เท่านั้น ไม่ต้องมีข้อความอื่น:
                                    {
                                      "sentiment": "positive/neutral/negative",
                                        "topic": "จอง/สอบถาม/ร้องเรียน/ขอบคุณ/อื่นๆ",
                                          "summary": "สรุปสั้นๆ ภาษาไทย 1 ประโยค",
                                            "priority": "high/medium/low"
                                            }`
                        }]
              }, {
                        headers: {
                                    'x-api-key': CLAUDE_API_KEY,
                                    'anthropic-version': '2023-06-01',
                                    'content-type': 'application/json'
                        }
              });
              const text = res.data.content[0].text;
              const jsonMatch = text.match(/\{[\s\S]*\}/);
              if (jsonMatch) return JSON.parse(jsonMatch[0]);
              return {};
      } catch (err) {
              console.error('Claude error:', err.message);
              return {};
      }
}

// —— FACEBOOK GRAPH API POLLING ————————————————————
let lastPollTime = null;
const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes
const processedMessageIds = new Set();

async function getPageId() {
      try {
              const res = await axios.get(`https://graph.facebook.com/v19.0/me?access_token=${PAGE_ACCESS_TOKEN}`);
              return res.data.id;
      } catch (err) {
              console.error('❌ Failed to get Page ID:', err.response?.data?.error?.message || err.message);
              return null;
      }
}

async function fetchConversations(pageId) {
      try {
              const url = `https://graph.facebook.com/v19.0/${pageId}/conversations?fields=id,participants,updated_time,messages.limit(10){message,from,created_time,id}&access_token=${PAGE_ACCESS_TOKEN}`;
              const res = await axios.get(url);
              return res.data.data || [];
      } catch (err) {
              const fbErr = err.response?.data?.error;
              if (fbErr) {
                        console.error(`❌ FB API error: ${fbErr.message} (code: ${fbErr.code}, subcode: ${fbErr.error_subcode})`);
                        if (fbErr.code === 10 || fbErr.error_subcode === 2018218) {
                                    console.warn('⚠️  pages_messaging permission not approved — trying alternative endpoint...');
                                    return await fetchConversationsAlt(pageId);
                        }
              } else {
                        console.error('❌ Fetch conversations error:', err.message);
              }
              return [];
      }
}

// Alternative: try feed/comments if conversations API is blocked
async function fetchConversationsAlt(pageId) {
      try {
              console.log('📡 Trying Page feed (posts + comments) instead...');
              const url = `https://graph.facebook.com/v19.0/${pageId}/feed?fields=id,message,from,created_time,comments.limit(20){message,from,created_time,id}&limit=10&access_token=${PAGE_ACCESS_TOKEN}`;
              const res = await axios.get(url);
              const posts = res.data.data || [];
              const results = [];
              for (const post of posts) {
                        if (post.comments && post.comments.data) {
                                    for (const comment of post.comments.data) {
                                                  results.push({
                                                                  id: comment.id,
                                                                  message: comment.message,
                                                                  from: comment.from,
                                                                  created_time: comment.created_time,
                                                                  source: 'comment',
                                                                  postId: post.id
                                                  });
                                    }
                        }
              }
              console.log(`📋 Found ${results.length} comments from feed`);
              return results;
      } catch (err) {
              console.error('❌ Feed fallback error:', err.response?.data?.error?.message || err.message);
              return [];
      }
}

async function pollFacebookMessages() {
      if (!PAGE_ACCESS_TOKEN) {
              console.warn('⚠️  FB_PAGE_ACCESS_TOKEN not set — skipping poll');
              return;
      }

  console.log(`\n📡 Polling Facebook messages... [${new Date().toISOString()}]`);

  const pageId = await getPageId();
      if (!pageId) return;
      console.log(`📄 Page ID: ${pageId}`);

  const conversations = await fetchConversations(pageId);

  if (conversations.length === 0) {
          console.log('📭 No conversations found');
          return;
  }

  let newCount = 0;

  for (const conv of conversations) {
          // Handle conversations API format
        if (conv.messages && conv.messages.data) {
                  for (const msg of conv.messages.data) {
                              if (processedMessageIds.has(msg.id)) continue;

                    const isPage = msg.from.id === pageId;
                              const senderRole = isPage ? 'page' : 'customer';

                    processedMessageIds.add(msg.id);

                    // Only analyze customer messages (skip sentiment for admin replies)
                    const analysis = isPage ? {} : await analyzeWithClaude(msg.message || '', msg.from.name || 'Unknown');

                    await saveToSheets({
                                  timestamp: msg.created_time,
                                  senderName: msg.from.name || 'Unknown',
                                  senderId: msg.from.id,
                                  senderRole,
                                  message: msg.message || '',
                                  conversationId: conv.id,
                                  ...analysis
                    });
                              newCount++;
                  }
        }

        // Handle feed/comments fallback format
        if (conv.source === 'comment') {
                  if (processedMessageIds.has(conv.id)) continue;
                  processedMessageIds.add(conv.id);

            const analysis = await analyzeWithClaude(conv.message || '', conv.from?.name || 'Unknown');
                  await saveToSheets({
                              timestamp: conv.created_time,
                              senderName: conv.from?.name || 'Unknown',
                              senderId: conv.from?.id || '',
                              senderRole: 'comment',
                              message: conv.message || '',
                              conversationId: conv.postId || '',
                              ...analysis
                  });
                  newCount++;
        }
  }

  console.log(`✅ Poll complete: ${newCount} new messages saved`);
      lastPollTime = new Date().toISOString();
}

// —— WEBHOOK VERIFY (Facebook) ———————————————————
app.get('/webhook', (req, res) => {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];

          if (mode === 'subscribe' && token === VERIFY_TOKEN) {
                  console.log('✅ Webhook verified');
                  res.status(200).send(challenge);
          } else {
                  res.sendStatus(403);
          }
});

// —— WEBHOOK RECEIVE (for future use when approved) ——
app.post('/webhook', async (req, res) => {
      res.sendStatus(200);

           const body = req.body;
      if (body.object !== 'page') return;

           for (const entry of body.entry || []) {
                   for (const event of entry.messaging || []) {
                             if (!event.message || event.message.is_echo) continue;

                     const senderId = event.sender.id;
                             const messageText = event.message.text;
                             if (!messageText) continue;

                     console.log(`💬 Webhook: ${senderId}: ${messageText}`);

                     let senderName = 'Unknown';
                             try {
                                         const profileRes = await axios.get(`https://graph.facebook.com/v19.0/${senderId}?fields=name&access_token=${PAGE_ACCESS_TOKEN}`);
                                         senderName = profileRes.data.name || 'Unknown';
                             } catch (e) { /* ignore */ }

                     const analysis = await analyzeWithClaude(messageText, senderName);

                     await saveToSheets({
                                 timestamp: new Date().toISOString(),
                                 senderName,
                                 senderId,
                                 senderRole: 'customer',
                                 message: messageText,
                                 conversationId: '',
                                 ...analysis
                     });
                   }
           }
});

// —— MANUAL POLL ENDPOINT ————————————————————————
app.get('/poll', async (req, res) => {
      try {
              await pollFacebookMessages();
              res.json({ status: 'ok', lastPoll: lastPollTime, cachedMessages: processedMessageIds.size });
      } catch (err) {
              res.status(500).json({ error: err.message });
      }
});

// —— HEALTH CHECK ————————————————————————————————
app.get('/', (req, res) => {
      res.json({
              status: 'ok',
              service: 'KohTalu FB Chat Logger',
              mode: 'Graph API Polling + Webhook',
              lastPoll: lastPollTime,
              cachedMessages: processedMessageIds.size,
              time: new Date().toISOString()
      });
});

// —— START SERVER ————————————————————————————————
app.listen(PORT, async () => {
      console.log(`🚀 KohTalu FB Chat Logger running on port ${PORT}`);

             const envStatus = {
                     FB_VERIFY_TOKEN: VERIFY_TOKEN ? '✅ set' : '⚠️  not set',
                     FB_PAGE_ACCESS_TOKEN: PAGE_ACCESS_TOKEN ? '✅ set' : '❌ not set',
                     ANTHROPIC_API_KEY: CLAUDE_API_KEY ? '✅ set' : '⚠️  not set',
                     GOOGLE_SHEET_ID: SHEET_ID ? '✅ set' : '❌ not set',
                     GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccountCreds ? '✅ valid' : '❌ invalid or not set',
             };
      console.log('—— Environment Check ——');
      for (const [key, status] of Object.entries(envStatus)) {
              console.log(`  ${key}: ${status}`);
      }
      console.log('————————————————————————');

             if (SHEET_ID && serviceAccountCreds) {
                     await initSheet();
                     console.log('📊 Google Sheet connected');
             }

             // Start polling immediately, then every 5 minutes
             if (PAGE_ACCESS_TOKEN) {
                     console.log('📡 Starting Facebook Graph API polling (every 5 min)...');
                     await pollFacebookMessages();
                     setInterval(pollFacebookMessages, POLL_INTERVAL);
             } else {
                     console.warn('⚠️  No PAGE_ACCESS_TOKEN — polling disabled, webhook-only mode');
             }
});
