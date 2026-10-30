/**
 * Node entry point (Render, local development).
 *
 * The HTTP surface lives in src/app.js - the same Hono app that runs on
 * Cloudflare Workers - so both deployments behave identically. Node only adds
 * .env loading and static file serving for /public.
 */

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { app } from './src/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(request) {
  const { pathname } = new URL(request.url);
  let rel;
  try {
    rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  if (rel.includes('\0')) return new Response('Bad request', { status: 400 });

  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return new Response('Not found', { status: 404 });

  try {
    const data = await readFile(file);
    return new Response(data, {
      headers: { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

const fetchHandler = (request) => {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith('/api/')) return app.fetch(request, process.env);
  return serveStatic(request);
};

serve({ fetch: fetchHandler, port: PORT, hostname: '0.0.0.0' }, (info) => {
  const twilioState =
    process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
      ? `configured (${process.env.TWILIO_PHONE_NUMBER || 'no from-number'})`
      : 'MISSING TWILIO CREDENTIALS';
  console.log(`\n  Pocketbandhu is running on http://0.0.0.0:${info.port}`);
  console.log(`  Runtime: Node ${process.version} (Hono)`);
  console.log(`  Model: ${process.env.GEMINI_MODEL || 'gemini-3.8-flash'}`);
  console.log(`  Gemini: ${process.env.GEMINI_API_KEY ? 'configured' : 'MISSING GEMINI_API_KEY'}`);
  console.log(`  Twilio: ${twilioState}`);
  console.log(`  Public URL: ${process.env.PUBLIC_URL || '(derived from each request)'}`);
  console.log('  Dashboard Settings panel can supply any key that is missing here.\n');
});
