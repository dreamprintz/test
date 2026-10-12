import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { Activity, MessageSquarePlus, Upload } from 'lucide-react';
import { db } from '../db/db';
import { Button, Card, EmptyState, PageHeader, ProgressBar, Spinner, Stat } from '../ui/components';
import { CampaignStatusBadge } from '../ui/status';
import { useAllCampaignCounts } from '../ui/useCampaignCounts';
import { progress } from '../lib/campaign';
import { fmtDate, fmtNum } from '../ui/download';

export default function Dashboard() {
  const data = useLiveQuery(async () => ({
    contacts: await db.contacts.count(),
    lists: await db.lists.count(),
    suppressed: await db.suppression.count(),
    campaigns: await db.campaigns.orderBy('updatedAt').reverse().toArray(),
    activity: await db.activity.orderBy('at').reverse().limit(12).toArray(),
  }));
  const counts = useAllCampaignCounts();
  if (!data || !counts) return <Spinner />;

  let sent = 0, failed = 0, delivered = 0, pending = 0;
  for (const c of counts.values()) {
    sent += c.sent;
    failed += c.failed;
    delivered += c.delivered;
    pending += c.pending + c.processing;
  }
  const active = data.campaigns.filter((c) => c.status === 'running' || c.status === 'paused');

  if (data.contacts === 0 && data.campaigns.length === 0) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <Card>
          <EmptyState
            icon={<Upload className="size-6" />}
            title="Welcome! Start by importing contacts"
            description="Upload a CSV of people who agreed to hear from you. Everything is processed and stored locally in this browser."
            action={<Link to="/import"><Button variant="primary" icon={<Upload className="size-4" />}>Import contacts</Button></Link>}
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Dashboard" description="Overview of your contacts and campaigns." actions={<Link to="/campaigns/new"><Button variant="primary" icon={<MessageSquarePlus className="size-4" />}>New campaign</Button></Link>} />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Contacts" value={fmtNum(data.contacts)} />
        <Stat label="Lists" value={fmtNum(data.lists)} />
        <Stat label="Opted out" value={fmtNum(data.suppressed)} />
        <Stat label="Sent" value={fmtNum(sent)} tone="text-emerald-600" hint="Confirmed by you (WhatsApp Web helper) or accepted by the Cloud API" />
        <Stat label="Delivered" value={fmtNum(delivered)} hint="Reported by Cloud API webhooks only" />
        <Stat label="Failed" value={fmtNum(failed)} tone={failed ? 'text-red-600' : ''} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="border-b border-slate-200 px-5 py-3 dark:border-slate-800"><h2 className="font-semibold">Active campaigns</h2></div>
          {active.length === 0 ? (
            <EmptyState title="No active campaigns" description={pending ? undefined : 'Running and paused campaigns appear here.'} />
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {active.map((c) => {
                const cc = counts.get(c.id);
                return (
                  <li key={c.id} className="px-5 py-4">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <Link to={`/campaigns/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                      <CampaignStatusBadge status={c.status} />
                    </div>
                    {cc && <ProgressBar value={progress(cc)} label={`${cc.sent} sent · ${cc.failed} failed · ${cc.pending + cc.processing} remaining`} />}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card>
          <div className="border-b border-slate-200 px-5 py-3 dark:border-slate-800"><h2 className="font-semibold">Recent activity</h2></div>
          {data.activity.length === 0 ? (
            <EmptyState icon={<Activity className="size-5" />} title="No activity yet" />
          ) : (
            <ul className="divide-y divide-slate-200 text-sm dark:divide-slate-800">
              {data.activity.map((a) => (
                <li key={a.id} className="px-5 py-2.5">
                  <p>{a.campaignId ? <Link to={`/campaigns/${a.campaignId}`} className="hover:underline">{a.message}</Link> : a.message}</p>
                  <p className="text-xs text-slate-500">{fmtDate(a.at)}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
