import Papa from 'papaparse';
import type { CountryCode } from 'libphonenumber-js';
import { normalizePhone } from './phone';
import { toFieldKey } from './template';

export type MappingTarget = 'name' | 'first_name' | 'last_name' | 'phone' | 'email' | 'custom' | 'ignore';

export interface ColumnMapping {
  header: string;
  index: number;
  target: MappingTarget;
  /** Placeholder key when target is "custom". */
  key: string;
}

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
  delimiter: string;
  /** Problems reported by the parser (e.g. unmatched quotes), with 1-based line numbers. */
  parseErrors: { row: number; message: string }[];
}

export type IssueLevel = 'error' | 'warning';

export interface RowIssue {
  level: IssueLevel;
  code: 'missing_phone' | 'invalid_phone' | 'missing_name' | 'duplicate_in_file' | 'existing_contact' | 'suppressed' | 'phone_normalised' | 'phone_warning' | 'invalid_email' | 'column_count';
  message: string;
}

export type RowStatus = 'valid' | 'invalid' | 'duplicate' | 'existing';

export interface ImportRow {
  /** 1-based data row number (header excluded), matching what spreadsheet users see minus the header. */
  rowNumber: number;
  raw: string[];
  name: string;
  rawPhone: string;
  phone?: string;
  email: string;
  fields: Record<string, string>;
  issues: RowIssue[];
  status: RowStatus;
  duplicateOfRow?: number;
  existingContactId?: string;
  suppressed: boolean;
}

export interface ImportSummary {
  total: number;
  valid: number;
  invalid: number;
  duplicates: number;
  existing: number;
  missingName: number;
  suppressed: number;
}

/** Common header spellings. Matching is done on toFieldKey(header). */
const HEADER_ALIASES: Record<Exclude<MappingTarget, 'custom' | 'ignore'>, string[]> = {
  name: ['name', 'full_name', 'fullname', 'student_name', 'contact_name', 'customer_name', 'candidate_name'],
  first_name: ['first_name', 'firstname', 'given_name', 'fname'],
  last_name: ['last_name', 'lastname', 'surname', 'family_name', 'lname'],
  phone: ['whatsapp', 'whatsapp_number', 'whatsapp_no', 'mobile', 'mobile_number', 'mobile_no', 'phone', 'phone_number', 'phone_no', 'contact', 'contact_number', 'contact_no', 'cell', 'telephone', 'tel', 'number'],
  email: ['email', 'email_address', 'e_mail', 'mail', 'email_id'],
};

/** Canonical keys for frequent custom fields so templates like {{registration_no}} just work. */
const CUSTOM_ALIASES: Record<string, string[]> = {
  registration_no: ['registration_no', 'registration_number', 'reg_no', 'reg_number', 'regno', 'registration_id', 'registration'],
  course: ['course', 'course_name', 'program', 'programme', 'program_name'],
};

export function parseCsvText(text: string): ParsedCsv {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const result = Papa.parse<string[]>(clean, { skipEmptyLines: 'greedy', delimitersToGuess: [',', ';', '\t', '|'] });
  return toParsed(result);
}

export function parseCsvFile(file: File, encoding = 'UTF-8'): Promise<ParsedCsv> {
  return new Promise((resolve, reject) => {
    Papa.parse<string[]>(file, {
      encoding,
      skipEmptyLines: 'greedy',
      delimitersToGuess: [',', ';', '\t', '|'],
      complete: (result) => {
        try {
          resolve(toParsed(result));
        } catch (e) {
          reject(e);
        }
      },
      error: (err) => reject(err),
    });
  });
}

function toParsed(result: Papa.ParseResult<string[]>): ParsedCsv {
  const [headerRow, ...rows] = result.data;
  if (!headerRow || headerRow.every((h) => !String(h).trim())) throw new Error('The file has no header row.');
  const headers = headerRow.map((h, i) => {
    const v = String(h ?? '').replace(/^﻿/, '').trim();
    return v || `Column ${i + 1}`;
  });
  return {
    headers,
    rows: rows.map((r) => r.map((c) => String(c ?? ''))),
    delimiter: result.meta.delimiter,
    parseErrors: result.errors.map((e) => ({ row: (e.row ?? 0) + 1, message: e.message })),
  };
}

export function detectMapping(headers: string[]): ColumnMapping[] {
  const keys = headers.map(toFieldKey);
  const mapping: ColumnMapping[] = headers.map((header, index) => ({ header, index, target: 'custom', key: keys[index]! }));
  const claim = (target: Exclude<MappingTarget, 'custom' | 'ignore'>) => {
    // Earlier alias = stronger signal (e.g. a "WhatsApp" column beats "Phone").
    for (const alias of HEADER_ALIASES[target]) {
      const idx = keys.findIndex((k, i) => k === alias && mapping[i]!.target === 'custom');
      if (idx >= 0) {
        mapping[idx]!.target = target;
        return;
      }
    }
  };
  claim('phone');
  claim('name');
  claim('email');
  if (!mapping.some((m) => m.target === 'name')) {
    claim('first_name');
    claim('last_name');
  }
  for (const m of mapping) {
    if (m.target !== 'custom') continue;
    for (const [canonical, aliases] of Object.entries(CUSTOM_ALIASES)) {
      if (aliases.includes(m.key) && !mapping.some((o) => o !== m && o.target === 'custom' && o.key === canonical)) {
        m.key = canonical;
      }
    }
  }
  return dedupeKeys(mapping);
}

