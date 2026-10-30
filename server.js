'use strict';

/* ==========================================================================
 * Pocketbandhu - AI Calling Agent
 * Node.js + Express + Twilio Voice API + Google Gemini API
 *
 * Endpoints
 *   POST /api/make-call   start an outbound phone call (Twilio)
 *   *     /api/voice      TwiML: <Gather input="speech"> welcome + listen
 *   *     /api/respond    TwiML: transcript -> Gemini -> spoken reply -> loop
 *   POST /api/chat        talk to the agent from the browser (no phone credit)
 *   GET  /api/call/:jobId live transcript + call status for the dashboard
 *   *     /api/status     Twilio status callback (cleans up finished calls)
 * ========================================================================== */

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const twilio = require('twilio');

const VoiceResponse = twilio.twiml.VoiceResponse;

/* --------------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------------ */

const {
  TWILIO_ACCOUNT_SID = '',
  TWILIO_AUTH_TOKEN = '',
  TWILIO_PHONE_NUMBER = '',
  GEMINI_API_KEY = '',
  PUBLIC_URL = '',
  GEMINI_MODEL = 'gemini-3.8-flash',
  GATHER_SPEECH_MODEL = 'googlev2_telephony',
  GATHER_SPEECH_TIMEOUT = '4',
  PORT = 3000,
} = process.env;

const CALL_JOB_TTL_MS = 60 * 60 * 1000; // keep finished transcripts for 1 hour
const MAX_HISTORY_TURNS = 20;           // conversation turns sent to Gemini

const DEFAULT_PERSONA =
  'You are Pocketbandhu, a friendly AI assistant who helps people over the phone.';

/** Languages supported by the phone channel (Twilio STT + TTS codes). */
const LANGUAGES = {
  bn: {
    code: 'bn-IN',
    label: 'Bengali',
    greet: 'হ্যালো! আমি পকেটবান্ধু, আপনার এআই সহকারী। বলুন, আমি কীভাবে আপনাকে সাহায্য করতে পারি?',
    prompt: 'Go ahead, I am listening.',
    speakPrompt: 'আমি শুনছি, আপনি বলুন।',
    fallback: 'দয়া করে একটু আবার বলুন, আমি পরিষ্কার শুনতে পারিনি।',
    hangup: 'ঠিক আছে, ধন্যবাদ। আজকের জন্য এতটুকুই, আবার কথা হবে। বিদায়!',
    instruction: 'Answer in Bengali (বাংলা), written in the Bengali script.',
  },
  hi: {
    code: 'hi-IN',
    label: 'Hindi',
    greet: 'नमस्ते! मैं पॉकेटबंधु हूँ, आपका एआई सहायक। बताइए, मैं आपकी किस तरह मदद कर सकता हूँ?',
    prompt: 'Go ahead, I am listening.',
    speakPrompt: 'मैं सुन रहा हूँ, आप बोलिए।',
    fallback: 'माफ़ कीजिए, कृपया एक बार दोबारा कहिए।',
    hangup: 'ठीक है, धन्यवाद। आज के लिए बस इतना ही, फिर बात करेंगे। नमस्ते!',
    instruction: 'Answer in Hindi (हिन्दी), written in the Devanagari script.',
  },
  en: {
    code: 'en-IN',
    label: 'English',
    greet: 'Hello! This is Pocketbandhu, your AI assistant on the call. How can I help you today?',
    prompt: 'Go ahead, I am listening.',
    speakPrompt: 'I am listening, go ahead.',
    fallback: 'Sorry, I did not catch that. Could you say it again?',
    hangup: 'Alright, thank you. That is all for now, talk to you soon. Goodbye!',
    instruction: 'Answer in natural Indian English.',
  },
};

/** Map anything the client sends ("bn", "bn-IN", "bengali", ...) to a key. */
function langKey(input) {
  const v = String(input || '').toLowerCase().trim();
  if (v.startsWith('bn') || v.startsWith('bengali') || v.startsWith('bangla')) return 'bn';
  if (v.startsWith('hi') || v.startsWith('hindi') || v.startsWith('हिं') || v.startsWith('हिन्दी')) return 'hi';
  if (v.startsWith('en') || v.startsWith('english')) return 'en';
  return 'en';
}

function langFor(job) {
  return LANGUAGES[job && job.language ? job.language : 'en'];
}

