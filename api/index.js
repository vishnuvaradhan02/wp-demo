/**
 * Vercel serverless entry point. vercel.json routes every request here and the
 * Express app handles the rest (dashboard, API, Twilio webhooks).
 */
import { createApp } from '../src/app.js';
import { initStore } from '../src/store/index.js';

const app = createApp();
const ready = initStore();

export default async function handler(req, res) {
  await ready;
  return app(req, res);
}
