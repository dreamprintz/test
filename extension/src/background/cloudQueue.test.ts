import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/db';
import { importRows } from '../db/contacts';
import { createList } from '../db/lists';
import { saveTemplate } from '../db/templates';
import { forceResend, launchCampaign, retryFailed, saveDraft, setCampaignStatus } from '../db/campaigns';
import { suppress } from '../db/contacts';
import { processCloudQueue, syncDeliveryStatuses, syncOptOuts } from './cloudQueue';
import { BackendClient } from '../providers/cloudApi';
import { DEFAULT_SETTINGS } from '../settings/settings';
import type { ImportRow } from '../lib/csv';
import type { SendRequest, SendResponse } from '../providers/types';

/** Fake backend implementing the idempotency contract of backend/src. */
function fakeBackend(behaviour: (req: SendRequest, n: number) => SendResponse | 'network-error') {
  const store = new Map<string, SendResponse>();
  const sends: SendRequest[] = [];
  const optouts: { phone: string; at: number }[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === '/api/messages') {
      const req = body as SendRequest;
      const existing = store.get(req.idempotencyKey);
      if (existing && existing.status !== 'failed') return Response.json(existing);
      sends.push(req);
      const out = behaviour(req, sends.length);
      if (out === 'network-error') throw new TypeError('fetch failed');
      store.set(req.idempotencyKey, out);
      return Response.json(out);
    }
    if (url.pathname === '/api/messages/status') {
      return Response.json({ messages: (body.keys as string[]).map((k) => store.get(k)).filter(Boolean) });
    }
    if (url.pathname === '/api/optouts') return Response.json({ optouts });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { client: new BackendClient({ backendUrl: 'http://backend.test', backendKey: 'k' }, fetchImpl), store, sends, optouts };
}

const row = (n: number, over: Partial<ImportRow> = {}): ImportRow => ({
  rowNumber: n, raw: [], name: `Person ${n}`, rawPhone: '', phone: `+9198765432${String(n).padStart(2, '0')}`, email: '', fields: { course: 'DS' }, issues: [], status: 'valid', suppressed: false, ...over,
});

async function setup(count = 3) {
  const list = await createList('Batch A');
  await importRows(Array.from({ length: count }, (_, i) => row(i + 1)), { listId: list.id, existing: 'keep', consent: 'granted' });
  const t = await saveTemplate({ name: 'T', body: 'Hi {{name}}, {{course}}' });
  const c = await saveDraft({ name: 'C', listId: list.id, templateId: t.id, provider: 'cloud_api', cloudTemplate: { name: 'reg_ack', language: 'en', bodyParams: ['name', 'course'] } });
  return c;
}