/* --------------------------------------------------------------------------
 * Twilio + Gemini clients (created lazily so the server still boots and can
 * serve the dashboard when credentials are missing)
 * ------------------------------------------------------------------------ */

const twilioClients = new Map();

/** Trim a value coming from the client without ever logging it. */
function cleanStr(value) {
  return value == null ? '' : String(value).trim();
}

/**
 * Build (and cache) a Twilio REST client. Server .env credentials win; when
 * they are missing, the values pasted into the dashboard's Settings panel are
 * used for this request only and are never stored by the server.
 */
function getTwilioClient(accountSid, authToken) {
  if (!accountSid || !authToken) {
    const err = new Error(
      'Twilio is not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN on the server, or add them in Settings -> API keys in the dashboard.'
    );
    err.status = 500;
    throw err;
  }
  const cacheKey = `${accountSid}|${authToken}`;
  if (!twilioClients.has(cacheKey)) {
    if (twilioClients.size >= 8) twilioClients.clear(); // bound the cache
    twilioClients.set(cacheKey, twilio(accountSid, authToken));
  }
  return twilioClients.get(cacheKey);
}

/**
 * Ask Gemini for the next thing the agent should say.
 * Keeps replies short and speech-friendly because the text is read aloud.
 */
async function askGemini({ persona, language, transcript, userText, apiKey }) {
  // Server .env always wins; a key pasted into the dashboard fills the gap.
  const key = GEMINI_API_KEY || cleanStr(apiKey);
  if (!key) {
    const err = new Error(
      'Gemini is not configured. Set GEMINI_API_KEY on the server, or add it in Settings -> API keys in the dashboard.'
    );
    err.status = 500;
    throw err;
  }

  const lang = LANGUAGES[language] || LANGUAGES.en;

  // Twilio opens the call with a greeting. When the transcript starts with the
  // agent, hand that line to Gemini as context so it never repeats itself.
  const opening = transcript.length && transcript[0].role !== 'user' ? transcript[0] : null;
  const history = transcript.filter((t) => t.role === 'user').slice(-MAX_HISTORY_TURNS);

  const systemParts = [buildSystemPrompt(persona, lang)];
  if (opening) {
    systemParts.push(
      `You already opened this phone call with: "${opening.text}". Continue from there - never greet the caller again.`
    );
  }

  // generateContent wants a single user/model conversation: pair every user
  // turn with the agent reply that follows it, and never two turns in a row of
  // the same role.
  const contents = [];
  const addTurn = (role, text) => {
    const value = String(text).slice(0, 2000);
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += `\n${value}`;
    else contents.push({ role, parts: [{ text: value }] });
  };

  for (const turn of history) {
    addTurn('user', turn.text);
    const idx = transcript.indexOf(turn);
    const reply = transcript[idx + 1];
    if (reply && reply.role !== 'user') addTurn('model', reply.text);
  }
  addTurn('user', userText);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    GEMINI_MODEL
  )}:generateContent`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': key,
    },
    body: JSON.stringify({
      systemInstruction: { parts: systemParts.map((text) => ({ text })) },
      contents,
      generationConfig: { maxOutputTokens: 150 },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`Gemini API error ${response.status}: ${body.slice(0, 300)}`);
    err.status = 502;
    throw err;
  }

  const data = await response.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content
    ? data.candidates[0].content.parts
    : []) || [];
  const text = parts
    .map((p) => p.text || '')
    .join('')
    .trim();

  if (!text) {
    const err = new Error('Gemini returned an empty reply.');
    err.status = 502;
    throw err;
  }
  return text;
}

function buildSystemPrompt(persona, lang) {
  return [
    (persona || DEFAULT_PERSONA).trim(),
    lang.instruction,
    'You are speaking live on a telephone call. Your reply is converted to speech by a voice synthesiser, so it is read out loud word for word.',
    'Keep every reply to one or two sentences, at most about 30 words.',
    'Use warm, natural, spoken language. Never use markdown, headings, bullet points, emoji, code or stage directions.',
    'Do not repeat the caller\'s question back to them before answering.',
    'If you cannot hear or understand the caller, politely ask them to repeat.',
    'If the caller wants to end the call, say a short goodbye.',
  ].join('\n');
}

/* --------------------------------------------------------------------------
 * Call sessions
 * ------------------------------------------------------------------------ */

/** jobId -> { persona, language, status, transcript, callSid, createdAt, ... } */
const jobs = new Map();
/** Twilio CallSid -> jobId */
const sessions = new Map();

function createJob({ persona, language, apiKey }) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = {
    id,
    persona: String(persona || '').trim() || DEFAULT_PERSONA,
    language: langKey(language),
    // Client-supplied Gemini key, kept in memory for this call only so
    // /api/respond can answer without a server-side GEMINI_API_KEY.
    geminiKey: cleanStr(apiKey) || null,
    status: 'created',
    transcript: [],
    callSid: null,
    noInput: 0,
    greeted: false,
    lastError: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  jobs.set(id, job);
  return job;
}

/** Resolve the job behind a Twilio webhook (query param first, CallSid fallback). */
function resolveJob(req) {
  const body = req.body || {};
  const wanted = req.query.job || body.job;

  if (wanted && jobs.has(wanted)) return { job: jobs.get(wanted), id: wanted };

  const sid = body.CallSid;
  if (sid && sessions.has(sid)) {
    const id = sessions.get(sid);
    if (jobs.has(id)) return { job: jobs.get(id), id };
  }
  // Always hand back a job id that is registered in `jobs`, otherwise the next
  // webhook (?job=...) would miss and silently start a brand-new session.
  if (sid) {
    // Call placed outside /api/make-call: adopt it with default settings, and
    // keep any ?job= id working so the rest of the loop stays on one session.
    const job = createJob({});
    jobs.set(sid, job);
    if (wanted) jobs.set(wanted, job);
    sessions.set(sid, job.id);
    return { job, id: job.id };
  }
  if (wanted) {
    const job = createJob({});
    jobs.set(wanted, job);
    return { job, id: job.id };
  }

  const job = createJob({});
  return { job, id: job.id };
}

function pushTurn(job, role, text) {
  job.transcript.push({ role, text, at: Date.now() });
  if (job.transcript.length > 60) job.transcript.shift();
  job.updatedAt = Date.now();
}

// Sweep expired call transcripts so a long-running process stays small.
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.updatedAt > CALL_JOB_TTL_MS) {
      jobs.delete(id);
      if (job.callSid) sessions.delete(job.callSid);
    }
  }
}, 5 * 60 * 1000).unref();

/* --------------------------------------------------------------------------
 * TwiML helpers
 * ------------------------------------------------------------------------ */

/** Strip characters that would break or stall a phone TTS stream. */
function speechText(text, max = 600) {
  return String(text || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function baseUrl(req) {
  const explicit = PUBLIC_URL.replace(/\/+$/, '');
  if (explicit) return explicit;
  // Fall back to the origin Twilio is actually calling (ngrok, Render, ...).
  return `${req.protocol}://${req.get('host')}`;
}

