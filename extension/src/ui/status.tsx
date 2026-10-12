import { Badge, type Tone } from './components';
import type { CampaignStatus, ConsentStatus, DeliveryStatus, Recipient, RecipientStatus } from '../lib/types';

const campaignTone: Record<CampaignStatus, Tone> = { draft: 'neutral', running: 'blue', paused: 'amber', completed: 'green', cancelled: 'red' };
export function CampaignStatusBadge({ status, archived }: { status: CampaignStatus; archived?: boolean }) {
  return (
    <span className="inline-flex gap-1">
      <Badge tone={campaignTone[status]}>{status[0]!.toUpperCase() + status.slice(1)}</Badge>
      {archived && <Badge>Archived</Badge>}
    </span>
  );
}

const recipientTone: Record<RecipientStatus, Tone> = { pending: 'neutral', processing: 'blue', sent: 'green', failed: 'red', skipped: 'amber', unknown: 'purple' };
export function recipientLabel(r: Pick<Recipient, 'status' | 'sentEvidence'>): string {
  if (r.status === 'sent') return r.sentEvidence === 'user_confirmed' ? 'Sent (you confirmed)' : 'Sent (API accepted)';
  if (r.status === 'processing') return 'Processing';
  if (r.status === 'unknown') return 'Outcome unknown';
  return r.status[0]!.toUpperCase() + r.status.slice(1);
}
export function RecipientStatusBadge({ r }: { r: Pick<Recipient, 'status' | 'sentEvidence'> }) {
  return <Badge tone={recipientTone[r.status]}>{recipientLabel(r)}</Badge>;
}

const deliveryTone: Record<DeliveryStatus, Tone> = { accepted: 'neutral', sent: 'blue', delivered: 'green', read: 'green', failed: 'red' };
export function DeliveryBadge({ status }: { status?: DeliveryStatus }) {
  if (!status) return <span className="text-xs text-slate-400" title="Delivery status is only available with the official API">n/a</span>;
  return <Badge tone={deliveryTone[status]}>{status[0]!.toUpperCase() + status.slice(1)}</Badge>;
}

const consentTone: Record<ConsentStatus, Tone> = { unknown: 'neutral', granted: 'green', denied: 'red' };
const consentLabel: Record<ConsentStatus, string> = { unknown: 'Unknown', granted: 'Opted in', denied: 'Opted out' };
export function ConsentBadge({ consent }: { consent: ConsentStatus }) {
  return <Badge tone={consentTone[consent]}>{consentLabel[consent]}</Badge>;
}
