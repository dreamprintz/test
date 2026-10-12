import { db } from '../db/db';
import { completeIfFinished, updateRecipient } from '../db/campaigns';
import { suppressedSet } from '../db/contacts';
import { waDigits } from '../lib/phone';
import type { Recipient } from '../lib/types';

/**
 * WhatsApp Web helper. It only opens WhatsApp's own click-to-chat URL with the text prefilled.
 * The user reviews and presses Send in WhatsApp. "Sent" here means "the user told us they sent it".
 */
export function chatUrl(phone: string, message: string): string {
  return `https://web.whatsapp.com/send?phone=${waDigits(phone)}&text=${encodeURIComponent(message)}`;
}

const TAB_KEY = 'helperTabId';

export async function openInWhatsAppTab(url: string): Promise<void> {
  const stored = (await chrome.storage.session.get(TAB_KEY))[TAB_KEY] as number | undefined;
  if (stored !== undefined) {
    try {
      const tab = await chrome.tabs.update(stored, { url, active: true });
      if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      return;
    } catch {
      // Tab was closed; open a new one.
    }
  }
  const tab = await chrome.tabs.create({ url, active: true });
  if (tab.id !== undefined) await chrome.storage.session.set({ [TAB_KEY]: tab.id });
}

/** The recipient the user is working on (opened chat), or the next queued one. */
export async function currentRecipient(campaignId: string): Promise<Recipient | undefined> {
  const inFlight = await db.recipients.where('[campaignId+status]').equals([campaignId, 'processing']).sortBy('order');
  if (inFlight[0]) return inFlight[0];
  const pending = await db.recipients.where('[campaignId+status]').equals([campaignId, 'pending']).sortBy('order');
  return pending[0];
}

/** Returns false if the recipient was skipped because they opted out since launch. */
export async function openChatFor(r: Recipient): Promise<boolean> {
  const suppressed = await suppressedSet();
  const contact = await db.contacts.get(r.contactId);
  if (suppressed.has(r.phone) || contact?.consent === 'denied') {
    await updateRecipient(r.id, 'skipped', { skipReason: 'opted_out' }, 'Opted out after launch');
    await completeIfFinished(r.campaignId);
    return false;
  }
  if (r.status === 'pending') await updateRecipient(r.id, 'processing', { attempts: r.attempts + 1 }, 'Chat opened for review');
  await openInWhatsAppTab(chatUrl(r.phone, r.message));
  return true;
}

export async function confirmSent(r: Recipient): Promise<void> {
  await updateRecipient(r.id, 'sent', { sentEvidence: 'user_confirmed' }, 'User confirmed they pressed Send');
  await completeIfFinished(r.campaignId);
}

export async function markFailed(r: Recipient, reason: string): Promise<void> {
  await updateRecipient(r.id, 'failed', { lastError: reason, retryable: true }, reason);
  await completeIfFinished(r.campaignId);
}

export async function skipRecipient(r: Recipient): Promise<void> {
  await updateRecipient(r.id, 'skipped', { skipReason: 'user_skipped' }, 'Skipped by user');
  await completeIfFinished(r.campaignId);
}
