import { contactContext, renderTemplate } from './template';
import type { Contact, Recipient } from './types';
import { newId } from './ids';

export type ExclusionReason = 'opted_out' | 'no_consent' | 'missing_fields';

export interface AudienceOptions {
  suppressed: Set<string>;
  /** Only include contacts whose consent is "granted". Always true for the Cloud API. */
  requireConsent: boolean;
  /** Skip contacts whose message would contain unfilled placeholders. */
  skipIncomplete: boolean;
}

export interface AudienceEntry {
  contact: Contact;
  message: string;
  missing: string[];
  exclusion?: ExclusionReason;
}

export const EXCLUSION_LABEL: Record<ExclusionReason, string> = {
  opted_out: 'Opted out / suppressed',
  no_consent: 'No recorded consent',
  missing_fields: 'Missing placeholder values',
};

/** True when a contact must never be messaged, regardless of campaign settings. */
export function isOptedOut(contact: Pick<Contact, 'phone' | 'consent'>, suppressed: Set<string>): boolean {
  return contact.consent === 'denied' || suppressed.has(contact.phone);
}

export function buildAudience(contacts: Contact[], templateBody: string, opts: AudienceOptions): AudienceEntry[] {
  return contacts.map((contact) => {
    const { text, missing } = renderTemplate(templateBody, contactContext(contact));
    const entry: AudienceEntry = { contact, message: text, missing };
    if (isOptedOut(contact, opts.suppressed)) entry.exclusion = 'opted_out';
    else if (opts.requireConsent && contact.consent !== 'granted') entry.exclusion = 'no_consent';
    else if (opts.skipIncomplete && missing.length > 0) entry.exclusion = 'missing_fields';
    return entry;
  });
}

/** Freeze the audience into recipient records. Excluded contacts are kept as "skipped" so nothing disappears silently. */
export function toRecipients(campaignId: string, audience: AudienceEntry[], now = Date.now()): Recipient[] {
  return audience.map((a, order) => {
    const base: Recipient = {
      id: newId('r'),
      campaignId,
      contactId: a.contact.id,
      phone: a.contact.phone,
      name: a.contact.name,
      message: a.message,
      status: a.exclusion ? 'skipped' : 'pending',
      attempts: 0,
      sendGeneration: 0,
      order,
      updatedAt: now,
      history: [{ at: now, status: a.exclusion ? 'skipped' : 'pending', ...(a.exclusion ? { note: EXCLUSION_LABEL[a.exclusion] } : {}) }],
    };
    if (a.exclusion) base.skipReason = a.exclusion;
    return base;
  });
}
