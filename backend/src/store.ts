import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type RecordStatus = 'in_progress' | 'accepted' | 'failed' | 'unknown';
export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface StoredError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface MessageRecord {
  key: string;
  to: string;
  status: RecordStatus;
  providerMessageId?: string;
  deliveryStatus?: DeliveryStatus;
  error?: StoredError;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export interface OptOutRecord {
  phone: string;
  at: number;
}

interface Snapshot {
  messages: MessageRecord[];
  optouts: OptOutRecord[];
}

/**
 * Small durable store backed by a JSON file with atomic writes.
 * Suitable for a single instance; swap for Postgres/Redis to scale horizontally.
 */
export class Store {
  private messages = new Map<string, MessageRecord>();
  private byProviderId = new Map<string, string>();
  private optouts = new Map<string, OptOutRecord>();
  private readonly file: string | null;

  constructor(dataDir: string | null, private readonly retentionMs = 30 * 24 * 3600_000) {
    this.file = dataDir ? join(dataDir, 'store.json') : null;
    if (dataDir) mkdirSync(dataDir, { recursive: true });
    if (this.file && existsSync(this.file)) {
      const snap = JSON.parse(readFileSync(this.file, 'utf8')) as Snapshot;
      for (const m of snap.messages) this.index(m);
      for (const o of snap.optouts) this.optouts.set(o.phone, o);
    }
  }

  private index(m: MessageRecord) {
    this.messages.set(m.key, m);
    if (m.providerMessageId) this.byProviderId.set(m.providerMessageId, m.key);
  }

  /** Written synchronously so an in-progress marker exists on disk before we call Meta. */
  flush(): void {
    if (!this.file) return;
    const cutoff = Date.now() - this.retentionMs;
    for (const [k, m] of this.messages) {
      if (m.updatedAt < cutoff) {
        this.messages.delete(k);
        if (m.providerMessageId) this.byProviderId.delete(m.providerMessageId);
      }
    }
    const snap: Snapshot = { messages: [...this.messages.values()], optouts: [...this.optouts.values()] };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get(key: string): MessageRecord | undefined {
    return this.messages.get(key);
  }

  getByProviderId(id: string): MessageRecord | undefined {
    const key = this.byProviderId.get(id);
    return key ? this.messages.get(key) : undefined;
  }

  put(m: MessageRecord): void {
    this.index(m);
    this.flush();
  }

  addOptOut(phone: string, at: number): void {
    if (!this.optouts.has(phone)) {
      this.optouts.set(phone, { phone, at });
      this.flush();
    }
  }

  optOutsSince(since: number): OptOutRecord[] {
    return [...this.optouts.values()].filter((o) => o.at > since).sort((a, b) => a.at - b.at);
  }

  isOptedOut(phone: string): boolean {
    return this.optouts.has(phone);
  }
}
