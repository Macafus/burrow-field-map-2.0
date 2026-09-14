import { env } from "cloudflare:workers";

let databaseReady: Promise<unknown> | null = null;

export function getD1() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }
  return env.DB;
}

export async function ensureDatabase() {
  databaseReady ??= getD1().batch([
    getD1().prepare(`
      CREATE TABLE IF NOT EXISTS app_states (
        id TEXT PRIMARY KEY NOT NULL,
        data TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
  ]);

  try {
    await databaseReady;
  } catch (error) {
    databaseReady = null;
    throw error;
  }
}
