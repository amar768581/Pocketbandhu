/**
 * Google Gemini - generateContent over plain fetch (works on Workers and Node).
 */

import { MAX_HISTORY_TURNS, buildSystemPrompt, cleanStr, langKey, LANGUAGES } from './shared.js';

export async function askGemini({ env = {}, persona, language, transcript, userText, apiKey }) {
  // Server/deployment env wins; a key pasted into the dashboard fills the gap.
  const key = cleanStr(env.GEMINI_API_KEY) || cleanStr(apiKey);
  if (!key) {
    const err = new Error(
      'Gemini is not configured. Set GEMINI_API_KEY on the server, or add it in Settings -> API keys in the dashboard.'
    );
    err.status = 500;
    throw err;
  }

  const model = cleanStr(env.GEMINI_MODEL) || 'gemini-3.8-flash';
  const lang = LANGUAGES[langKey(language)] || LANGUAGES.en;

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
  // turn with the agent reply that follows it, and never two turns in a row
  // of the same role.
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
    model
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
  const parts =
    (data.candidates && data.candidates[0] && data.candidates[0].content
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
