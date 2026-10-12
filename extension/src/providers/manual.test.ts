import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/db';
import { importRows, suppress } from '../db/contacts';
import { createList } from '../db/lists';
import { saveTemplate } from '../db/templates';
import { launchCampaign, retryFailed, saveDraft } from '../db/campaigns';
import { chatUrl, confirmSent, currentRecipient, markFailed, openChatFor, skipRecipient } from './manual';
import type { ImportRow } from '../lib/csv';

const tabs = { create: vi.fn(async (o: { url: string }) => ({ id: 7, windowId: 1, url: o.url })), update: vi.fn(async () => ({ id: 7, windowId: 1 })) };
const session = new Map<string, unknown>();
vi.stubGlobal('chrome', {
  tabs,
  windows: { update: vi.fn(async () => ({})) },
  storage: { session: { get: async (k: string) => ({ [k]: session.get(k) }), set: async (o: Record<string, unknown>) => Object.entries(o).forEach(([k, v]) => session.set(k, v)) } },
});

const row = (n: number): ImportRow => ({ rowNumber: n, raw: [], name: `P${n}`, rawPhone: '', phone: `+91987654321${n}`, email: '', fields: {}, issues: [], status: 'valid', suppressed: false });

async function setup() {
  const list = await createList('L');
  await importRows([row(1), row(2), row(3)], { listId: list.id, existing: 'keep', consent: 'granted' });
  const t = await saveTemplate({ name: 'T', body: 'Hi {{name}} & welcome!\nLine 2' });
  const c = await saveDraft({ name: 'C', listId: list.id, templateId: t.id, provider: 'manual' });
  await launchCampaign(c.id, { requireConsent: false, skipIncomplete: true });
  return c.id;
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  session.clear();
  tabs.create.mockClear();
  tabs.update.mockClear();
});

describe('WhatsApp Web helper', () => {
  it('builds a click-to-chat URL with the message encoded', () => {
    expect(chatUrl('+919876543210', 'Hi & bye\n👋')).toBe('https://web.whatsapp.com/send?phone=919876543210&text=Hi%20%26%20bye%0A%F0%9F%91%8B');
  });

  it('walks the queue only on explicit user actions and records evidence honestly', async () => {
    const id = await setup();
    const first = (await currentRecipient(id))!;
    expect(first.status).toBe('pending');
    expect(await openChatFor(first)).toBe(true);
    expect(tabs.create).toHaveBeenCalledTimes(1);
    const opened = (await currentRecipient(id))!;
    expect(opened.id).toBe(first.id);
    expect(opened.status).toBe('processing');
    await confirmSent(opened);
    expect((await db.recipients.get(first.id))!).toMatchObject({ status: 'sent', sentEvidence: 'user_confirmed' });
    expect((await db.recipients.get(first.id))!.deliveryStatus).toBeUndefined();

    const second = (await currentRecipient(id))!;
    await openChatFor(second);
    expect(tabs.update).toHaveBeenCalledWith(7, expect.objectContaining({ active: true }));
    await markFailed((await currentRecipient(id))!, 'Number is not on WhatsApp');
    const third = (await currentRecipient(id))!;
    await skipRecipient(third);
    expect((await db.campaigns.get(id))!.status).toBe('completed');

    expect(await retryFailed(id)).toEqual({ requeued: 1, heldBack: 0 });
    expect((await currentRecipient(id))!.id).toBe(second.id);
  });

  it('skips a contact who opted out after launch instead of opening the chat', async () => {
    const id = await setup();
    const first = (await currentRecipient(id))!;
    await suppress(first.phone, 'STOP', 'manual');
    expect(await openChatFor(first)).toBe(false);
    expect(tabs.create).not.toHaveBeenCalled();
    expect((await db.recipients.get(first.id))!).toMatchObject({ status: 'skipped', skipReason: 'opted_out' });
  });
});
