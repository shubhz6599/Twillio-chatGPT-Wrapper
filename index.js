require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const OpenAI = require('openai');

const app = express();
app.use(cors());
app.use(bodyParser.urlencoded({ extended: true })); // for Twilio webhook form posts
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -------- PSTN Call API (optional) --------
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

// End call (PSTN)
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

// -------- TwiML Webhook (called by TwiML App) --------
// This endpoint expects Twilio to POST when a call is created by a browser connect.
// We read "To" param and decide whether to dial a client identity or a PSTN number.
app.post('/api/voice', (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  let toParam = req.body.To || req.body.to || '';
  const outgoingCallerId = process.env.TWILIO_NUMBER;

  // Ensure client: prefix for web clients
  if (toParam && !toParam.startsWith('client:')) {
    toParam = `client:${toParam}`;
  }

  if (toParam.toLowerCase().startsWith('client:')) {
    const identity = toParam.split(':')[1];
    const dial = twiml.dial(); // no callerId for client-to-client
    dial.client(identity);
    console.log(`TwiML: Dialing client ${identity}`);
  } else {
    const toNumber = process.env.TARGET_NUMBER || process.env.TWILIO_NUMBER;
    const dial = twiml.dial({ callerId: outgoingCallerId });
    dial.number(toNumber);
    console.log(`TwiML: Dialing number ${toNumber}`);
  }

  res.type('text/xml').send(twiml.toString());
});


// -------- Browser Token Endpoint --------
// Accepts optional query params:
//  - identity: preferred client identity (if not provided, server returns a generated identity).
//  - incoming: "true" or "false" whether to allow incoming connections (receiver needs incoming true).
// Replace your existing /api/token handler with this block
app.get('/api/token', (req, res) => {
  try {
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    // identity param (default random if not provided)
    let identity = req.query.identity || 'unknown';
    if (identity === 'unknown') {
      identity = 'web-' + Math.floor(Math.random() * 100000);
    }

    // DEBUG: Log identity requested
    console.log(`[token] Issuing token for identity: ${identity}`);

    const token = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_API_KEY_SID,
      process.env.TWILIO_API_KEY_SECRET,
      { identity }
    );

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: process.env.TWIML_APP_SID,
      incomingAllow: true // allow incoming so agent can receive
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



// Config helper
app.get('/api/config', (req, res) => {
  res.send({
    twilioNumber: process.env.TWILIO_NUMBER || null,
    targetNumber: process.env.TARGET_NUMBER || null
  });
});

// -------- ChatGPT Endpoint (unchanged except for safety) --------
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

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
