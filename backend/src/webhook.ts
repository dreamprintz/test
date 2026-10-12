import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DeliveryStatus, Store } from './store.js';
import { RETRYABLE_DELIVERY_CODES } from './retryCodes.js';

export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!appSecret || !header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', appSecret).update(rawBody).digest('hex'), 'hex');
  const given = Buffer.from(header.slice(7), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const RANK: Record<DeliveryStatus, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };

interface StatusEvent {
  id: string;
  status: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: { code?: number; title?: string; message?: string; error_data?: { details?: string } }[];
}
interface InboundMessage {
  from: string;
  timestamp?: string;
  type: string;
  text?: { body?: string };
  button?: { text?: string; payload?: string };
  interactive?: { button_reply?: { title?: string } };
}

export interface WebhookResult {
  statusesApplied: number;
  optOuts: number;
}

/** Apply a WhatsApp Cloud API webhook payload. Unknown shapes are ignored, never thrown. */
export function processWebhook(payload: unknown, store: Store, optOutKeywords: string[], now = Date.now()): WebhookResult {
  const result: WebhookResult = { statusesApplied: 0, optOuts: 0 };
  const entries = (payload as { entry?: { changes?: { value?: { statuses?: StatusEvent[]; messages?: InboundMessage[] } }[] }[] })?.entry ?? [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      for (const s of value.statuses ?? []) {
        const rec = store.getByProviderId(s.id);
        if (!rec) continue;
        const status = s.status as DeliveryStatus;
        if (!(status in RANK)) continue;
        // Webhooks can arrive out of order; never downgrade read -> delivered.
        if (rec.deliveryStatus && RANK[rec.deliveryStatus] >= RANK[status] && status !== 'failed') continue;
        const next = { ...rec, deliveryStatus: status, updatedAt: now };
        if (status === 'failed') {
          const e = s.errors?.[0];
          next.error = { code: String(e?.code ?? 'failed'), message: e?.error_data?.details || e?.message || e?.title || 'Delivery failed', retryable: e?.code !== undefined && RETRYABLE_DELIVERY_CODES.has(e.code) };
        }
        store.put(next);
        result.statusesApplied++;
      }
      for (const m of value.messages ?? []) {
        const text = (m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? '').trim().toUpperCase().replace(/[.!]+$/, '');
        if (text && optOutKeywords.includes(text)) {
          store.addOptOut(m.from, m.timestamp ? Number(m.timestamp) * 1000 : now);
          result.optOuts++;
        }
      }
    }
  }
  return result;
}
