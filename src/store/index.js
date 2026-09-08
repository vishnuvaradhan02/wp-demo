import config from '../config.js';
import { createSqliteStore } from './sqlite.js';
import { createPostgresStore } from './postgres.js';

/**
 * One async data interface, two back ends:
 *   DATABASE_URL set  → Postgres (Vercel / Neon / any managed Postgres)
 *   otherwise         → SQLite on local disk (zero-config development)
 */
export const store = config.databaseUrl
  ? createPostgresStore({ connectionString: config.databaseUrl })
  : createSqliteStore({ file: config.dbFile });

let ready = null;
/** Idempotent schema creation; every entry point awaits this once. */
export function initStore() {
  ready ??= store.init().then(() => store);
  return ready;
}

export { normalizeWaId } from './util.js';
export { SETTING_KEYS, SETTING_DEFAULTS } from './util.js';
export default store;
