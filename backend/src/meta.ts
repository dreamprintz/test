import type { Config } from './config.js';
import type { StoredError } from './store.js';

export interface TemplateMessage {
  to: string;
  template: { name: string; language: string; bodyParams: string[] };
}

export type MetaResult =
  | { kind: 'accepted'; id: string }
  | { kind: 'rejected'; error: StoredError }
  /** We cannot know whether Meta processed the request (timeout, reset). Never auto-retried. */
  | { kind: 'unknown'; error: StoredError };

/**
 * Error codes from https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 * that are safe to retry later. Everything else is treated as permanent.
 */
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 341, 80007, 130429, 131000, 131016, 131056, 133004]);

export function classifyMetaError(httpStatus: number, body: unknown): StoredError {
  const err = (body as { error?: { code?: number; message?: string; error_data?: { details?: string }; error_user_msg?: string } })?.error;
  const code = err?.code;
  const message = err?.error_data?.details || err?.error_user_msg || err?.message || `HTTP ${httpStatus}`;
  const retryable = code !== undefined ? RETRYABLE_CODES.has(code) : httpStatus === 429 || httpStatus >= 500;
  return { code: String(code ?? httpStatus), message, retryable };
}

const NOT_SENT_NET_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);

export class MetaClient {
  constructor(private readonly cfg: Config, private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 20_000) {}

  buildPayload(m: TemplateMessage) {
    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: m.to,
      type: 'template',
      template: {
        name: m.template.name,
        language: { code: m.template.language },
        ...(m.template.bodyParams.length
          ? { components: [{ type: 'body', parameters: m.template.bodyParams.map((text) => ({ type: 'text', text })) }] }
          : {}),
      },
    };
    return payload;
  }

  async sendTemplate(m: TemplateMessage): Promise<MetaResult> {
    const { apiVersion, phoneNumberId, accessToken } = this.cfg.meta;
    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(this.buildPayload(m)),
        signal: ctrl.signal,
      });
    } catch (e) {
      const code = (e as { cause?: { code?: string } })?.cause?.code ?? '';
      if (NOT_SENT_NET_CODES.has(code)) {
        return { kind: 'rejected', error: { code: `network_${code}`, message: 'Could not connect to Meta', retryable: true } };
      }
      const timedOut = (e as Error)?.name === 'AbortError';
      return { kind: 'unknown', error: { code: timedOut ? 'timeout' : 'network', message: timedOut ? 'Meta did not respond in time; the message may or may not have been sent' : 'Connection to Meta was interrupted; the message may or may not have been sent', retryable: false } };
    } finally {
      clearTimeout(timer);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Non-JSON body
    }
    if (res.ok) {
      const id = (body as { messages?: { id?: string }[] })?.messages?.[0]?.id;
      if (id) return { kind: 'accepted', id };
      return { kind: 'unknown', error: { code: 'no_message_id', message: 'Meta returned success without a message id', retryable: false } };
    }
    if (res.status >= 500 && !(body as { error?: unknown })?.error) {
      // e.g. a gateway error: Meta may have processed the request before the failure.
      return { kind: 'unknown', error: { code: String(res.status), message: `Meta returned HTTP ${res.status}; the message may or may not have been sent`, retryable: false } };
    }
    return { kind: 'rejected', error: classifyMetaError(res.status, body) };
  }
}
