import express from 'express';
import config from '../config.js';
import {
  listConversations, listMessages, getConversation, getOrCreateConversation,
  updateConversation, deleteConversation, allSettings, setSetting, listLogs, stats,
  normalizeWaId, listTemplates, getTemplate, createBroadcast, finishBroadcast, listBroadcasts, log,
} from '../db.js';
import { initStore, SETTING_KEYS } from '../store/index.js';
import { fetchTemplates, twilioStatus, verifyCredentials } from '../services/twilio.js';
import { contextInfo, readContext, writeContext, azureStatus, testAzure } from '../services/ai.js';
import { sendAndRecord, runAutoReply, recordInbound, autoReplyEnabled } from '../services/messaging.js';
import { addClient } from '../services/events.js';

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Every API call works against a ready schema (matters for serverless cold starts).
router.use(wrap(async (_req, _res, next) => { await initStore(); next(); }));

/* ── status & stats ───────────────────────────────────────── */

router.get('/status', wrap(async (_req, res) => {
  const base = config.publicUrl || `http://localhost:${config.port}`;
  res.json({
    twilio: twilioStatus(),
    azure: azureStatus(),
    context: await contextInfo(),
    publicUrl: config.publicUrl,
    webhookUrl: `${base}/webhook/twilio`,
    statusCallbackUrl: `${base}/webhook/status`,
    settings: await allSettings(),
    dryRun: config.dryRun,
    storage: config.databaseUrl ? 'postgres' : 'sqlite',
  });
}));

router.get('/stats', wrap(async (_req, res) => res.json(await stats())));
router.get('/logs', wrap(async (_req, res) => res.json(await listLogs(200))));

router.post('/test/twilio', wrap(async (_req, res) => res.json(await verifyCredentials())));
router.post('/test/azure', wrap(async (_req, res) => res.json(await testAzure())));

/* ── settings ─────────────────────────────────────────────── */

router.get('/settings', wrap(async (_req, res) => res.json(await allSettings())));

router.put('/settings', wrap(async (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) {
    if (SETTING_KEYS.includes(k)) await setSetting(k, v);
  }
  log('info', 'settings', 'Settings updated', req.body);
  res.json(await allSettings());
}));

/* ── company context ──────────────────────────────────────── */

router.get('/context', wrap(async (_req, res) => res.json({ ...(await contextInfo()), content: await readContext() })));

router.put('/context', wrap(async (req, res) => {
  if (typeof req.body?.content !== 'string') return res.status(400).json({ error: 'content required' });
  await writeContext(req.body.content);
  res.json(await contextInfo());
}));

/* ── templates ────────────────────────────────────────────── */

router.get('/templates', wrap(async (_req, res) => res.json(await listTemplates())));

router.post('/templates/sync', wrap(async (_req, res) => {
  const templates = await fetchTemplates();
  res.json({ ok: true, count: templates.length, templates });
}));

router.post('/templates/preview', wrap(async (req, res) => {
  const { contentSid, variables = {} } = req.body || {};
  const t = await getTemplate(contentSid);
  if (!t) return res.status(404).json({ error: 'template not found' });
  const filled = String(t.body || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => variables[k] ?? m);
  res.json({ ...t, preview: filled });
}));

/* ── conversations & messages ─────────────────────────────── */

router.get('/conversations', wrap(async (req, res) => {
  res.json(await listConversations({ search: req.query.q || '', filter: req.query.filter || 'all' }));
}));

router.post('/conversations', wrap(async (req, res) => {
  const { phone, name } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone required' });
  res.json(await getOrCreateConversation(phone, name));
}));

router.get('/conversations/:id', wrap(async (req, res) => {
  const conv = await getConversation(Number(req.params.id));
  if (!conv) return res.status(404).json({ error: 'not found' });
  await updateConversation(conv.id, { unread: 0 });
  res.json({ conversation: { ...conv, unread: 0 }, messages: await listMessages(conv.id) });
}));

router.patch('/conversations/:id', wrap(async (req, res) => {
  const { auto_reply, needs_human, name } = req.body || {};
  const fields = {};
  if (auto_reply !== undefined) fields.auto_reply = auto_reply ? 1 : 0;
  if (needs_human !== undefined) fields.needs_human = needs_human ? 1 : 0;
  if (name !== undefined) fields.name = name;
  res.json(await updateConversation(Number(req.params.id), fields));
}));

