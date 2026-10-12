import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { Store } from './store.js';

const KEY = 'test-key-0123456789abcdef0123';
const SECRET = 'app-secret';
const config = loadConfig({ BACKEND_API_KEY: KEY, META_ACCESS_TOKEN: 'EAAtoken', META_PHONE_NUMBER_ID: '1234567890', META_APP_SECRET: SECRET, META_WEBHOOK_VERIFY_TOKEN: 'verify-me' } as NodeJS.ProcessEnv);

type MetaReply = { status: number; body: unknown } | 'timeout' | 'refused';
let metaCalls: { url: string; body: any; auth: string | null }[] = [];
let replies: MetaReply[] = [];
const fakeMeta = (async (url: URL | RequestInfo, init?: RequestInit) => {
  metaCalls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get('authorization') });
  const r = replies.shift() ?? { status: 200, body: { messages: [{ id: `wamid.${metaCalls.length}` }] } };
  if (r === 'timeout') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  if (r === 'refused') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

let server: Server;
let base: string;
let store: Store;
let dataDir: string;

function start() {
  store = new Store(dataDir);
  const app = createApp({ config, store, fetchImpl: fakeMeta, senderOptions: { sleep: async () => {} } });
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

beforeEach(async () => {
  metaCalls = [];
  replies = [];
  dataDir = mkdtempSync(join(tmpdir(), 'wa-be-'));
  await start();
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

const api = (path: string, body?: unknown, key = KEY) =>
  fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

const msg = (key = 'cmp_1:r_1:0', to = '919876543210') => ({ idempotencyKey: key, to, template: { name: 'registration_ack', language: 'en', bodyParams: ['Asha', 'Data Science'] } });

describe('auth and validation', () => {
  it('rejects a missing or wrong key', async () => {
    expect((await api('/api/health', undefined, 'nope')).status).toBe(401);
    expect((await fetch(`${base}/api/health`)).status).toBe(401);
    const ok = await api('/api/health');
    expect(await ok.json()).toEqual({ ok: true, configured: true, apiVersion: 'v23.0' });
  });
  it('validates send requests', async () => {
    const res = await api('/api/messages', { ...msg(), to: '+91 98765' });
    expect(res.status).toBe(400);
    expect(metaCalls).toHaveLength(0);
  });
  it('refuses weak configuration', () => {
    expect(() => loadConfig({ BACKEND_API_KEY: 'short' } as NodeJS.ProcessEnv)).toThrow(/24 characters/);
  });
});

describe('sending', () => {
  it('builds the Cloud API template payload with the server-side token', async () => {
    const res = await api('/api/messages', msg());
    expect(await res.json()).toEqual({ key: 'cmp_1:r_1:0', status: 'accepted', providerMessageId: 'wamid.1', deliveryStatus: 'sent' });
    expect(metaCalls[0]!.url).toBe('https://graph.facebook.com/v23.0/1234567890/messages');
    expect(metaCalls[0]!.auth).toBe('Bearer EAAtoken');
    expect(metaCalls[0]!.body).toEqual({
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '919876543210', type: 'template',
      template: { name: 'registration_ack', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Asha' }, { type: 'text', text: 'Data Science' }] }] },
    });
  });

  it('is idempotent: repeated and concurrent requests send once', async () => {
    const results = await Promise.all([api('/api/messages', msg()), api('/api/messages', msg()), api('/api/messages', msg())]);
    const bodies = await Promise.all(results.map((r) => r.json()));
    expect(new Set(bodies.map((b) => b.providerMessageId))).toEqual(new Set(['wamid.1']));
    await api('/api/messages', msg());
    expect(metaCalls).toHaveLength(1);
  });

  it('survives a restart without resending', async () => {
    await api('/api/messages', msg());
    await new Promise<void>((r) => server.close(() => r()));
    await start();
    const res = await (await api('/api/messages', msg())).json();
    expect(res.status).toBe('accepted');
    expect(metaCalls).toHaveLength(1);
  });

  it('rejects reusing a key for another number', async () => {
    await api('/api/messages', msg());
    expect((await api('/api/messages', msg('cmp_1:r_1:0', '919000000000'))).status).toBe(409);
  });

  it('retries temporary errors inline', async () => {
    replies = [{ status: 429, body: { error: { code: 130429, message: 'Rate limit hit' } } }, { status: 200, body: { messages: [{ id: 'wamid.ok' }] } }];
    const res = await (await api('/api/messages', msg())).json();
    expect(res.status).toBe('accepted');
    expect(metaCalls).toHaveLength(2);
  });

  it('reports retryable failure after inline retries, and retries again on the next request', async () => {
    replies = Array(3).fill({ status: 503, body: { error: { code: 133004, message: 'Server temporarily unavailable' } } });
    const res = await (await api('/api/messages', msg())).json();
    expect(res).toMatchObject({ status: 'failed', error: { code: '133004', retryable: true } });
    expect(metaCalls).toHaveLength(3);
    const again = await (await api('/api/messages', msg())).json();
    expect(again.status).toBe('accepted');
  });

  it('does not retry permanent errors', async () => {
    replies = [{ status: 400, body: { error: { code: 132001, message: 'Template does not exist' } } }];
    const res = await (await api('/api/messages', msg())).json();
    expect(res).toMatchObject({ status: 'failed', error: { code: '132001', retryable: false } });
    await api('/api/messages', msg());
    expect(metaCalls).toHaveLength(1);
  });

  it('marks timeouts as unknown and never resends that key', async () => {
    replies = ['timeout'];
    const res = await (await api('/api/messages', msg())).json();
    expect(res).toMatchObject({ status: 'unknown', error: { code: 'timeout' } });
    await api('/api/messages', msg());
    expect(metaCalls).toHaveLength(1);
  });

  it('treats connection refused as not sent', async () => {
    replies = ['refused', 'refused', 'refused'];
    const res = await (await api('/api/messages', msg())).json();
    expect(res).toMatchObject({ status: 'failed', error: { retryable: true } });
  });

  it('turns a stale in-progress record (crash mid-send) into unknown', async () => {
    store.put({ key: 'cmp_1:r_9:0', to: '919876543210', status: 'in_progress', attempts: 1, createdAt: Date.now() - 300_000, updatedAt: Date.now() - 300_000 });
    const res = await (await api('/api/messages', msg('cmp_1:r_9:0'))).json();
    expect(res.status).toBe('unknown');
    expect(metaCalls).toHaveLength(0);
  });
});

describe('webhooks', () => {
  const sign = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const post = (payload: unknown, secret = SECRET) => {
    const body = JSON.stringify(payload);
    return fetch(`${base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body, secret) }, body });
  };
  const statusPayload = (id: string, status: string, errors?: unknown[]) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id, status, timestamp: '1', recipient_id: '919876543210', ...(errors ? { errors } : {}) }] } }] }] });

  it('answers the verification challenge only with the right token', async () => {
    expect(await (await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`)).text()).toBe('42');
    expect((await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`)).status).toBe(403);
  });

  it('rejects unsigned or badly signed payloads', async () => {
    expect((await post(statusPayload('x', 'read'), 'wrong')).status).toBe(401);
    expect((await fetch(`${base}/webhook`, { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('updates delivery status and never downgrades', async () => {
    await api('/api/messages', msg());
    await post(statusPayload('wamid.1', 'read'));
    await post(statusPayload('wamid.1', 'delivered'));
    const res = await (await api('/api/messages/status', { keys: ['cmp_1:r_1:0', 'missing'] })).json();
    expect(res.messages).toEqual([{ key: 'cmp_1:r_1:0', status: 'accepted', providerMessageId: 'wamid.1', deliveryStatus: 'read' }]);
  });

  it('records delivery failures with retryability', async () => {
    await api('/api/messages', msg());
    await post(statusPayload('wamid.1', 'failed', [{ code: 131026, title: 'Message undeliverable' }]));
    const res = await (await api('/api/messages/status', { keys: ['cmp_1:r_1:0'] })).json();
    expect(res.messages[0]).toMatchObject({ deliveryStatus: 'failed', error: { code: '131026', retryable: false } });
  });

  it('records STOP replies as opt-outs and blocks further sends', async () => {
    const inbound = { entry: [{ changes: [{ value: { messages: [{ from: '919876543210', timestamp: '1700000000', type: 'text', text: { body: ' stop ' } }, { from: '919111111111', type: 'text', text: { body: 'stop by tomorrow?' } }] } }] }] };
    expect((await post(inbound)).status).toBe(200);
    const res = await (await api('/api/optouts?since=0')).json();
    expect(res.optouts).toEqual([{ phone: '919876543210', at: 1700000000000 }]);
    const send = await (await api('/api/messages', msg())).json();
    expect(send).toMatchObject({ status: 'failed', error: { code: 'opted_out' } });
    expect(metaCalls).toHaveLength(0);
  });
});
