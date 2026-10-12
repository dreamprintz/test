import express, { type NextFunction, type Request, type Response } from 'express';
import { timingSafeEqual, createHash } from 'node:crypto';
import { z } from 'zod';
import { metaConfigured, type Config } from './config.js';
import { MetaClient } from './meta.js';
import { IdempotencyConflict, Sender, type SendOptions } from './sender.js';
import type { MessageRecord, Store } from './store.js';
import { processWebhook, verifySignature } from './webhook.js';

export interface AppDeps {
  config: Config;
  store: Store;
  fetchImpl?: typeof fetch;
  senderOptions?: SendOptions;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

const sendSchema = z.object({
  idempotencyKey: z.string().min(8).max(200).regex(/^[\w:.-]+$/),
  to: z.string().regex(/^[1-9]\d{6,14}$/, 'to must be an international number, digits only'),
  template: z.object({
    name: z.string().min(1).max(512).regex(/^[a-z0-9_]+$/, 'template name: lowercase letters, digits and underscores'),
    language: z.string().min(2).max(15).regex(/^[a-zA-Z_]+$/),
    bodyParams: z.array(z.string().min(1).max(1024)).max(30),
  }),
});
const statusSchema = z.object({ keys: z.array(z.string().max(200)).max(500) });

const sha = (s: string) => createHash('sha256').update(s).digest();

/** What the extension sees. Phone numbers are not echoed back. */
function toResponse(r: MessageRecord) {
  return {
    key: r.key,
    status: r.status,
    ...(r.providerMessageId ? { providerMessageId: r.providerMessageId } : {}),
    ...(r.deliveryStatus ? { deliveryStatus: r.deliveryStatus } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

/** Simple fixed-window limiter per client IP. */
function rateLimit(limit: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || h.reset < now) hits.set(ip, { n: 1, reset: now + windowMs });
    else if (++h.n > limit) {
      res.status(429).json({ error: { message: 'Too many requests' } });
      return;
    }
    next();
  };
}

export function createApp({ config, store, fetchImpl, senderOptions, log = () => {} }: AppDeps) {
  const app = express();
  const sender = new Sender(store, new MetaClient(config, fetchImpl), senderOptions);
  const apiKeyHash = sha(config.apiKey);

  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // ---- Meta webhook (raw body needed for signature verification) ----
  app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && config.meta.verifyToken && typeof token === 'string' && timingSafeEqual(sha(token), sha(config.meta.verifyToken)) && typeof challenge === 'string') {
      res.type('text/plain').send(challenge);
      return;
    }
    res.sendStatus(403);
  });

  app.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifySignature(raw, req.get('x-hub-signature-256'), config.meta.appSecret)) {
      log('webhook rejected: bad signature');
      res.sendStatus(401);
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      res.sendStatus(400);
      return;
    }
    const result = processWebhook(payload, store, config.optOutKeywords);
    log('webhook processed', { ...result });
    res.sendStatus(200);
  });

  // ---- Extension API ----
  const api = express.Router();
  api.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });
  api.use(rateLimit(600, 60_000));
  api.use((req, res, next) => {
    const auth = req.get('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || !timingSafeEqual(sha(token), apiKeyHash)) {
      res.status(401).json({ error: { message: 'Invalid access key' } });
      return;
    }
    next();
  });
  api.use(express.json({ limit: '100kb' }));

  api.get('/health', (_req, res) => {
    res.json({ ok: true, configured: metaConfigured(config), apiVersion: config.meta.apiVersion });
  });

  api.post('/messages', async (req, res, next) => {
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
      return;
    }
    if (!metaConfigured(config)) {
      res.status(503).json({ error: { message: 'Backend has no Meta credentials configured' } });
      return;
    }
    try {
      const rec = await sender.send(parsed.data);
      log('send', { key: rec.key, status: rec.status, code: rec.error?.code });
      res.json(toResponse(rec));
    } catch (e) {
      if (e instanceof IdempotencyConflict) {
        res.status(409).json({ error: { message: e.message } });
        return;
      }
      next(e);
    }
  });

  api.post('/messages/status', (req, res) => {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'keys must be an array of up to 500 strings' } });
      return;
    }
    const messages = parsed.data.keys.map((k) => store.get(k)).filter((r): r is MessageRecord => !!r).map(toResponse);
    res.json({ messages });
  });

  api.get('/optouts', (req, res) => {
    const since = Number(req.query.since ?? 0);
    res.json({ optouts: store.optOutsSince(Number.isFinite(since) ? since : 0) });
  });

  app.use('/api', api);
  app.use((_req, res) => {
    res.status(404).json({ error: { message: 'Not found' } });
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log('error', { message: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: { message: 'Internal error' } });
  });
  return app;
}
