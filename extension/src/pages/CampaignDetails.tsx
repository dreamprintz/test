import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Archive, ArchiveRestore, Ban, Copy, Download, ExternalLink, Pause, PanelRight, Pencil, Play, RefreshCw, RotateCcw, Search, Trash2 } from 'lucide-react';
import { db } from '../db/db';
import { campaignReportCsv, deleteDraft, duplicateCampaign, forceResend, retryFailed, setArchived, setCampaignStatus } from '../db/campaigns';
import { countRecipients, progress, retryDecision } from '../lib/campaign';
import type { Recipient, RecipientStatus } from '../lib/types';
import { Alert, Button, Card, EmptyState, Input, Modal, PageHeader, ProgressBar, Select, Spinner, Stat, useAction, useConfirm } from '../ui/components';
import { CampaignStatusBadge, DeliveryBadge, RecipientStatusBadge } from '../ui/status';
import { Pager, usePage } from '../ui/Pager';
import { downloadText, fmtDate } from '../ui/download';
import { MessageBubble } from '../ui/MessagePreview';
import { kickCloudQueue } from '../ui/runtime';
import { useOpenHelper } from '../ui/helperLauncher';
import { EXCLUSION_LABEL, type ExclusionReason } from '../lib/audience';

const SKIP_LABEL: Record<string, string> = { ...EXCLUSION_LABEL, cancelled: 'Campaign cancelled', user_skipped: 'Skipped by you' };

