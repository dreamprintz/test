import { db } from '../db/db';
import { completeIfFinished } from '../db/campaigns';
import { suppress, suppressedSet } from '../db/contacts';
import { logActivity } from '../db/activity';
import { idempotencyKey, MAX_AUTOMATIC_ATTEMPTS, transitionRecipient } from '../lib/campaign';
import { contactContext } from '../lib/template';
import { waDigits } from '../lib/phone';
import type { Campaign, Recipient } from '../lib/types';
import { BackendClient, BackendError } from '../providers/cloudApi';
import type { SendResponse } from '../providers/types';
import type { Settings } from '../settings/settings';

export interface QueueDeps {
  client: BackendClient;
  settings: Settings;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Wall-clock budget for one tick; MV3 service workers can be stopped when idle. */
  budgetMs?: number;
}

const backoffMs = (attempt: number) => Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1));

/** Apply a backend send result to a recipient. Pure apart from the timestamp. */
export function applySendResult(r: Recipient, res: SendResponse, now: number): Recipient {
  switch (res.status) {
    case 'accepted': {
      const next = transitionRecipient(r, 'sent', 'Accepted by WhatsApp Cloud API', now);
      next.sentEvidence = 'api_accepted';
      next.deliveryStatus = res.deliveryStatus ?? 'accepted';
      if (res.providerMessageId) next.providerMessageId = res.providerMessageId;
      delete next.lastError;
      delete next.nextAttemptAt;
      if (res.deliveryStatus === 'failed') {
        const failed = transitionRecipient(next, 'failed', res.error?.message ?? 'Delivery failed', now);
        failed.lastError = res.error?.message ?? 'Delivery failed';
        failed.retryable = res.error?.retryable ?? false;
        return failed;
      }
      return next;
    }
    case 'in_progress': {
      // Another request with this key is still running on the backend. Check again later.
      return { ...r, nextAttemptAt: now + 30_000, updatedAt: now };
    }
    case 'unknown': {
      const next = transitionRecipient(r, 'unknown', res.error?.message ?? 'Outcome unknown', now);
      next.lastError = res.error?.message ?? 'The API did not confirm whether the message was sent';
      next.retryable = false;
      return next;
    }
    case 'failed': {
      const retryable = res.error?.retryable ?? false;
      const message = res.error ? `${res.error.code}: ${res.error.message}` : 'Send failed';
      if (retryable && r.attempts < MAX_AUTOMATIC_ATTEMPTS) {
        const next = transitionRecipient(r, 'pending', `Temporary error, will retry: ${message}`, now);
        return { ...next, lastError: message, retryable, nextAttemptAt: now + backoffMs(r.attempts) };
      }
      const next = transitionRecipient(r, 'failed', message, now);
      return { ...next, lastError: message, retryable };
    }
  }
}

async function sendOne(c: Campaign, r: Recipient, deps: QueueDeps, suppressed: Set<string>): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  const contact = await db.contacts.get(r.contactId);
  if (suppressed.has(r.phone) || contact?.consent === 'denied') {
    await db.recipients.put({ ...transitionRecipient(r, 'skipped', 'Opted out after launch', now), skipReason: 'opted_out' });
    return;
  }
  if (!c.cloudTemplate) throw new Error('Campaign has no Cloud API template');
  const ctx = contact ? contactContext(contact) : { name: r.name, phone: r.phone };
  const bodyParams = c.cloudTemplate.bodyParams.map((k) => (ctx[k.toLowerCase()] ?? '').trim());
  if (bodyParams.some((p) => !p)) {
    const next = transitionRecipient(r.status === 'pending' ? transitionRecipient(r, 'processing', undefined, now) : r, 'skipped', 'Missing template parameter value', now);
    await db.recipients.put({ ...next, skipReason: 'missing_fields' });
    return;
  }

  // Persist "processing" before the network call so a crash leaves evidence of an in-flight send.
  let working = r.status === 'processing' ? r : transitionRecipient(r, 'processing', 'Sending via Cloud API', now);
  working = { ...working, attempts: r.attempts + 1 };
  await db.recipients.put(working);

  try {
    const res = await deps.client.send({
      idempotencyKey: idempotencyKey(working),
      to: waDigits(working.phone),
      template: { name: c.cloudTemplate.name, language: c.cloudTemplate.language, bodyParams },
    });
    await db.recipients.put(applySendResult(working, res, deps.now?.() ?? Date.now()));
  } catch (e) {
    const t = deps.now?.() ?? Date.now();
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof BackendError && e.kind === 'auth') {
      // Configuration problem: leave the recipient in processing and pause so the user can fix it.
      await db.recipients.put({ ...working, lastError: msg, attempts: r.attempts });
      throw e;
    }
    // The backend may or may not have received the request. Retrying with the SAME idempotency key is safe.
    if (working.attempts >= MAX_AUTOMATIC_ATTEMPTS) {
      const next = transitionRecipient(working, 'unknown', `Backend did not confirm: ${msg}`, t);
      await db.recipients.put({ ...next, lastError: msg, retryable: false });
    } else {
      await db.recipients.put({ ...working, lastError: msg, nextAttemptAt: t + backoffMs(working.attempts), updatedAt: t });
    }
  }
}

