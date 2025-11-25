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
      voice: "ballad",
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

// ===================================================================
//               🔥 REALTIME VOICE-TO-VOICE WEBSOCKET PROXY (FIXED)
// ===================================================================

/**
 * Realtime WS proxy that:
 *  - Accepts frontend WebSocket connects on port 3001
 *  - For each frontend client, opens a dedicated OpenAI realtime WS
 *  - Buffers client messages until OpenAI WS is open, then flushes
 *  - Forwards binary and JSON messages both ways with safety guards
 */

const REALTIME_PORT = 3001;
const REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

const ALLOWED_KNOWLEDGE = `
You are Msetu portal assistant.

Allowed questions include:
- email
- phone
- login
- asn
- GST
- Forgot Password
- po report
- purchase order report
- payment report


GREETING RULE:
If user only says:
"hi", "hello", "hey", "good morning", "good evening", 
"how are you", "what's up"

→ Reply with a friendly greeting such as:
"Hello! How can I help you on the Msetu portal?"

Do NOT say the unrelated message for greetings.

UNRELATED QUESTION RULE:
If question is NOT about Msetu portal → reply:
"I'm sorry, but this question is not related to Msetu."

Below are the OFFICIAL answers you must use.
`;

const ALLOWED_ANSWERS = `
MSETU PORTAL OFFICIAL ANSWERS (Refined):

1) EMAIL:
To update your email address:
1. Log in to the Msetu Portal.
2. Go to the Dashboard or Main Menu.
3. Click on the profile icon at the top-right corner.
4. In the user details popup, update your email in the Email Address field.
5. Click “Save Changes”.
Your email will be successfully updated.

2) PHONE:
To update your phone number:
1. Log in to the Msetu Portal.
2. Go to the Dashboard or Main Menu.
3. Click on the profile icon in the top-right corner.
4. In the user details popup, update your phone number in the Mobile Number field.
5. Click “Save Changes”.
Your mobile number will be updated.

3) LOGIN:
To log in to the Msetu Portal:
1. Open supplier.mahindra.com in your browser.
2. Select the “Msetu Login” option.
3. Choose either “M&M User Login” or “Supplier User Login”.
4. Follow the on-screen instructions to complete the login process.

4) ASN:
To create an ASN:
1. Log in to the Msetu Portal using your vendor code.
2. On the landing page, select the OE Supplies tab.
3. Click on Transactions & Self Service Report.
4. You will be redirected to the SRM Portal landing page. Select OE Supplies again.
5. Open the Self Service Page from the Transactions menu.
6. The supplier self-service page will open in a new tab.
7. Download the ASN file format provided.
8. While filling the file, ensure:
   - Invoice & LR date must be in DD.MM.YYYY format.
   - Invoice should not be older than 3 months.
   - If excise amount is not applicable, enter 0.
   - Enter * in LR number if not available.
   - Remove packaging material columns if not required.
9. Save the file in CSV format.
10. Click “Upload ASN”, then choose the file and upload it.
Your ASN will be successfully created.

5) GST:
To check M&M GSTN details:
1. Log in to the Msetu Portal.
2. Navigate to the "GST Info" section.
3. Open the file named “MnM GSTN Numbers.pdf”.
This file contains all official GST details.

6) FORGOT PASSWORD:
Use the Forgot Password link on the MSetu portal login page to reset your password.

7) PO REPORT:
To get the Purchase Order (PO) report:
1. Go to the main Msetu chatbot.
2. Type “PO Report”.
3. The chatbot will ask you to enter your vendor code.
4. Enter your vendor code and press Enter.
Your PO report will be successfully obtained.

8) PURCHASE ORDER REPORT:
To get the Purchase Order report:
1. Open the main Msetu chatbot.
2. Type “PO Report” or “Purchase Order Report”.
3. The chatbot will ask you to enter your vendor code.
4. Enter your vendor code and press Enter.
Your Purchase Order report will be successfully generated.

9) PAYMENT REPORT:
To get the Payment Report:
1. Go to the main Msetu chatbot.
2. Type “Payment Report”.
3. The chatbot will ask you to select a date range.
4. Enter the required date range and press Enter.
Your Payment Report for the selected period will be successfully generated.


`;


const realtimeServer = new WebSocket.Server({ server, path: '/realtime' });



