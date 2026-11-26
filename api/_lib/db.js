import { neon } from '@neondatabase/serverless';

let schemaReadyPromise = null;

export function isDbConfigured(env = process.env) {
  return Boolean(env.DATABASE_URL && env.DATABASE_URL.trim());
}

/**
 * Return a Neon serverless SQL query tag and guarantee tables exist (idempotent).
 */
export async function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url || !url.trim()) {
    throw new Error('DATABASE_URL is not configured');
  }
  const sql = neon(url);

  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS users (
          lichess_id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          lichess_token_enc TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS lichess_token_enc TEXT
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS user_repertoires (
          lichess_id TEXT PRIMARY KEY REFERENCES users(lichess_id) ON DELETE CASCADE,
          name TEXT NOT NULL DEFAULT '',
          repertoire_json JSONB NOT NULL,
          updated_at BIGINT NOT NULL
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS user_progress (
          lichess_id TEXT PRIMARY KEY REFERENCES users(lichess_id) ON DELETE CASCADE,
          progress_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at BIGINT NOT NULL
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS user_scout_targets (
          lichess_id TEXT PRIMARY KEY REFERENCES users(lichess_id) ON DELETE CASCADE,
          targets_json JSONB NOT NULL DEFAULT '[]'::jsonb,
          updated_at BIGINT NOT NULL
        )
      `;
    })().catch((err) => {
      schemaReadyPromise = null;
      throw err;
    });
  }

  await schemaReadyPromise;
  return sql;
}
