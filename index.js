// ---------------- POLYFILLS (Fix Node 16 fetch error) ----------------
globalThis.fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const OpenAI = require('openai');
const textToSpeech = require('@google-cloud/text-to-speech');
const fs = require('fs');
const util = require('util');
const WebSocket = require('ws'); // Realtime WebSocket
const http = require('http');

// ---------------- EXPRESS APP ----------------
const app = express();
const server = http.createServer(app);
app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// health check
app.get('/healthz', (req, res) => res.send({ ok: true }));

const PORT = process.env.PORT || 3000;

// ---------------- CLIENTS ----------------
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  fetch: (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args))
});

// -------------------- REST endpoints (unchanged) --------------------
app.post('/api/call', async (req, res) => {
  try {
    let { phone } = req.body;
    if (!phone) return res.status(400).send({ error: 'Phone number required' });

    if (!phone.startsWith('+')) phone = '+91' + phone;

    const call = await client.calls.create({
      to: phone,
      from: process.env.TWILIO_NUMBER,
      url: 'https://demo.twilio.com/welcome/voice/'
    });

    res.send({ success: true, callSid: call.sid });
  } catch (err) {
    console.error('/api/call error', err);
    res.status(500).send({ error: err.message });
  }
});

app.post('/api/end-call', async (req, res) => {
  try {
    const { callSid } = req.body;
    if (!callSid) return res.status(400).send({ error: 'Call SID required' });

    const call = await client.calls(callSid).update({ status: 'completed' });
    res.send({ success: true, call });
  } catch (err) {
    console.error('/api/end-call error', err);
    res.status(500).send({ error: err.message });
  }
});

app.post('/api/voice', (req, res) => {
  try {
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const twiml = new VoiceResponse();

    let toParam = req.body.To || '';
    const outgoingCallerId = process.env.TWILIO_NUMBER;

    if (toParam && !toParam.startsWith('client:')) {
      toParam = `client:${toParam}`;
    }

    if (toParam.toLowerCase().startsWith('client:')) {
      const identity = toParam.split(':')[1];
      const dial = twiml.dial();
      dial.client(identity);
    } else {
      const toNumber = process.env.TARGET_NUMBER || process.env.TWILIO_NUMBER;
      const dial = twiml.dial({ callerId: outgoingCallerId });
      dial.number(toNumber);
    }

    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('/api/voice error', err);
    res.status(500).send({ error: 'voice endpoint failed' });
  }
});

app.get('/api/token', (req, res) => {
  try {
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    let identity = req.query.identity || 'unknown';
    if (identity === 'unknown') identity = 'web-' + Math.floor(Math.random() * 100000);

    const token = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_API_KEY_SID,
      process.env.TWILIO_API_KEY_SECRET,
      { identity }
    );

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: process.env.TWIML_APP_SID,
      incomingAllow: true
    });

    token.addGrant(voiceGrant);

    res.send({
      token: token.toJwt(),
      identity,
      incomingAllowed: true
    });
  } catch (err) {
    console.error('/api/token error', err);
    res.status(500).send({ error: err.message });
  }
});

app.get('/api/config', (req, res) => {
  res.send({
    twilioNumber: process.env.TWILIO_NUMBER || null,
    targetNumber: process.env.TARGET_NUMBER || null
  });
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).send({ error: 'Message required' });

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: message }],
    });

    res.send({ reply: response.choices[0].message.content });
  } catch (err) {
    console.error('/api/chat error', err);
    res.status(500).send({ error: err.message });
  }
});

app.post("/api/ttss", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || text.trim() === "") {
      return res.status(400).send({ error: "Text required" });
    }

    const response = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "ballad",
      input: text
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(buffer);
  } catch (err) {
    console.error('/api/ttss error', err);
    res.status(500).send({ error: "TTS failed" });
  }
});

// ===================================================================
// Realtime WebSocket proxy — attach to the same server at "/realtime"
// ===================================================================
const REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

// Create WS server attached to same HTTP server and targeted path
const realtimeServer = new WebSocket.Server({ noServer: true }); // use manual upgrade so we can log

// log upgrade requests and delegate to ws only when URL matches
server.on('upgrade', (req, socket, head) => {
  try {
    console.log('[WS Upgrade] incoming upgrade:', req.url);
    console.log('[WS Upgrade] headers:', {
      host: req.headers.host,
      upgrade: req.headers.upgrade,
      connection: req.headers.connection,
      origin: req.headers.origin
    });
  } catch (e) { console.warn('[WS Upgrade] logging failed', e); }

  // only accept the specific path
  if (req.url && req.url.startsWith('/realtime')) {
    realtimeServer.handleUpgrade(req, socket, head, (ws) => {
      realtimeServer.emit('connection', ws, req);
    });
  } else {
    // not our path — close socket politely
    try {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    } catch (e) { /* ignore */ }
  }
});

