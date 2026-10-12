/** Ask the service worker to process the Cloud API queue now (it also runs on a 30s alarm). */
export function kickCloudQueue(): void {
  if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
    chrome.runtime.sendMessage({ type: 'cloud-queue-kick' }).catch(() => {});
  }
}

export const isExtension = () => typeof chrome !== 'undefined' && !!chrome.runtime?.id;
