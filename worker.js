/**
 * Cloudflare Workers entry point (Freebuff Sites).
 * Static assets are served by env.ASSETS from the Hono notFound handler;
 * everything under /api is handled above it.
 */

import { app } from './src/app.js';

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
};
