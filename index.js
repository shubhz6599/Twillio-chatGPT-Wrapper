require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const OpenAI = require('openai');
const textToSpeech = require('@google-cloud/text-to-speech');
const fs = require('fs');
const util = require('util');

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


// // uncomment below for google cloud
// const ttsClient = new textToSpeech.TextToSpeechClient({ keyFilename: 'key.json' });

// app.post('/api/tts', async (req, res) => {
//   try {
//     const { text, language = 'en-IN', voiceGender = 'MALE' } = req.body;
//     if (!text) return res.status(400).send({ error: 'Text required' });

//     let voiceName = '';

//     switch (language) {
//       case 'hi-IN': // Hindi
//         voiceName = voiceGender === 'MALE' ? 'hi-IN-Wavenet-C' : 'hi-IN-Wavenet-D';
//         break;
//       case 'mr-IN': // Marathi
//         voiceName = voiceGender === 'MALE' ? 'mr-IN-Wavenet-A' : 'mr-IN-Wavenet-B';
//         break;
//       case 'en-IN': // English (Indian)
//       default:
//         voiceName = voiceGender === 'MALE' ? 'en-IN-Wavenet-B' : 'en-IN-Wavenet-A';
//     }

//     const [response] = await ttsClient.synthesizeSpeech({
//       input: { text },
//       voice: { languageCode: language, name: voiceName, ssmlGender: voiceGender },
//       audioConfig: { audioEncoding: 'MP3' },
//     });

//     const audioBuffer = Buffer.from(response.audioContent, 'binary');
//     res.set('Content-Type', 'audio/mpeg');
//     res.send(audioBuffer);
//   } catch (err) {
//     console.error(err);
//     res.status(500).send({ error: err.message });
//   }
// });


// modal for chat gpt text to voice
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


// Uncomment below for elevenLabs
// -------- ElevenLabs TTS (FAST + Indian Voices) --------
// -------- ElevenLabs TTS FIXED VERSION --------
// const { ElevenLabsClient } = require("elevenlabs");

// const eleven = new ElevenLabsClient({
//   apiKey: process.env.ELEVENLABS_API_KEY
// });

// app.post('/api/tts-eleven', async (req, res) => {
//   try {
//     const { text, voiceId } = req.body;

//     if (!text) return res.status(400).send({ error: "Text required" });

//     // Fallback if no voiceId received
//     // const selectedVoice = voiceId || process.env.ELEVENLABS_VOICE_ID;
//     const selectedVoice = voiceId || 'pqHfZKP75CvOlQylNhV4';

//     if (!selectedVoice) {
//       console.log("❌ Missing voiceId");
//       return res.status(400).send({
//         error: "Missing voiceId. Provide a valid ElevenLabs voice ID."
//       });
//     }

//     console.log("🎤 Using Voice ID:", selectedVoice);

//     const readableStream = await eleven.textToSpeech.convert(selectedVoice, {
//       text,
//       model_id: "eleven_multilingual_v2",
//       voice_settings: {
//         stability: 0.4,
//         similarity_boost: 0.3,
//         speed: 1.1,
//         stability:0.4,
//         style:0.0,
//         speaker_boost:'enabled'
//       }
//     });

//     res.setHeader("Content-Type", "audio/mpeg");
//     res.setHeader("Transfer-Encoding", "chunked");

//     for await (const chunk of readableStream) {
//       res.write(chunk);
//     }
//     res.end();

//   } catch (err) {
//     console.error("❌ ElevenLabs TTS error:", err);
//     if (err.statusCode === 400) {
//       return res.status(400).send({
//         error: "Bad Request — Invalid voiceId or invalid body sent to ElevenLabs"
//       });
//     }
//     res.status(500).send({ error: err.message });
//   }
// });

// Uncomment below for Googlegemini
// const API_KEY = process.env.GOOGLE_API_KEY; // *** IMPORTANT: Set your actual API Key here ***
// const TTS_MODEL = "gemini-2.5-flash-preview-tts";
// const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${API_KEY}`;
// const VOICE_NAME = "Algieba"; // Example voice: Kore, Puck, Zephyr, etc.

