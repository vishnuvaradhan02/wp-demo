import express from 'express';
import config from '../config.js';
import { log, updateMessageStatus, getMessageBySid } from '../db.js';
import { initStore } from '../store/index.js';
import { validateSignature } from '../services/twilio.js';
import { recordInbound, runAutoReply, autoReplyEnabled } from '../services/messaging.js';
import { emit } from '../services/events.js';

const router = express.Router();

/**
 * Incoming WhatsApp messages.
 * Point Twilio here:  <PUBLIC_URL>/webhook/twilio   (HTTP POST)
 *
 * Note: if the sender belongs to a Messaging Service, Twilio uses the service's
 * "Incoming Message" URL and ignores the sender-level webhook — set it there.
 */
router.post('/twilio', async (req, res) => {
  await initStore();

  if (!validateSignature(req)) {
    log('error', 'webhook', 'Rejected inbound webhook — invalid Twilio signature');
    return res.status(403).type('text/xml').send('<Response/>');
  }

  const p = req.body || {};
  const from = p.From || p.from;
  if (!from) return res.status(400).type('text/xml').send('<Response/>');

  const numMedia = Number(p.NumMedia || 0);
  const mediaUrl = numMedia > 0 ? p.MediaUrl0 : null;
  const body = p.Body || (mediaUrl ? '[media]' : '');

  const { conversation } = await recordInbound({
    from,
    body,
    mediaUrl,
    messageSid: p.MessageSid || p.SmsMessageSid,
    profileName: p.ProfileName,
  });
  log('info', 'webhook', `Inbound from ${conversation.phone}: ${String(body).slice(0, 120)}`);

  const shouldReply = await autoReplyEnabled(conversation);

  // Serverless functions may be frozen the moment the response is sent, so the
  // reply has to finish inline there. On a long-lived server we ack immediately
  // (Twilio times out at ~15s) and answer out of band.
  if (shouldReply && config.isServerless) {
    try { await runAutoReply(conversation.id); }
    catch (err) { log('error', 'ai', 'Auto-reply crashed', err.message); }
    return res.type('text/xml').send('<Response/>');
  }

  res.type('text/xml').send('<Response/>');
  if (shouldReply) {
    runAutoReply(conversation.id).catch((err) => log('error', 'ai', 'Auto-reply crashed', err.message));
  }
});

/** Delivery status callbacks: <PUBLIC_URL>/webhook/status */
router.post('/status', async (req, res) => {
  await initStore();
  if (!validateSignature(req)) return res.status(403).send('');
  const p = req.body || {};
  const sid = p.MessageSid || p.SmsSid;
  if (sid && p.MessageStatus) {
    await updateMessageStatus(sid, p.MessageStatus,
      p.ErrorMessage || (p.ErrorCode ? `Twilio error ${p.ErrorCode}` : null));
    const row = await getMessageBySid(sid);
    if (row) emit('status', { conversationId: row.conversation_id, sid, status: p.MessageStatus });
  }
  res.status(204).send('');
});

/** Twilio "fallback URL" target — logs why a webhook failed. */
router.post('/fallback', async (req, res) => {
  await initStore();
  log('error', 'webhook', 'Twilio reported a webhook failure', req.body);
  res.type('text/xml').send('<Response/>');
});

/** Convenience: GET the webhook URL in a browser to confirm it is reachable. */
router.get('/twilio', (_req, res) =>
  res.json({ ok: true, hint: 'Configure this URL as an HTTP POST webhook in Twilio.' }));

export default router;
