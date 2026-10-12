import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CheckCircle2, ClipboardCopy, ExternalLink, LayoutDashboard, MessageCircle, Pause, Play, SkipForward, XCircle } from 'lucide-react';
import { db } from '../db/db';
import { setCampaignStatus } from '../db/campaigns';
import { confirmSent, currentRecipient, markFailed, openChatFor, skipRecipient } from '../providers/manual';
import { countRecipients, progress } from '../lib/campaign';
import { Alert, Button, Card, EmptyState, ProgressBar, Select, Spinner, useAction, useToast } from '../ui/components';
import { MessageBubble } from '../ui/MessagePreview';
import { HELPER_CAMPAIGN_KEY } from '../ui/helperLauncher';
import { isExtension } from '../ui/runtime';

const FAIL_REASONS = ['Number is not on WhatsApp', 'WhatsApp showed an error', 'Wrong or invalid number', 'Other problem'];

export default function Helper() {
  const [campaignId, setCampaignId] = useState<string | null>(new URLSearchParams(location.search).get('campaign'));
  const [failOpen, setFailOpen] = useState(false);
  const { run, busy } = useAction();
  const toast = useToast();

  useEffect(() => {
    if (!isExtension()) return;
    if (!campaignId) void chrome.storage.local.get(HELPER_CAMPAIGN_KEY).then((r) => { if (r[HELPER_CAMPAIGN_KEY]) setCampaignId(r[HELPER_CAMPAIGN_KEY] as string); });
    const l = (ch: Record<string, chrome.storage.StorageChange>, area: string) => { if (area === 'local' && ch[HELPER_CAMPAIGN_KEY]?.newValue) setCampaignId(ch[HELPER_CAMPAIGN_KEY].newValue as string); };
    chrome.storage.onChanged.addListener(l);
    return () => chrome.storage.onChanged.removeListener(l);
  }, [campaignId]);

  const data = useLiveQuery(async () => {
    const campaigns = (await db.campaigns.where('status').anyOf(['running', 'paused']).toArray()).filter((c) => c.provider === 'manual');
    const campaign = campaignId ? await db.campaigns.get(campaignId) : undefined;
    if (!campaign) return { campaigns, campaign: undefined, current: undefined, counts: undefined };
    const rs = await db.recipients.where('campaignId').equals(campaign.id).toArray();
    return { campaigns, campaign, current: await currentRecipient(campaign.id), counts: countRecipients(rs) };
  }, [campaignId]);

  if (!data) return <Spinner />;
  const { campaign, current, counts } = data;
  const openDashboard = (hash = '') => (isExtension() ? void chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html${hash}`) }) : window.open(`dashboard.html${hash}`));

  return (
    <div className="flex min-h-full flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2"><img src="icons/icon32.png" alt="" className="size-6" /><h1 className="font-semibold">WhatsApp Web helper</h1></div>
        <Button size="sm" variant="ghost" icon={<LayoutDashboard className="size-3.5" />} onClick={() => openDashboard(campaign ? `#/campaigns/${campaign.id}` : '')}>Dashboard</Button>
      </header>

      <Select aria-label="Campaign" value={campaign?.id ?? ''} onChange={(e) => { setCampaignId(e.target.value || null); if (isExtension()) void chrome.storage.local.set({ [HELPER_CAMPAIGN_KEY]: e.target.value }); }}>
        <option value="">Choose a campaign…</option>
        {data.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}{c.status === 'paused' ? ' (paused)' : ''}</option>)}
        {campaign && !data.campaigns.some((c) => c.id === campaign.id) && <option value={campaign.id}>{campaign.name} ({campaign.status})</option>}
      </Select>

      {!campaign ? (
        <Card><EmptyState icon={<MessageCircle className="size-5" />} title="No campaign selected" description="Start a campaign that uses the WhatsApp Web helper, then pick it here." action={<Button onClick={() => openDashboard('#/campaigns/new')}>New campaign</Button>} /></Card>
      ) : (
        <>
          {counts && <ProgressBar value={progress(counts)} label={`${counts.sent} sent · ${counts.failed} failed · ${counts.skipped} skipped · ${counts.pending + counts.processing} left`} />}

          {campaign.status === 'paused' && (
            <Alert tone="amber" title="Campaign paused"><Button size="sm" className="mt-2" icon={<Play className="size-3.5" />} onClick={() => void run(() => setCampaignStatus(campaign.id, 'running'), 'Resumed')}>Resume</Button></Alert>
          )}
          {(campaign.status === 'completed' || campaign.status === 'cancelled') && (
            <Alert tone="green" title={campaign.status === 'completed' ? 'Campaign complete 🎉' : 'Campaign cancelled'}>Review results and export a report from the dashboard.</Alert>
          )}

          {campaign.status === 'running' && !current && <Alert tone="green" title="Nothing left in the queue" />}

          {campaign.status === 'running' && current && (
            <Card className="space-y-3 p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs text-slate-500">Recipient {current.order + 1} of {counts?.total}</p>
                  <p className="font-semibold">{current.name || 'No name'}</p>
                  <p className="font-mono text-xs text-slate-500">{current.phone}</p>
                </div>
                {current.status === 'processing' && <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800 dark:bg-sky-900/40 dark:text-sky-300">Chat opened</span>}
              </div>
              <MessageBubble text={current.message} />

              {current.status === 'pending' ? (
                <Button variant="primary" className="w-full" loading={busy} icon={<ExternalLink className="size-4" />} onClick={() => void run(async () => { const ok = await openChatFor(current); if (!ok) toast('Skipped: this contact has opted out', 'info'); })}>
                  Open chat in WhatsApp Web
                </Button>
              ) : (
                <>
                  <p className="text-xs text-slate-600 dark:text-slate-400">Check the message in WhatsApp, press <strong>Send</strong> there, then confirm below. Nothing is sent automatically.</p>
                  <Button variant="primary" className="w-full" loading={busy} icon={<CheckCircle2 className="size-4" />} onClick={() => void run(() => confirmSent(current))}>I sent it — next</Button>
                  <div className="grid grid-cols-2 gap-2">
                    <Button icon={<XCircle className="size-4" />} onClick={() => setFailOpen(!failOpen)} aria-expanded={failOpen}>Couldn't send</Button>
                    <Button icon={<SkipForward className="size-4" />} onClick={() => void run(() => skipRecipient(current))}>Skip</Button>
                  </div>
                  {failOpen && (
                    <div className="space-y-1.5 rounded-lg border border-slate-200 p-2 dark:border-slate-700">
                      {FAIL_REASONS.map((r) => <Button key={r} size="sm" variant="ghost" className="w-full justify-start" onClick={() => void run(async () => { await markFailed(current, r); setFailOpen(false); })}>{r}</Button>)}
                    </div>
                  )}
                  <Button size="sm" variant="ghost" className="w-full" icon={<ExternalLink className="size-3.5" />} onClick={() => void run(() => openChatFor(current))}>Re-open chat</Button>
                </>
              )}
              <Button size="sm" variant="ghost" className="w-full" icon={<ClipboardCopy className="size-3.5" />} onClick={() => void run(() => navigator.clipboard.writeText(current.message), 'Message copied')}>Copy message</Button>
            </Card>
          )}

          {campaign.status === 'running' && (
            <Button size="sm" icon={<Pause className="size-3.5" />} onClick={() => void run(() => setCampaignStatus(campaign.id, 'paused'), 'Paused')}>Pause campaign</Button>
          )}
          <p className="text-xs text-slate-500">Progress is saved after every step. You can close this panel or restart Chrome and continue later.</p>
        </>
      )}
    </div>
  );
}