/** Guarantee unique custom keys ("city", "city_2") so no column silently overwrites another. */
export function dedupeKeys(mapping: ColumnMapping[]): ColumnMapping[] {
  const reserved = new Set(['name', 'first_name', 'phone', 'email']);
  const used = new Set<string>();
  return mapping.map((m) => {
    if (m.target !== 'custom') return m;
    let key = toFieldKey(m.key);
    if (reserved.has(key)) key = `${key}_col`;
    let n = 2;
    const base = key;
    while (used.has(key)) key = `${base}_${n++}`;
    used.add(key);
    return { ...m, key };
  });
}

export interface ValidateOptions {
  defaultCountry: CountryCode;
  /** E.164 phone -> existing contact id */
  existingPhones?: Map<string, string>;
  suppressedPhones?: Set<string>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateRows(parsed: ParsedCsv, mapping: ColumnMapping[], opts: ValidateOptions): ImportRow[] {
  const phoneCols = mapping.filter((m) => m.target === 'phone');
  if (phoneCols.length !== 1) throw new Error('Map exactly one column to Phone.');
  const phoneCol = phoneCols[0]!;
  const col = (t: MappingTarget) => mapping.find((m) => m.target === t);
  const nameCol = col('name');
  const firstCol = col('first_name');
  const lastCol = col('last_name');
  const emailCol = col('email');
  const customCols = mapping.filter((m) => m.target === 'custom');
  const firstSeen = new Map<string, number>();

  return parsed.rows.map((raw, i) => {
    const rowNumber = i + 1;
    const cell = (m?: ColumnMapping) => (m ? (raw[m.index] ?? '').trim() : '');
    const issues: RowIssue[] = [];
    if (raw.length !== parsed.headers.length) {
      issues.push({ level: 'warning', code: 'column_count', message: `Row has ${raw.length} columns, header has ${parsed.headers.length}` });
    }
    let name = cell(nameCol);
    if (!name) name = [cell(firstCol), cell(lastCol)].filter(Boolean).join(' ');
    const email = cell(emailCol);
    const rawPhone = cell(phoneCol);
    const fields: Record<string, string> = {};
    for (const c of customCols) fields[c.key] = cell(c);
    if (lastCol) fields.last_name = cell(lastCol);

    let phone: string | undefined;
    let status: RowStatus = 'valid';
    let duplicateOfRow: number | undefined;
    let existingContactId: string | undefined;
    let suppressed = false;

    if (!rawPhone) {
      issues.push({ level: 'error', code: 'missing_phone', message: 'Phone number is missing' });
      status = 'invalid';
    } else {
      const res = normalizePhone(rawPhone, opts.defaultCountry);
      if (!res.ok) {
        issues.push({ level: 'error', code: 'invalid_phone', message: res.error ?? 'Invalid phone number' });
        status = 'invalid';
      } else {
        phone = res.e164!;
        if (res.changed) issues.push({ level: 'warning', code: 'phone_normalised', message: `Normalised "${rawPhone}" to ${phone}` });
        if (res.warning) issues.push({ level: 'warning', code: 'phone_warning', message: res.warning });
        const prev = firstSeen.get(phone);
        if (prev !== undefined) {
          issues.push({ level: 'warning', code: 'duplicate_in_file', message: `Same phone as row ${prev}` });
          status = 'duplicate';
          duplicateOfRow = prev;
        } else {
          firstSeen.set(phone, rowNumber);
          const existing = opts.existingPhones?.get(phone);
          if (existing) {
            existingContactId = existing;
            status = 'existing';
            issues.push({ level: 'warning', code: 'existing_contact', message: 'Already in your contacts' });
          }
        }
        if (opts.suppressedPhones?.has(phone)) {
          suppressed = true;
          issues.push({ level: 'warning', code: 'suppressed', message: 'On the opt-out list; will never be messaged' });
        }
      }
    }
    if (!name) issues.push({ level: 'warning', code: 'missing_name', message: 'Name is missing' });
    if (email && !EMAIL.test(email)) issues.push({ level: 'warning', code: 'invalid_email', message: 'Email address looks invalid' });

    const row: ImportRow = { rowNumber, raw, name, rawPhone, email, fields, issues, status, suppressed };
    if (phone) row.phone = phone;
    if (duplicateOfRow !== undefined) row.duplicateOfRow = duplicateOfRow;
    if (existingContactId) row.existingContactId = existingContactId;
    return row;
  });
}

export function summarize(rows: ImportRow[]): ImportSummary {
  const s: ImportSummary = { total: rows.length, valid: 0, invalid: 0, duplicates: 0, existing: 0, missingName: 0, suppressed: 0 };
  for (const r of rows) {
    if (r.status === 'valid') s.valid++;
    else if (r.status === 'invalid') s.invalid++;
    else if (r.status === 'duplicate') s.duplicates++;
    else if (r.status === 'existing') s.existing++;
    if (r.issues.some((i) => i.code === 'missing_name')) s.missingName++;
    if (r.suppressed) s.suppressed++;
  }
  return s;
}

/** Prevent CSV/formula injection when the export is opened in a spreadsheet. */
export function safeCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  if (/^[=@\t\r]/.test(s)) return `'${s}`;
  if (/^[+-]/.test(s) && !/^[+-]?[\d\s().-]+$/.test(s)) return `'${s}`;
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return Papa.unparse({ fields: headers.map(safeCell), data: rows.map((r) => r.map(safeCell)) });
}

/** Rows that will not be imported as-is, with the original data and every issue. */
export function issuesCsv(parsed: ParsedCsv, rows: ImportRow[]): string {
  const flagged = rows.filter((r) => r.status === 'invalid' || r.status === 'duplicate' || r.issues.some((i) => i.level === 'error'));
  return toCsv(
    ['row_number', 'status', 'issues', ...parsed.headers],
    flagged.map((r) => [r.rowNumber, r.status, r.issues.map((i) => i.message).join('; '), ...parsed.headers.map((_, i) => r.raw[i] ?? '')]),
  );
}
