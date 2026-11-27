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
      await sql`
        CREATE TABLE IF NOT EXISTS insight_player_archives (
          src TEXT NOT NULL,
          acct TEXT NOT NULL,
          display_name TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          total_games INTEGER NOT NULL DEFAULT 0,
          perfs_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          newest_ms BIGINT NOT NULL DEFAULT 0,
          oldest_ms BIGINT NOT NULL DEFAULT 0,
          complete BOOLEAN NOT NULL DEFAULT FALSE,
          months_done JSONB NOT NULL DEFAULT '[]'::jsonb,
          last_sync_at BIGINT NOT NULL DEFAULT 0,
          sync_error TEXT NOT NULL DEFAULT '',
          sync_lock_until BIGINT NOT NULL DEFAULT 0,
          requested_by TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (src, acct)
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS insight_games (
          src TEXT NOT NULL,
          acct TEXT NOT NULL,
          game_id TEXT NOT NULL,
          played_at BIGINT NOT NULL,
          seq BIGSERIAL NOT NULL,
          record_json JSONB NOT NULL,
          PRIMARY KEY (src, acct, game_id)
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_insight_games_src_acct_seq
        ON insight_games (src, acct, seq)
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS user_insight_sources (
          lichess_id TEXT NOT NULL REFERENCES users(lichess_id) ON DELETE CASCADE,
          src TEXT NOT NULL,
          acct TEXT NOT NULL,
          display_name TEXT NOT NULL,
          added_at BIGINT NOT NULL,
          PRIMARY KEY (lichess_id, src, acct)
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS user_pgn_games (
          lichess_id TEXT NOT NULL REFERENCES users(lichess_id) ON DELETE CASCADE,
          acct TEXT NOT NULL,
          game_id TEXT NOT NULL,
          played_at BIGINT NOT NULL,
          seq BIGSERIAL NOT NULL,
          record_json JSONB NOT NULL,
          PRIMARY KEY (lichess_id, game_id)
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_user_pgn_games_user_seq
        ON user_pgn_games (lichess_id, seq)
      `;
    })().catch((err) => {
      schemaReadyPromise = null;
      throw err;
    });
  }

  await schemaReadyPromise;
  return sql;
}
