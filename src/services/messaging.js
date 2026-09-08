import {
  addMessage, getOrCreateConversation, listMessages, allSettings, log,
  getConversation, updateConversation,
} from '../db.js';
import { sendWhatsApp } from './twilio.js';
import { generateReply } from './ai.js';
import { emit } from './events.js';

/**
 * Send one outbound WhatsApp message and record it against a conversation.
 * Never throws — failures are stored on the message row so the UI can show them.
 */
export async function sendAndRecord({ to, body, contentSid, variables, mediaUrl, source = 'manual', name }) {
  const conv = await getOrCreateConversation(to, name);
  try {
    const result = await sendWhatsApp({ to: conv.wa_id, body, contentSid, variables, mediaUrl });
    const record = await addMessage({
      conversationId: conv.id,
      direction: 'out',
      body: body ?? null,
      mediaUrl: mediaUrl ?? null,
      status: result.dryRun ? 'dry-run' : result.status || 'queued',
      messageSid: result.sid,
      source,
      templateSid: contentSid ?? null,
      meta: variables ? { variables } : null,
    });
    emit('message', { conversationId: conv.id, message: record });
    return { ok: true, conversation: conv, message: record, sid: result.sid, dryRun: result.dryRun };
  } catch (err) {
    const record = await addMessage({
      conversationId: conv.id,
      direction: 'out',
      body: body ?? null,
      status: 'failed',
      error: err.message,
      source,
      templateSid: contentSid ?? null,
    });
    log('error', 'send', `Failed to send to ${conv.phone}`, err.message);
    emit('message', { conversationId: conv.id, message: record });
    return { ok: false, conversation: conv, message: record, error: err.message };
  }
}

/** Record an inbound message from the Twilio webhook. */
export async function recordInbound({ from, body, mediaUrl, messageSid, profileName }) {
  const conv = await getOrCreateConversation(from, profileName);
  const message = await addMessage({
    conversationId: conv.id,
    direction: 'in',
    body,
    mediaUrl,
    status: 'received',
    messageSid,
    source: 'inbound',
  });
  emit('message', { conversationId: conv.id, message });
  emit('conversation', { conversationId: conv.id });
  return { conversation: conv, message };
}

/** Decide whether the bot should answer this conversation. */
export async function autoReplyEnabled(conv) {
  const settings = await allSettings();
  return settings.auto_reply_enabled === 'true' && conv.auto_reply === 1;
}

/**
 * Generate and send an AI answer for the latest inbound message.
 * Runs after the webhook has already responded to Twilio (or inline on serverless).
 */
export async function runAutoReply(conversationId) {
  const conv = await getConversation(conversationId);
  if (!conv) return;
  if (!(await autoReplyEnabled(conv))) {
    log('info', 'ai', `Auto-reply off for ${conv.phone} — leaving for a human`);
    return;
  }

  const settings = await allSettings();
  const history = await listMessages(conv.id, 40);
  emit('typing', { conversationId: conv.id });

  try {
    const answer = await generateReply({ history, contact: { name: conv.name } });
    const text = answer.needsHuman ? settings.escalation_message : answer.reply;

    await sendAndRecord({ to: conv.wa_id, body: text, source: 'ai' });
    await updateConversation(conv.id, { needs_human: answer.needsHuman ? 1 : 0 });
    emit('conversation', { conversationId: conv.id });

    log('info', 'ai', `Auto-replied to ${conv.phone}${answer.needsHuman ? ' (escalated to human)' : ''}`,
      { category: answer.category, confidence: answer.confidence });
  } catch (err) {
    log('error', 'ai', `Auto-reply failed for ${conv.phone}`, err.message);
    if (settings.fallback_on_error === 'true') {
      await sendAndRecord({ to: conv.wa_id, body: settings.escalation_message, source: 'ai' });
      await updateConversation(conv.id, { needs_human: 1 });
      emit('conversation', { conversationId: conv.id });
    }
  }
}
