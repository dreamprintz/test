import { loadSettings } from '../settings/settings';
import { BackendClient } from '../providers/cloudApi';
import { processCloudQueue, syncDeliveryStatuses, syncOptOuts } from './cloudQueue';

const ALARM = 'cloud-queue-tick';
let running: Promise<void> | null = null;

async function tick(): Promise<void> {
  if (running) return running;
  running = (async () => {
    const settings = await loadSettings();
    const api = settings.cloudApi;
    if (!api.enabled || !api.dataSharingConsent || !api.backendUrl || !api.backendKey) return;
    const client = new BackendClient(api);
    try {
      await processCloudQueue({ client, settings });
      await syncDeliveryStatuses(client);
      const { optOutSince = 0 } = (await chrome.storage.local.get('optOutSince')) as { optOutSince?: number };
      const { latest } = await syncOptOuts(client, optOutSince);
      if (latest > optOutSince) await chrome.storage.local.set({ optOutSince: latest });
    } catch (e) {
      // Contacts are never logged; only the error class/message.
      console.warn('Cloud queue tick failed:', e instanceof Error ? e.message : e);
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM);
  if (!existing) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => void ensureAlarm());
chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm();
  void tick();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) void tick();
});

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'cloud-queue-kick') {
    void ensureAlarm();
    void tick().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'open-dashboard') {
    void chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  }
  return false;
});
