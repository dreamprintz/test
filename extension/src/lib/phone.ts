import { parsePhoneNumberFromString, getCountryCallingCode, type CountryCode } from 'libphonenumber-js/max';

export interface PhoneResult {
  ok: boolean;
  /** E.164 form when ok. */
  e164?: string;
  error?: string;
  /** Non-fatal concern, e.g. the number looks like a landline. */
  warning?: string;
  /** True when normalisation changed anything beyond formatting characters. */
  changed: boolean;
}

/**
 * Normalise a phone number to E.164. Numbers without an international prefix
 * are interpreted in `defaultCountry` (India by default). A "00" prefix is
 * treated as an international prefix.
 */
export function normalizePhone(raw: string, defaultCountry: CountryCode = 'IN'): PhoneResult {
  const input = (raw ?? '').trim();
  if (!input) return { ok: false, error: 'Missing phone number', changed: false };
  // Spreadsheet exports sometimes write numbers in scientific notation.
  if (/^\d(\.\d+)?e\+?\d+$/i.test(input)) {
    return { ok: false, error: 'Phone looks like scientific notation (spreadsheet formatting); fix the source file', changed: false };
  }
  if (/[a-z]/i.test(input.replace(/\b(ext|x)\.?\s*\d+$/i, ''))) {
    return { ok: false, error: 'Phone contains letters', changed: false };
  }
  let candidate = input.replace(/[\s\-().\/]/g, '');
  if (candidate.startsWith('00')) candidate = `+${candidate.slice(2)}`;
  const parsed = parsePhoneNumberFromString(candidate, defaultCountry);
  if (!parsed) return { ok: false, error: 'Not a recognisable phone number', changed: false };
  if (!parsed.isValid()) {
    return { ok: false, error: `Invalid number for ${parsed.country ?? defaultCountry}`, changed: false };
  }
  const type = parsed.getType();
  const e164 = parsed.number;
  const digitsIn = input.replace(/\D/g, '');
  const result: PhoneResult = { ok: true, e164, changed: `+${digitsIn}` !== e164 };
  if (type === 'FIXED_LINE' || type === 'PREMIUM_RATE' || type === 'TOLL_FREE' || type === 'SHARED_COST') {
    result.warning = `Looks like a ${type.toLowerCase().replace(/_/g, ' ')} number; it may not be on WhatsApp`;
  }
  return result;
}

export function callingCode(country: CountryCode): string {
  return `+${getCountryCallingCode(country)}`;
}

/** Digits only (no "+"), as expected by WhatsApp click-to-chat URLs and the Cloud API. */
export function waDigits(e164: string): string {
  return e164.replace(/\D/g, '');
}

/** Mask for logs and lists where the full number isn't needed: +91******3210 */
export function maskPhone(e164: string): string {
  if (e164.length <= 6) return e164;
  return `${e164.slice(0, 3)}${'*'.repeat(Math.max(0, e164.length - 7))}${e164.slice(-4)}`;
}