function gatherOptions(jobId, lang) {
  const options = {
    input: 'speech',
    language: lang.code,
    action: `/api/respond?job=${jobId}`,
    method: 'POST',
    speechTimeout: GATHER_SPEECH_TIMEOUT,
  };
  if (GATHER_SPEECH_MODEL) options.speechModel = GATHER_SPEECH_MODEL;
  return options;
}

/** Welcome prompt, nested inside <Gather> so Twilio starts listening right after. */
function addGreeting(response, job, lang) {
  const gather = response.gather(gatherOptions(job.id, lang));
  const text = job.greeted ? lang.speakPrompt : lang.greet;
  gather.say({ language: lang.code }, text);
  if (!job.greeted) {
    job.greeted = true;
    pushTurn(job, 'agent', text);
  }
  return gather;
}

/**
 * The conversation loop: speak the reply, keep listening, and fall back to a
 * fresh <Gather> when the caller says nothing.
 */
function buildConversationTwiML(job, replyText) {
  const lang = langFor(job);
  const response = new VoiceResponse();

  if (replyText) {
    addGreetingSpeakOnly(response, job, lang, replyText);
  } else {
    addGreeting(response, job, lang);
  }

  response.redirect({ method: 'POST' }, `/api/voice?job=${job.id}`);
  return response.toString();
}

function addGreetingSpeakOnly(response, job, lang, replyText) {
  const gather = response.gather(gatherOptions(job.id, lang));
  gather.say({ language: lang.code }, speechText(replyText));
}

/* --------------------------------------------------------------------------
 * App
 * ------------------------------------------------------------------------ */

const app = express();
// Render / ngrok terminate TLS: report https:// as the request protocol so the
// TwiML and status-callback URLs Twilio receives are always absolute https.
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false }));

