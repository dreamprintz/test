import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { Download, History, MessageSquarePlus } from 'lucide-react';
import { db } from '../db/db';
import { campaignReportCsv } from '../db/campaigns';
import { progress } from '../lib/campaign';
import type { CampaignStatus } from '../lib/types';
import { Button, Card, Checkbox, EmptyState, Input, PageHeader, Select, Spinner, useAction } from '../ui/components';
import { CampaignStatusBadge } from '../ui/status';
import { useAllCampaignCounts } from '../ui/useCampaignCounts';
import { downloadText, fmtDate } from '../ui/download';

export default function CampaignHistory() {
  const campaigns = useLiveQuery(() => db.campaigns.orderBy('createdAt').reverse().toArray(), []);
  const lists = useLiveQuery(async () => new Map((await db.lists.toArray()).map((l) => [l.id, l.name])), []);
  const counts = useAllCampaignCounts();
  const [showArchived, setShowArchived] = useState(false);
  const [status, setStatus] = useState<'' | CampaignStatus>('');
  const [q, setQ] = useState('');
  const { run } = useAction();
  const shown = useMemo(() => (campaigns ?? []).filter((c) => (showArchived || !c.archived) && (!status || c.status === status) && c.name.toLowerCase().includes(q.toLowerCase())), [campaigns, showArchived, status, q]);
  if (!campaigns || !counts || !lists) return <Spinner />;
  return (
    <>
      <PageHeader title="Campaign history" description="All campaigns with their results. Export a CSV report for any campaign."
        actions={<Link to="/campaigns/new"><Button variant="primary" icon={<MessageSquarePlus className="size-4" />}>New campaign</Button></Link>} />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4 dark:border-slate-800">
          <Input className="max-w-xs" placeholder="Search campaigns" aria-label="Search campaigns" value={q} onChange={(e) => setQ(e.target.value)} />
          <Select className="w-40" aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="">All statuses</option>
            {(['draft', 'running', 'paused', 'completed', 'cancelled'] as const).map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Checkbox label="Show archived" checked={showArchived} onChange={setShowArchived} />
        </div>
        {shown.length === 0 ? <EmptyState icon={<History className="size-6" />} title={campaigns.length ? 'No campaigns match' : 'No campaigns yet'} action={campaigns.length ? undefined : <Link to="/campaigns/new"><Button variant="primary">Create a campaign</Button></Link>} /> : (
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead className="bg-slate-50 dark:bg-slate-900/60"><tr><th className="th">Campaign</th><th className="th">Status</th><th className="th">Method</th><th className="th">Recipients</th><th className="th">Sent / failed / skipped</th><th className="th">Started</th><th className="th">Finished</th><th className="th" /></tr></thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {shown.map((c) => {
                  const cc = counts.get(c.id);
                  return (
                    <tr key={c.id}>
                      <td className="td"><Link className="font-medium hover:underline" to={`/campaigns/${c.id}`}>{c.name}</Link><p className="text-xs text-slate-500">{lists.get(c.listId) ?? '(deleted list)'}</p></td>
                      <td className="td"><CampaignStatusBadge status={c.status} archived={c.archived} /></td>
                      <td className="td text-xs">{c.provider === 'manual' ? 'WhatsApp Web helper' : 'Official API'}</td>
                      <td className="td tabular-nums">{cc?.total ?? '—'}{cc && c.status !== 'draft' && <span className="ml-2 text-xs text-slate-500">({Math.round(progress(cc) * 100)}%)</span>}</td>
                      <td className="td tabular-nums">{cc ? <><span className="text-emerald-600">{cc.sent}</span> / <span className="text-red-600">{cc.failed}</span> / <span className="text-amber-600">{cc.skipped}</span></> : '—'}</td>
                      <td className="td text-xs text-slate-500">{fmtDate(c.startedAt)}</td>
                      <td className="td text-xs text-slate-500">{fmtDate(c.completedAt)}</td>
                      <td className="td text-right">{c.status !== 'draft' && <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => void run(async () => downloadText(`${c.name.replace(/[^\w-]+/g, '_')}-report.csv`, await campaignReportCsv(c.id)), 'Report exported')}>CSV</Button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
