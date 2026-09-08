import path from 'node:path';
import express from 'express';
import config from './config.js';
import { log } from './db.js';
import apiRoutes from './routes/api.js';
import webhookRoutes from './routes/webhook.js';

/** Builds the Express app. Shared by the local server and the Vercel handler. */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(express.urlencoded({ extended: false, limit: '1mb' })); // Twilio posts form-encoded
  app.use(express.json({ limit: '2mb' }));

  /** Optional basic auth for the dashboard + API (webhooks stay open for Twilio). */
  function dashboardAuth(req, res, next) {
    const { user, pass } = config.dashboard;
    if (!user && !pass) return next();
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const [u, p] = Buffer.from(encoded, 'base64').toString().split(':');
      if (u === user && p === pass) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="WhatsApp Console"').status(401).send('Authentication required');
  }

  app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));
  app.use('/webhook', webhookRoutes);
  app.use('/api', dashboardAuth, apiRoutes);
  app.use(dashboardAuth, express.static(path.join(config.root, 'public'), { extensions: ['html'] }));

  app.use((err, _req, res, _next) => {
    log('error', 'http', err.message, err.stack?.split('\n').slice(0, 3).join(' | '));
    res.status(err.status || 500).json({ error: err.message || 'Internal error' });
  });

  return app;
}

export default createApp;
