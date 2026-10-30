/**
 * Pocketbandhu - the whole HTTP surface as a Hono app.
 *
 * Hono runs unchanged on Cloudflare Workers (Sites) and on Node (Render/local),
 * so this single file backs both deployments. Storage is picked per runtime by
 * getStore(): D1 on Workers, in-memory Maps on Node.
 */

import { Hono } from 'hono';
import { askGemini } from './ai.js';
import { placeCall } from './twilio.js';
import { getStore } from './store.js';
import { XML_CONTENT_TYPE, voiceTwiML } from './twiml.js';
import {
  DEFAULT_PERSONA,
  LANGUAGES,
  MAX_HISTORY_TURNS,
  baseUrl,
  buildSystemPrompt,
  cleanStr,
  createJob,
  describeTwilioError,
  gatherSettings,
  langFor,
  langKey,
  normalizePhone,
} from './shared.js';

const TERMINAL_STATUSES = ['completed', 'busy', 'failed', 'no-answer', 'canceled'];

/* ------------------------------------------------------------------ *
 * Request helpers
 * ------------------------------------------------------------------ */

async function jsonBody(c) {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

/** Query string + form/JSON body, flattened (Twilio mixes both). */
async function paramsOf(c) {
  const query = c.req.query();
  const type = c.req.header('content-type') || '';
  let body = {};
  if (type.includes('json')) {
    body = await jsonBody(c);
  } else if (type.includes('form') || type.includes('multipart')) {
    try {
      body = await c.req.parseBody();
    } catch {
      body = {};
    }
  }
  return { ...query, ...body };
}

function fail(c, err, fallbackStatus = 500, message = 'Internal server error.') {
  const status = err && err.status ? err.status : fallbackStatus;
  const text = err && err.message ? err.message : message;
  console.error('error:', text);
  return c.json({ error: text }, status);
}

function twiml(c, xml) {
  return c.body(xml, 200, XML_CONTENT_TYPE);
}

/** Look a job up by direct id, then by any alias (query id or CallSid). */
async function findJob(store, key, sid) {
  if (key) {
    const direct = await store.getJob(key);
    if (direct) return direct;
    const aliased = await store.getAlias(key);
    if (aliased) {
      const job = await store.getJob(aliased);
      if (job) return job;
    }
  }
  if (sid) {
    const aliased = await store.getAlias(sid);
    if (aliased) {
      const job = await store.getJob(aliased);
      if (job) return job;
    }
  }
  return null;
}

/** Resolve the job behind a Twilio webhook (query id first, CallSid fallback). */
async function resolveJob(store, params) {
  const wanted = cleanStr(params.job);
  const sid = cleanStr(params.CallSid);

  const existing = await findJob(store, wanted, sid);
  if (existing) {
    // Remember the CallSid so later status callbacks reach this session too.
    if (sid && (await store.getAlias(sid)) !== existing.id) {
      await store.setAlias(sid, existing.id);
    }
    return { job: existing, id: existing.id };
  }

  // Call placed outside /api/make-call: adopt it with default settings.
  const job = createJob({});
  await store.putJob(job);
  if (sid) await store.setAlias(sid, job.id);
  if (wanted) await store.setAlias(wanted, job.id);
  return { job, id: job.id };
}

/* ------------------------------------------------------------------ *
 * App
 * ------------------------------------------------------------------ */

export function createApp() {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    if (c.req.path.startsWith('/api/')) {
      console.log(`${c.req.method} ${c.req.path} -> ${c.res.status} (${Date.now() - started}ms)`);
    }
  });

  /* ------------------------------- /api/chat ------------------------------ */
  app.post('/api/chat', async (c) => {
    try {
      const body = await jsonBody(c);
      const message = cleanStr(body.message);
      if (!message) {
        return c.json({ error: 'Send a "message" to talk to the agent.' }, 400);
      }

      const language = langKey(body.language);
      const persona = cleanStr(body.persona) || DEFAULT_PERSONA;
      const transcript = Array.isArray(body.history)
        ? body.history
            .filter((t) => t && (t.role === 'user' || t.role === 'agent') && cleanStr(t.text))
            .slice(-MAX_HISTORY_TURNS)
            .map((t) => ({ role: t.role, text: cleanStr(t.text).slice(0, 2000) }))
        : [];

      const reply = await askGemini({
        env: c.env,
        persona,
        language,
        transcript,
        userText: message,
        apiKey: cleanStr(body.geminiApiKey),
      });

      return c.json({ reply, language });
    } catch (err) {
      return fail(c, err);
    }
  });

  /* ----------------------------- /api/make-call --------------------------- */
  app.post('/api/make-call', async (c) => {
    const store = getStore(c.env);
    const body = await jsonBody(c);
    const to = normalizePhone(body.phone);

    if (!to) {
      return c.json(
        {
          error:
            'Enter a valid phone number, e.g. 9876543210 (a +91 prefix is added for you) or +14155550123.',
        },
        400
      );
    }

    const job = createJob({
      persona: body.persona,
      language: body.language,
      apiKey: body.geminiApiKey,
    });

    // Deployment env wins; dashboard-supplied values fill any gap.
    const from = cleanStr(c.env.TWILIO_PHONE_NUMBER) || cleanStr(body.twilioPhoneNumber);
    const accountSid = cleanStr(c.env.TWILIO_ACCOUNT_SID) || cleanStr(body.twilioAccountSid);
    const authToken = cleanStr(c.env.TWILIO_AUTH_TOKEN) || cleanStr(body.twilioAuthToken);

    if (!from) {
      await store.deleteJob(job.id).catch(() => {});
      return c.json(
        {
          error:
            'No calling number. Set TWILIO_PHONE_NUMBER on the server, or add it in Settings -> API keys in the dashboard.',
        },
        500
      );
    }

    try {
      const origin = baseUrl(c.req.raw, c.env);
      const call = await placeCall({ accountSid, authToken, to, from, origin, jobId: job.id });

      job.callSid = call.sid;
      job.status = 'initiated';
      job.to = to;
      job.updatedAt = Date.now();

      await store.putJob(job);
      await store.setAlias(call.sid, job.id);
      await store.sweep().catch(() => {});

      console.log(`Call ${call.sid} -> ${to} (${LANGUAGES[job.language].label})`);
      return c.json({
        ok: true,
        jobId: job.id,
        callSid: call.sid,
        to,
        language: job.language,
        status: job.status,
      });
    } catch (err) {
      await store.deleteJob(job.id).catch(() => {});
      console.error('Twilio call error:', err.message);
      return c.json({ error: describeTwilioError(err) }, err.status || 502);
    }
  });

  /* ------------------------------- /api/voice ----------------------------- */
  /** Twilio's first webhook: greet the caller and start listening. */
  app.all('/api/voice', async (c) => {
    try {
      const store = getStore(c.env);
      const params = await paramsOf(c);
      const { job, id } = await resolveJob(store, params);
      const lang = langFor(job);

      const sayText = job.greeted ? lang.speakPrompt : lang.greet;
      if (!job.greeted) {
        job.greeted = true;
        await store.addTurn(job.id, { role: 'agent', text: sayText, at: Date.now() });
      }

      job.noInput += 1;
      job.updatedAt = Date.now();
      const hangup = job.noInput >= 3;
      if (hangup) job.status = 'no-input';
      await store.putJob(job);

      return twiml(
        c,
        voiceTwiML({
          sayText,
          lang,
          jobId: id,
          settings: gatherSettings(c.env),
          hangup,
        })
      );
    } catch (err) {
      return fail(c, err, 500, 'Voice webhook error.');
    }
  });

  /* ------------------------------ /api/respond ---------------------------- */
  /** SpeechResult -> Gemini -> spoken reply -> re-open the <Gather>. */
  app.all('/api/respond', async (c) => {
    try {
      const store = getStore(c.env);
      const params = await paramsOf(c);
      const { job, id } = await resolveJob(store, params);
      const lang = langFor(job);
      const settings = gatherSettings(c.env);

      const speech = cleanStr(params.SpeechResult).slice(0, 1000);

      if (!speech) {
        job.noInput += 1;
        job.updatedAt = Date.now();
        await store.putJob(job);
        return twiml(
          c,
          voiceTwiML({ sayText: lang.fallback, lang, jobId: id, settings })
        );
      }

      job.noInput = 0;
      await store.addTurn(job.id, { role: 'user', text: speech, at: Date.now() });
      const history = await store.listTurns(job.id);

      let reply;
      try {
        reply = await askGemini({
          env: c.env,
          persona: job.persona,
          language: job.language,
          transcript: history,
          userText: speech,
          apiKey: job.geminiKey,
        });
        job.lastError = null;
      } catch (err) {
        console.error('Reply error:', err.message);
        job.lastError = err.message;
        reply = lang.fallback;
      }

      await store.addTurn(job.id, { role: 'agent', text: reply, at: Date.now() });
      job.updatedAt = Date.now();
      await store.putJob(job);

      return twiml(c, voiceTwiML({ sayText: reply, lang, jobId: id, settings }));
    } catch (err) {
      return fail(c, err, 500, 'Reply webhook error.');
    }
  });

  /* ------------------------------- /api/status ---------------------------- */
  /** Twilio call lifecycle callback; marks finished calls and frees the session. */
  app.all('/api/status', async (c) => {
    try {
      const store = getStore(c.env);
      const params = await paramsOf(c);
      const sid = cleanStr(params.CallSid);
      const status = cleanStr(params.CallStatus) || 'unknown';

      const key = cleanStr(params.job);
      const job = await findJob(store, key, sid);

      if (job) {
        job.status = status;
        job.updatedAt = Date.now();
        await store.putJob(job);
        if (TERMINAL_STATUSES.includes(status)) {
          if (sid) await store.deleteAlias(sid);
          console.log(`Call ${sid || job.callSid} ended: ${status}`);
        }
      }
      return c.body(null, 204);
    } catch (err) {
      console.error('Status callback error:', err.message);
      return c.body(null, 204); // never make Twilio retry forever
    }
  });

  /* ---------------------------- /api/call/:jobId -------------------------- */
  /** Polling endpoint that feeds the live transcript in the dashboard. */
  app.get('/api/call/:jobId', async (c) => {
    try {
      const store = getStore(c.env);
      const job = await store.getJob(c.req.param('jobId'));
      if (!job) return c.json({ error: 'Unknown call.' }, 404);

      const transcript = await store.listTurns(job.id);
      return c.json({
        jobId: job.id,
        callSid: job.callSid,
        to: job.to || null,
        status: job.status,
        language: job.language,
        error: job.lastError,
        transcript,
      });
    } catch (err) {
      return fail(c, err);
    }
  });

  /* --------------------------------- misc --------------------------------- */

  app.notFound(async (c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'Not found.' }, 404);
    if (c.env && c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
    return c.text('Not found', 404);
  });

  return app;
}

export const app = createApp();
