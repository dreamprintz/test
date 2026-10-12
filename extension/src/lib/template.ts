import type { Contact } from './types';

/** Matches {{ key }} or {{ key | fallback text }}. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*(?:\|([^}]*))?\}\}/g;

export interface Placeholder {
  key: string;
  fallback?: string;
}

export interface RenderResult {
  text: string;
  /** Placeholders with no value and no fallback. These make the message incomplete. */
  missing: string[];
  /** Placeholders that used their fallback text because the value was empty. */
  usedFallback: string[];
}

/** Convert a column header into a placeholder-safe key: "Registration No." -> "registration_no" */
export function toFieldKey(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'field';
}

export function extractPlaceholders(body: string): Placeholder[] {
  const seen = new Map<string, Placeholder>();
  for (const m of body.matchAll(PLACEHOLDER)) {
    const key = m[1]!.toLowerCase();
    if (!seen.has(key)) {
      const fallback = m[2]?.trim();
      seen.set(key, fallback !== undefined ? { key, fallback } : { key });
    }
  }
  return [...seen.values()];
}

export function contactContext(contact: Pick<Contact, 'name' | 'phone' | 'email' | 'fields'>): Record<string, string> {
  const name = (contact.name ?? '').trim();
  return {
    ...Object.fromEntries(Object.entries(contact.fields ?? {}).map(([k, v]) => [k.toLowerCase(), v ?? ''])),
    name,
    first_name: name.split(/\s+/)[0] ?? '',
    phone: contact.phone ?? '',
    email: contact.email ?? '',
  };
}

export function renderTemplate(body: string, context: Record<string, string | undefined>): RenderResult {
  const missing = new Set<string>();
  const usedFallback = new Set<string>();
  const text = body.replace(PLACEHOLDER, (_all, rawKey: string, fallback: string | undefined) => {
    const key = rawKey.toLowerCase();
    const value = (context[key] ?? '').trim();
    if (value) return value;
    if (fallback !== undefined) {
      usedFallback.add(key);
      return fallback.trim();
    }
    missing.add(key);
    return `{{${key}}}`;
  });
  return { text, missing: [...missing], usedFallback: [...usedFallback] };
}

/** Placeholders that don't correspond to any known field. Usually a typo. */
export function unknownPlaceholders(body: string, availableKeys: Iterable<string>): string[] {
  const known = new Set([...availableKeys].map((k) => k.toLowerCase()));
  for (const k of ['name', 'first_name', 'phone', 'email']) known.add(k);
  return extractPlaceholders(body).map((p) => p.key).filter((k) => !known.has(k));
}

/** WhatsApp counts UTF-16 code units loosely; we report user-perceived characters. */
export function characterCount(text: string): number {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    let n = 0;
    for (const _ of seg.segment(text)) n++;
    return n;
  }
  return [...text].length;
}

/** WhatsApp text messages are limited to 4096 characters. */
export const WHATSAPP_TEXT_LIMIT = 4096;