app.use('/api', (req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`);
  });
  next();
});

/* ------------------------------- /api/chat ------------------------------ */
/**
 * Text in, text out. Used by the in-browser voice test (Web Speech API) and
 * handy for trying the persona without spending phone credits.
 * Body: { message, persona?, language?, history?: [{role:'user'|'agent', text}] }
 */
app.post('/api/chat', async (req, res) => {
  const body = req.body || {};
  const message = String(body.message || '').trim();
  if (!message) {
    return res.status(400).json({ error: 'Send a "message" to talk to the agent.' });
  }

  const language = langKey(body.language);
  const persona = String(body.persona || '').trim() || DEFAULT_PERSONA;

  const transcript = Array.isArray(body.history)
    ? body.history
        .filter((t) => t && (t.role === 'user' || t.role === 'agent') && String(t.text || '').trim())
        .slice(-MAX_HISTORY_TURNS)
        .map((t) => ({ role: t.role, text: String(t.text).slice(0, 2000) }))
    : [];

  try {
    const reply = await askGemini({
      persona,
      language,
      transcript,
      userText: message,
      apiKey: cleanStr(body.geminiApiKey),
    });
    res.json({ reply, language });
  } catch (err) {
    console.error('Gemini error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* ----------------------------- /api/make-call --------------------------- */
/**
 * Body: { phone, persona?, language? }
 * Places an outbound call whose first webhook is /api/voice.
 */
app.post('/api/make-call', async (req, res) => {
  const body = req.body || {};
  const to = normalizePhone(body.phone);

  if (!to) {
    return res.status(400).json({
      error: 'Enter a valid phone number, e.g. 9876543210 (a +91 prefix is added for you) or +14155550123.',
    });
  }
  const job = createJob({
    persona: body.persona,
    language: body.language,
    apiKey: cleanStr(body.geminiApiKey),
  });

  // Server .env wins; dashboard-supplied values fill any gap.
  const from = TWILIO_PHONE_NUMBER || cleanStr(body.twilioPhoneNumber);
  const accountSid = TWILIO_ACCOUNT_SID || cleanStr(body.twilioAccountSid);
  const authToken = TWILIO_AUTH_TOKEN || cleanStr(body.twilioAuthToken);

  if (!from) {
    jobs.delete(job.id);
    return res.status(500).json({
      error:
        'No calling number. Set TWILIO_PHONE_NUMBER on the server, or add it in Settings -> API keys in the dashboard.',
    });
  }

  try {
    const client = getTwilioClient(accountSid, authToken);
    const origin = baseUrl(req);

    const call = await client.calls.create({
      to,
      from,
      url: `${origin}/api/voice?job=${job.id}`,
      method: 'POST',
      statusCallback: `${origin}/api/status?job=${job.id}`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });

    job.callSid = call.sid;
    job.status = 'initiated';
    job.to = to;
    job.updatedAt = Date.now();
    sessions.set(call.sid, job.id);

    console.log(`Call ${call.sid} -> ${to} (${LANGUAGES[job.language].label})`);
    res.json({
      ok: true,
      jobId: job.id,
      callSid: call.sid,
      to,
      language: job.language,
      status: job.status,
    });
  } catch (err) {
    jobs.delete(job.id);
    console.error('Twilio call error:', err.message);
    res.status(err.status || 502).json({ error: describeTwilioError(err) });
  }
});

/** Normalise Indian local formats to E.164, honouring a leading +cc. */
function normalizePhone(raw) {
  const value = String(raw || '').replace(/[\s().\-]/g, '');
  if (!value) return null;

  let number = value;
  if (number.startsWith('+')) {
    return /^\+\d{8,15}$/.test(number) ? number : null;
  }
  if (/^00\d+$/.test(number)) number = `+${number.slice(2)}`;
  else if (/^\d{10}$/.test(number)) number = `+91${number}`;
  else if (/^0\d{10}$/.test(number)) number = `+91${number.slice(1)}`;
  else if (/^\d{11,15}$/.test(number)) number = `+${number}`;
  else return null;

  return /^\+\d{8,15}$/.test(number) ? number : null;
}

function describeTwilioError(err) {
  const code = err.code || (err.original && err.original.code);
  const known = {
    21211: 'That phone number is not a valid Twilio-usable number.',
    21214: 'That phone number cannot receive calls from this Twilio number.',
    21606: 'Your Twilio number is not capable of calling this destination.',
    21608: 'The destination number is unverified. On a trial account you must verify it in Twilio → Caller IDs.',
    21610: 'The destination number has opted out of calls from this Twilio number.',
  };
  if (code && known[code]) return `${known[code]} (Twilio error ${code})`;
  return err.message || 'Could not place the call.';
}

/* ------------------------------- /api/voice ----------------------------- */
/**
 * Twilio's first webhook: greet the caller and start listening.
 * <Gather input="speech"> posts the transcript to /api/respond.
 */
app.all('/api/voice', (req, res) => {
  const { job, id } = resolveJob(req);
  const lang = langFor(job);
  const response = new VoiceResponse();

  addGreeting(response, job, lang);

  job.noInput += 1;
  if (job.noInput >= 3) {
    // The caller has stayed silent three times: end the call politely.
    const goodbye = new VoiceResponse();
    goodbye.say({ language: lang.code }, lang.hangup);
    goodbye.hangup();
    job.status = 'no-input';
    return res.type('text/xml').send(goodbye.toString());
  }

  response.redirect({ method: 'POST' }, `/api/voice?job=${id}`);
  res.type('text/xml').send(response.toString());
});

/* ------------------------------ /api/respond ---------------------------- */
/**
 * Receives SpeechResult + Confidence from <Gather>, asks Gemini for the next
 * reply, speaks it back and re-opens the <Gather> to keep the loop running.
 */
app.all('/api/respond', async (req, res) => {
  const { job } = resolveJob(req);
  const lang = langFor(job);

  const speech = String((req.body && req.body.SpeechResult) || req.query.SpeechResult || '')
    .trim()
    .slice(0, 1000);

  // No words recognised: acknowledge and listen again (Twilio normally skips
  // this path and follows the <Redirect>, but handle it for direct calls).
  if (!speech) {
    job.noInput += 1;
    return res.type('text/xml').send(buildConversationTwiML(job, lang.fallback));
  }

  job.noInput = 0;
  pushTurn(job, 'user', speech);

  let reply;
  try {
    reply = await askGemini({
      persona: job.persona,
      language: job.language,
      transcript: job.transcript.slice(0, -1),
      userText: speech,
      apiKey: job.geminiKey,
    });
    job.lastError = null;
  } catch (err) {
    console.error('Reply error:', err.message);
    job.lastError = err.message;
    reply = lang.fallback;
  }

  pushTurn(job, 'agent', reply);
  res.type('text/xml').send(buildConversationTwiML(job, reply));
});

/* ------------------------------- /api/status ---------------------------- */
/** Twilio call lifecycle callback; marks finished calls and frees the session. */
app.all('/api/status', (req, res) => {
  const body = req.body || {};
  const sid = body.CallSid;
  const status = body.CallStatus || 'unknown';

  const jobId = req.query.job || (sid && sessions.get(sid));
  const job = jobId && jobs.get(jobId) ? jobs.get(jobId) : null;

  if (job) {
    job.status = status;
    job.updatedAt = Date.now();
    if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(status)) {
      if (sid) sessions.delete(sid);
      console.log(`Call ${sid || job.callSid} ended: ${status}`);
    }
  }
  res.status(204).end();
});

/* ---------------------------- /api/call/:jobId -------------------------- */
/** Polling endpoint that feeds the live transcript in the dashboard. */
app.get('/api/call/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown call.' });

  res.json({
    jobId: job.id,
    callSid: job.callSid,
    to: job.to || null,
    status: job.status,
    language: job.language,
    error: job.lastError,
    transcript: job.transcript,
  });
});

/* --------------------------------- misc --------------------------------- */

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(Number(PORT), '0.0.0.0', () => {
  const twilioState =
    TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
      ? `configured (${TWILIO_PHONE_NUMBER || 'no from-number'})`
      : 'MISSING TWILIO CREDENTIALS';
  console.log(`\n  Pocketbandhu is running on http://0.0.0.0:${PORT}`);
  console.log(`  Model: ${GEMINI_MODEL}`);
  console.log(`  Gemini: ${GEMINI_API_KEY ? 'configured' : 'MISSING GEMINI_API_KEY'}`);
  console.log(`  Twilio: ${twilioState}`);
  console.log(`  Public URL: ${PUBLIC_URL || '(derived from each request)'}\n`);
  console.log('  Dashboard Settings panel can supply any key that is missing here.\n');
});
