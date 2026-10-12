import { db } from './db';
import { newId } from '../lib/ids';
import type { ImportRow } from '../lib/csv';
import type { ConsentStatus, Contact, SuppressionEntry, SuppressionSource } from '../lib/types';
import { logActivity } from './activity';

export type ExistingStrategy = 'keep' | 'merge';

export interface ImportOptions {
  listId?: string;
  /** For contacts that already exist: keep their data and only add to the list, or fill in/overwrite with CSV values. */
  existing: ExistingStrategy;
  consent: ConsentStatus;
  consentNote?: string;
}

export interface ImportResult {
  created: number;
  updated: number;
  addedToList: number;
}

/** Import the rows the user selected. Every row is either created, merged or reported; nothing is dropped. */
export async function importRows(rows: ImportRow[], opts: ImportOptions): Promise<ImportResult> {
  const now = Date.now();
  const result: ImportResult = { created: 0, updated: 0, addedToList: 0 };
  await db.transaction('rw', db.contacts, async () => {
    const phones = rows.map((r) => r.phone).filter((p): p is string => !!p);
    const existing = await db.contacts.where('phone').anyOf(phones).toArray();
    const byPhone = new Map(existing.map((c) => [c.phone, c]));
    const creates: Contact[] = [];
    const updates: Contact[] = [];
    for (const row of rows) {
      if (!row.phone) throw new Error(`Row ${row.rowNumber} has no valid phone and cannot be imported`);
      const found = byPhone.get(row.phone);
      if (found) {
        const next: Contact = { ...found, updatedAt: now };
        if (opts.listId && !next.listIds.includes(opts.listId)) {
          next.listIds = [...next.listIds, opts.listId];
          result.addedToList++;
        }
        if (opts.existing === 'merge') {
          if (row.name) next.name = row.name;
          if (row.email) next.email = row.email;
          next.fields = { ...next.fields, ...Object.fromEntries(Object.entries(row.fields).filter(([, v]) => v !== '')) };
          // Merging never upgrades or clears an opt-out.
          if (found.consent === 'unknown' && opts.consent !== 'unknown') setConsentFields(next, opts.consent, opts.consentNote, now);
        }
        updates.push(next);
        byPhone.set(row.phone, next);
        result.updated++;
      } else {
        const c: Contact = {
          id: newId('c'),
          phone: row.phone,
          rawPhone: row.rawPhone,
          name: row.name,
          email: row.email,
          fields: row.fields,
          listIds: opts.listId ? [opts.listId] : [],
          consent: 'unknown',
          createdAt: now,
          updatedAt: now,
        };
        setConsentFields(c, opts.consent, opts.consentNote, now);
        creates.push(c);
        byPhone.set(row.phone, c);
        result.created++;
        if (opts.listId) result.addedToList++;
      }
    }
    await db.contacts.bulkAdd(creates);
    await db.contacts.bulkPut(updates);
  });
  await logActivity('import', `Imported ${result.created} new and ${result.updated} existing contacts`);
  return result;
}

function setConsentFields(c: Contact, consent: ConsentStatus, note: string | undefined, now: number) {
  c.consent = consent;
  c.consentUpdatedAt = now;
  if (note) c.consentNote = note;
}

export async function existingPhoneMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  await db.contacts.each((c) => map.set(c.phone, c.id));
  return map;
}

export async function updateContact(id: string, patch: Partial<Omit<Contact, 'id' | 'createdAt'>>): Promise<void> {
  if (patch.phone) {
    const clash = await db.contacts.where('phone').equals(patch.phone).first();
    if (clash && clash.id !== id) throw new Error('Another contact already uses this phone number');
  }
  await db.contacts.update(id, { ...patch, updatedAt: Date.now() });
}

export async function setConsent(ids: string[], consent: ConsentStatus, note?: string): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', db.contacts, db.suppression, async () => {
    const contacts = await db.contacts.bulkGet(ids);
    for (const c of contacts) {
      if (!c) continue;
      await db.contacts.update(c.id, { consent, consentUpdatedAt: now, consentNote: note ?? c.consentNote ?? '', updatedAt: now });
      if (consent === 'denied') await suppress(c.phone, note || 'Consent withdrawn', 'contact');
    }
  });
}

export async function deleteContacts(ids: string[]): Promise<void> {
  await db.contacts.bulkDelete(ids);
  await logActivity('contacts', `Deleted ${ids.length} contact(s)`);
}

export async function suppress(phone: string, reason: string, source: SuppressionSource): Promise<void> {
  const existing = await db.suppression.get(phone);
  if (existing) return;
  const entry: SuppressionEntry = { phone, reason, source, createdAt: Date.now() };
  await db.suppression.put(entry);
}

export async function unsuppress(phone: string): Promise<void> {
  await db.suppression.delete(phone);
}

export async function suppressedSet(): Promise<Set<string>> {
  return new Set(await db.suppression.toCollection().primaryKeys());
}
