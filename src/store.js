/**
 * Persistence for call sessions.
 *
 *  - Cloudflare Workers (Sites): D1, via the env.DB binding, so a conversation
 *    survives isolate switches while Twilio walks the webhook loop.
 *  - Node (Render / local): in-memory Maps, exactly like the original server.
 *
 * Both implementations expose the same async interface.
 */

import { CALL_JOB_TTL_MS } from './shared.js';

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS jobs (
     id TEXT PRIMARY KEY,
     persona TEXT NOT NULL,
     language TEXT NOT NULL,
     status TEXT NOT NULL,
     gemini_key TEXT,
     call_sid TEXT,
     to_number TEXT,
     no_input INTEGER NOT NULL DEFAULT 0,
     greeted INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS turns (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     job_id TEXT NOT NULL,
     role TEXT NOT NULL,
     text TEXT NOT NULL,
     at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS aliases (
     alias TEXT PRIMARY KEY,
     job_id TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_turns_job ON turns (job_id, id)`,
];

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    persona: row.persona,
    language: row.language,
    status: row.status,
    geminiKey: row.gemini_key || null,
    callSid: row.call_sid || null,
    to: row.to_number || null,
    noInput: row.no_input || 0,
    greeted: !!row.greeted,
    lastError: row.last_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createMemoryStore() {
  const jobs = new Map();
  const turns = new Map();
  const aliases = new Map();

  return {
    kind: 'memory',

    async getJob(id) {
      const found = jobs.get(id);
      return found ? { ...found } : null;
    },

    async putJob(job) {
      jobs.set(job.id, { ...job });
    },

    async deleteJob(id) {
      jobs.delete(id);
      turns.delete(id);
    },

    async addTurn(jobId, turn) {
      const list = turns.get(jobId) || [];
      list.push(turn);
      if (list.length > 60) list.shift();
      turns.set(jobId, list);
    },

    async listTurns(jobId) {
      return (turns.get(jobId) || []).slice();
    },

    async getAlias(alias) {
      return aliases.get(alias) || null;
    },

    async setAlias(alias, jobId) {
      aliases.set(alias, jobId);
    },

    async deleteAlias(alias) {
      aliases.delete(alias);
    },

    async sweep() {
      const cutoff = Date.now() - CALL_JOB_TTL_MS;
      for (const [id, job] of jobs) {
        if (job.updatedAt < cutoff) {
          jobs.delete(id);
          turns.delete(id);
        }
      }
      for (const [alias, jobId] of aliases) {
        if (!jobs.has(jobId)) aliases.delete(alias);
      }
    },
  };
}

export function createD1Store(db) {
  let ready;

  const init = () => {
    if (!ready) {
      // D1's exec() splits statements itself and can mangle multi-line DDL,
      // so each statement is prepared and run on its own.
      ready = (async () => {
        for (const sql of SCHEMA_STATEMENTS) {
          await db.prepare(sql).run();
        }
      })().catch((err) => {
        ready = undefined; // allow a retry after a transient failure
        throw err;
      });
    }
    return ready;
  };

  return {
    kind: 'd1',

    async getJob(id) {
      await init();
      return rowToJob(await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first());
    },

    async putJob(job) {
      await init();
      await db
        .prepare(
          `INSERT INTO jobs (id, persona, language, status, gemini_key, call_sid, to_number,
                             no_input, greeted, last_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             persona = excluded.persona, language = excluded.language, status = excluded.status,
             gemini_key = excluded.gemini_key, call_sid = excluded.call_sid, to_number = excluded.to_number,
             no_input = excluded.no_input, greeted = excluded.greeted, last_error = excluded.last_error,
             updated_at = excluded.updated_at`
        )
        .bind(
          job.id,
          job.persona,
          job.language,
          job.status,
          job.geminiKey,
          job.callSid,
          job.to,
          job.noInput,
          job.greeted ? 1 : 0,
          job.lastError,
          job.createdAt,
          job.updatedAt
        )
        .run();
    },

    async deleteJob(id) {
      await init();
      await db.prepare('DELETE FROM turns WHERE job_id = ?').bind(id).run();
      await db.prepare('DELETE FROM jobs WHERE id = ?').bind(id).run();
      await db.prepare('DELETE FROM aliases WHERE job_id = ?').bind(id).run();
    },

    async addTurn(jobId, turn) {
      await init();
      await db
        .prepare('INSERT INTO turns (job_id, role, text, at) VALUES (?, ?, ?, ?)')
        .bind(jobId, turn.role, turn.text, turn.at)
        .run();
      // keep the newest 60 turns per call
      await db
        .prepare(
          `DELETE FROM turns WHERE job_id = ? AND id NOT IN (
             SELECT id FROM turns WHERE job_id = ? ORDER BY id DESC LIMIT 60
           )`
        )
        .bind(jobId, jobId)
        .run();
    },

    async listTurns(jobId) {
      await init();
      const res = await db
        .prepare('SELECT role, text, at FROM turns WHERE job_id = ? ORDER BY id ASC')
        .bind(jobId)
        .all();
      return (res.results || []).map((r) => ({ role: r.role, text: r.text, at: r.at }));
    },

    async getAlias(alias) {
      await init();
      const row = await db.prepare('SELECT job_id FROM aliases WHERE alias = ?').bind(alias).first();
      return row ? row.job_id : null;
    },

    async setAlias(alias, jobId) {
      await init();
      await db
        .prepare(
          'INSERT INTO aliases (alias, job_id) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET job_id = excluded.job_id'
        )
        .bind(alias, jobId)
        .run();
    },

    async deleteAlias(alias) {
      await init();
      await db.prepare('DELETE FROM aliases WHERE alias = ?').bind(alias).run();
    },

    async sweep() {
      await init();
      const cutoff = Date.now() - CALL_JOB_TTL_MS;
      await db
        .prepare(
          `DELETE FROM turns WHERE job_id IN (SELECT id FROM jobs WHERE updated_at < ?)`
        )
        .bind(cutoff)
        .run();
      await db.prepare('DELETE FROM aliases WHERE job_id IN (SELECT id FROM jobs WHERE updated_at < ?)')
        .bind(cutoff)
        .run();
      await db.prepare('DELETE FROM jobs WHERE updated_at < ?').bind(cutoff).run();
    },
  };
}

const STORES = new WeakMap();
let memoryStore = null;

/** Pick the store for this runtime: D1 when env.DB exists, memory otherwise. */
export function getStore(env) {
  if (env && env.DB) {
    let store = STORES.get(env.DB);
    if (!store) {
      store = createD1Store(env.DB);
      STORES.set(env.DB, store);
    }
    return store;
  }
  if (!memoryStore) memoryStore = createMemoryStore();
  return memoryStore;
}