// attach handlers
realtimeServer.on('connection', (clientWs, req) => {
  console.log(`[proxy] Frontend connected (remote=${req.socket.remoteAddress}) path=${req.url}`);

  let openaiWS = null;
  let openaiReady = false;
  const outboundQueue = [];
  let closed = false;

  function cleanup() {
    closed = true;
    try { if (clientWs && clientWs.readyState === WebSocket.OPEN) clientWs.close(); } catch (e) {}
    try { if (openaiWS && openaiWS.readyState === WebSocket.OPEN) openaiWS.close(); } catch (e) {}
  }

  clientWs.on('error', (err) => {
    console.error('[proxy] clientWs error:', err && err.message ? err.message : err);
  });

  clientWs.on('close', (code, reason) => {
    console.log('[proxy] clientWs closed', { code, reason: reason ? reason.toString() : ''});
    cleanup();
  });

  // Create OpenAI WS for this client
  try {
    openaiWS = new WebSocket(REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });
  } catch (err) {
    console.error('[proxy] Failed to create OpenAI WS', err);
    try { clientWs.send(JSON.stringify({ error: 'Failed to connect to OpenAI realtime' })); } catch(e){}
    cleanup(); return;
  }

  openaiWS.on('open', () => {
    console.log('[proxy] OpenAI realtime WS connected for client');
    openaiReady = true;

    // initial session.update (customize as needed)
    const initial = {
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice: "verse",
        instructions: `You are a strict domain-limited voice assistant.`
      }
    };

    try { openaiWS.send(JSON.stringify(initial)); } catch (e) { console.warn('[proxy] send initial failed', e); }

    // flush queued frames
    while (outboundQueue.length > 0) {
      const item = outboundQueue.shift();
      if (!item) continue;
      try {
        if (openaiWS.readyState === WebSocket.OPEN) openaiWS.send(item);
      } catch (err) {
        console.warn('[proxy] error flushing queue', err);
      }
    }
  });

  openaiWS.on('error', (err) => {
    console.error('[proxy] OpenAI WS error:', err && err.message ? err.message : err);
    try { if (clientWs && clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify({ type: 'error', message: 'OpenAI WS error'})); } catch(e){}
  });

  openaiWS.on('close', (code, reason) => {
    console.log('[proxy] OpenAI WS closed', { code, reason: reason ? reason.toString() : '' });
    openaiReady = false;
    try { if (clientWs && clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify({ type: 'openai.closed', code, reason: reason ? reason.toString() : '' })); } catch(e){}
  });

  openaiWS.on('message', (data, isBinary) => {
    if (closed) return;
    try {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
    } catch (err) {
      console.error('[proxy] error forwarding OpenAI->client', err);
    }
  });

  clientWs.on('message', async (data, isBinary) => {
    if (closed) return;
    try {
      if (isBinary || data instanceof Buffer || data instanceof ArrayBuffer) {
        // convert to Buffer
        let buf;
        if (data instanceof ArrayBuffer) buf = Buffer.from(data);
        else if (Buffer.isBuffer(data)) buf = data;
        else buf = Buffer.from(data);

        const b64 = buf.toString('base64');
        const appendEvent = JSON.stringify({ type: "input_audio_buffer.append", audio: b64 });

        if (openaiReady && openaiWS && openaiWS.readyState === WebSocket.OPEN) {
          openaiWS.send(appendEvent);
        } else {
          if (outboundQueue.length > 2000) outboundQueue.shift();
          outboundQueue.push(appendEvent);
        }
        return;
      }

      // string control messages
      if (typeof data === 'string') {
        if (openaiReady && openaiWS && openaiWS.readyState === WebSocket.OPEN) {
          openaiWS.send(data);
        } else {
          if (outboundQueue.length > 2000) outboundQueue.shift();
          outboundQueue.push(data);
        }
      }
    } catch (err) {
      console.error('[proxy] failed to forward client->OpenAI', err);
    }
  });

}); // realtimeServer.on('connection')

realtimeServer.on('error', (err) => {
  console.error('[realtimeServer] error:', err && err.message ? err.message : err);
});

// ===================================================================
// START EXPRESS+WS SERVER (one listener)
// ===================================================================
server.listen(PORT, "0.0.0.0", () => {
  console.log("Server + Realtime WS at /realtime running on PORT " + PORT);
});
