import type { MetaClient, TemplateMessage } from './meta.js';
import type { MessageRecord, Store } from './store.js';

export interface SendInput extends TemplateMessage {
  idempotencyKey: string;
}

export interface SendOptions {
  /** Immediate in-request retries for temporary Meta errors. */
  maxInlineRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** An in-progress record older than this is from a crashed request: its outcome is unknown. */
  staleInProgressMs?: number;
}

/** Per-key mutex so two concurrent requests with the same key never both call Meta. */
const inflight = new Map<string, Promise<MessageRecord>>();

export class Sender {
  constructor(private readonly store: Store, private readonly meta: MetaClient, private readonly opts: SendOptions = {}) {}

  send(input: SendInput): Promise<MessageRecord> {
    const running = inflight.get(input.idempotencyKey);
    if (running) return running;
    const p = this.doSend(input).finally(() => inflight.delete(input.idempotencyKey));
    inflight.set(input.idempotencyKey, p);
    return p;
  }

  private async doSend(input: SendInput): Promise<MessageRecord> {
    const now = this.opts.now ?? Date.now;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const existing = this.store.get(input.idempotencyKey);
    if (existing) {
      if (existing.to !== input.to) throw new IdempotencyConflict();
      if (existing.status === 'accepted' || existing.status === 'unknown') return existing;
      if (existing.status === 'failed' && !existing.error?.retryable) return existing;
      if (existing.status === 'in_progress') {
        // Not running in this process (checked by the mutex), so a previous process died mid-request.
        if (now() - existing.updatedAt > (this.opts.staleInProgressMs ?? 60_000)) {
          const rec: MessageRecord = { ...existing, status: 'unknown', updatedAt: now(), error: { code: 'interrupted', message: 'Server stopped while sending; the message may or may not have been sent', retryable: false } };
          this.store.put(rec);
          return rec;
        }
        return existing;
      }
    }
    if (this.store.isOptedOut(input.to)) {
      const rec: MessageRecord = { key: input.idempotencyKey, to: input.to, status: 'failed', attempts: existing?.attempts ?? 0, createdAt: existing?.createdAt ?? now(), updatedAt: now(), error: { code: 'opted_out', message: 'Recipient opted out', retryable: false } };
      this.store.put(rec);
      return rec;
    }

    let rec: MessageRecord = { key: input.idempotencyKey, to: input.to, status: 'in_progress', attempts: existing?.attempts ?? 0, createdAt: existing?.createdAt ?? now(), updatedAt: now() };
    const maxRetries = this.opts.maxInlineRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      rec = { ...rec, status: 'in_progress', attempts: rec.attempts + 1, updatedAt: now() };
      this.store.put(rec); // durable marker before the network call
      const result = await this.meta.sendTemplate(input);
      if (result.kind === 'accepted') {
        rec = { ...rec, status: 'accepted', providerMessageId: result.id, deliveryStatus: rec.deliveryStatus ?? 'sent', updatedAt: now() };
        delete rec.error;
        break;
      }
      if (result.kind === 'unknown') {
        rec = { ...rec, status: 'unknown', error: result.error, updatedAt: now() };
        break;
      }
      rec = { ...rec, status: 'failed', error: result.error, updatedAt: now() };
      if (!result.error.retryable || attempt >= maxRetries) break;
      await sleep(1000 * 3 ** attempt);
    }
    this.store.put(rec);
    return rec;
  }
}

export class IdempotencyConflict extends Error {
  constructor() {
    super('Idempotency key was already used for a different recipient');
  }
}
