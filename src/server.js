import config from './config.js';
import { log } from './db.js';
import { initStore } from './store/index.js';
import { createApp } from './app.js';

const app = createApp();

await initStore();

app.listen(config.port, () => {
  const base = config.publicUrl || `http://localhost:${config.port}`;
  console.log(`
  WhatsApp Comms Console
  ──────────────────────────────────────────────
  Dashboard   http://localhost:${config.port}
  Webhook     ${base}/webhook/twilio
  Status cb   ${base}/webhook/status
  Storage     ${config.databaseUrl ? 'postgres' : `sqlite (${config.dbFile})`}
  Twilio      ${config.twilio.configured ? 'configured' : 'NOT configured (.env)'}
  Azure AI    ${config.azure.configured ? 'configured' : 'NOT configured (.env)'}
  Dry run     ${config.dryRun ? 'ON — messages are not really sent' : 'off'}
  ──────────────────────────────────────────────`);
  log('info', 'server', `Listening on port ${config.port}`);
});
