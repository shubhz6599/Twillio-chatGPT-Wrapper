// ----------- GLOBAL WEB API POLYFILLS FOR NODE 16 -----------
// ---------------- POLYFILLS FOR NODE 16 ----------------
(async () => {
  const nf = await import("node-fetch");
  globalThis.fetch = (...args) => nf.default(...args);
  globalThis.Headers = nf.Headers;
  globalThis.Request = nf.Request;
  globalThis.Response = nf.Response;

  const formdata = await import("formdata-node");
  globalThis.FormData = formdata.FormData;
  globalThis.File = formdata.File;
  globalThis.Blob = formdata.Blob;
})();



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

// ---------------- EXPRESS APP ----------------
const app = express();
const server = require('http').createServer(app);

app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  fetch: (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args))
});

// -------------------- Your existing REST endpoints --------------------
// (kept as you provided them - unchanged)
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
    console.error(err);
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
    console.error(err);
    res.status(500).send({ error: err.message });
  }
});

app.post('/api/voice', (req, res) => {
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
    console.log(`Dialing client: ${identity}`);
  } else {
    const toNumber = process.env.TARGET_NUMBER || process.env.TWILIO_NUMBER;
    const dial = twiml.dial({ callerId: outgoingCallerId });
    dial.number(toNumber);
    console.log(`Dialing number: ${toNumber}`);
  }

  res.type('text/xml').send(twiml.toString());
});

app.get('/api/token', (req, res) => {
  try {
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    let identity = req.query.identity || 'unknown';
    if (identity === 'unknown') identity = 'web-' + Math.floor(Math.random() * 100000);

    console.log(`[token] Issuing token for: ${identity}`);

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
    console.error(err);
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
    console.error(err);
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
      voice: "ballad",  // available: alloy, sage, verse, coral, shimmer
      input: text
    });

    const buffer = Buffer.from(await response.arrayBuffer());

    res.setHeader("Content-Type", "audio/mpeg");
    res.send(buffer);

  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "TTS failed" });
  }
});



server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
