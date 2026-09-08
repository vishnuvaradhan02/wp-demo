/* WhatsApp Comms Console — dashboard client */

/* ── helpers ──────────────────────────────────────────────── */
const $ = (sel, root = document) => root.querySelector(sel);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(message, kind = 'ok') {
  const node = el(`<div class="toast ${kind === 'bad' ? 'bad' : ''}">${esc(message)}</div>`);
  $('#toasts').append(node);
  setTimeout(() => { node.style.opacity = '0'; setTimeout(() => node.remove(), 250); }, 3800);
}

const timeShort = (iso) => {
  if (!iso) return '';
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
               : d.toLocaleDateString([], { day: '2-digit', month: 'short' });
};
const timeFull = (iso) => (iso ? new Date(iso.replace(' ', 'T') + 'Z').toLocaleString() : '');
const initials = (c) => (c.name ? c.name.trim().slice(0, 2).toUpperCase() : (c.phone || '').slice(-2));

/* ── state ────────────────────────────────────────────────── */
const state = {
  view: 'overview',
  status: null,
  conversations: [],
  activeId: null,
  messages: [],
  templates: [],
  filter: 'all',
  search: '',
};

/* ── shell ────────────────────────────────────────────────── */
const TITLES = {
  overview: 'Overview', inbox: 'Inbox', send: 'Send message',
  templates: 'Templates', knowledge: 'Knowledge base', settings: 'Settings', logs: 'Activity',
};

function go(view) {
  state.view = view;
  location.hash = view;
  for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('active', b.dataset.view === view);
  $('#view-title').textContent = TITLES[view] || view;
  $('#topbar-actions').innerHTML = '';
  const host = $('#view');
  host.className = view === 'inbox' ? 'view flush' : 'view';
  host.innerHTML = '';
  views[view](host);
}

function renderStatusPills() {
  const s = state.status;
  if (!s) return;
  const set = (id, ok, label, title) => {
    const p = $(id);
    p.className = `pill ${ok ? 'ok' : 'bad'}`;
    p.innerHTML = `<i class="dot"></i>${label}`;
    p.title = title;
  };
  set('#pill-twilio', s.twilio.configured, 'Twilio', s.twilio.configured ? `Account ${s.twilio.accountSid}` : 'Add Twilio keys to .env');
  set('#pill-azure', s.azure.configured, 'Azure AI', s.azure.configured ? `Deployment ${s.azure.deployment}` : 'Add Azure OpenAI keys to .env');
  $('#pill-dry').hidden = !s.dryRun;
  $('#pill-dry').title = 'Twilio calls are simulated — no real messages are sent';
  const on = s.settings.auto_reply_enabled === 'true';
  $('#auto-toggle').checked = on;
  $('#auto-sub').textContent = on ? 'AI answers everyone' : 'Manual replies only';
}

async function refreshStatus() {
  state.status = await api('/status');
  renderStatusPills();
}

async function refreshConversations() {
  const q = new URLSearchParams({ q: state.search, filter: state.filter });
  state.conversations = await api(`/conversations?${q}`);
  const unread = state.conversations.filter((c) => c.unread > 0).length;
  const badge = $('#badge-inbox');
  badge.hidden = unread === 0;
  badge.textContent = unread;
}

/* ── views ────────────────────────────────────────────────── */
const views = {};

