import pg from 'pg';
import { normalizeRow, normalizeRows, SETTING_DEFAULTS } from './util.js';

/**
 * Postgres adapter (Vercel / Neon / Supabase / any managed Postgres).
 * Uses a small pool so it behaves under serverless cold starts; point
 * DATABASE_URL at the provider's *pooled* connection string.
 */
export function createPostgresStore({ connectionString }) {
  const pool = new pg.Pool({
    connectionString,
    max: Number(process.env.PGPOOL_MAX || 3),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // Let an explicit sslmode in the URL win (Neon/Supabase set sslmode=require
    // and present valid certificates); otherwise default to verified TLS.
    ...(/[?&]sslmode=/.test(connectionString) ? {} : { ssl: { rejectUnauthorized: true } }),
  });

  const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const one = async (sql, params = []) => normalizeRow((await pool.query(sql, params)).rows[0] || null);
  const many = async (sql, params = []) => normalizeRows((await pool.query(sql, params)).rows);
  const count = async (sql) => Number((await pool.query(sql)).rows[0]?.c ?? 0);

  return {
    kind: 'postgres',

    async init() {
      await pool.query(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS conversations (
  id             SERIAL PRIMARY KEY,
  wa_id          TEXT NOT NULL UNIQUE,
  phone          TEXT NOT NULL,
  name           TEXT,
  auto_reply     INTEGER NOT NULL DEFAULT 1,
  needs_human    INTEGER NOT NULL DEFAULT 0,
  unread         INTEGER NOT NULL DEFAULT 0,
  last_message   TEXT,
  last_direction TEXT,
  last_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction       TEXT NOT NULL,
  body            TEXT,
  media_url       TEXT,
  status          TEXT NOT NULL DEFAULT 'received',
  error           TEXT,
  message_sid     TEXT,
  source          TEXT NOT NULL DEFAULT 'manual',
  template_sid    TEXT,
  meta            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_sid  ON messages(message_sid);

CREATE TABLE IF NOT EXISTS templates (
  sid           TEXT PRIMARY KEY,
  friendly_name TEXT,
  language      TEXT,
  body          TEXT,
  variables     TEXT,
  types         TEXT,
  status        TEXT,
  category      TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS broadcasts (
  id           SERIAL PRIMARY KEY,
  mode         TEXT NOT NULL,
  body         TEXT,
  template_sid TEXT,
  variables    TEXT,
  total        INTEGER NOT NULL DEFAULT 0,
  sent         INTEGER NOT NULL DEFAULT 0,
  failed       INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logs (
  id         SERIAL PRIMARY KEY,
  level      TEXT NOT NULL DEFAULT 'info',
  scope      TEXT,
  message    TEXT,
  detail     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`);
    },

    async close() { await pool.end(); },

    /* settings */
    async allSettings() {
      const out = { ...SETTING_DEFAULTS };
      for (const r of await q('SELECT key, value FROM settings')) out[r.key] = r.value;
      return out;
    },
    async setSetting(key, value) {
      await pool.query(
        'INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value',
        [key, String(value)]);
    },

    /* conversations */
    async getConversation(id) { return one('SELECT * FROM conversations WHERE id = $1', [id]); },
    async getConversationByWaId(waId) { return one('SELECT * FROM conversations WHERE wa_id = $1', [waId]); },
    async createConversation(waId, phone, name) {
      return one(
        `INSERT INTO conversations (wa_id, phone, name, auto_reply) VALUES ($1, $2, $3, 1)
         ON CONFLICT (wa_id) DO UPDATE SET name = COALESCE(conversations.name, EXCLUDED.name)
         RETURNING *`, [waId, phone, name ?? null]);
    },
    async listConversations({ search = '', filter = 'all' } = {}) {
      const clauses = [];
      const params = [];
      if (search) {
        params.push(`%${search}%`);
        clauses.push(`(phone ILIKE $${params.length} OR COALESCE(name,'') ILIKE $${params.length} OR COALESCE(last_message,'') ILIKE $${params.length})`);
      }
      if (filter === 'unread') clauses.push('unread > 0');
      if (filter === 'human') clauses.push('needs_human = 1');
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      return many(`SELECT * FROM conversations ${where} ORDER BY COALESCE(last_at, created_at) DESC LIMIT 300`, params);
    },
    async updateConversation(id, fields) {
      const sets = [];
      const params = [];
      for (const [k, v] of Object.entries(fields)) {
        if (!['auto_reply', 'needs_human', 'name', 'unread'].includes(k)) continue;
        params.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
        sets.push(`${k} = $${params.length}`);
      }
      if (sets.length) {
        params.push(id);
        await pool.query(`UPDATE conversations SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      }
      return one('SELECT * FROM conversations WHERE id = $1', [id]);
    },
    async deleteConversation(id) { await pool.query('DELETE FROM conversations WHERE id = $1', [id]); },
    async touchConversation(id, { body, direction, incrementUnread = false, needsHuman }) {
      await pool.query(
        `UPDATE conversations
            SET last_message = $1, last_direction = $2, last_at = NOW(),
                unread = CASE WHEN $3 THEN unread + 1 ELSE unread END,
                needs_human = COALESCE($4, needs_human)
          WHERE id = $5`,
        [(body || '').slice(0, 300), direction, Boolean(incrementUnread),
         needsHuman === undefined ? null : needsHuman ? 1 : 0, id]);
    },

    /* messages */
    async addMessage(m) {
      return one(
        `INSERT INTO messages
           (conversation_id, direction, body, media_url, status, error, message_sid, source, template_sid, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [m.conversationId, m.direction, m.body ?? null, m.mediaUrl ?? null,
         m.status ?? (m.direction === 'in' ? 'received' : 'queued'),
         m.error ?? null, m.messageSid ?? null, m.source ?? 'manual',
         m.templateSid ?? null, m.meta ? JSON.stringify(m.meta) : null]);
    },
    async listMessages(conversationId, limit = 200) {
      const rows = await many(
        'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2', [conversationId, limit]);
      return rows.reverse();
    },
    async updateMessageStatus(sid, status, error) {
      await pool.query('UPDATE messages SET status = $1, error = COALESCE($2, error) WHERE message_sid = $3',
        [status, error ?? null, sid]);
    },
    async getMessageBySid(sid) { return one('SELECT * FROM messages WHERE message_sid = $1', [sid]); },

    /* templates */
    async upsertTemplates(items) {
      for (const t of items) {
        await pool.query(
          `INSERT INTO templates (sid, friendly_name, language, body, variables, types, status, category, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
           ON CONFLICT(sid) DO UPDATE SET
             friendly_name = EXCLUDED.friendly_name, language = EXCLUDED.language, body = EXCLUDED.body,
             variables = EXCLUDED.variables, types = EXCLUDED.types, status = EXCLUDED.status,
             category = EXCLUDED.category, updated_at = EXCLUDED.updated_at`,
          [t.sid, t.friendly_name, t.language, t.body,
           JSON.stringify(t.variables), JSON.stringify(t.types), t.status, t.category]);
      }
    },
    async listTemplates() { return many('SELECT * FROM templates ORDER BY LOWER(friendly_name)'); },

    /* broadcasts */
    async createBroadcast(b) {
      const row = await one(
        'INSERT INTO broadcasts (mode, body, template_sid, variables, total) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [b.mode, b.body ?? null, b.templateSid ?? null, b.variables ? JSON.stringify(b.variables) : null, b.total]);
      return Number(row.id);
    },
    async finishBroadcast(id, sent, failed) {
      await pool.query('UPDATE broadcasts SET sent = $1, failed = $2 WHERE id = $3', [sent, failed, id]);
    },
    async listBroadcasts(limit = 50) { return many('SELECT * FROM broadcasts ORDER BY id DESC LIMIT $1', [limit]); },

    /* logs */
    async addLog(level, scope, message, detail) {
      await pool.query('INSERT INTO logs (level, scope, message, detail) VALUES ($1,$2,$3,$4)',
        [level, scope, message, detail]);
      await pool.query('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 500)');
    },
    async listLogs(limit = 200) { return many('SELECT * FROM logs ORDER BY id DESC LIMIT $1', [limit]); },

    /* stats */
    async stats() {
      return {
        conversations: await count('SELECT COUNT(*) c FROM conversations'),
        messagesIn: await count("SELECT COUNT(*) c FROM messages WHERE direction = 'in'"),
        messagesOut: await count("SELECT COUNT(*) c FROM messages WHERE direction = 'out'"),
        aiReplies: await count("SELECT COUNT(*) c FROM messages WHERE source = 'ai'"),
        needsHuman: await count('SELECT COUNT(*) c FROM conversations WHERE needs_human = 1'),
        unread: await count('SELECT COUNT(*) c FROM conversations WHERE unread > 0'),
        failed: await count("SELECT COUNT(*) c FROM messages WHERE status = 'failed'"),
        last7days: (await q(
          `SELECT to_char(created_at::date, 'YYYY-MM-DD') d,
                  COUNT(*) FILTER (WHERE direction = 'in')  AS inbound,
                  COUNT(*) FILTER (WHERE direction = 'out') AS outbound
             FROM messages WHERE created_at >= NOW() - INTERVAL '7 days'
            GROUP BY 1 ORDER BY 1`)).map((r) => ({
              d: r.d, inbound: Number(r.inbound), outbound: Number(r.outbound),
            })),
      };
    },
  };
}