// function pcmToWavBuffer(pcmBuffer, sampleRate) {
//     const numChannels = 1;
//     const bytesPerSample = 2; // 16-bit PCM
//     const numSamples = pcmBuffer.length / bytesPerSample;
//     const buffer = Buffer.alloc(44 + pcmBuffer.length);

//     let offset = 0;

//     // RIFF header
//     buffer.write('RIFF', offset); offset += 4;
//     buffer.writeUInt32LE(36 + pcmBuffer.length, offset); offset += 4; // File size (data + 36)
//     buffer.write('WAVE', offset); offset += 4;

//     // fmt chunk
//     buffer.write('fmt ', offset); offset += 4;
//     buffer.writeUInt32LE(16, offset); offset += 4; // Chunk size (16)
//     buffer.writeUInt16LE(1, offset); offset += 2; // Audio format (1 = PCM)
//     buffer.writeUInt16LE(numChannels, offset); offset += 2;
//     buffer.writeUInt32LE(sampleRate, offset); offset += 4;
//     buffer.writeUInt32LE(sampleRate * numChannels * bytesPerSample, offset); offset += 4; // Byte rate
//     buffer.writeUInt16LE(numChannels * bytesPerSample, offset); offset += 2; // Block align
//     buffer.writeUInt16LE(16, offset); offset += 2; // Bits per sample (16)

//     // data chunk
//     buffer.write('data', offset); offset += 4;
//     buffer.writeUInt32LE(pcmBuffer.length, offset); offset += 4; // Data size

//     // Copy the raw PCM data
//     pcmBuffer.copy(buffer, offset);

//     return buffer;
// }

// app.post("/api/tts-gemini", async (req, res) => {
//     try {
//         const { text } = req.body;

//         if (!text || text.trim() === "") {
//             return res.status(400).send({ error: "Text required" });
//         }

//         if (API_KEY === "YOUR_GEMINI_API_KEY") {
//              return res.status(500).send({ error: "API Key not configured. Please set YOUR_GEMINI_API_KEY in server.js" });
//         }


//         const payload = {
//             contents: [{ parts: [{ text: text }] }],
//             generationConfig: {
//                 responseModalities: ["AUDIO"],
//                 speechConfig: {
//                     voiceConfig: {
//                         prebuiltVoiceConfig: { voiceName: VOICE_NAME }
//                     }
//                 }
//             },
//             model: TTS_MODEL
//         };

//         let maxRetries = 5;
//         let delay = 1000;
//         let apiResult;

//         // Exponential backoff loop
//         for (let i = 0; i < maxRetries; i++) {
//             try {
//                 const apiResponse = await fetch(API_URL, {
//                     method: 'POST',
//                     headers: { 'Content-Type': 'application/json' },
//                     body: JSON.stringify(payload)
//                 });

//                 if (!apiResponse.ok) {
//                     const errorBody = await apiResponse.json();
//                       throw new Error( 'API error: +(apiResponse.status) - +(errorBody.error?.message)');

//                 }

//                 apiResult = await apiResponse.json();
//                 break; 

//             } catch (error) {
//                 if (i === maxRetries - 1) {
//                     throw error; // Rethrow on final failure
//                 }
//                 await new Promise(resolve => setTimeout(resolve, delay));
//                 delay *= 2; // Exponential backoff
//             }
//         }
        
//         const part = apiResult?.candidates?.[0]?.content?.parts?.[0];
//         const audioDataB64 = part?.inlineData?.data;
//         const mimeType = part?.inlineData?.mimeType;

//         if (!audioDataB64 || !mimeType || !mimeType.startsWith("audio/L16")) {
//             console.error("Invalid TTS response from API:", JSON.stringify(apiResult, null, 2));
//             return res.status(500).send({ error: "TTS failed: Invalid audio response." });
//         }

//         const pcmBuffer = Buffer.from(audioDataB64, 'base64');

//         const rateMatch = mimeType.match(/rate=(\d+)/);
//         const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;

//         const wavBuffer = pcmToWavBuffer(pcmBuffer, sampleRate);

//         res.setHeader("Content-Type", "audio/wav");
//         res.setHeader("Content-Length", wavBuffer.length);
//         res.send(wavBuffer);

//     } catch (err) {
//         console.error("TTS Request Error:", err.message);
//         res.status(500).send({ error: "TTS failed" });
//     }
// });


app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
