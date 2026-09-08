/** Helpers shared by the SQLite and Postgres adapters. */

/** Normalize a phone/wa id into { waId, phone }. */
export function normalizeWaId(input) {
  const raw = String(input || '').trim();
  const digits = raw.replace(/^whatsapp:/i, '').replace(/[^\d+]/g, '');
  const phone = digits.startsWith('+') ? digits : `+${digits}`;
  return { waId: `whatsapp:${phone}`, phone };
}

/**
 * Both adapters hand the UI the same timestamp shape: "YYYY-MM-DD HH:MM:SS" in UTC.
 * SQLite already stores that; Postgres returns Date objects.
 */
export function toStamp(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

const STAMP_FIELDS = ['created_at', 'last_at', 'updated_at'];

/** Coerce a row so both back ends look identical to the API layer. */
export function normalizeRow(row) {
  if (!row) return row;
  const out = { ...row };
  for (const f of STAMP_FIELDS) if (f in out) out[f] = toStamp(out[f]);
  // Postgres returns BIGINT counts as strings and booleans as true/false.
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'boolean') out[k] = v ? 1 : 0;
    else if (typeof v === 'string' && /^(id|conversation_id|unread|auto_reply|needs_human|total|sent|failed)$/.test(k)) {
      const n = Number(v);
      if (!Number.isNaN(n)) out[k] = n;
    }
  }
  return out;
}

export const normalizeRows = (rows) => (rows || []).map(normalizeRow);

/** Default values for the settings table. */
export const SETTING_DEFAULTS = {
  auto_reply_enabled: 'true',
  agent_name: 'Acme Assistant',
  ai_temperature: '0.3',
  ai_max_tokens: '400',
  escalation_message:
    "Thanks for reaching out! I'm connecting you with a member of our team who will reply here shortly.",
  fallback_on_error: 'true',
  history_turns: '10',
};

export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS);
