#!/usr/bin/env bash
# Public HTTPS tunnel to the local app so Twilio can deliver inbound webhooks.
# Cloudflare quick tunnel: no account needed. The URL changes each start, so
# after starting, update PUBLIC_URL in .env and the sender webhook in Twilio.
PORT="${PORT:-3000}"
exec cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate
