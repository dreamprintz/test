import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig, metaConfigured } from './config.js';
import { Store } from './store.js';

const config = loadConfig();
const store = new Store(config.dataDir);
// Logs never include phone numbers, message parameters or tokens.
const log = (msg: string, meta?: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...meta }));
const app = createApp({ config, store, log });

app.listen(config.port, () => {
  log('listening', { port: config.port, metaConfigured: metaConfigured(config), apiVersion: config.meta.apiVersion, webhookSignature: !!config.meta.appSecret });
  if (!config.meta.appSecret) log('warning: META_APP_SECRET not set; all webhooks will be rejected');
});
