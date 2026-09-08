# WhatsApp Comms Console

A WhatsApp communications management platform on top of **Twilio** (WhatsApp Business
API) and **Azure OpenAI**. It fetches your approved templates from Twilio, sends
messages to any numbers you provide, exposes a webhook for incoming messages, and by
default answers every customer query automatically using a company context file — with
manual sending available at any time.

```
Customer WhatsApp  ⇄  Twilio  ⇄  /webhook/twilio  ⇄  this app  ⇄  Azure OpenAI
                                                        ↑
                                                context/company.md
```

## Features

| Area | What you get |
|---|---|
| **Overview** | Live counters, 7-day traffic chart, connection health, and a local “simulate an inbound message” tester |
| **Inbox** | WhatsApp-style threaded chat per contact, unread + “needs human” filters, live updates over SSE |
| **Auto-reply** | Every inbound message is answered by Azure OpenAI using `context/company.md`; escalates to a human when the answer isn’t in the knowledge base. Toggle globally or per conversation |
| **Manual send** | Type a reply in any thread, or use the **Send** tab to message one number or up to 500 at once |
| **Templates** | One click pulls your WhatsApp content templates (with approval status and variables) from Twilio; fill variables and send |
| **Knowledge** | Edit the company context markdown right in the browser — the next reply uses it |
| **Webhooks** | `POST /webhook/twilio` (inbound), `POST /webhook/status` (delivery receipts), `POST /webhook/fallback`, with optional Twilio signature verification |
| **Activity** | Rolling log of inbound messages, AI replies, sends, and errors |

## Setup

```bash
npm install
cp .env.example .env      # already done — just fill in the keys
npm start                 # http://localhost:3000
```

Everything runs with **zero external services**: storage is SQLite (`data/app.db`,
via Node’s built-in `node:sqlite`), so there is nothing else to install.

### 1. Fill in `.env`

| Key | Where to get it |
|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Twilio Console → Account Info |
| `TWILIO_WHATSAPP_FROM` | Your WhatsApp sender, e.g. `whatsapp:+14155238886` (sandbox) |
| `TWILIO_MESSAGING_SERVICE_SID` | Optional — used instead of a single sender if set |
| `AZURE_OPENAI_ENDPOINT` | `https://<resource>.openai.azure.com` |
| `AZURE_OPENAI_API_KEY` | Azure portal → your OpenAI resource → Keys |
| `AZURE_OPENAI_DEPLOYMENT` | The **deployment name** of your chat model (e.g. `gpt-4o`) |
| `PUBLIC_URL` | The public HTTPS URL Twilio will call (ngrok or your host) |

Until real Twilio keys are present the app runs in **dry-run**: the whole flow works,
messages are recorded and shown in the UI, but nothing is actually delivered. Without
Azure keys the auto-reply is a clearly-labelled `[simulated reply]` placeholder.
Set `DRY_RUN=true` to force simulation even with valid keys.

### 2. Point Twilio at the webhook

Expose the app publicly (`ngrok http 3000`), put that host in `PUBLIC_URL`, restart, then in
**Twilio Console → Messaging → Senders → WhatsApp senders → your sender** (or the
WhatsApp Sandbox settings) set:

- **When a message comes in:** `https://<PUBLIC_URL>/webhook/twilio` — HTTP **POST**
- **Status callback URL:** `https://<PUBLIC_URL>/webhook/status` — HTTP **POST**

Both URLs are shown with a copy button on the Overview and Settings screens.
Set `TWILIO_VALIDATE_SIGNATURE=true` in production to reject forged requests.

### 3. Write your knowledge base

Edit `context/company.md` (or the **Knowledge** tab). The agent answers strictly from
this file and escalates anything it doesn't cover — keep prices, policies, timelines and
troubleshooting steps in there.

### 4. Optional: protect the dashboard

Set `DASHBOARD_USER` / `DASHBOARD_PASS` to require basic auth on the UI and API.
The `/webhook/*` routes stay open so Twilio can reach them.

## Sending

- **One thread:** open it in the Inbox, type, press Enter.
- **Many numbers:** Send tab → paste numbers (comma / newline separated, E.164) → text or template → Send. Results are listed per number.
- **Templates are required** to open a conversation outside the 24-hour customer service window; freeform text only works inside it. The Send tab labels both options.

