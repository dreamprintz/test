import { db } from './db';
import { newId } from '../lib/ids';
import { assertCampaignTransition, countRecipients, isFinished, retryDecision, transitionRecipient } from '../lib/campaign';
import { buildAudience, toRecipients, type AudienceEntry } from '../lib/audience';
import { suppressedSet } from './contacts';
import { logActivity } from './activity';
import type { Campaign, CampaignStatus, CloudTemplateConfig, ProviderId, Recipient, RecipientStatus } from '../lib/types';
import { toCsv } from '../lib/csv';

export interface CampaignDraft {
  name: string;
  listId: string;
  templateId: string;
  provider: ProviderId;
  cloudTemplate?: CloudTemplateConfig;
}

function event(type: string, note?: string) {
  return note ? { at: Date.now(), type, note } : { at: Date.now(), type };
}

function validateDraft(d: CampaignDraft) {
  if (!d.name.trim()) throw new Error('Campaign name is required');
  if (!d.listId) throw new Error('Choose a contact list');
  if (!d.templateId) throw new Error('Choose a message template');
  if (d.provider === 'cloud_api') {
    if (!d.cloudTemplate?.name.trim()) throw new Error('Enter the approved WhatsApp template name');
    if (!d.cloudTemplate.language.trim()) throw new Error('Enter the template language code');
  }
}

export async function saveDraft(d: CampaignDraft, id?: string): Promise<Campaign> {
  validateDraft(d);
  const now = Date.now();
  const template = await db.templates.get(d.templateId);
  if (!template) throw new Error('Template not found');
  if (id) {
    const existing = await db.campaigns.get(id);
    if (!existing) throw new Error('Campaign not found');
    if (existing.status !== 'draft') throw new Error('Only draft campaigns can be edited');
    const next: Campaign = { ...existing, ...d, name: d.name.trim(), templateBody: template.body, updatedAt: now, history: [...existing.history, event('edited')] };
    await db.campaigns.put(next);
    return next;
  }
  const c: Campaign = {
    id: newId('cmp'),
    ...d,
    name: d.name.trim(),
    templateBody: template.body,
    status: 'draft',
    archived: false,
    createdAt: now,
    updatedAt: now,
    history: [event('created')],
  };
  await db.campaigns.add(c);
  await logActivity('campaign', `Created campaign "${c.name}"`, c.id);
  return c;
}

export async function duplicateCampaign(id: string): Promise<Campaign> {
  const c = await db.campaigns.get(id);
  if (!c) throw new Error('Campaign not found');
  const draft: CampaignDraft = { name: `${c.name} (copy)`, listId: c.listId, templateId: c.templateId, provider: c.provider };
  if (c.cloudTemplate) draft.cloudTemplate = { ...c.cloudTemplate, bodyParams: [...c.cloudTemplate.bodyParams] };
  return saveDraft(draft);
}

export async function setArchived(id: string, archived: boolean): Promise<void> {
  const c = await db.campaigns.get(id);
  if (!c) throw new Error('Campaign not found');
  if (archived && (c.status === 'running' || c.status === 'paused')) throw new Error('Cancel or finish the campaign before archiving it');
  await db.campaigns.update(id, { archived, updatedAt: Date.now(), history: [...c.history, event(archived ? 'archived' : 'unarchived')] });
}

export async function deleteDraft(id: string): Promise<void> {
  const c = await db.campaigns.get(id);
  if (c?.status !== 'draft') throw new Error('Only drafts can be deleted; archive other campaigns instead');
  await db.campaigns.delete(id);
}

export interface AudienceOptionsInput {
  requireConsent: boolean;
  skipIncomplete: boolean;
}

/** Preview who would receive the campaign, with exclusions explained. Opt-outs are always excluded. */
export async function previewAudience(listId: string, templateBody: string, provider: ProviderId, opts: AudienceOptionsInput): Promise<AudienceEntry[]> {
  const contacts = await db.contacts.where('listIds').equals(listId).sortBy('name');
  const suppressed = await suppressedSet();
  return buildAudience(contacts, templateBody, {
    suppressed,
    requireConsent: provider === 'cloud_api' ? true : opts.requireConsent,
    skipIncomplete: opts.skipIncomplete,
  });
}

/** Freeze the audience and start sending. */
export async function launchCampaign(id: string, opts: AudienceOptionsInput): Promise<void> {
  const c = await db.campaigns.get(id);
  if (!c) throw new Error('Campaign not found');
  assertCampaignTransition(c.status, 'running');
  const template = await db.templates.get(c.templateId);
  const body = template?.body ?? c.templateBody;
  const audience = await previewAudience(c.listId, body, c.provider, opts);
  const recipients = toRecipients(c.id, audience);
  if (!recipients.some((r) => r.status === 'pending')) throw new Error('No eligible recipients: everyone is excluded');
  await db.transaction('rw', db.campaigns, db.recipients, async () => {
    await db.recipients.where('campaignId').equals(id).delete();
    await db.recipients.bulkAdd(recipients);
    const now = Date.now();
    await db.campaigns.update(id, {
      status: 'running',
      templateBody: body,
      startedAt: now,
      updatedAt: now,
      history: [...c.history, event('started', `${recipients.filter((r) => r.status === 'pending').length} queued, ${recipients.filter((r) => r.status === 'skipped').length} excluded`)],
    });
  });
  await logActivity('campaign', `Started campaign "${c.name}"`, id);
}