/* Overview ------------------------------------------------- */
views.overview = async (host) => {
  host.innerHTML = '<div class="grid cols-4" id="stat-cards"></div>';
  const s = state.status;
  const stats = await api('/stats');

  const card = (k, v, d = '') => `<div class="card stat"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
  $('#stat-cards', host).innerHTML =
    card('Conversations', stats.conversations, `${stats.unread} unread`) +
    card('Messages received', stats.messagesIn) +
    card('Messages sent', stats.messagesOut, `${stats.failed} failed`) +
    card('AI auto-replies', stats.aiReplies, `${stats.needsHuman} need a human`);

  const max = Math.max(1, ...stats.last7days.flatMap((d) => [d.inbound, d.outbound]));
  const bars = stats.last7days.length
    ? stats.last7days.map((d) => `
        <div class="bar-col">
          <div class="bar-stack">
            <div class="bar in" style="height:${(d.inbound / max) * 100}%" title="${d.inbound} received"></div>
            <div class="bar out" style="height:${(d.outbound / max) * 100}%" title="${d.outbound} sent"></div>
          </div>
          <div class="bar-label">${new Date(d.d).toLocaleDateString([], { weekday: 'short' })}</div>
        </div>`).join('')
    : '<div class="empty" style="flex:1">No message activity yet</div>';

  host.append(el(`
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card">
        <div class="card-head"><h2>Last 7 days</h2><div class="spacer"></div>
          <div class="legend"><span><i style="background:var(--blue)"></i>Received</span><span><i style="background:var(--accent)"></i>Sent</span></div>
        </div>
        <div class="card-body"><div class="bars">${bars}</div></div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Connection</h2></div>
        <div class="card-body stack">
          <div class="row"><span class="pill ${s.twilio.configured ? 'ok' : 'bad'}">Twilio ${s.twilio.configured ? 'connected' : 'not configured'}</span>
            <span class="pill ${s.azure.configured ? 'ok' : 'bad'}">Azure OpenAI ${s.azure.configured ? 'connected' : 'not configured'}</span>
            ${s.dryRun ? '<span class="pill warn">Dry run</span>' : ''}</div>
          <label class="field">Inbound webhook — paste this into the Twilio console
            <div class="copyrow"><code>${esc(s.webhookUrl)}</code><button class="btn btn-sm" data-copy="${esc(s.webhookUrl)}">Copy</button></div>
          </label>
          <label class="field">Status callback
            <div class="copyrow"><code>${esc(s.statusCallbackUrl)}</code><button class="btn btn-sm" data-copy="${esc(s.statusCallbackUrl)}">Copy</button></div>
          </label>
          <div class="hint">WhatsApp sender: <b>${esc(s.twilio.from || '—')}</b> · Knowledge base: ${s.context.chars} characters</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Test the automation</h2></div>
        <div class="card-body stack">
          <div class="hint">Simulate an inbound WhatsApp message locally — the AI answers it exactly as it would in production.</div>
          <div class="row">
            <input type="text" id="sim-from" value="+919876543210" style="max-width:180px" placeholder="From number">
            <input type="text" id="sim-body" value="What is the price of the SmartCam and how long is delivery?" style="flex:1;min-width:220px">
            <button class="btn btn-primary" id="sim-go">Simulate</button>
          </div>
        </div>
      </div>
    </div>`));

  $('#sim-go', host).onclick = async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('/simulate/inbound', { method: 'POST', body: { from: $('#sim-from').value, body: $('#sim-body').value } });
      toast('Inbound message simulated — open the Inbox to see the reply');
      state.activeId = r.conversationId;
      go('inbox');
    } catch (err) { toast(err.message, 'bad'); }
    finally { e.target.disabled = false; }
  };
};

/* Inbox ---------------------------------------------------- */
views.inbox = async (host) => {
  host.innerHTML = `
    <div class="inbox">
      <div class="conv-list">
        <div class="conv-tools">
          <input type="text" id="conv-search" placeholder="Search name, number or text" value="${esc(state.search)}">
          <div class="filters">
            <button data-filter="all">All</button>
            <button data-filter="unread">Unread</button>
            <button data-filter="human">Needs human</button>
          </div>
          <button class="btn btn-sm" id="new-conv">+ New conversation</button>
        </div>
        <div class="conv-scroll" id="conv-scroll"></div>
      </div>
      <div class="chat" id="chat"></div>
    </div>`;

  for (const b of host.querySelectorAll('.filters button')) {
    b.classList.toggle('active', b.dataset.filter === state.filter);
    b.onclick = async () => { state.filter = b.dataset.filter; await refreshConversations(); renderConvList(); for (const x of host.querySelectorAll('.filters button')) x.classList.toggle('active', x.dataset.filter === state.filter); };
  }
  let searchTimer;
  $('#conv-search', host).oninput = (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => { state.search = e.target.value; await refreshConversations(); renderConvList(); }, 220);
  };
  $('#new-conv', host).onclick = async () => {
    const phone = prompt('Phone number in E.164 format (e.g. +919876543210)');
    if (!phone) return;
    try {
      const conv = await api('/conversations', { method: 'POST', body: { phone } });
      await refreshConversations(); renderConvList(); openConversation(conv.id);
    } catch (err) { toast(err.message, 'bad'); }
  };

  await refreshConversations();
  renderConvList();
  const first = state.activeId || state.conversations[0]?.id;
  if (first) openConversation(first); else renderChatEmpty();
};

function renderConvList() {
  const host = $('#conv-scroll');
  if (!host) return;
  if (!state.conversations.length) {
    host.innerHTML = '<div class="empty">No conversations yet.<br>Send a message or wait for an inbound one.</div>';
    return;
  }
  host.innerHTML = state.conversations.map((c) => `
    <div class="conv ${c.id === state.activeId ? 'active' : ''}" data-id="${c.id}">
      <div class="avatar">${esc(initials(c))}</div>
      <div style="min-width:0">
        <div class="top">
          <span class="name">${esc(c.name || c.phone)}</span>
          <span class="time">${timeShort(c.last_at)}</span>
        </div>
        <div class="prev">${c.last_direction === 'out' ? '↗ ' : ''}${esc(c.last_message || 'No messages yet')}</div>
        <div class="tags">
          ${c.unread ? `<span class="unread-dot">${c.unread}</span>` : ''}
          ${c.needs_human ? '<span class="pill warn" style="font-size:10px;padding:0 6px">needs human</span>' : ''}
          ${c.auto_reply ? '' : '<span class="pill" style="font-size:10px;padding:0 6px">auto off</span>'}
        </div>
      </div>
    </div>`).join('');
  for (const node of host.querySelectorAll('.conv')) node.onclick = () => openConversation(Number(node.dataset.id));
}

function renderChatEmpty() {
  $('#chat').innerHTML = '<div class="empty" style="margin:auto"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><div>Select a conversation</div></div>';
}

async function openConversation(id) {
  state.activeId = id;
  const { conversation, messages } = await api(`/conversations/${id}`);
  state.messages = messages;
  await refreshConversations();
  renderConvList();
  renderChat(conversation);
}

function bubble(m) {
  const tags = [];
  if (m.source === 'ai') tags.push('AI');
  if (m.source === 'broadcast') tags.push('Broadcast');
  if (m.template_sid) tags.push('Template');
  if (m.status === 'dry-run') tags.push('Dry run');
  return `
    <div class="msg ${m.direction === 'in' ? 'in' : 'out'} ${m.status === 'failed' ? 'err' : ''}" title="${esc(timeFull(m.created_at))}${m.error ? ' — ' + esc(m.error) : ''}">
      ${m.media_url ? `<div><a href="${esc(m.media_url)}" target="_blank" rel="noopener">📎 attachment</a></div>` : ''}
      <div class="text">${esc(m.body || '')}</div>
      <div class="meta">
        ${tags.map((t) => `<span class="tag">${t}</span>`).join('')}
        <span>${timeShort(m.created_at)}</span>
        ${m.direction === 'out' ? `<span>${m.status === 'failed' ? '⚠︎' : m.status === 'delivered' || m.status === 'read' ? '✓✓' : '✓'}</span>` : ''}
      </div>
    </div>`;
}

function renderChat(conv) {
  const chat = $('#chat');
  chat.innerHTML = `
    <div class="chat-head">
      <div class="avatar">${esc(initials(conv))}</div>
      <div style="min-width:0">
        <div class="who">${esc(conv.name || conv.phone)}</div>
        <div class="sub mono">${esc(conv.phone)}</div>
      </div>
      <div class="spacer" style="flex:1"></div>
      <label class="row micro" style="gap:8px" title="Auto-reply for this conversation only">
        <span class="switch"><input type="checkbox" id="conv-auto" ${conv.auto_reply ? 'checked' : ''}><span></span></span> Auto-reply
      </label>
      <button class="btn btn-sm" id="ai-now" title="Generate an AI answer to the last message now">Ask AI</button>
      <button class="btn btn-sm btn-ghost" id="mark-done" title="Clear the needs-human flag">${conv.needs_human ? 'Resolve' : '✓'}</button>
    </div>
    <div class="chat-scroll" id="chat-scroll">${state.messages.map(bubble).join('') || '<div class="empty" style="margin:auto">No messages yet</div>'}</div>
    <div class="composer">
      <div class="line">
        <select id="tpl-pick" style="max-width:190px"><option value="">Freeform text…</option>${state.templates.map((t) => `<option value="${t.sid}">${esc(t.friendly_name || t.sid)}</option>`).join('')}</select>
        <textarea id="composer-text" rows="1" placeholder="Type a message…  (Enter to send, Shift+Enter for a new line)"></textarea>
        <button class="btn btn-primary" id="send-msg">Send</button>
      </div>
      <div id="tpl-vars"></div>
    </div>`;

  const scroll = $('#chat-scroll');
  scroll.scrollTop = scroll.scrollHeight;

  $('#conv-auto').onchange = async (e) => {
    await api(`/conversations/${conv.id}`, { method: 'PATCH', body: { auto_reply: e.target.checked } });
    toast(e.target.checked ? 'Auto-reply on for this chat' : 'Auto-reply off — you reply manually');
    await refreshConversations(); renderConvList();
  };
  $('#mark-done').onclick = async () => {
    await api(`/conversations/${conv.id}`, { method: 'PATCH', body: { needs_human: false } });
    await refreshConversations(); renderConvList();
  };
  $('#ai-now').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Thinking…';
    try { await api(`/conversations/${conv.id}/ai-reply`, { method: 'POST' }); await openConversation(conv.id); }
    catch (err) { toast(err.message, 'bad'); }
    finally { e.target.disabled = false; e.target.textContent = 'Ask AI'; }
  };

  const tplPick = $('#tpl-pick');
  const tplVars = $('#tpl-vars');
  const text = $('#composer-text');
  tplPick.onchange = () => {
    const t = state.templates.find((x) => x.sid === tplPick.value);
    tplVars.innerHTML = '';
    if (!t) { text.disabled = false; text.placeholder = 'Type a message…'; return; }
    text.disabled = true;
    text.placeholder = t.body || '(template)';
    if (t.variables.length) {
      tplVars.innerHTML = `<div class="var-grid">${t.variables.map((v) => `<input type="text" data-var="${esc(v)}" placeholder="{{${esc(v)}}}">`).join('')}</div>`;
    }
  };

  const send = async () => {
    const btn = $('#send-msg');
    const contentSid = tplPick.value || undefined;
    const body = contentSid ? undefined : text.value.trim();
    if (!contentSid && !body) return;
    const variables = {};
    for (const i of tplVars.querySelectorAll('[data-var]')) if (i.value) variables[i.dataset.var] = i.value;
    btn.disabled = true;
    try {
      const r = await api(`/conversations/${conv.id}/messages`, { method: 'POST', body: { body, contentSid, variables } });
      if (!r.ok) toast(r.error || 'Send failed', 'bad');
      text.value = ''; tplPick.value = ''; tplVars.innerHTML = ''; text.disabled = false;
      await openConversation(conv.id);
    } catch (err) { toast(err.message, 'bad'); }
    finally { btn.disabled = false; }
  };
  $('#send-msg').onclick = send;
  text.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  text.oninput = () => { text.style.height = 'auto'; text.style.height = Math.min(text.scrollHeight, 140) + 'px'; };
}

/* Send / broadcast ----------------------------------------- */
views.send = async (host) => {
  host.innerHTML = `
    <div class="grid cols-2">
      <div class="card">
        <div class="card-head"><h2>Compose</h2><div class="spacer"></div><span class="hint" id="recipient-count">0 recipients</span></div>
        <div class="card-body stack">
          <label class="field">Recipients
            <textarea id="numbers" placeholder="+919876543210, +14155550100&#10;One per line or comma separated (E.164 format)"></textarea>
            <span class="hint">Numbers must include the country code. Up to 500 per send.</span>
          </label>
          <label class="field">Message type
            <select id="mode">
              <option value="text">Freeform text — only allowed inside the 24-hour customer service window</option>
              <option value="template">Approved template — required to start a new conversation</option>
            </select>
          </label>
          <div id="mode-text" class="stack">
            <label class="field">Message
              <textarea id="body" placeholder="Type your message…"></textarea>
            </label>
            <label class="field">Media URL (optional)
              <input type="text" id="media" placeholder="https://example.com/image.jpg">
            </label>
          </div>
          <div id="mode-template" class="stack" hidden>
            <label class="field">Template
              <select id="tpl"></select>
            </label>
            <div id="tpl-var-inputs"></div>
            <div class="field">Preview<div class="tpl-body" id="tpl-preview">—</div></div>
          </div>
          <div class="row">
            <button class="btn btn-primary" id="do-send">Send</button>
            <span class="hint" id="send-note"></span>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Results</h2></div>
        <div class="card-body" id="send-results"><div class="empty">Nothing sent yet in this session</div></div>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="card-head"><h2>Recent broadcasts</h2></div>
      <div id="broadcast-table"></div>
    </div>`;

  if (!state.templates.length) { try { state.templates = await api('/templates'); } catch {} }
  const tpl = $('#tpl', host);
  tpl.innerHTML = state.templates.length
    ? state.templates.map((t) => `<option value="${t.sid}">${esc(t.friendly_name || t.sid)} · ${esc(t.language || '')} ${t.status === 'approved' ? '✓' : `(${esc(t.status || 'unknown')})`}</option>`).join('')
    : '<option value="">No templates — sync them from the Templates tab</option>';

  const numbers = $('#numbers', host);
  const countNumbers = () => numbers.value.split(/[\s,;\n]+/).filter(Boolean).length;
  numbers.oninput = () => { $('#recipient-count', host).textContent = `${countNumbers()} recipient${countNumbers() === 1 ? '' : 's'}`; };

  const mode = $('#mode', host);
  mode.onchange = () => {
    $('#mode-text', host).hidden = mode.value !== 'text';
    $('#mode-template', host).hidden = mode.value !== 'template';
    renderTplVars();
  };

  function renderTplVars() {
    const t = state.templates.find((x) => x.sid === tpl.value);
    const box = $('#tpl-var-inputs', host);
    box.innerHTML = t?.variables.length
      ? `<label class="field">Variables<div class="var-grid">${t.variables.map((v) => `<input type="text" data-var="${esc(v)}" placeholder="{{${esc(v)}}}">`).join('')}</div></label>`
      : '';
    for (const i of box.querySelectorAll('[data-var]')) i.oninput = preview;
    preview();
  }
  function collectVars() {
    const out = {};
    for (const i of host.querySelectorAll('#tpl-var-inputs [data-var]')) if (i.value) out[i.dataset.var] = i.value;
    return out;
  }
  function preview() {
    const t = state.templates.find((x) => x.sid === tpl.value);
    const vars = collectVars();
    $('#tpl-preview', host).textContent = t
      ? String(t.body || '(no text body)').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => vars[k] ?? m)
      : '—';
  }
  tpl.onchange = renderTplVars;
  renderTplVars();

  $('#do-send', host).onclick = async (e) => {
    const list = numbers.value.split(/[\s,;\n]+/).filter(Boolean);
    if (!list.length) return toast('Add at least one recipient', 'bad');
    if (list.length > 1 && !confirm(`Send this message to ${list.length} recipients?`)) return;
    e.target.disabled = true; e.target.textContent = 'Sending…';
    try {
      const payload = mode.value === 'template'
        ? { numbers: list, mode: 'template', contentSid: tpl.value, variables: collectVars() }
        : { numbers: list, mode: 'text', body: $('#body', host).value, mediaUrl: $('#media', host).value || undefined };
      const r = await api('/send', { method: 'POST', body: payload });
      toast(`${r.sent} sent · ${r.failed} failed`, r.failed ? 'bad' : 'ok');
      $('#send-results', host).innerHTML = `
        <table><thead><tr><th>Number</th><th>Result</th><th>Detail</th></tr></thead><tbody>
        ${r.results.map((x) => `<tr>
          <td class="mono">${esc(x.number)}</td>
          <td class="${x.ok ? 'result-ok' : 'result-bad'}">${x.ok ? 'Sent' : 'Failed'}</td>
          <td class="hint">${esc(x.error || x.sid || '')}</td></tr>`).join('')}
        </tbody></table>`;
      loadBroadcasts();
      await refreshConversations();
    } catch (err) { toast(err.message, 'bad'); }
    finally { e.target.disabled = false; e.target.textContent = 'Send'; }
  };

  async function loadBroadcasts() {
    const rows = await api('/broadcasts');
    $('#broadcast-table', host).innerHTML = rows.length
      ? `<table><thead><tr><th>When</th><th>Type</th><th>Content</th><th>Recipients</th><th>Sent</th><th>Failed</th></tr></thead><tbody>
         ${rows.map((b) => `<tr>
           <td class="hint">${timeFull(b.created_at)}</td>
           <td><span class="pill">${esc(b.mode)}</span></td>
           <td>${esc((b.body || b.template_sid || '').slice(0, 70))}</td>
           <td>${b.total}</td><td class="result-ok">${b.sent}</td>
           <td class="${b.failed ? 'result-bad' : 'hint'}">${b.failed}</td></tr>`).join('')}
         </tbody></table>`
      : '<div class="empty">No broadcasts yet</div>';
  }
  loadBroadcasts();
  $('#send-note', host).textContent = state.status?.dryRun ? 'Dry run is on — messages are simulated, not delivered.' : '';
};

/* Templates ------------------------------------------------ */
views.templates = async (host) => {
  const sync = el('<button class="btn btn-primary btn-sm">Sync from Twilio</button>');
  $('#topbar-actions').append(sync);
  sync.onclick = async () => {
    sync.disabled = true; sync.textContent = 'Syncing…';
    try {
      const r = await api('/templates/sync', { method: 'POST' });
      state.templates = r.templates;
      toast(`${r.count} template(s) fetched from Twilio`);
      render();
    } catch (err) { toast(err.message, 'bad'); }
    finally { sync.disabled = false; sync.textContent = 'Sync from Twilio'; }
  };

  state.templates = await api('/templates');
  render();

  function render() {
    host.innerHTML = state.templates.length ? `
      <div class="card">
        <div class="card-head"><h2>WhatsApp content templates</h2><div class="spacer"></div>
          <span class="hint">${state.templates.length} template(s) cached from your Twilio account</span></div>
        <table>
          <thead><tr><th>Name</th><th>Language</th><th>Body</th><th>Variables</th><th>Approval</th><th>Content SID</th></tr></thead>
          <tbody>${state.templates.map((t) => `
            <tr>
              <td><b>${esc(t.friendly_name || '—')}</b></td>
              <td>${esc(t.language || '—')}</td>
              <td style="max-width:340px"><div class="hint" style="white-space:pre-wrap">${esc(t.body || '—')}</div></td>
              <td>${t.variables.length ? t.variables.map((v) => `<span class="pill">${esc(v)}</span>`).join(' ') : '<span class="hint">none</span>'}</td>
              <td><span class="pill ${t.status === 'approved' ? 'ok' : t.status === 'rejected' ? 'bad' : 'warn'}">${esc(t.status || 'unknown')}</span></td>
              <td class="mono hint">${esc(t.sid)}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>` : `
      <div class="card"><div class="card-body empty">
        <div>No templates cached yet.</div>
        <div class="hint" style="margin-top:6px">Click <b>Sync from Twilio</b> to pull the WhatsApp content templates from your Twilio account.</div>
      </div></div>`;
  }
};

/* Knowledge base ------------------------------------------- */
views.knowledge = async (host) => {
  const data = await api('/context');
  host.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Company context</h2><div class="spacer"></div>
        <span class="hint mono">${esc(data.path)}</span></div>
      <div class="card-body stack">
        <div class="hint">Everything the AI is allowed to say lives in this markdown file. It is injected into every automatic reply — the agent is instructed to answer only from here and to escalate to a human otherwise.</div>
        <textarea id="ctx" class="mono" style="min-height:52vh">${esc(data.content)}</textarea>
        <div class="row">
          <button class="btn btn-primary" id="save-ctx">Save</button>
          <span class="hint" id="ctx-meta">${data.chars} characters · last updated ${data.updatedAt ? new Date(data.updatedAt).toLocaleString() : '—'}</span>
        </div>
      </div>
    </div>`;
  $('#save-ctx', host).onclick = async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('/context', { method: 'PUT', body: { content: $('#ctx', host).value } });
      $('#ctx-meta', host).textContent = `${r.chars} characters · saved just now`;
      toast('Knowledge base saved — the AI uses it from the next message');
      await refreshStatus();
    } catch (err) { toast(err.message, 'bad'); }
    finally { e.target.disabled = false; }
  };
};

/* Settings ------------------------------------------------- */
views.settings = async (host) => {
  const s = state.status;
  const st = s.settings;
  host.innerHTML = `
    <div class="grid cols-2">
      <div class="card">
        <div class="card-head"><h2>Automation</h2></div>
        <div class="card-body stack">
          <div class="autobox">
            <label class="switch"><input type="checkbox" id="set-auto" ${st.auto_reply_enabled === 'true' ? 'checked' : ''}><span></span></label>
            <div><div class="label">Reply to every incoming message</div>
            <div class="sub">When off, messages land in the Inbox and wait for a manual reply.</div></div>
          </div>
          <label class="field">Agent name<input type="text" id="set-agent" value="${esc(st.agent_name)}"></label>
          <label class="field">Escalation message — sent when the AI cannot answer
            <textarea id="set-escalation" style="min-height:70px">${esc(st.escalation_message)}</textarea>
          </label>
          <div class="row">
            <label class="field" style="flex:1">Creativity (0–1)<input type="number" id="set-temp" step="0.1" min="0" max="1" value="${esc(st.ai_temperature)}"></label>
            <label class="field" style="flex:1">Max reply tokens<input type="number" id="set-tokens" min="50" max="2000" value="${esc(st.ai_max_tokens)}"></label>
            <label class="field" style="flex:1">History turns<input type="number" id="set-history" min="2" max="40" value="${esc(st.history_turns)}"></label>
          </div>
          <div class="autobox">
            <label class="switch"><input type="checkbox" id="set-fallback" ${st.fallback_on_error === 'true' ? 'checked' : ''}><span></span></label>
            <div><div class="label">Send the escalation message if the AI fails</div>
            <div class="sub">Keeps the customer informed when Azure OpenAI errors out.</div></div>
          </div>
          <div><button class="btn btn-primary" id="save-settings">Save settings</button></div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><h2>Twilio</h2><div class="spacer"></div>
            <span class="pill ${s.twilio.configured ? 'ok' : 'bad'}">${s.twilio.configured ? 'configured' : 'not configured'}</span></div>
          <div class="card-body stack">
            <div class="hint">Credentials are read from <code class="mono">.env</code> and never stored in the database.</div>
            <table>
              <tr><td>Account SID</td><td class="mono">${esc(s.twilio.accountSid || '—')}</td></tr>
              <tr><td>WhatsApp sender</td><td class="mono">${esc(s.twilio.from || '—')}</td></tr>
              <tr><td>Messaging service</td><td class="mono">${esc(s.twilio.messagingServiceSid || '—')}</td></tr>
              <tr><td>Dry run</td><td>${s.dryRun ? '<span class="pill warn">on — nothing is really sent</span>' : 'off'}</td></tr>
            </table>
            <label class="field">Inbound webhook (Twilio → this app)
              <div class="copyrow"><code>${esc(s.webhookUrl)}</code><button class="btn btn-sm" data-copy="${esc(s.webhookUrl)}">Copy</button></div>
            </label>
            <label class="field">Status callback
              <div class="copyrow"><code>${esc(s.statusCallbackUrl)}</code><button class="btn btn-sm" data-copy="${esc(s.statusCallbackUrl)}">Copy</button></div>
            </label>
            <div class="row"><button class="btn" id="test-twilio">Test Twilio connection</button><span id="twilio-result" class="hint"></span></div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>Azure OpenAI</h2><div class="spacer"></div>
            <span class="pill ${s.azure.configured ? 'ok' : 'bad'}">${s.azure.configured ? 'configured' : 'not configured'}</span></div>
          <div class="card-body stack">
            <table>
              <tr><td>Endpoint</td><td class="mono">${esc(s.azure.endpoint || '—')}</td></tr>
              <tr><td>Deployment</td><td class="mono">${esc(s.azure.deployment || '—')}</td></tr>
              <tr><td>API version</td><td class="mono">${esc(s.azure.apiVersion)}</td></tr>
              <tr><td>Knowledge base</td><td>${s.context.chars} characters</td></tr>
            </table>
            <div class="row"><button class="btn" id="test-azure">Test Azure connection</button><span id="azure-result" class="hint"></span></div>
          </div>
        </div>
      </div>
    </div>`;

  $('#save-settings', host).onclick = async (e) => {
    e.target.disabled = true;
    try {
      await api('/settings', { method: 'PUT', body: {
        auto_reply_enabled: String($('#set-auto', host).checked),
        agent_name: $('#set-agent', host).value,
        escalation_message: $('#set-escalation', host).value,
        ai_temperature: $('#set-temp', host).value,
        ai_max_tokens: $('#set-tokens', host).value,
        history_turns: $('#set-history', host).value,
        fallback_on_error: String($('#set-fallback', host).checked),
      }});
      await refreshStatus();
      toast('Settings saved');
    } catch (err) { toast(err.message, 'bad'); }
    finally { e.target.disabled = false; }
  };

  const test = async (btn, path, out) => {
    btn.disabled = true; out.textContent = 'Testing…';
    try {
      const r = await api(path, { method: 'POST' });
      out.innerHTML = r.ok
        ? `<span class="result-ok">OK</span> ${esc(r.friendlyName || r.sample || '')}`
        : `<span class="result-bad">Failed</span> ${esc(r.error)}`;
    } catch (err) { out.innerHTML = `<span class="result-bad">${esc(err.message)}</span>`; }
    finally { btn.disabled = false; }
  };
  $('#test-twilio', host).onclick = (e) => test(e.target, '/test/twilio', $('#twilio-result', host));
  $('#test-azure', host).onclick = (e) => test(e.target, '/test/azure', $('#azure-result', host));
};

/* Activity log --------------------------------------------- */
views.logs = async (host) => {
  const render = (rows) => {
    host.innerHTML = `<div class="card">
      <div class="card-head"><h2>Activity</h2><div class="spacer"></div><span class="hint">latest ${rows.length} events</span></div>
      ${rows.length ? `<table><thead><tr><th style="width:150px">Time</th><th style="width:80px">Scope</th><th>Event</th></tr></thead><tbody>
        ${rows.map((l) => `<tr>
          <td class="hint mono">${timeFull(l.created_at)}</td>
          <td><span class="pill ${l.level === 'error' ? 'bad' : l.level === 'warn' ? 'warn' : ''}">${esc(l.scope || l.level)}</span></td>
          <td>${esc(l.message)}${l.detail ? `<div class="hint mono">${esc(l.detail)}</div>` : ''}</td>
        </tr>`).join('')}</tbody></table>` : '<div class="empty">No activity yet</div>'}
    </div>`;
  };
  render(await api('/logs'));
  const refresh = el('<button class="btn btn-sm">Refresh</button>');
  $('#topbar-actions').append(refresh);
  refresh.onclick = async () => render(await api('/logs'));
};

/* ── live updates ─────────────────────────────────────────── */
function connectEvents() {
  const source = new EventSource('/api/events');
  source.addEventListener('message', async (e) => {
    const { conversationId } = JSON.parse(e.data);
    if (state.view !== 'inbox') { await refreshConversations(); return; }
    if (conversationId === state.activeId) await openConversation(conversationId);
    else { await refreshConversations(); renderConvList(); }
  });
  source.addEventListener('conversation', async () => {
    await refreshConversations();
    if (state.view === 'inbox') renderConvList();
  });
  source.addEventListener('typing', (e) => {
    const { conversationId } = JSON.parse(e.data);
    if (state.view !== 'inbox' || conversationId !== state.activeId) return;
    const scroll = $('#chat-scroll');
    if (!scroll || $('#typing-ind')) return;
    scroll.append(el('<div class="typing" id="typing-ind">Assistant is typing…</div>'));
    scroll.scrollTop = scroll.scrollHeight;
  });
  source.addEventListener('status', async () => { if (state.view === 'inbox' && state.activeId) await openConversation(state.activeId); });
  source.onerror = () => { /* EventSource retries on its own */ };
}

/* ── boot ─────────────────────────────────────────────────── */
document.addEventListener('click', (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) { navigator.clipboard?.writeText(copy.dataset.copy); toast('Copied to clipboard'); }
});

$('#nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-item');
  if (btn) go(btn.dataset.view);
});

$('#auto-toggle').onchange = async (e) => {
  try {
    await api('/settings', { method: 'PUT', body: { auto_reply_enabled: String(e.target.checked) } });
    await refreshStatus();
    toast(e.target.checked ? 'Auto-reply enabled for all conversations' : 'Auto-reply disabled — replies are manual');
    if (state.view === 'settings') go('settings');
  } catch (err) { toast(err.message, 'bad'); }
};

(async function boot() {
  try {
    await refreshStatus();
    try { state.templates = await api('/templates'); } catch {}
    await refreshConversations();
  } catch (err) { toast(err.message, 'bad'); }
  connectEvents();
  go(location.hash.slice(1) in TITLES ? location.hash.slice(1) : 'overview');
  setInterval(() => refreshConversations().catch(() => {}), 20_000);
})();

window.addEventListener('hashchange', () => {
  const view = location.hash.slice(1);
  if (view in TITLES && view !== state.view) go(view);
});