router.delete('/conversations/:id', wrap(async (req, res) => {
  await deleteConversation(Number(req.params.id));
  res.json({ ok: true });
}));

/** Manual send (freeform text, media, or a template) into one conversation. */
router.post('/conversations/:id/messages', wrap(async (req, res) => {
  const conv = await getConversation(Number(req.params.id));
  if (!conv) return res.status(404).json({ error: 'not found' });
  const { body, contentSid, variables, mediaUrl } = req.body || {};
  if (!body && !contentSid && !mediaUrl) {
    return res.status(400).json({ error: 'body, mediaUrl or contentSid required' });
  }
  const result = await sendAndRecord({ to: conv.wa_id, body, contentSid, variables, mediaUrl, source: 'manual' });
  res.status(result.ok ? 200 : 502).json(result);
}));

/** Ask the AI to answer on demand (the "Ask AI" button). */
router.post('/conversations/:id/ai-reply', wrap(async (req, res) => {
  const id = Number(req.params.id);
  await runAutoReply(id);
  res.json({ ok: true, messages: await listMessages(id) });
}));

/* ── send / broadcast ─────────────────────────────────────── */

/**
 * Send to one or many numbers.
 * body: { numbers: string[] | string, mode: 'text'|'template', body?, contentSid?, variables? }
 */
router.post('/send', wrap(async (req, res) => {
  const { mode = 'text', body, contentSid, variables, mediaUrl } = req.body || {};
  const raw = req.body?.numbers;
  const numbers = (Array.isArray(raw) ? raw : String(raw || '').split(/[\s,;\n]+/))
    .map((n) => String(n).trim())
    .filter(Boolean);

  if (!numbers.length) return res.status(400).json({ error: 'Provide at least one number' });
  if (mode === 'template' && !contentSid) return res.status(400).json({ error: 'contentSid required for template mode' });
  if (mode === 'text' && !body && !mediaUrl) return res.status(400).json({ error: 'Message body required' });
  if (numbers.length > 500) return res.status(400).json({ error: 'Maximum 500 recipients per broadcast' });

  const broadcastId = await createBroadcast({
    mode, body, templateSid: contentSid, variables, total: numbers.length,
  });

  const results = [];
  let sent = 0, failed = 0;
  for (const number of numbers) {
    const { phone } = normalizeWaId(number);
    if (!/^\+\d{7,15}$/.test(phone)) {
      failed++;
      results.push({ number, ok: false, error: 'Invalid phone number (use E.164, e.g. +919876543210)' });
      continue;
    }
    const r = await sendAndRecord({
      to: phone,
      body: mode === 'text' ? body : undefined,
      contentSid: mode === 'template' ? contentSid : undefined,
      variables,
      mediaUrl: mode === 'text' ? mediaUrl : undefined,
      source: numbers.length > 1 ? 'broadcast' : 'manual',
    });
    r.ok ? sent++ : failed++;
    results.push({ number: phone, ok: r.ok, sid: r.sid, error: r.error, conversationId: r.conversation.id });
  }

  await finishBroadcast(broadcastId, sent, failed);
  log('info', 'send', `Broadcast #${broadcastId}: ${sent} sent, ${failed} failed`);
  res.json({ ok: failed === 0, broadcastId, total: numbers.length, sent, failed, results });
}));

router.get('/broadcasts', wrap(async (_req, res) => res.json(await listBroadcasts(50))));

/* ── live updates ─────────────────────────────────────────── */

router.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  addClient(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25_000);
  req.on('close', () => clearInterval(ping));
});

/* ── local simulation (no Twilio needed) ──────────────────── */

router.post('/simulate/inbound', wrap(async (req, res) => {
  const { from = '+10000000000', body = 'Hello', name } = req.body || {};
  const { conversation, message } = await recordInbound({
    from, body, profileName: name, messageSid: `SM_SIM_${Date.now()}`,
  });
  if (await autoReplyEnabled(conversation)) {
    runAutoReply(conversation.id).catch(() => {});
  }
  res.json({ ok: true, conversationId: conversation.id, message });
}));

export default router;