export async function setCampaignStatus(id: string, to: CampaignStatus, note?: string): Promise<void> {
  await db.transaction('rw', db.campaigns, db.recipients, async () => {
    const c = await db.campaigns.get(id);
    if (!c) throw new Error('Campaign not found');
    if (c.status === to) return;
    assertCampaignTransition(c.status, to);
    const now = Date.now();
    const patch: Partial<Campaign> = { status: to, updatedAt: now, history: [...c.history, event(to === 'running' ? 'resumed' : to, note)] };
    if (to === 'completed' || to === 'cancelled') patch.completedAt = now;
    if (to === 'cancelled') {
      // Pending recipients are skipped; in-flight ones keep their state so their real outcome is recorded.
      const pending = await db.recipients.where('[campaignId+status]').equals([id, 'pending']).toArray();
      await db.recipients.bulkPut(pending.map((r) => ({ ...transitionRecipient(r, 'skipped', 'Campaign cancelled', now), skipReason: 'cancelled' })));
    }
    await db.campaigns.update(id, patch);
  });
  const c = await db.campaigns.get(id);
  await logActivity('campaign', `Campaign "${c?.name ?? id}" ${to === 'running' ? 'resumed' : to}`, id);
}

/** Mark completed when nothing is queued or in flight. */
export async function completeIfFinished(id: string): Promise<boolean> {
  const c = await db.campaigns.get(id);
  if (!c || c.status !== 'running') return false;
  const rs = await db.recipients.where('campaignId').equals(id).toArray();
  if (!isFinished(countRecipients(rs))) return false;
  await setCampaignStatus(id, 'completed');
  return true;
}

export async function updateRecipient(id: string, to: RecipientStatus, patch: Partial<Recipient> = {}, note?: string): Promise<Recipient> {
  return db.transaction('rw', db.recipients, async () => {
    const r = await db.recipients.get(id);
    if (!r) throw new Error('Recipient not found');
    const next = { ...transitionRecipient(r, to, note), ...patch };
    await db.recipients.put(next);
    return next;
  });
}

/** Requeue failures that are safe to retry. Returns how many were requeued and how many were held back. */
export async function retryFailed(campaignId: string): Promise<{ requeued: number; heldBack: number }> {
  let requeued = 0;
  let heldBack = 0;
  await db.transaction('rw', db.campaigns, db.recipients, async () => {
    const c = await db.campaigns.get(campaignId);
    if (!c) throw new Error('Campaign not found');
    if (c.status === 'cancelled') throw new Error('Cancelled campaigns cannot be retried; duplicate it instead');
    const failed = await db.recipients.where('[campaignId+status]').anyOf([[campaignId, 'failed'], [campaignId, 'unknown']]).toArray();
    const updates: Recipient[] = [];
    for (const r of failed) {
      if (retryDecision(r).eligible) {
        // Same sendGeneration => same idempotency key; the backend will not resend if the first attempt actually went through.
        updates.push({ ...transitionRecipient(r, 'pending', 'Queued for retry'), attempts: 0 });
        requeued++;
      } else heldBack++;
    }
    await db.recipients.bulkPut(updates);
    if (requeued > 0 && c.status === 'completed') {
      await db.campaigns.update(campaignId, { status: 'running', updatedAt: Date.now(), history: [...c.history, event('retry', `${requeued} requeued`)] });
    }
  });
  if (requeued) await logActivity('campaign', `Requeued ${requeued} failed recipient(s)`, campaignId);
  return { requeued, heldBack };
}

/**
 * Explicit user override for an "unknown" or permanently failed recipient.
 * Bumps sendGeneration so a new idempotency key is used; the user has accepted that a duplicate may occur.
 */
export async function forceResend(recipientId: string): Promise<void> {
  await db.transaction('rw', db.campaigns, db.recipients, async () => {
    const r = await db.recipients.get(recipientId);
    if (!r) throw new Error('Recipient not found');
    const d = retryDecision(r);
    if (d.eligible || !d.canForce) throw new Error(d.eligible ? 'Use "Retry failed" for this recipient' : d.reason);
    const next = transitionRecipient(r, 'pending', 'Resend forced by user (duplicate possible)');
    const updated: Recipient = { ...next, attempts: 0, sendGeneration: r.sendGeneration + 1 };
    delete updated.deliveryStatus;
    delete updated.providerMessageId;
    delete updated.lastError;
    delete updated.retryable;
    await db.recipients.put(updated);
    const c = await db.campaigns.get(r.campaignId);
    if (c && c.status === 'completed') await db.campaigns.update(c.id, { status: 'running', updatedAt: Date.now(), history: [...c.history, event('retry', 'Forced resend of one recipient')] });
  });
}

export async function campaignReportCsv(campaignId: string): Promise<string> {
  const rs = await db.recipients.where('[campaignId+order]').between([campaignId, -Infinity], [campaignId, Infinity]).toArray();
  return toCsv(
    ['name', 'phone', 'status', 'sent_evidence', 'delivery_status', 'attempts', 'error', 'skip_reason', 'provider_message_id', 'last_updated'],
    rs.map((r) => [r.name, r.phone, r.status, r.sentEvidence ?? '', r.deliveryStatus ?? '', r.attempts, r.lastError ?? '', r.skipReason ?? '', r.providerMessageId ?? '', new Date(r.updatedAt).toISOString()]),
  );
}