## API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/status` | Config, webhook URLs, settings |
| `GET/PUT` | `/api/settings` | Auto-reply toggle, agent name, escalation message, model params |
| `GET/PUT` | `/api/context` | Read/write the company knowledge file |
| `GET` | `/api/templates` · `POST /api/templates/sync` | Cached templates · refetch from Twilio |
| `GET` | `/api/conversations` · `/api/conversations/:id` | List · thread with messages |
| `PATCH/DELETE` | `/api/conversations/:id` | Per-thread auto-reply, needs-human, name · delete |
| `POST` | `/api/conversations/:id/messages` | Manual send into a thread |
| `POST` | `/api/conversations/:id/ai-reply` | Generate + send an AI answer now |
| `POST` | `/api/send` | Send to one or many numbers (text or template) |
| `GET` | `/api/stats` · `/api/logs` · `/api/broadcasts` | Dashboard data |
| `GET` | `/api/events` | Server-sent events stream for live UI updates |
| `POST` | `/api/simulate/inbound` | Fake an inbound message locally (no Twilio needed) |

## Deploying to Vercel

The app ships with `vercel.json` and a serverless entry point at `api/index.js`, so
the dashboard, the API and the Twilio webhooks all run from one deployment.

**1. Postgres is required on Vercel.** Serverless filesystems are ephemeral and
read-only, so SQLite cannot persist there. Create a database (Neon, Supabase or
Vercel Postgres) and copy its **pooled** connection string. Tables are created
automatically on first boot — there is no migration step.

**2. Set the environment variables** in *Project → Settings → Environment Variables*:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Pooled Postgres connection string |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | From the Twilio console |
| `TWILIO_WHATSAPP_FROM` | e.g. `whatsapp:+15557143526` |
| `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT` | Your Azure resource |
| `DASHBOARD_USER`, `DASHBOARD_PASS` | **Set these** — the deployment is public |
| `TWILIO_VALIDATE_SIGNATURE` | `true` in production |
| `PUBLIC_URL` | Optional; defaults to the Vercel deployment URL |

`PUBLIC_URL` is only needed to pin a custom domain — otherwise `VERCEL_URL` is used
automatically, so the webhook URLs shown in the dashboard are always correct.

**3. Point Twilio at the deployment.** Use your production domain (not a preview URL,
which changes on every push):

```
Incoming message   POST  https://<your-domain>/webhook/twilio
Status callback    POST  https://<your-domain>/webhook/status
```

> **Where to set this matters.** If your WhatsApp sender belongs to a **Messaging
> Service**, Twilio delivers to the *service's* "Incoming Message" webhook and
> **ignores the sender-level webhook**. Set it at
> *Messaging → Services → your service → Integration*. Configuring only the sender
> is the most common reason inbound messages never arrive.

### Serverless behaviour

- **Auto-replies run inline.** On a long-lived server the webhook acks Twilio
  immediately and answers out of band; on Vercel the function can be frozen once the
  response is sent, so the reply is awaited before responding. `maxDuration` is 30s
  in `vercel.json` and Twilio's own timeout is ~15s, which is comfortable for a
  `gpt-4o-mini` reply.
- **Live updates degrade gracefully.** The SSE stream is cut short by function
  timeouts, so the dashboard also polls every 20 seconds.
- **Knowledge edits are not durable on Vercel.** `context/company.md` ships with the
  deploy and the filesystem is read-only, so edits from the Knowledge tab are written
  to `/tmp` and last only until the next cold start. Commit changes to the file for
  permanent updates.

## Local development

```bash
npm start          # SQLite, no external services
```

To expose it to Twilio while developing, run a tunnel and put its URL in `PUBLIC_URL`:

```bash
./tunnel.sh        # cloudflared quick tunnel → prints an https URL
```

## Layout

```
api/index.js           Vercel serverless entry point
vercel.json            routes every request to the Express app
src/
  app.js               builds the Express app (shared by server + serverless)
  server.js            local long-lived server
  config.js            env loading, serverless detection, "is this configured?" checks
  db.js                domain layer over the store (async)
  store/index.js       picks the adapter: Postgres if DATABASE_URL, else SQLite
  store/sqlite.js      SQLite adapter (local dev)
  store/postgres.js    Postgres adapter (Vercel / Neon / Supabase)
  store/util.js        shared row/timestamp normalisation, setting defaults
  routes/api.js        dashboard REST API
  routes/webhook.js    Twilio inbound + status callbacks
  services/twilio.js   sending, Content API template sync, signature validation
  services/ai.js       Azure OpenAI calls, system prompt, knowledge file
  services/messaging.js send+record, auto-reply orchestration
  services/events.js   SSE hub
public/                dashboard (vanilla JS, no build step)
context/company.md     the knowledge base the AI answers from
tunnel.sh              cloudflared quick tunnel for local webhook testing
```

## Notes

- Twilio rejects a webhook that takes longer than ~15s, so the app acknowledges the
  message immediately and generates the AI reply out of band.
- Auto-reply resolution order: global toggle → per-conversation toggle. If the AI errors
  and `fallback_on_error` is on, the escalation message is sent and the thread is flagged
  for a human.
- Outbound messages carry a `statusCallback`, so delivery ticks update live in the Inbox.
