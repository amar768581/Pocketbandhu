/**
 * Shared constants and pure helpers for both runtimes.
 * NO Node.js APIs in this file - it runs on Cloudflare Workers too.
 */

export const DEFAULT_PERSONA =
  'You are Pocketbandhu, a friendly AI assistant who helps people over the phone.';

export const MAX_HISTORY_TURNS = 20;
export const CALL_JOB_TTL_MS = 60 * 60 * 1000;

/** Languages supported by the phone channel (Twilio STT + TTS codes). */
export const LANGUAGES = {
  bn: {
    code: 'bn-IN',
    label: 'Bengali',
    greet: 'হ্যালো! আমি পকেটবান্ধু, আপনার এআই সহকারী। বলুন, আমি কীভাবে আপনাকে সাহায্য করতে পারি?',
    speakPrompt: 'আমি শুনছি, আপনি বলুন।',
    fallback: 'দয়া করে একটু আবার বলুন, আমি পরিষ্কার শুনতে পারিনি।',
    hangup: 'ঠিক আছে, ধন্যবাদ। আজকের জন্য এতটুকুই, আবার কথা হবে। বিদায়!',
    instruction: 'Answer in Bengali (বাংলা), written in the Bengali script.',
  },
  hi: {
    code: 'hi-IN',
    label: 'Hindi',
    greet: 'नमस्ते! मैं पॉकेटबंधु हूँ, आपका एआई सहायक। बताइए, मैं आपकी किस तरह मदद कर सकता हूँ?',
    speakPrompt: 'मैं सुन रहा हूँ, आप बोलिए।',
    fallback: 'माफ़ कीजिए, कृपया एक बार दोबारा कहिए।',
    hangup: 'ठीक है, धन्यवाद। आज के लिए बस इतना ही, फिर बात करेंगे। नमस्ते!',
    instruction: 'Answer in Hindi (हिन्दी), written in the Devanagari script.',
  },
  en: {
    code: 'en-IN',
    label: 'English',
    greet: 'Hello! This is Pocketbandhu, your AI assistant on the call. How can I help you today?',
    speakPrompt: 'Go ahead, I am listening.',
    fallback: 'Sorry, I did not catch that. Could you say it again?',
    hangup: 'Alright, thank you. That is all for now, talk to you soon. Goodbye!',
    instruction: 'Answer in natural Indian English.',
  },
};

/** Map anything the client sends ("bn", "bn-IN", "bengali", ...) to a key. */
export function langKey(input) {
  const v = String(input || '').toLowerCase().trim();
  if (v.startsWith('bn') || v.startsWith('bengali') || v.startsWith('bangla')) return 'bn';
  if (v.startsWith('hi') || v.startsWith('hindi') || v.startsWith('हिं') || v.startsWith('हिन्दी')) return 'hi';
  if (v.startsWith('en') || v.startsWith('english')) return 'en';
  return 'en';
}

export function langFor(job) {
  return LANGUAGES[job && job.language ? job.language : 'en'];
}

/** Trim a value coming from the client without ever logging it. */
export function cleanStr(value) {
  return value == null ? '' : String(value).trim();
}

export function buildSystemPrompt(persona, lang) {
  return [
    (persona || DEFAULT_PERSONA).trim(),
    lang.instruction,
    'You are speaking live on a telephone call. Your reply is converted to speech by a voice synthesiser, so it is read out loud word for word.',
    'Keep every reply to one or two sentences, at most about 30 words.',
    'Use warm, natural, spoken language. Never use markdown, headings, bullet points, emoji, code or stage directions.',
    "Do not repeat the caller's question back to them before answering.",
    'If you cannot hear or understand the caller, politely ask them to repeat.',
    'If the caller wants to end the call, say a short goodbye.',
  ].join('\n');
}

/** Normalise Indian local formats to E.164, honouring a leading +cc. */
export function normalizePhone(raw) {
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

/** Strip characters that would break or stall a phone TTS stream. */
export function speechText(text, max = 600) {
  return String(text || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function describeTwilioError(err) {
  const code = err && err.code;
  const known = {
    21211: 'That phone number is not a valid Twilio-usable number.',
    21214: 'That phone number cannot receive calls from this Twilio number.',
    21606: 'Your Twilio number is not capable of calling this destination.',
    21608:
      'The destination number is unverified. On a trial account you must verify it in Twilio → Caller IDs.',
    21610: 'The destination number has opted out of calls from this Twilio number.',
  };
  if (code && known[code]) return `${known[code]} (Twilio error ${code})`;
  return (err && err.message) || 'Could not place the call.';
}

/** <Gather> tuning, overridable through env vars. */
export function gatherSettings(env) {
  const e = env || {};
  return {
    model: cleanStr(e.GATHER_SPEECH_MODEL === undefined ? 'googlev2_telephony' : e.GATHER_SPEECH_MODEL),
    timeout: cleanStr(e.GATHER_SPEECH_TIMEOUT === undefined ? '4' : e.GATHER_SPEECH_TIMEOUT) || '4',
  };
}

/** 16 hex chars - the job id used in every Twilio webhook URL. */
export function newId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Public origin for the Twilio webhooks. PUBLIC_URL wins, else the request origin. */
export function baseUrl(request, env) {
  const explicit = cleanStr((env || {}).PUBLIC_URL).replace(/\/+$/, '');
  if (explicit) return explicit;
  try {
    return new URL(request.url).origin;
  } catch {
    return '';
  }
}

export function createJob({ persona, language, apiKey } = {}) {
  const now = Date.now();
  return {
    id: newId(),
    persona: cleanStr(persona) || DEFAULT_PERSONA,
    language: langKey(language),
    status: 'created',
    geminiKey: cleanStr(apiKey) || null,
    callSid: null,
    to: null,
    noInput: 0,
    greeted: false,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}