realtimeServer.on('connection', (clientWs, req) => {
  console.log('[proxy] Frontend connected:', req.socket.remoteAddress);

  // Per-connection state
  let openaiWS = null;
  let openaiReady = false;
  const outboundQueue = []; // queue binary or string messages until OpenAI WS is ready
  let closed = false;

  // helper to cleanup both sockets
  function cleanup() {
    closed = true;
    try { if (clientWs && clientWs.readyState === WebSocket.OPEN) clientWs.close(); } catch (e) { }
    try { if (openaiWS && openaiWS.readyState === WebSocket.OPEN) openaiWS.close(); } catch (e) { }
  }

  // Create OpenAI WS for this client
  try {
    openaiWS = new WebSocket(REALTIME_URL, {
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });
  } catch (err) {
    console.error('[proxy] Failed to create OpenAI WS', err);
    clientWs.send(JSON.stringify({ error: 'Failed to connect to OpenAI realtime' }));
    clientWs.close();
    return;
  }

  // When OpenAI WS opens, send initial session.update and flush queue
  openaiWS.on('open', () => {
    console.log('[proxy] OpenAI realtime WS connected for client');

    openaiReady = true;

    // send initial session update (adjust as needed)
    const initial = {
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice: "shimmer",
 instructions: `
${ALLOWED_KNOWLEDGE}

${ALLOWED_ANSWERS}

STRICT RULES:
1. You must answer ONLY using the official answers listed above.
2. If the user's question does NOT match any allowed topics, reply:
   "I'm sorry, but this question is not related to Msetu."
3. For greetings like "hi", "hello", "good morning":
   Reply only:
   "Hello! How can I help you on the Msetu portal?"
4. Do NOT generate any information outside the official list.
5. Do NOT guess answers.
6. Responses MUST be short, clear, and professional.
`

      }
    };




    try {
      openaiWS.send(JSON.stringify(initial));
    } catch (e) {
      console.warn('[proxy] failed to send session.update', e);
    }

    // flush queued frames (if any)
    while (outboundQueue.length > 0) {
      const item = outboundQueue.shift();
      if (!item) continue;
      try {
        if (openaiWS.readyState === WebSocket.OPEN) {
          openaiWS.send(item);
        } else {
          outboundQueue.unshift(item);
          break;
        }
      } catch (err) {
        console.warn('[proxy] error flushing queue', err);
      }
    }
  });

  openaiWS.on('error', (err) => {
    console.error('[proxy] OpenAI WS error', err);
    // forward a lightweight error to client
    try { if (clientWs && clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify({ type: 'error', message: 'OpenAI WS error' })); } catch (e) { }
  });

  openaiWS.on('close', (code, reason) => {
    openaiReady = false;
    console.log(`[proxy] OpenAI WS closed (code=${code}) ${reason ? reason.toString() : ''}`);

    // Send a notification to the client, but DO NOT close the client socket here.
    // Let the client decide when to disconnect (so it can still receive any final forwarded events).
    try {
      if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'openai.closed',
          code,
          reason: reason ? reason.toString() : ''
        }));
      }
    } catch (e) {
      console.warn('[proxy] failed to notify client of openai close', e);
    }

    // Do not automatically close clientWs here. Keep it open so the browser can
    // receive any last messages and user code can decide when to disconnect.
    // cleanup() will still be called when clientWs.close() happens on the client's side.
  });


  // Forward OpenAI -> Client (binary or JSON)
  openaiWS.on('message', (data, isBinary) => {
    if (closed) return;
    // data may be Buffer or string
    try {
      if (clientWs.readyState === WebSocket.OPEN) {
        // forward as-is
        clientWs.send(data, { binary: isBinary });
      } else {
        console.warn('[proxy] client not open, dropping OpenAI message');
      }
    } catch (err) {
      console.error('[proxy] error forwarding OpenAI->client', err);
    }
  });

  // When client sends data -> forward to OpenAI (or queue until ready)
  clientWs.on('message', async (data, isBinary) => {
    if (closed) return;

    try {
      if (isBinary || data instanceof Buffer || data instanceof ArrayBuffer) {
        // Convert binary (ArrayBuffer/Buffer) to base64 string
        let buf;
        if (data instanceof ArrayBuffer) {
          buf = Buffer.from(data);
        } else if (Buffer.isBuffer(data)) {
          buf = data;
        } else {
          // some environments supply Blob-like objects — try to handle them
          buf = Buffer.from(data);
        }

        // Base64 encode
        const b64 = buf.toString('base64');

        // Build append event
        const appendEvent = JSON.stringify({
          type: "input_audio_buffer.append",
          audio: b64
        });

        if (openaiReady && openaiWS && openaiWS.readyState === WebSocket.OPEN) {
          openaiWS.send(appendEvent);
        } else {
          // queue string events (we already support queuing binary; now queue text too)
          if (outboundQueue.length > 2000) outboundQueue.shift();
          outboundQueue.push(appendEvent);
        }

        return;
      }

      // Non-binary messages (control JSON strings) — forward as-is to OpenAI
      if (typeof data === 'string') {
        // If client sends control events (e.g. 'commit' from frontend), forward them.
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


  clientWs.on('close', (code, reason) => {
    console.log(`[proxy] client disconnected (code=${code})`);
    cleanup();
  });

  clientWs.on('error', (err) => {
    console.error('[proxy] client WS error', err);
    cleanup();
  });

}); // realtimeServer.on('connection')

// ===================================================================
// START EXPRESS SERVER
// ===================================================================
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
