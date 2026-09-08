import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env without an external dependency (Node >= 20.12 / 22).
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = (m[2] ?? '').replace(/^["']|["']$/g, '');
      }
    }
  }
}

const bool = (v, fallback = false) =>
  v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(String(v));

const twilio = {
  accountSid: process.env.TWILIO_ACCOUNT_SID || '',
  authToken: process.env.TWILIO_AUTH_TOKEN || '',
  from: process.env.TWILIO_WHATSAPP_FROM || '',
  messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID || '',
  validateSignature: bool(process.env.TWILIO_VALIDATE_SIGNATURE, false),
};

const azure = {
  endpoint: (process.env.AZURE_OPENAI_ENDPOINT || '').replace(/\/+$/, ''),
  apiKey: process.env.AZURE_OPENAI_API_KEY || '',
  deployment: process.env.AZURE_OPENAI_DEPLOYMENT || '',
  apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
};

// A value is "configured" only when it is present and not still the placeholder.
const real = (v) => Boolean(v) && !/^(your|ACxxx|xxx)/i.test(v) && !v.includes('your-resource');

twilio.configured = real(twilio.accountSid) && real(twilio.authToken) && /^AC[0-9a-f]{32}$/i.test(twilio.accountSid);
azure.configured = real(azure.endpoint) && real(azure.apiKey) && Boolean(azure.deployment);

// On Vercel the filesystem is read-only apart from /tmp, and VERCEL_URL gives
// us the deployment host so the webhook URL is correct without extra config.
const isServerless = Boolean(process.env.VERCEL);
const vercelUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '';
const publicUrl = (process.env.PUBLIC_URL || vercelUrl || '').replace(/\/+$/, '');
const writableDir = isServerless ? '/tmp' : path.join(ROOT, 'data');

export const config = {
  root: ROOT,
  isServerless,
  port: Number(process.env.PORT || 3000),
  publicUrl,
  databaseUrl: process.env.DATABASE_URL || process.env.POSTGRES_URL || '',
  writableDir,
  dashboard: {
    user: process.env.DASHBOARD_USER || '',
    pass: process.env.DASHBOARD_PASS || '',
  },
  twilio,
  azure,
  contextFile: path.resolve(ROOT, process.env.COMPANY_CONTEXT_FILE || './context/company.md'),
  // Edits made from the Knowledge tab land here when the bundled file is read-only.
  contextOverrideFile: path.join(writableDir, 'company.md'),
  autoReplyDefault: bool(process.env.AUTO_REPLY_DEFAULT, true),
  // Explicit DRY_RUN wins; otherwise we fall back to dry-run when Twilio is unconfigured.
  dryRun: bool(process.env.DRY_RUN, !twilio.configured),
  dbFile: process.env.DB_FILE || path.join(writableDir, 'app.db'),
};

export default config;
