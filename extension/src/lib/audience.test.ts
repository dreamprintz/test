import { describe, expect, it } from 'vitest';
import { buildAudience, isOptedOut, toRecipients } from './audience';
import type { Contact } from './types';

const contact = (id: string, phone: string, over: Partial<Contact> = {}): Contact => ({
  id, phone, rawPhone: phone, name: `N${id}`, email: '', fields: { course: 'X' }, listIds: ['l'], consent: 'granted', createdAt: 0, updatedAt: 0, ...over,
});

describe('suppression filtering', () => {
  const contacts = [
    contact('1', '+911'),
    contact('2', '+912'),
    contact('3', '+913', { consent: 'denied' }),
    contact('4', '+914', { consent: 'unknown' }),
    contact('5', '+915', { fields: {} }),
  ];
  const suppressed = new Set(['+912']);

  it('always excludes suppressed and denied contacts', () => {
    const a = buildAudience(contacts, 'Hi {{name}} {{course}}', { suppressed, requireConsent: false, skipIncomplete: false });
    expect(a.map((e) => e.exclusion)).toEqual([undefined, 'opted_out', 'opted_out', undefined, undefined]);
    expect(isOptedOut(contacts[2]!, new Set())).toBe(true);
  });
  it('can require consent and complete data', () => {
    const a = buildAudience(contacts, 'Hi {{name}} {{course}}', { suppressed, requireConsent: true, skipIncomplete: true });
    expect(a.map((e) => e.exclusion)).toEqual([undefined, 'opted_out', 'opted_out', 'no_consent', 'missing_fields']);
  });
  it('keeps excluded contacts as skipped recipients with a reason', () => {
    const a = buildAudience(contacts, 'Hi {{name}}', { suppressed, requireConsent: true, skipIncomplete: true });
    const rs = toRecipients('c', a, 1);
    expect(rs).toHaveLength(5);
    expect(rs.map((r) => r.status)).toEqual(['pending', 'skipped', 'skipped', 'skipped', 'pending']);
    expect(rs[1]!.skipReason).toBe('opted_out');
    expect(rs[0]!.message).toBe('Hi N1');
  });
});
