import { describe, expect, it } from 'vitest';
import { maskPhone, normalizePhone, waDigits } from './phone';

describe('normalizePhone', () => {
  it('adds the default Indian country code to a 10-digit mobile', () => {
    expect(normalizePhone('98765 43210')).toMatchObject({ ok: true, e164: '+919876543210', changed: true });
  });
  it('accepts numbers already in international form', () => {
    expect(normalizePhone('+91 98765-43210')).toMatchObject({ ok: true, e164: '+919876543210', changed: false });
  });
  it('treats 00 as an international prefix', () => {
    expect(normalizePhone('0044 7911 123456').e164).toBe('+447911123456');
  });
  it('strips the national trunk 0', () => {
    expect(normalizePhone('09876543210').e164).toBe('+919876543210');
  });
  it('uses the configured country', () => {
    expect(normalizePhone('07911 123456', 'GB').e164).toBe('+447911123456');
    expect(normalizePhone('(201) 555-0123', 'US').ok).toBe(true);
  });
  it('rejects missing, short, alphabetic and scientific-notation values', () => {
    expect(normalizePhone('')).toMatchObject({ ok: false, error: 'Missing phone number' });
    expect(normalizePhone('12345').ok).toBe(false);
    expect(normalizePhone('call me').ok).toBe(false);
    expect(normalizePhone('9.87654E+09').ok).toBe(false);
  });
  it('warns, but does not reject, landline numbers', () => {
    const r = normalizePhone('011 2345 6789');
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/fixed line/);
  });
});

describe('helpers', () => {
  it('formats digits and masks', () => {
    expect(waDigits('+919876543210')).toBe('919876543210');
    expect(maskPhone('+919876543210')).toBe('+91******3210');
  });
});