/** Send a batch for every running Cloud API campaign. Safe to call repeatedly and after restarts. */
export async function processCloudQueue(deps: QueueDeps): Promise<number> {
  const start = deps.now?.() ?? Date.now();
  const budget = deps.budgetMs ?? 25_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const gap = Math.ceil(60_000 / Math.max(1, Math.min(600, deps.settings.cloudApi.ratePerMinute)));
  const campaigns = (await db.campaigns.where('status').equals('running').toArray()).filter((c) => c.provider === 'cloud_api');
  let sent = 0;
  for (const c of campaigns) {
    const suppressed = await suppressedSet();
    const candidates = [
      ...(await db.recipients.where('[campaignId+status]').equals([c.id, 'processing']).sortBy('order')),
      ...(await db.recipients.where('[campaignId+status]').equals([c.id, 'pending']).sortBy('order')),
    ];
    for (const r of candidates) {
      const now = deps.now?.() ?? Date.now();
      if (now - start > budget) return sent;
      if (r.nextAttemptAt && r.nextAttemptAt > now) continue;
      // Re-read: the user may have paused or cancelled meanwhile.
      const fresh = await db.campaigns.get(c.id);
      if (fresh?.status !== 'running') break;
      try {
        await sendOne(c, r, deps, suppressed);
      } catch (e) {
        await db.transaction('rw', db.campaigns, async () => {
          const cur = await db.campaigns.get(c.id);
          if (cur?.status === 'running') {
            await db.campaigns.update(c.id, { status: 'paused', updatedAt: Date.now(), history: [...cur.history, { at: Date.now(), type: 'paused', note: `Auto-paused: ${e instanceof Error ? e.message : String(e)}` }] });
          }
        });
        await logActivity('campaign', `Campaign "${c.name}" auto-paused: ${e instanceof Error ? e.message : 'error'}`, c.id);
        break;
      }
      sent++;
      await sleep(gap);
    }
    await completeIfFinished(c.id);
  }
  return sent;
}

const FINAL_DELIVERY = new Set(['read', 'failed']);

/** Pull delivery updates (from webhooks) for recently sent messages. */
export async function syncDeliveryStatuses(client: BackendClient, now = Date.now()): Promise<number> {
  const since = now - 14 * 24 * 3600_000;
  const candidates = await db.recipients
    .filter((r) => r.sentEvidence === 'api_accepted' && r.updatedAt > since && !FINAL_DELIVERY.has(r.deliveryStatus ?? ''))
    .limit(500)
    .toArray();
  let changed = 0;
  for (let i = 0; i < candidates.length; i += 100) {
    const batch = candidates.slice(i, i + 100);
    const byKey = new Map(batch.map((r) => [idempotencyKey(r), r]));
    const res = await client.statuses([...byKey.keys()]);
    for (const m of res.messages) {
      const r = byKey.get(m.key);
      if (!r || !m.deliveryStatus || m.deliveryStatus === r.deliveryStatus) continue;
      let next: Recipient = { ...r, deliveryStatus: m.deliveryStatus, updatedAt: now };
      if (m.deliveryStatus === 'failed' && r.status === 'sent') {
        next = transitionRecipient(next, 'failed', m.error?.message ?? 'WhatsApp reported delivery failure', now);
        next.lastError = m.error ? `${m.error.code}: ${m.error.message}` : 'Delivery failed';
        next.retryable = m.error?.retryable ?? false;
      }
      await db.recipients.put(next);
      changed++;
    }
  }
  return changed;
}

/** Import opt-outs (e.g. "STOP" replies) recorded by the backend webhook. */
export async function syncOptOuts(client: BackendClient, since: number): Promise<{ count: number; latest: number }> {
  const { optouts } = await client.optOuts(since);
  let latest = since;
  for (const o of optouts) {
    const phone = o.phone.startsWith('+') ? o.phone : `+${o.phone}`;
    await suppress(phone, 'Opted out via WhatsApp reply', 'backend');
    await db.contacts.where('phone').equals(phone).modify({ consent: 'denied', consentUpdatedAt: o.at, consentNote: 'Opted out via WhatsApp reply' });
    latest = Math.max(latest, o.at);
  }
  return { count: optouts.length, latest };
}
