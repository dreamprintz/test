import { useEffect, useRef } from 'react';
import { isExtension } from './runtime';

export const HELPER_CAMPAIGN_KEY = 'helperCampaignId';

/** Returns a function that opens the WhatsApp Web helper side panel for a campaign. Must be called from a click. */
export function useOpenHelper() {
  const windowId = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (isExtension()) void chrome.windows.getCurrent().then((w) => { windowId.current = w.id; });
  }, []);
  return (campaignId: string, mode: 'panel' | 'window' = 'panel') => {
    if (!isExtension()) {
      window.open(`sidepanel.html?campaign=${campaignId}`, 'wa-helper', 'width=440,height=760');
      return;
    }
    void chrome.storage.local.set({ [HELPER_CAMPAIGN_KEY]: campaignId });
    if (mode === 'panel' && chrome.sidePanel && windowId.current !== undefined) {
      // Called synchronously inside the click handler to keep the user gesture.
      chrome.sidePanel.open({ windowId: windowId.current }).catch(() => openWindow(campaignId));
    } else openWindow(campaignId);
  };
}

function openWindow(campaignId: string) {
  void chrome.windows.create({ url: chrome.runtime.getURL(`sidepanel.html?campaign=${campaignId}`), type: 'popup', width: 440, height: 780 });
}
