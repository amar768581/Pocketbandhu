# Pocketbandhu 🤝 — AI Calling Agent

**Pocketbandhu** is a small, complete AI calling agent: it dials a phone number with the
**Twilio Voice API**, listens to the caller with TwiML `<Gather input="speech">`
(Bengali · Hindi · English), answers with **Google Gemini**, and speaks the reply back —
keeping the conversation looping until the call ends.

It also lets you **test the whole agent for free in your browser** with the Web Speech API
(speech recognition in, speech synthesis out), so you never need phone credits to try a persona.

The backend is a single **[Hono](https://hono.dev)** app, so the identical code runs in two
places: as a **Cloudflare Worker on Freebuff Sites** (D1 for session storage) and as a **Node
service on Render** (in-memory storage). Twilio and Gemini are both called with plain `fetch` —
no SDKs.

```
Browser dashboard ──► POST /api/make-call ──► Twilio dials the phone
                                                 │
                       Twilio ◄── /api/voice  ◄─┘   <Gather input="speech"> greeting
                          │                          (bn-IN / hi-IN / en-IN)
                          └──► /api/respond  ──►  Gemini generateContent
                                    ▲                    │
                                    └── <Say> reply ──────┘   loop until hang-up

Browser voice test ──► /api/chat ──► Gemini ──► Web Speech synthesis
```

---

## Features

| Area | What you get |
| --- | --- |
| Outbound calling | `POST /api/make-call` places the call, passes persona + language through the TwiML URL |
| Speech listening | `/api/voice` returns TwiML `<Gather input="speech">` for `bn-IN`, `hi-IN`, `en-IN` |
| AI replies | `/api/respond` sends `SpeechResult` to Gemini and speaks a short, natural reply back |
| Conversation memory | Turn history is kept per call and fed to Gemini, so it never repeats its greeting |
| Browser testing | `POST /api/chat` + Web Speech API = free, no-SIM testing of any persona |
| Dashboard | Dark, mobile-friendly UI: number field (+91 prefix), persona textarea, language selector, two buttons, live transcript |
| Call status | Twilio status callbacks + `GET /api/call/:jobId` feed the live transcript and status pill |
| API keys panel | Paste `GEMINI_API_KEY` and the optional Twilio credentials in the browser (localStorage) — used wherever the server has no `.env` |
| 1-click deploy | `render.yaml` blueprint for Render, `sites.manifest.json` + esbuild bundle for Sites |
| Runs anywhere | One Hono app: Cloudflare Workers (Sites) or Node (Render, local) |

---

## 1. Requirements

* A **Twilio** account — <https://console.twilio.com>
* A **Google Gemini API key** — <https://aistudio.google.com/apikey>
* **Node.js 20+** for local development and the Render deployment (the Sites deployment is a
  prebuilt bundle and needs nothing installed)

---

## 2. Local setup

```bash
git clone <your-repo-url> pocketbandhu
cd pocketbandhu
npm install
cp .env.example .env
# now edit .env and fill in your keys
npm start
```

Open <http://localhost:3000>.

### Environment variables (`.env`)

| Variable | Required | Description |
| --- | --- | --- |
| `TWILIO_ACCOUNT_SID` | ✅ | From the Twilio Console dashboard |
| `TWILIO_AUTH_TOKEN` | ✅ | From the Twilio Console dashboard (click to reveal) |
| `TWILIO_PHONE_NUMBER` | ✅ | The Twilio number placing the call, E.164, e.g. `+15005550006` |
| `GEMINI_API_KEY` | ✅ | Google AI Studio API key |
| `PUBLIC_URL` | ✅ | Public base URL of this server, no trailing slash |
| `GEMINI_MODEL` | optional | Default `gemini-3.8-flash` (use `gemini-3.5-flash-lite` for cheaper turns) |
| `GATHER_SPEECH_MODEL` | optional | Default `googlev2_telephony` (supports bn/hi/en-IN) |
| `GATHER_SPEECH_TIMEOUT` | optional | Seconds of silence before Twilio submits, default `4` |
| `PORT` | optional | Default `3000` (Render sets this for you) |

> Never commit `.env`. It is git-ignored.

---

## 3. Twilio configuration

1. Buy (or use the free trial) voice number that can call out.
2. **Trial accounts can only call verified numbers**: add your phone under
   **Caller ID → Verified Caller IDs** in the Twilio Console, otherwise the API returns
   error `21608`.
3. Nothing else to configure — the app passes the TwiML URL per call, so no phone-number
   webhook configuration is needed.

---

## 4. Public URL for the webhooks (local development)

Twilio must be able to reach `/api/voice`, `/api/respond` and `/api/status`, so expose your
local server with a tunnel:

```bash
ngrok http 3000
```

Copy the `https://….ngrok-free.app` URL into `.env`:

```env
PUBLIC_URL=https://abc123.ngrok-free.app
```

Restart the server. If `PUBLIC_URL` is empty, the server falls back to the origin Twilio is
calling (handy behind ngrok/Render), but setting it explicitly is safer.

---

## 5. Deploy to Freebuff Sites (Cloudflare Workers)

**Live preview (published):**
<https://site-d6ee9666b7a54f649164915a4d2a74f2.freebuff.page>

Because the backend is Hono, the same `src/app.js` runs on Workers:

* `npm run build` bundles `worker.js` with esbuild into `dist/worker.js` (no `twilio` or
  `express` runtime — Twilio and Gemini are plain `fetch` calls).
* `sites.manifest.json` ships that bundle plus `public/` as static assets.
* Session state lives in **D1** (binding `DB`), so a conversation survives isolate switches
  while Twilio walks the webhook loop. The schema (`jobs`, `turns`, `aliases`) is created
  automatically on first use — no migrations to run.
* Without the binding (Node/local) the store falls back to in-memory `Map`s, so nothing has
  to be configured.

To redeploy: `npm run build`, then publish the new build from the Sites panel. Twilio can hit
`/api/voice`, `/api/respond` and `/api/status` directly on the public URL — no tunnel needed.
Paste your keys in **API keys & settings** on first visit, or store them as site secrets
(Sites → Secrets) so every visitor shares them.

---

## 6. Deploy to Render (1-click)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/amar768581/Pocketbandhu)

The repo ships a [`render.yaml`](render.yaml) blueprint, so Render does the configuration
for you:

1. Click the button above (or **New → Blueprint** in the Render dashboard and pick this repo).
2. Render reads `render.yaml` and offers to create a **free** Node web service with
   `npm install` / `npm start` and `healthCheckPath: /`.
3. It asks for the four secrets (`GEMINI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
   `TWILIO_PHONE_NUMBER`) — each is marked `sync: false`, so you type them in during setup.
   **You can skip them all** and paste them later in the dashboard's *API keys & settings* panel.
4. `PUBLIC_URL` is wired automatically: the blueprint self-references the service's own
   `RENDER_EXTERNAL_URL`, so the TwiML and status-callback URLs always match the deployed
   origin — no manual editing or redeploy loop.
5. Open `https://pocketbandhu.onrender.com`, enter a number, press **Call phone number**.

Manual alternative: **New → Web Service → Connect repo**, Runtime *Node*, build
`npm install`, start `npm start`, then add the env vars yourself.

> **Heads-up:** Render's free tier sleeps after inactivity, so the first call after idle can
> fail or take ~30 s to wake the service. Use a paid/stable instance for real calling.

Any other host works the same way (Railway, Fly.io, a VPS…): run `npm start` and set
`PUBLIC_URL` to the public `https://` origin. Without `PUBLIC_URL` the server derives the
origin from each incoming Twilio request, which also works behind a proxy.

---

## 7. Using the dashboard

* **Phone number** — type 10 digits and the `+91` prefix is added automatically; pick another
  country code, or choose *Full number* and type the whole thing including `+`.
* **Agent persona / system prompt** — this becomes Gemini's system instruction for both the
  phone call and the browser test, e.g.
  *"You are Pocketbandhu, a friendly assistant speaking in Bengali and English."*
* **Language** — sets Twilio's recognition language, the `<Say>` language, and the language
  Gemini replies in.
* **API keys & settings** (collapsible panel at the bottom of the controls) — paste your
  `GEMINI_API_KEY` and, if you like, `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` /
  `TWILIO_PHONE_NUMBER`, then press **Save keys**.

  How it behaves:

  * Keys are stored in **this browser only** (`localStorage`) and sent along with
    `/api/chat` and `/api/make-call`. The server uses them **only for values missing from
    its own `.env`** — a server-side value always wins — and never writes them to disk,
    logs or responses.
  * During a phone call the Gemini key is held **in memory for that call only**, so
    `/api/respond` can answer; it is dropped when the call transcript expires.
  * Nothing here is mandatory: with no browser keys the app runs purely on `.env`.
  * Treat it as a personal-testing convenience. `localStorage` is readable by any script
    running on the page, so use test keys, and press **Clear all** on a shared machine.
    For production, prefer keeping every secret in the server's `.env` / Render env vars.
* **Call phone number** — real outbound call through Twilio (uses your Twilio balance).
* **Test voice in browser** — speak into your mic; the browser transcribes it, `/api/chat`
  asks Gemini, and the reply is spoken back with `speechSynthesis`. Free, no credits.
  Works best in **Chrome / Edge** (the Web Speech API is not available in Firefox/Safari).

The right-hand panel streams the transcript live: phone turns are polled from
`GET /api/call/:id`, browser turns appear as they happen.

---

## 8. API reference

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/make-call` | `{ phone, persona?, language? }` → places the Twilio call |
| `*` | `/api/voice` | TwiML: welcome + `<Gather input="speech">`, re-prompts on silence |
| `*` | `/api/respond` | TwiML: `SpeechResult` → Gemini → `<Say>` → re-gathers (the loop) |
| `POST` | `/api/chat` | `{ message, persona?, language?, history? }` → `{ reply }` — browser testing |
| `GET` | `/api/call/:jobId` | `{ status, transcript[] }` for the dashboard |
| `*` | `/api/status` | Twilio call-status callback (cleans up finished calls) |

Example (curl):

```bash
curl -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Hello! Who are you?","language":"bn"}'
```

---

## 9. Project structure

```
pocketbandhu/
├── worker.js           # Cloudflare Workers entry (Sites)
├── server.js           # Node entry: .env + static files (Render / local)
├── src/
│   ├── app.js          # Hono app: every route, TwiML webhooks, JSON APIs
│   ├── ai.js           # Gemini generateContent over fetch
│   ├── twilio.js       # Twilio Calls REST over fetch
│   ├── store.js        # D1 store (Workers) + in-memory store (Node)
│   ├── twiml.js        # <Gather>/<Say>/<Redirect>/<Hangup> builders
│   └── shared.js       # languages, prompts, phone normalisation, helpers
├── public/
│   └── index.html      # Dark mobile-first dashboard + Web Speech voice test
├── dist/worker.js      # esbuild bundle uploaded to Sites (generated)
├── sites.manifest.json # Freebuff Sites deploy manifest
├── wrangler.jsonc      # local workerd + D1 testing (`npm run dev:workers`)
├── render.yaml         # Render Blueprint
├── package.json
├── .env.example        # copy to .env for the Node/Render run
└── README.md
```

---

## 10. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `403 … 21608` when calling | Trial account: verify the destination number in Twilio → Caller IDs |
| Call connects, no reply | Check `GEMINI_API_KEY`; look at the Render/terminal logs for `Gemini error` |
| Twilio error `30006` / webhook unreachable | `PUBLIC_URL` must be a public `https://` origin with no trailing slash |
| `<Gather>` returns no transcript | Make sure `GATHER_SPEECH_MODEL` is set (default `googlev2_telephony`) so `bn-IN` is supported |
| "Gemini API error 404" | The model id in `GEMINI_MODEL` is unavailable on your key — use `gemini-3.8-flash` or `gemini-3.5-flash-lite` |
| Browser mic button does nothing | Use Chrome/Edge and serve the page over `https://` or `localhost` (mic permission) |
| Replies are too slow | Use `gemini-3.5-flash-lite`, and lower `GATHER_SPEECH_TIMEOUT` to `3` |

---

## 11. Notes & limits

* Conversation state lives **in D1** on Sites and **in memory** on Node; both are swept an
  hour after the last activity. A Node restart drops active transcripts (the call keeps going
  with default settings).
* On Sites, a Gemini key pasted into the dashboard is held in that call's D1 row so
  `/api/respond` can answer. No endpoint ever returns it, and it disappears with the
  transcript — deployment-level keys (site secrets / `.env`) are never stored per call.
* Twilio webhook signature validation is intentionally not enforced so preview URLs and local
  tunnels keep working; verify the `X-Twilio-Signature` header against your auth token on
  `/api/voice`, `/api/respond` and `/api/status` before handling sensitive traffic in production.
* Gemini replies are capped at ~150 output tokens and trimmed to 600 characters because
  they are read aloud by a phone voice.
* Each call spends real Twilio minutes and Gemini tokens.

MIT
