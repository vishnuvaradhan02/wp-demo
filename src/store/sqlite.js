import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeRow, normalizeRows, SETTING_DEFAULTS } from './util.js';

/**
 * SQLite adapter (local development / any host with a real disk).
 * The API is async to match the Postgres adapter, even though the driver is sync.
 */
export function createSqliteStore({ file }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS conversations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_id          TEXT NOT NULL UNIQUE,
  phone          TEXT NOT NULL,
  name           TEXT,
  auto_reply     INTEGER NOT NULL DEFAULT 1,
  needs_human    INTEGER NOT NULL DEFAULT 0,
  unread         INTEGER NOT NULL DEFAULT 0,
  last_message   TEXT,
  last_direction TEXT,
  last_at        TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
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
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
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
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS broadcasts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  mode         TEXT NOT NULL,
  body         TEXT,
  template_sid TEXT,
  variables    TEXT,
  total        INTEGER NOT NULL DEFAULT 0,
  sent         INTEGER NOT NULL DEFAULT 0,
  failed       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  level      TEXT NOT NULL DEFAULT 'info',
  scope      TEXT,
  message    TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

  const get = (sql, ...p) => normalizeRow(db.prepare(sql).get(...p));
  const all = (sql, ...p) => normalizeRows(db.prepare(sql).all(...p));
  const run = (sql, ...p) => db.prepare(sql).run(...p);

  return {
    kind: 'sqlite',
    async init() {},
    async close() { db.close(); },

    /* settings */
    async allSettings() {
      const out = { ...SETTING_DEFAULTS };
      for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
      return out;
    },
    async setSetting(key, value) {
      run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key, String(value));
    },

    /* conversations */
    async getConversation(id) { return get('SELECT * FROM conversations WHERE id = ?', id); },
    async getConversationByWaId(waId) { return get('SELECT * FROM conversations WHERE wa_id = ?', waId); },
    async createConversation(waId, phone, name) {
      run('INSERT INTO conversations (wa_id, phone, name, auto_reply) VALUES (?, ?, ?, 1)', waId, phone, name ?? null);
      return get('SELECT * FROM conversations WHERE wa_id = ?', waId);
    },
    async listConversations({ search = '', filter = 'all' } = {}) {
      const clauses = [];
      const params = [];
      if (search) {
        clauses.push("(phone LIKE ? OR IFNULL(name, '') LIKE ? OR IFNULL(last_message, '') LIKE ?)");
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }
      if (filter === 'unread') clauses.push('unread > 0');
      if (filter === 'human') clauses.push('needs_human = 1');
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      return all(`SELECT * FROM conversations ${where} ORDER BY COALESCE(last_at, created_at) DESC LIMIT 300`, ...params);
    },
    async updateConversation(id, fields) {
      const sets = [];
      const params = [];
      for (const [k, v] of Object.entries(fields)) {
        if (!['auto_reply', 'needs_human', 'name', 'unread'].includes(k)) continue;
        sets.push(`${k} = ?`);
        params.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
      }
      if (sets.length) run(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
      return get('SELECT * FROM conversations WHERE id = ?', id);
    },
    async deleteConversation(id) { run('DELETE FROM conversations WHERE id = ?', id); },
    async touchConversation(id, { body, direction, incrementUnread = false, needsHuman }) {
      run(
        `UPDATE conversations
            SET last_message = ?, last_direction = ?, last_at = datetime('now'),
                unread = CASE WHEN ? = 1 THEN unread + 1 ELSE unread END,
                needs_human = COALESCE(?, needs_human)
          WHERE id = ?`,
        (body || '').slice(0, 300), direction, incrementUnread ? 1 : 0,
        needsHuman === undefined ? null : needsHuman ? 1 : 0, id
      );
    },

    /* messages */
    async addMessage(m) {
      const info = run(
        `INSERT INTO messages
           (conversation_id, direction, body, media_url, status, error, message_sid, source, template_sid, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        m.conversationId, m.direction, m.body ?? null, m.mediaUrl ?? null,
        m.status ?? (m.direction === 'in' ? 'received' : 'queued'),
        m.error ?? null, m.messageSid ?? null, m.source ?? 'manual',
        m.templateSid ?? null, m.meta ? JSON.stringify(m.meta) : null
      );
      return get('SELECT * FROM messages WHERE id = ?', info.lastInsertRowid);
    },
    async listMessages(conversationId, limit = 200) {
      return all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?', conversationId, limit).reverse();
    },
    async updateMessageStatus(sid, status, error) {
      run('UPDATE messages SET status = ?, error = COALESCE(?, error) WHERE message_sid = ?', status, error ?? null, sid);
    },
    async getMessageBySid(sid) { return get('SELECT * FROM messages WHERE message_sid = ?', sid); },

    /* templates */
    async upsertTemplates(items) {
      const stmt = db.prepare(
        `INSERT INTO templates (sid, friendly_name, language, body, variables, types, status, category, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(sid) DO UPDATE SET
           friendly_name = excluded.friendly_name, language = excluded.language, body = excluded.body,
           variables = excluded.variables, types = excluded.types, status = excluded.status,
           category = excluded.category, updated_at = excluded.updated_at`
      );
      for (const t of items) {
        stmt.run(t.sid, t.friendly_name, t.language, t.body,
          JSON.stringify(t.variables), JSON.stringify(t.types), t.status, t.category);
      }
    },
    async listTemplates() {
      return all('SELECT * FROM templates ORDER BY friendly_name COLLATE NOCASE');
    },

    /* broadcasts */
    async createBroadcast(b) {
      const info = run('INSERT INTO broadcasts (mode, body, template_sid, variables, total) VALUES (?, ?, ?, ?, ?)',
        b.mode, b.body ?? null, b.templateSid ?? null, b.variables ? JSON.stringify(b.variables) : null, b.total);
      return Number(info.lastInsertRowid);
    },
    async finishBroadcast(id, sent, failed) {
      run('UPDATE broadcasts SET sent = ?, failed = ? WHERE id = ?', sent, failed, id);
    },
    async listBroadcasts(limit = 50) {
      return all('SELECT * FROM broadcasts ORDER BY id DESC LIMIT ?', limit);
    },

    /* logs */
    async addLog(level, scope, message, detail) {
      run('INSERT INTO logs (level, scope, message, detail) VALUES (?, ?, ?, ?)', level, scope, message, detail);
      db.exec('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 500)');
    },
    async listLogs(limit = 200) { return all('SELECT * FROM logs ORDER BY id DESC LIMIT ?', limit); },

    /* stats */
    async stats() {
      const one = (sql) => db.prepare(sql).get();
      return {
        conversations: one('SELECT COUNT(*) c FROM conversations').c,
        messagesIn: one("SELECT COUNT(*) c FROM messages WHERE direction = 'in'").c,
        messagesOut: one("SELECT COUNT(*) c FROM messages WHERE direction = 'out'").c,
        aiReplies: one("SELECT COUNT(*) c FROM messages WHERE source = 'ai'").c,
        needsHuman: one('SELECT COUNT(*) c FROM conversations WHERE needs_human = 1').c,
        unread: one('SELECT COUNT(*) c FROM conversations WHERE unread > 0').c,
        failed: one("SELECT COUNT(*) c FROM messages WHERE status = 'failed'").c,
        last7days: db.prepare(
          `SELECT date(created_at) d,
                  SUM(direction = 'in')  AS inbound,
                  SUM(direction = 'out') AS outbound
             FROM messages WHERE created_at >= datetime('now', '-7 days')
            GROUP BY d ORDER BY d`).all(),
      };
    },
  };
}
