/**
 * Thin domain layer over the storage adapter (see src/store/).
 * Everything here is async; the adapter decides SQLite vs Postgres.
 */
import { store } from './store/index.js';
import { normalizeWaId } from './store/util.js';

export { normalizeWaId };
export { store };

/* ── settings ─────────────────────────────────────────────── */

/** Keys prefixed with an underscore are internal (e.g. the knowledge base) and hidden from the settings API. */
export async function allSettings() {
  const all = await store.allSettings();
  return Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith('_')));
}
export const setSetting = (key, value) => store.setSetting(key, value);
export const getSetting = (key) => store.getSetting(key);

/* ── conversations ────────────────────────────────────────── */

export async function getOrCreateConversation(input, name) {
  const { waId, phone } = normalizeWaId(input);
  const existing = await store.getConversationByWaId(waId);
  if (!existing) return store.createConversation(waId, phone, name);
  if (name && !existing.name) return store.updateConversation(existing.id, { name });
  return existing;
}

export const getConversation = (id) => store.getConversation(id);
export const listConversations = (opts) => store.listConversations(opts);
export const updateConversation = (id, fields) => store.updateConversation(id, fields);
export const deleteConversation = (id) => store.deleteConversation(id);
export const touchConversation = (id, opts) => store.touchConversation(id, opts);

/* ── messages ─────────────────────────────────────────────── */

/** Insert a message and roll the conversation's preview/unread state forward. */
export async function addMessage(m) {
  const message = await store.addMessage(m);
  await store.touchConversation(m.conversationId, {
    body: m.body,
    direction: m.direction,
    incrementUnread: m.direction === 'in',
    needsHuman: m.needsHuman,
  });
  return message;
}

export const listMessages = (conversationId, limit) => store.listMessages(conversationId, limit);
export const updateMessageStatus = (sid, status, error) => store.updateMessageStatus(sid, status, error);
export const getMessageBySid = (sid) => store.getMessageBySid(sid);

/* ── templates, broadcasts ────────────────────────────────── */

export const upsertTemplates = (items) => store.upsertTemplates(items);
export const createBroadcast = (b) => store.createBroadcast(b);
export const finishBroadcast = (id, sent, failed) => store.finishBroadcast(id, sent, failed);
export const listBroadcasts = (limit) => store.listBroadcasts(limit);

/** Templates are stored with JSON-encoded columns; hand callers real arrays. */
export async function listTemplates() {
  const rows = await store.listTemplates();
  return rows.map((t) => ({
    ...t,
    variables: safeParse(t.variables, []),
    types: safeParse(t.types, []),
  }));
}

export async function getTemplate(sid) {
  return (await listTemplates()).find((t) => t.sid === sid) || null;
}

function safeParse(value, fallback) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value;
  try { return JSON.parse(value || 'null') ?? fallback; } catch { return fallback; }
}

/* ── logs & stats ─────────────────────────────────────────── */

export function log(level, scope, message, detail) {
  const line = `[${scope}] ${message}`;
  if (level === 'error') console.error(line, detail ?? '');
  else console.log(line);
  // Logging must never break a request, and callers do not await it.
  return store.addLog(
    level, scope,
    String(message ?? '').slice(0, 500),
    detail ? String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 2000) : null
  ).catch(() => {});
}

export const listLogs = (limit) => store.listLogs(limit);
export const stats = () => store.stats();
