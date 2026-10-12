import type { CampaignStatus, Recipient, RecipientStatus } from './types';

/** Allowed campaign state transitions. Anything else is a bug or a stale UI. */
const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  draft: ['running', 'cancelled'],
  running: ['paused', 'completed', 'cancelled'],
  paused: ['running', 'cancelled'],
  completed: ['running'], // only via retrying failures
  cancelled: [],
};

export function canTransitionCampaign(from: CampaignStatus, to: CampaignStatus): boolean {
  return CAMPAIGN_TRANSITIONS[from].includes(to);
}

export function assertCampaignTransition(from: CampaignStatus, to: CampaignStatus): void {
  if (!canTransitionCampaign(from, to)) throw new Error(`Campaign cannot go from ${from} to ${to}`);
}

/**
 * Recipient transitions.
 * - "processing" means a send is in flight (API) or the chat was opened for the user (manual).
 * - "unknown" means we cannot tell whether the message went out; it is never retried automatically.
 */
const RECIPIENT_TRANSITIONS: Record<RecipientStatus, RecipientStatus[]> = {
  pending: ['processing', 'skipped'],
  processing: ['sent', 'failed', 'skipped', 'unknown', 'pending', 'processing'],
  sent: ['failed'], // a delivery-failure webhook can arrive after acceptance
  failed: ['pending', 'skipped'],
  skipped: ['pending'],
  unknown: ['sent', 'failed', 'skipped', 'pending'],
};

export function canTransitionRecipient(from: RecipientStatus, to: RecipientStatus): boolean {
  return RECIPIENT_TRANSITIONS[from].includes(to);
}

export function transitionRecipient(r: Recipient, to: RecipientStatus, note?: string, now = Date.now()): Recipient {
  if (!canTransitionRecipient(r.status, to)) throw new Error(`Recipient cannot go from ${r.status} to ${to}`);
  const entry: Recipient['history'][number] = note ? { at: now, status: to, note } : { at: now, status: to };
  return { ...r, status: to, updatedAt: now, history: [...r.history, entry] };
}

export type RetryDecision =
  | { eligible: true }
  | { eligible: false; reason: string; canForce: boolean };

export const MAX_AUTOMATIC_ATTEMPTS = 3;

/**
 * Whether a recipient can be put back in the queue by "Retry failed".
 * We never requeue anything that might already have reached the person.
 */
export function retryDecision(r: Recipient): RetryDecision {
  switch (r.status) {
    case 'failed':
      if (r.deliveryStatus === 'failed') {
        return r.retryable
          ? { eligible: true }
          : { eligible: false, reason: 'WhatsApp reported a permanent delivery failure', canForce: true };
      }
      if (r.retryable === false) return { eligible: false, reason: r.lastError ?? 'Permanent error', canForce: true };
      return { eligible: true };
    case 'unknown':
      return { eligible: false, reason: 'Outcome unknown: the message may already have been sent', canForce: true };
    case 'skipped':
      if (r.skipReason === 'opted_out') return { eligible: false, reason: 'Recipient opted out', canForce: false };
      return { eligible: false, reason: 'Skipped', canForce: false };
    case 'sent':
      return { eligible: false, reason: 'Already sent', canForce: false };
    default:
      return { eligible: false, reason: 'Still queued', canForce: false };
  }
}

/** Idempotency key sent to the backend. Same key => backend returns the original result instead of resending. */
export function idempotencyKey(r: Pick<Recipient, 'campaignId' | 'id' | 'sendGeneration'>): string {
  return `${r.campaignId}:${r.id}:${r.sendGeneration}`;
}

export interface RecipientCounts {
  total: number;
  pending: number;
  processing: number;
  sent: number;
  failed: number;
  skipped: number;
  unknown: number;
  delivered: number;
  read: number;
}

export function countRecipients(rs: Pick<Recipient, 'status' | 'deliveryStatus'>[]): RecipientCounts {
  const c: RecipientCounts = { total: rs.length, pending: 0, processing: 0, sent: 0, failed: 0, skipped: 0, unknown: 0, delivered: 0, read: 0 };
  for (const r of rs) {
    c[r.status]++;
    if (r.deliveryStatus === 'delivered') c.delivered++;
    if (r.deliveryStatus === 'read') {
      c.delivered++;
      c.read++;
    }
  }
  return c;
}

/** Fraction of recipients that reached a terminal-for-now state. */
export function progress(c: RecipientCounts): number {
  if (c.total === 0) return 0;
  return (c.sent + c.failed + c.skipped + c.unknown) / c.total;
}

export function isFinished(c: RecipientCounts): boolean {
  return c.pending === 0 && c.processing === 0;
}
