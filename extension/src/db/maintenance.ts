import { db } from './db';

/** Full JSON export of everything stored locally (for backups and data-access requests). */
export async function exportAll(): Promise<string> {
  const [contacts, lists, suppression, templates, campaigns, recipients] = await Promise.all([
    db.contacts.toArray(), db.lists.toArray(), db.suppression.toArray(), db.templates.toArray(), db.campaigns.toArray(), db.recipients.toArray(),
  ]);
  return JSON.stringify({ format: 'wa-campaign-manager-backup', version: 1, exportedAt: new Date().toISOString(), contacts, lists, suppression, templates, campaigns, recipients }, null, 2);
}

export async function deleteAllData(): Promise<void> {
  await db.transaction('rw', [db.contacts, db.lists, db.suppression, db.templates, db.campaigns, db.recipients, db.activity], async () => {
    await Promise.all([db.contacts.clear(), db.lists.clear(), db.suppression.clear(), db.templates.clear(), db.campaigns.clear(), db.recipients.clear(), db.activity.clear()]);
  });
}

/** Remove message bodies and names from finished campaigns, keeping only aggregate status. */
export async function purgeFinishedCampaignContent(): Promise<number> {
  const finished = (await db.campaigns.toArray()).filter((c) => c.status === 'completed' || c.status === 'cancelled').map((c) => c.id);
  let n = 0;
  await db.recipients.where('campaignId').anyOf(finished).modify((r) => { r.message = ''; r.name = ''; n++; });
  return n;
}
