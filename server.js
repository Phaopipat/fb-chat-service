const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// ─── ENV VARIABLES ───────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');

// ─── GOOGLE SHEETS SETUP ─────────────────────────────────────
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: GOOGLE_SERVICE_ACCOUNT,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// ─── CLAUDE ANALYSIS ─────────────────────────────────────────
async function analyzeWithClaude(message, senderName) {
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `วิเคราะห์ข้อความนี้จากลูกค้าของรีสอร์ทเกาะทะลุ:
"${message}"

ตอบเป็น JSON เท่านั้น ไม่ต้องมีข้อความอื่น:
{
  "sentiment": "positive/neutral/negative",
  "topic": "จอง/สอบถาม/ร้องเรียน/ขอบคุณ/อื่นๆ",
  "summary": "สรุปสั้นๆ ภาษาไทย 1 ประโยค",
  "priority": "high/medium/low"
}`
        }]
      },
      {
        headers: {
          'x-api-key': CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        }
      }
    );

    const text = response.data.content[0].text.trim();
    return JSON.parse(text);
  } catch (err) {
    console.error('Claude error:', err.message);
    return {
      sentiment: 'neutral',
      topic: 'อื่นๆ',
      summary: message.substring(0, 50),
      priority: 'low'
    };
  }
}

// ─── SAVE TO GOOGLE SHEETS ────────────────────────────────────
async function saveToSheets(data) {
  try {
    const sheets = await getSheetsClient();
    const now = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:H',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          now,
          data.senderId,
          data.senderName || 'Unknown',
          data.message,
          data.sentiment,
          data.topic,
          data.summary,
          data.priority
        ]]
      }
    });
    console.log('✅ Saved to Sheets:', data.senderName, '-', data.topic);
  } catch (err) {
    console.error('Sheets error:', err.message);
  }
}

// ─── GET SENDER NAME ──────────────────────────────────────────
async function getSenderName(senderId) {
  try {
    const res = await axios.get(
      `https://graph.facebook.com/v19.0/${senderId}`,
      { params: { fields: 'name', access_token: PAGE_ACCESS_TOKEN } }
    );
    return res.data.name || 'Unknown';
  } catch {
    return 'Unknown';
  }
}

// ─── WEBHOOK VERIFY ───────────────────────────────────────────
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

// ─── WEBHOOK RECEIVE ──────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // ตอบ Meta ก่อนเสมอ

  const body = req.body;
  if (body.object !== 'page') return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      if (!event.message || event.message.is_echo) continue;

      const senderId = event.sender.id;
      const messageText = event.message.text;
      if (!messageText) continue;

      console.log(`📨 New message from ${senderId}: ${messageText}`);

      // ดึงชื่อ + วิเคราะห์พร้อมกัน
      const [senderName, analysis] = await Promise.all([
        getSenderName(senderId),
        analyzeWithClaude(messageText, senderId)
      ]);

      // บันทึกลง Google Sheets
      await saveToSheets({
        senderId,
        senderName,
        message: messageText,
        ...analysis
      });
    }
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'KohTalu FB Chat Logger', time: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
