import type { CountryCode } from 'libphonenumber-js';

export type Theme = 'system' | 'light' | 'dark';

export interface Settings {
  defaultCountry: CountryCode;
  theme: Theme;
  /** Manual helper: include contacts whose consent is "unknown". Cloud API always requires "granted". */
  manualRequireConsent: boolean;
  skipIncomplete: boolean;
  cloudApi: {
    enabled: boolean;
    /** Your own backend (see /backend). Meta credentials live only there. */
    backendUrl: string;
    /** Shared secret for your backend, not a Meta token. */
    backendKey: string;
    /** User has agreed that phone numbers and message parameters are sent to this backend. */
    dataSharingConsent: boolean;
    /** Messages per minute sent from the queue. */
    ratePerMinute: number;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  defaultCountry: 'IN',
  theme: 'system',
  manualRequireConsent: false,
  skipIncomplete: true,
  cloudApi: { enabled: false, backendUrl: 'http://localhost:8787', backendKey: '', dataSharingConsent: false, ratePerMinute: 20 },
};

const KEY = 'settings';
const hasChromeStorage = () => typeof chrome !== 'undefined' && !!chrome.storage?.local;

export function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  return { ...DEFAULT_SETTINGS, ...stored, cloudApi: { ...DEFAULT_SETTINGS.cloudApi, ...(stored?.cloudApi ?? {}) } };
}

export async function loadSettings(): Promise<Settings> {
  if (hasChromeStorage()) {
    const res = await chrome.storage.local.get(KEY);
    return mergeSettings(res[KEY] as Partial<Settings> | undefined);
  }
  try {
    return mergeSettings(JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? undefined);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  if (hasChromeStorage()) await chrome.storage.local.set({ [KEY]: s });
  else localStorage.setItem(KEY, JSON.stringify(s));
}

export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  if (!hasChromeStorage()) return () => {};
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[KEY]) cb(mergeSettings(changes[KEY].newValue as Partial<Settings>));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** Origin pattern for chrome.permissions, e.g. https://api.example.com/* */
export function originPattern(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}
