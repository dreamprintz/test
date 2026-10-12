import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { countRecipients, type RecipientCounts } from '../lib/campaign';

/** Live recipient counts for one campaign (undefined while loading). */
export function useCampaignCounts(campaignId: string | undefined): RecipientCounts | undefined {
  return useLiveQuery(async () => {
    if (!campaignId) return undefined;
    const rs = await db.recipients.where('campaignId').equals(campaignId).toArray();
    return countRecipients(rs);
  }, [campaignId]);
}

/** Counts for many campaigns at once, keyed by campaign id. */
export function useAllCampaignCounts(): Map<string, RecipientCounts> | undefined {
  return useLiveQuery(async () => {
    const groups = new Map<string, { status: import('../lib/types').RecipientStatus; deliveryStatus?: import('../lib/types').DeliveryStatus }[]>();
    await db.recipients.each((r) => {
      const g = groups.get(r.campaignId) ?? [];
      g.push(r.deliveryStatus ? { status: r.status, deliveryStatus: r.deliveryStatus } : { status: r.status });
      groups.set(r.campaignId, g);
    });
    return new Map([...groups].map(([k, v]) => [k, countRecipients(v)]));
  }, []);
}
