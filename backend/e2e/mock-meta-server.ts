/**
 * TEST HARNESS ONLY. Runs the real backend with a fake Meta Graph API so the extension's
 * Cloud API flow can be exercised end to end. Nothing is sent to WhatsApp.
 * Usage: PORT=8799 ALLOWED_ORIGINS=chrome-extension://<id> npx tsx e2e/mock-meta-server.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';

const config = loadConfig({
  ...process.env,
  BACKEND_API_KEY: process.env.BACKEND_API_KEY ?? 'e2e-key-0123456789abcdefghij',
  META_ACCESS_TOKEN: 'mock-token',
  META_PHONE_NUMBER_ID: '1000000000',
  META_APP_SECRET: 'mock-secret',
  DATA_DIR: mkdtempSync(join(tmpdir(), 'wa-mock-')),
});
let n = 0;
const fakeMeta = (async (_url: URL | RequestInfo, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body));
  // Numbers ending in 0 simulate a permanent "undeliverable" error.
  if (String(body.to).endsWith('0')) return Response.json({ error: { code: 131026, message: 'Message undeliverable' } }, { status: 400 });
  return Response.json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.mock${++n}` }] });
}) as typeof fetch;

const app = createApp({ config, store: new Store(config.dataDir), fetchImpl: fakeMeta, log: (m, meta) => console.log('[mock-backend]', m, JSON.stringify(meta ?? {})) });
app.listen(config.port, () => console.log(`[mock-backend] MOCK META listening on ${config.port}`));
