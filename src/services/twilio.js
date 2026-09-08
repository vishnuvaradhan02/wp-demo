import Twilio from 'twilio';
import config from '../config.js';
import { log, upsertTemplates, listTemplates } from '../db.js';

let client = null;
if (config.twilio.configured) {
  client = Twilio(config.twilio.accountSid, config.twilio.authToken);
}

export function twilioStatus() {
  return {
    configured: config.twilio.configured,
    dryRun: config.dryRun,
    accountSid: config.twilio.configured ? `${config.twilio.accountSid.slice(0, 8)}…${config.twilio.accountSid.slice(-4)}` : '',
    from: config.twilio.from,
    messagingServiceSid: config.twilio.messagingServiceSid || null,
  };
}

/** Basic-auth header for the REST APIs we call directly (Content API). */
function authHeader() {
  const raw = `${config.twilio.accountSid}:${config.twilio.authToken}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

/**
 * Send a WhatsApp message. Either `body` (freeform, inside the 24h window)
 * or `contentSid` (+ optional variables) for an approved template.
 */
export async function sendWhatsApp({ to, body, contentSid, variables, mediaUrl }) {
  const toWa = String(to).startsWith('whatsapp:') ? String(to) : `whatsapp:${to}`;

  if (config.dryRun || !client) {
    const sid = `SM_DRYRUN_${Math.random().toString(36).slice(2, 12)}`;
    log('warn', 'twilio', `DRY RUN — not actually sent to ${toWa}`, { body, contentSid });
    return { sid, status: 'queued', dryRun: true };
  }

  const payload = { to: toWa };
  if (config.twilio.messagingServiceSid) payload.messagingServiceSid = config.twilio.messagingServiceSid;
  else payload.from = config.twilio.from;

  if (contentSid) {
    payload.contentSid = contentSid;
    if (variables && Object.keys(variables).length) {
      payload.contentVariables = JSON.stringify(variables);
    }
  } else {
    payload.body = body;
  }
  if (mediaUrl) payload.mediaUrl = [mediaUrl];
  if (config.publicUrl && !config.publicUrl.includes('your-tunnel')) {
    payload.statusCallback = `${config.publicUrl}/webhook/status`;
  }

  const msg = await client.messages.create(payload);
  return { sid: msg.sid, status: msg.status, dryRun: false };
}

/** Extract the plain-text body and variable placeholders out of a Content template. */
function summarizeContent(item) {
  const types = item.types || {};
  const typeKeys = Object.keys(types);
  let body = '';
  for (const key of typeKeys) {
    const t = types[key] || {};
    if (t.body) { body = t.body; break; }
    if (t.title) { body = t.title; break; }
  }
  const vars = new Set(String(body).match(/\{\{\s*(\w+)\s*\}\}/g)?.map((v) => v.replace(/[^\w]/g, '')) || []);
  for (const k of Object.keys(item.variables || {})) vars.add(k);
  return { body, types: typeKeys, variables: [...vars] };
}

/** Fetch WhatsApp content templates (with approval status) from Twilio and cache them. */
export async function fetchTemplates() {
  if (!config.twilio.configured) {
    throw new Error('Twilio is not configured — add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to .env');
  }

  const items = [];
  let url = 'https://content.twilio.com/v1/ContentAndApprovals?PageSize=50';
  while (url && items.length < 500) {
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Twilio Content API ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    items.push(...(data.contents || []));
    const next = data.meta?.next_page_url;
    url = next && next !== url ? next : null;
  }

  await upsertTemplates(items.map((item) => {
    const { body, types, variables } = summarizeContent(item);
    const approval = item.approval_requests || {};
    return {
      sid: item.sid,
      friendly_name: item.friendly_name || '',
      language: item.language || '',
      body,
      variables,
      types,
      status: approval.status || 'unsubmitted',
      category: approval.category || '',
    };
  }));

  log('info', 'twilio', `Fetched ${items.length} content template(s) from Twilio`);
  return listTemplates();
}

/** Verify the X-Twilio-Signature header on an incoming webhook. */
export function validateSignature(req) {
  if (!config.twilio.validateSignature) return true;
  if (!config.twilio.authToken) return false;
  const signature = req.header('X-Twilio-Signature') || '';
  if (!signature) return false;

  // Twilio signs the exact URL it called. Behind a proxy or a platform rewrite the
  // request may not reproduce that verbatim, so accept a match on either the host
  // the request arrived on or the configured public URL.
  const candidates = new Set();
  const host = req.get('x-forwarded-host') || req.get('host');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  if (host) candidates.add(`${proto}://${host}${req.originalUrl}`);
  if (config.publicUrl) candidates.add(`${config.publicUrl}${req.originalUrl}`);

  for (const url of candidates) {
    if (Twilio.validateRequest(config.twilio.authToken, signature, url, req.body || {})) return true;
  }
  log('error', 'webhook', 'Twilio signature did not match', { tried: [...candidates] });
  return false;
}

/** Quick credential check used by the Settings screen. */
export async function verifyCredentials() {
  if (!config.twilio.configured) return { ok: false, error: 'Credentials missing or placeholder' };
  try {
    const acc = await client.api.v2010.accounts(config.twilio.accountSid).fetch();
    return { ok: true, friendlyName: acc.friendlyName, status: acc.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
