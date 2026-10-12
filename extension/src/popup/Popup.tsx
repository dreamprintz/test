import { useLiveQuery } from 'dexie-react-hooks';
import { LayoutDashboard, MessageSquarePlus, PanelRight, Upload } from 'lucide-react';
import { db } from '../db/db';
import { progress } from '../lib/campaign';
import { Button, ProgressBar } from '../ui/components';
import { useAllCampaignCounts } from '../ui/useCampaignCounts';
import { useOpenHelper } from '../ui/helperLauncher';
import { isExtension } from '../ui/runtime';

const open = (hash = '') => {
  if (isExtension()) void chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html${hash}`) });
  else window.open(`dashboard.html${hash}`);
  window.close();
};

export default function Popup() {
  const data = useLiveQuery(async () => ({
    contacts: await db.contacts.count(),
    active: await db.campaigns.where('status').anyOf(['running', 'paused']).toArray(),
  }), []);
  const counts = useAllCampaignCounts();
  const openHelper = useOpenHelper();
  return (
    <div className="w-80 space-y-4 p-4">
      <div className="flex items-center gap-2">
        <img src="icons/icon48.png" alt="" className="size-8" />
        <div><p className="font-semibold leading-tight">WA Campaign Manager</p><p className="text-xs text-slate-500">{data ? `${data.contacts.toLocaleString()} contacts` : '…'}</p></div>
      </div>
      <Button variant="primary" className="w-full" icon={<LayoutDashboard className="size-4" />} onClick={() => open()}>Open dashboard</Button>
      <div className="grid grid-cols-2 gap-2">
        <Button size="sm" icon={<Upload className="size-3.5" />} onClick={() => open('#/import')}>Import CSV</Button>
        <Button size="sm" icon={<MessageSquarePlus className="size-3.5" />} onClick={() => open('#/campaigns/new')}>New campaign</Button>
      </div>
      {data && data.active.length > 0 && (
        <div className="space-y-3 border-t border-slate-200 pt-3 dark:border-slate-800">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Active campaigns</p>
          {data.active.map((c) => {
            const cc = counts?.get(c.id);
            return (
              <div key={c.id} className="space-y-1.5">
                <button className="block w-full truncate text-left text-sm font-medium hover:underline" onClick={() => open(`#/campaigns/${c.id}`)}>{c.name}{c.status === 'paused' && ' (paused)'}</button>
                {cc && <ProgressBar value={progress(cc)} label={`${cc.sent}/${cc.total} sent`} />}
                {c.provider === 'manual' && c.status === 'running' && <Button size="sm" className="w-full" icon={<PanelRight className="size-3.5" />} onClick={() => { openHelper(c.id); window.close(); }}>Continue in helper</Button>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