export default function CampaignDetails() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const openHelper = useOpenHelper();
  const [filter, setFilter] = useState<'' | RecipientStatus>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<Recipient | null>(null);

  const data = useLiveQuery(async () => {
    const campaign = await db.campaigns.get(id);
    if (!campaign) return null;
    const recipients = await db.recipients.where('[campaignId+order]').between([id, -Infinity], [id, Infinity]).toArray();
    const list = await db.lists.get(campaign.listId);
    return { campaign, recipients, listName: list?.name ?? '(deleted list)' };
  }, [id]);

  const counts = useMemo(() => countRecipients(data?.recipients ?? []), [data]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.recipients ?? []).filter((r) => (!filter || r.status === filter) && (!needle || r.name.toLowerCase().includes(needle) || r.phone.includes(needle.replace(/\D/g, '') || '\u0000')));
  }, [data, filter, q]);
  const pg = usePage(filtered, page, 50);

  if (data === undefined) return <Spinner />;
  if (data === null) return <Alert tone="red" title="Campaign not found"><Link to="/campaigns" className="underline">Back to campaigns</Link></Alert>;
  const { campaign: c, recipients } = data;
  const retryable = recipients.filter((r) => (r.status === 'failed' || r.status === 'unknown') && retryDecision(r).eligible).length;
  const isManual = c.provider === 'manual';

  const status = (to: 'paused' | 'running' | 'cancelled', label: string) => run(async () => {
    await setCampaignStatus(c.id, to);
    if (to === 'running' && !isManual) kickCloudQueue();
  }, label);

  return (
    <>
      <PageHeader
        title={c.name}
        description={<span className="inline-flex flex-wrap items-center gap-2"><CampaignStatusBadge status={c.status} archived={c.archived} /> <span>{isManual ? 'WhatsApp Web helper' : 'Official API'} · list “{data.listName}” · created {fmtDate(c.createdAt)}</span></span>}
        actions={
          <>
            {c.status === 'draft' && <Link to={`/campaigns/${c.id}/edit`}><Button variant="primary" icon={<Pencil className="size-4" />}>Edit & start</Button></Link>}
            {c.status === 'running' && isManual && (
              <>
                <Button variant="primary" icon={<PanelRight className="size-4" />} onClick={() => openHelper(c.id)}>Open helper</Button>
                <Button icon={<ExternalLink className="size-4" />} onClick={() => openHelper(c.id, 'window')} title="Open the helper in its own window">Helper window</Button>
              </>
            )}
            {c.status === 'running' && <Button icon={<Pause className="size-4" />} loading={busy} onClick={() => void status('paused', 'Campaign paused')}>Pause</Button>}
            {c.status === 'paused' && <Button variant="primary" icon={<Play className="size-4" />} loading={busy} onClick={() => void status('running', 'Campaign resumed')}>Resume</Button>}
            {(c.status === 'running' || c.status === 'paused') && (
              <Button variant="danger" icon={<Ban className="size-4" />} onClick={async () => {
                if (await confirm({ title: 'Cancel campaign?', message: `${counts.pending} pending recipient(s) will be marked skipped. This can't be undone, but you can duplicate the campaign later.`, confirmLabel: 'Cancel campaign', danger: true })) await status('cancelled', 'Campaign cancelled');
              }}>Cancel</Button>
            )}
            {(c.status === 'completed' || c.status === 'running' || c.status === 'paused') && retryable > 0 && (
              <Button icon={<RotateCcw className="size-4" />} onClick={async () => {
                if (await confirm({ title: 'Retry failed messages?', message: `${retryable} recipient(s) with temporary or user-reported failures will be queued again. Recipients whose outcome is unknown or permanently failed are not included.`, confirmLabel: 'Retry' })) {
                  const res = await run(() => retryFailed(c.id));
                  if (res && !isManual) kickCloudQueue();
                }
              }}>Retry {retryable} failed</Button>
            )}
            {c.status !== 'draft' && <Button icon={<Download className="size-4" />} onClick={() => void run(async () => downloadText(`${c.name.replace(/[^\w-]+/g, '_')}-report.csv`, await campaignReportCsv(c.id)), 'Report exported')}>Export report</Button>}
            <Button icon={<Copy className="size-4" />} onClick={() => void run(async () => navigate(`/campaigns/${(await duplicateCampaign(c.id)).id}/edit`), 'Campaign duplicated')}>Duplicate</Button>
            {(c.status === 'completed' || c.status === 'cancelled') && (
              <Button icon={c.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />} onClick={() => void run(() => setArchived(c.id, !c.archived), c.archived ? 'Unarchived' : 'Archived')}>{c.archived ? 'Unarchive' : 'Archive'}</Button>
            )}
            {c.status === 'draft' && (
              <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={async () => {
                if (await confirm({ title: 'Delete draft?', message: 'This draft will be permanently deleted.', confirmLabel: 'Delete', danger: true })) { await run(() => deleteDraft(c.id), 'Draft deleted'); navigate('/campaigns'); }
              }}>Delete</Button>
            )}
          </>
        }
      />

      {c.status === 'paused' && c.history.at(-1)?.note?.startsWith('Auto-paused') && <div className="mb-4"><Alert tone="red" title="Campaign was paused automatically">{c.history.at(-1)?.note}. Fix the problem in Settings, then resume.</Alert></div>}
      {isManual && c.status === 'running' && <div className="mb-4"><Alert tone="blue">The helper opens each chat in WhatsApp Web with the message filled in. You press Send in WhatsApp, then confirm in the helper. “Sent” means <em>you confirmed</em> it; delivery can't be verified with this method.</Alert></div>}
      {!isManual && c.status === 'running' && <div className="mb-4 flex items-center justify-between gap-3"><p className="text-sm text-slate-500">Sending in the background. You can close this page; progress is saved.</p><Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={kickCloudQueue}>Process now</Button></div>}

      {c.status === 'draft' ? (
        <Card><EmptyState title="Not started yet" description="Recipients are frozen when you start the campaign." action={<Link to={`/campaigns/${c.id}/edit`}><Button variant="primary">Review & start</Button></Link>} /></Card>
      ) : (
        <>
          <Card className="mb-6 p-5"><ProgressBar value={progress(counts)} label={`${counts.total - counts.pending - counts.processing} of ${counts.total} processed`} /></Card>
          <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Pending" value={counts.pending} />
            <Stat label="Processing" value={counts.processing} tone="text-sky-600" />
            <Stat label="Sent" value={counts.sent} tone="text-emerald-600" hint={isManual ? 'Confirmed by you' : 'Accepted by the Cloud API'} />
            <Stat label="Failed" value={counts.failed} tone="text-red-600" />
            <Stat label="Skipped" value={counts.skipped} tone="text-amber-600" />
            {isManual ? <Stat label="Unknown" value={counts.unknown} /> : <Stat label="Delivered / read" value={`${counts.delivered} / ${counts.read}`} hint="From WhatsApp webhooks" />}
          </div>

          <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
            <Card>
              <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4 dark:border-slate-800">
                <div className="relative min-w-48 flex-1">
                  <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" aria-hidden />
                  <Input className="pl-9" placeholder="Search recipients" aria-label="Search recipients" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
                </div>
                <Select className="w-44" aria-label="Filter by status" value={filter} onChange={(e) => { setFilter(e.target.value as typeof filter); setPage(0); }}>
                  <option value="">All statuses</option>
                  {(['pending', 'processing', 'sent', 'failed', 'skipped', 'unknown'] as const).map((s) => <option key={s} value={s}>{s} ({counts[s]})</option>)}
                </Select>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full">
                  <thead className="bg-slate-50 dark:bg-slate-900/60"><tr><th className="th">#</th><th className="th">Recipient</th><th className="th">Status</th>{!isManual && <th className="th">Delivery</th>}<th className="th">Details</th><th className="th">Updated</th></tr></thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {pg.slice.map((r) => (
                      <tr key={r.id} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40" onClick={() => setOpen(r)}>
                        <td className="td text-xs tabular-nums text-slate-500">{r.order + 1}</td>
                        <td className="td"><button className="text-left font-medium hover:underline" onClick={(e) => { e.stopPropagation(); setOpen(r); }}>{r.name || 'No name'}</button><p className="font-mono text-xs text-slate-500">{r.phone}</p></td>
                        <td className="td"><RecipientStatusBadge r={r} /></td>
                        {!isManual && <td className="td"><DeliveryBadge status={r.deliveryStatus} /></td>}
                        <td className="td max-w-xs text-xs text-slate-600 dark:text-slate-400">{r.lastError ?? (r.skipReason ? SKIP_LABEL[r.skipReason] ?? r.skipReason : '')}</td>
                        <td className="td text-xs text-slate-500">{fmtDate(r.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filtered.length === 0 && <EmptyState title="No recipients match" />}
              </div>
              <Pager page={pg.page} pages={pg.pages} total={filtered.length} onPage={setPage} />
            </Card>
            <Card className="h-fit p-4">
              <h2 className="mb-3 text-sm font-semibold">Timeline</h2>
              <ol className="space-y-3 border-l border-slate-200 pl-4 text-sm dark:border-slate-700">
                {[...c.history].reverse().map((h, i) => (
                  <li key={i} className="relative">
                    <span className="absolute top-1.5 -left-[21px] size-2.5 rounded-full bg-brand-500" aria-hidden />
                    <p className="font-medium capitalize">{h.type}</p>
                    {h.note && <p className="text-xs text-slate-600 dark:text-slate-400">{h.note}</p>}
                    <p className="text-xs text-slate-500">{fmtDate(h.at)}</p>
                  </li>
                ))}
              </ol>
            </Card>
          </div>
        </>
      )}
      {open && <RecipientModal r={recipients.find((x) => x.id === open.id) ?? open} manual={isManual} onClose={() => setOpen(null)} />}
    </>
  );
}

function RecipientModal({ r, manual, onClose }: { r: Recipient; manual: boolean; onClose: () => void }) {
  const confirm = useConfirm();
  const { run } = useAction();
  const decision = retryDecision(r);
  return (
    <Modal open onClose={onClose} title={r.name || r.phone} wide footer={
      <>
        {!decision.eligible && decision.canForce && (
          <Button variant="danger" onClick={async () => {
            if (await confirm({ title: 'Force resend?', danger: true, confirmLabel: 'Resend anyway', message: `${decision.reason}. Resending may deliver a duplicate message to this person. Only continue if you're sure it wasn't received.` })) {
              await run(() => forceResend(r.id), 'Queued for resend');
              if (!manual) kickCloudQueue();
            }
          }}>Force resend…</Button>
        )}
        <Button onClick={onClose}>Close</Button>
      </>
    }>
      <div className="grid gap-5 md:grid-cols-2">
        <div className="space-y-3 text-sm">
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1.5">
            <dt className="text-slate-500">Phone</dt><dd className="font-mono">{r.phone}</dd>
            <dt className="text-slate-500">Status</dt><dd><RecipientStatusBadge r={r} /></dd>
            {!manual && <><dt className="text-slate-500">Delivery</dt><dd><DeliveryBadge status={r.deliveryStatus} /></dd></>}
            <dt className="text-slate-500">Attempts</dt><dd>{r.attempts}</dd>
            {r.providerMessageId && <><dt className="text-slate-500">Message ID</dt><dd className="font-mono text-xs break-all">{r.providerMessageId}</dd></>}
            {r.lastError && <><dt className="text-slate-500">Last error</dt><dd className="text-red-600 dark:text-red-400">{r.lastError}</dd></>}
            {r.skipReason && <><dt className="text-slate-500">Skip reason</dt><dd>{SKIP_LABEL[r.skipReason as ExclusionReason] ?? r.skipReason}</dd></>}
          </dl>
          <h3 className="pt-2 font-semibold">History</h3>
          <ol className="space-y-1.5 text-xs">
            {[...r.history].reverse().map((h, i) => <li key={i}><span className="font-medium">{h.status}</span>{h.note && ` — ${h.note}`} <span className="text-slate-500">· {fmtDate(h.at)}</span></li>)}
          </ol>
        </div>
        <MessageBubble text={r.message} />
      </div>
    </Modal>
  );
}
