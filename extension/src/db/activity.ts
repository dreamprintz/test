import { db } from './db';

/** Activity log. Never pass phone numbers or message bodies here. */
export async function logActivity(type: string, message: string, campaignId?: string): Promise<void> {
  await db.activity.add(campaignId ? { at: Date.now(), type, message, campaignId } : { at: Date.now(), type, message });
  const count = await db.activity.count();
  if (count > 2000) {
    const old = await db.activity.orderBy('at').limit(count - 2000).primaryKeys();
    await db.activity.bulkDelete(old);
  }
}
