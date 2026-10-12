/// <reference lib="webworker" />
import { validateRows, type ColumnMapping, type ParsedCsv } from './csv';
import type { CountryCode } from 'libphonenumber-js';

export interface ValidateRequest {
  id: number;
  parsed: ParsedCsv;
  mapping: ColumnMapping[];
  defaultCountry: CountryCode;
  existing: [string, string][];
  suppressed: string[];
}

self.onmessage = (e: MessageEvent<ValidateRequest>) => {
  const { id, parsed, mapping, defaultCountry, existing, suppressed } = e.data;
  try {
    const rows = validateRows(parsed, mapping, { defaultCountry, existingPhones: new Map(existing), suppressedPhones: new Set(suppressed) });
    self.postMessage({ id, rows });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
