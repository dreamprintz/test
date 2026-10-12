import { describe, expect, it } from 'vitest';
import { detectMapping, issuesCsv, parseCsvText, safeCell, summarize, validateRows } from './csv';

const csv = `﻿Name,Mobile,Email,Course,Registration Number,City
Asha Rao,98765 43210,asha@example.com,Data Science,REG-001,Pune
Ravi Kumar,+91 91234 56789,ravi@example,Web Dev,REG-002,Delhi
,9876543210,dup@example.com,Data Science,REG-003,Pune
Meena,12345,,Design,REG-004,Chennai
"Shah, Priya",,priya@example.com,Design,REG-005,Mumbai
Existing,9000000001,,ML,REG-006,Goa`;

describe('csv import', () => {
  const parsed = parseCsvText(csv);
  const mapping = detectMapping(parsed.headers);

  it('parses headers, strips BOM and handles quoted commas', () => {
    expect(parsed.headers[0]).toBe('Name');
    expect(parsed.rows).toHaveLength(6);
    expect(parsed.rows[4]![0]).toBe('Shah, Priya');
  });

  it('detects standard and custom columns', () => {
    const t = Object.fromEntries(mapping.map((m) => [m.header, m.target === 'custom' ? `custom:${m.key}` : m.target]));
    expect(t).toEqual({ Name: 'name', Mobile: 'phone', Email: 'email', Course: 'custom:course', 'Registration Number': 'custom:registration_no', City: 'custom:city' });
  });

  it('prefers a WhatsApp column over Phone', () => {
    const m = detectMapping(['Phone', 'WhatsApp Number', 'Name']);
    expect(m.find((x) => x.target === 'phone')!.header).toBe('WhatsApp Number');
    expect(m.find((x) => x.header === 'Phone')!.target).toBe('custom');
  });

  it('validates, normalises and flags duplicates, invalid, existing and suppressed rows', () => {
    const rows = validateRows(parsed, mapping, {
      defaultCountry: 'IN',
      existingPhones: new Map([['+919000000001', 'c_1']]),
      suppressedPhones: new Set(['+919123456789']),
    });
    expect(rows.map((r) => r.status)).toEqual(['valid', 'valid', 'duplicate', 'invalid', 'invalid', 'existing']);
    expect(rows[0]!.phone).toBe('+919876543210');
    expect(rows[0]!.fields).toEqual({ course: 'Data Science', registration_no: 'REG-001', city: 'Pune' });
    expect(rows[1]!.suppressed).toBe(true);
    expect(rows[1]!.issues.map((i) => i.code)).toContain('invalid_email');
    expect(rows[2]!.duplicateOfRow).toBe(1);
    expect(rows[2]!.issues.map((i) => i.code)).toContain('missing_name');
    expect(rows[4]!.issues.map((i) => i.code)).toContain('missing_phone');
    expect(rows[5]!.existingContactId).toBe('c_1');
    expect(summarize(rows)).toEqual({ total: 6, valid: 2, invalid: 2, duplicates: 1, existing: 1, missingName: 1, suppressed: 1 });
  });

  it('exports problem rows with original data', () => {
    const rows = validateRows(parsed, mapping, { defaultCountry: 'IN' });
    const out = issuesCsv(parsed, rows);
    const lines = out.split(/\r?\n/);
    expect(lines[0]).toBe('row_number,status,issues,Name,Mobile,Email,Course,Registration Number,City');
    expect(lines).toHaveLength(4);
    expect(out).toContain('Meena,12345');
  });

  it('requires exactly one phone column', () => {
    expect(() => validateRows(parsed, mapping.map((m) => ({ ...m, target: m.target === 'phone' ? 'ignore' : m.target })), { defaultCountry: 'IN' })).toThrow(/Phone/);
  });

  it('guards against spreadsheet formula injection but keeps phone numbers', () => {
    expect(safeCell('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
    expect(safeCell('+91 98765 43210')).toBe('+91 98765 43210');
    expect(safeCell('-cmd')).toBe(`'-cmd`);
  });

  it('detects semicolon delimiters', () => {
    expect(parseCsvText('name;phone\nA;9876543210').rows[0]).toEqual(['A', '9876543210']);
  });
});