const settings = { ...DEFAULT_SETTINGS, cloudApi: { ...DEFAULT_SETTINGS.cloudApi, ratePerMinute: 600 } };
const deps = (client: BackendClient) => ({ client, settings, sleep: async () => {} });

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('cloud queue', () => {
  it('sends each eligible recipient once and completes the campaign', async () => {
    const c = await setup();
    await launchCampaign(c.id, { requireConsent: true, skipIncomplete: true });
    const be = fakeBackend((req) => ({ key: req.idempotencyKey, status: 'accepted', providerMessageId: `wamid.${req.to}` }));
    await processCloudQueue(deps(be.client));
    await processCloudQueue(deps(be.client));
    expect(be.sends).toHaveLength(3);
    expect(be.sends[0]!.template).toEqual({ name: 'reg_ack', language: 'en', bodyParams: ['Person 1', 'DS'] });
    const rs = await db.recipients.where('campaignId').equals(c.id).toArray();
    expect(rs.every((r) => r.status === 'sent' && r.sentEvidence === 'api_accepted')).toBe(true);
    expect((await db.campaigns.get(c.id))!.status).toBe('completed');
  });

  it('skips contacts who opt out after launch', async () => {
    const c = await setup(2);
    await launchCampaign(c.id, { requireConsent: true, skipIncomplete: true });
    await suppress('+919876543202', 'STOP', 'manual');
    const be = fakeBackend((req) => ({ key: req.idempotencyKey, status: 'accepted' }));
    await processCloudQueue(deps(be.client));
    expect(be.sends.map((s) => s.to)).toEqual(['919876543201']);
    const skipped = await db.recipients.where('[campaignId+status]').equals([c.id, 'skipped']).toArray();
    expect(skipped[0]!.skipReason).toBe('opted_out');
  });

  it('does not resend after a lost response: retries reuse the idempotency key', async () => {
    const c = await setup(1);
    await launchCampaign(c.id, { requireConsent: true, skipIncomplete: true });
    let lose = true;
    // Backend records the send but the response is lost on the first attempt.
    const store = new Map<string, SendResponse>();
    const metaCalls: string[] = [];
    const fetchImpl = (async (_u: URL | RequestInfo, init?: RequestInit) => {
      const req = JSON.parse(String(init!.body)) as SendRequest;
      if (!store.has(req.idempotencyKey)) {
        metaCalls.push(req.to);
        store.set(req.idempotencyKey, { key: req.idempotencyKey, status: 'accepted', providerMessageId: 'wamid.1' });
      }
      if (lose) {
        lose = false;
        throw new TypeError('connection reset');
      }
      return Response.json(store.get(req.idempotencyKey));
    }) as typeof fetch;
    const client = new BackendClient({ backendUrl: 'http://b.test', backendKey: 'k' }, fetchImpl);
    let now = 1_000_000;
    const d = { client, settings, sleep: async () => {}, now: () => now };
    await processCloudQueue(d);
    const mid = (await db.recipients.where('campaignId').equals(c.id).first())!;
    expect(mid.status).toBe('processing');
    now += 10 * 60_000;
    await processCloudQueue(d);
    const done = (await db.recipients.where('campaignId').equals(c.id).first())!;
    expect(done.status).toBe('sent');
    expect(done.providerMessageId).toBe('wamid.1');
    expect(metaCalls).toHaveLength(1);
  });

  it('backs off temporary errors, then marks failed; retryFailed requeues only eligible ones', async () => {
    const c = await setup(2);
    await launchCampaign(c.id, { requireConsent: true, skipIncomplete: true });
    const be = fakeBackend((req) =>
      req.to.endsWith('01')
        ? { key: req.idempotencyKey, status: 'failed', error: { code: '131026', message: 'Undeliverable', retryable: false } }
        : { key: req.idempotencyKey, status: 'failed', error: { code: '130429', message: 'Rate limit', retryable: true } },
    );
    let now = 1_000_000;
    const d = { client: be.client, settings, sleep: async () => {}, now: () => now };
    for (let i = 0; i < 5; i++) {
      await processCloudQueue(d);
      now += 60 * 60_000;
    }
    const rs = await db.recipients.where('campaignId').equals(c.id).sortBy('order');
    expect(rs.map((r) => [r.status, r.retryable])).toEqual([['failed', false], ['failed', true]]);
    expect(rs[1]!.attempts).toBe(3);
    expect((await db.campaigns.get(c.id))!.status).toBe('completed');
    const res = await retryFailed(c.id);
    expect(res).toEqual({ requeued: 1, heldBack: 1 });
    expect((await db.campaigns.get(c.id))!.status).toBe('running');
  });

  it('marks unknown outcomes and requires an explicit forced resend with a new key', async () => {
    const c = await setup(1);
    await launchCampaign(c.id, { requireConsent: true, skipIncomplete: true });
    const be = fakeBackend((req, n) => (n === 1 ? { key: req.idempotencyKey, status: 'unknown', error: { code: 'timeout', message: 'Meta timed out', retryable: false } } : { key: req.idempotencyKey, status: 'accepted' }));
    await processCloudQueue(deps(be.client));
    const r = (await db.recipients.where('campaignId').equals(c.id).first())!;
    expect(r.status).toBe('unknown');
    expect(await retryFailed(c.id)).toEqual({ requeued: 0, heldBack: 1 });
    await forceResend(r.id);
    await processCloudQueue(deps(be.client));
    expect(be.sends.map((s) => s.idempotencyKey)).toEqual([`${c.id}:${r.id}:0`, `${c.id}:${r.id}:1`]);
  });

  it('does not send while paused', async () => {
    const c = await setup(2);
    await launchCampaign(c.id, { requireConsent: true, skipIncomplete: true });
    await setCampaignStatus(c.id, 'paused');
    const be = fakeBackend((req) => ({ key: req.idempotencyKey, status: 'accepted' }));
    await processCloudQueue(deps(be.client));
    expect(be.sends).toHaveLength(0);
  });

  it('syncs delivery status and opt-outs', async () => {
    const c = await setup(1);
    await launchCampaign(c.id, { requireConsent: true, skipIncomplete: true });
    const be = fakeBackend((req) => ({ key: req.idempotencyKey, status: 'accepted', providerMessageId: 'w1' }));
    await processCloudQueue(deps(be.client));
    for (const [k, v] of be.store) be.store.set(k, { ...v, deliveryStatus: 'read' });
    expect(await syncDeliveryStatuses(be.client)).toBe(1);
    expect((await db.recipients.where('campaignId').equals(c.id).first())!.deliveryStatus).toBe('read');
    be.optouts.push({ phone: '919876543201', at: 5 });
    expect(await syncOptOuts(be.client, 0)).toEqual({ count: 1, latest: 5 });
    expect(await db.suppression.get('+919876543201')).toBeTruthy();
    expect((await db.contacts.where('phone').equals('+919876543201').first())!.consent).toBe('denied');
  });
});

describe('launch', () => {
  it('always enforces consent for the Cloud API and records exclusions', async () => {
    const list = await createList('L');
    await importRows([row(1), row(2)], { listId: list.id, existing: 'keep', consent: 'unknown' });
    const t = await saveTemplate({ name: 'T', body: 'Hi' });
    const c = await saveDraft({ name: 'C', listId: list.id, templateId: t.id, provider: 'cloud_api', cloudTemplate: { name: 'x', language: 'en', bodyParams: [] } });
    await expect(launchCampaign(c.id, { requireConsent: false, skipIncomplete: false })).rejects.toThrow(/No eligible/);
  });

  it('merges existing contacts without changing opt-outs', async () => {
    const list = await createList('L');
    await importRows([row(1)], { listId: list.id, existing: 'keep', consent: 'denied' });
    const list2 = await createList('L2');
    const res = await importRows([row(1, { name: 'New Name' })], { listId: list2.id, existing: 'merge', consent: 'granted' });
    expect(res).toEqual({ created: 0, updated: 1, addedToList: 1 });
    const c = (await db.contacts.toArray())[0]!;
    expect(c.name).toBe('New Name');
    expect(c.consent).toBe('denied');
    expect(c.listIds).toEqual([list.id, list2.id]);
  });
});
