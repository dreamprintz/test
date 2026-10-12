import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Plus, Rocket, Save, Trash2 } from 'lucide-react';
import { db } from '../db/db';
import { launchCampaign, previewAudience, saveDraft, type CampaignDraft } from '../db/campaigns';
import { EXCLUSION_LABEL, type AudienceEntry, type ExclusionReason } from '../lib/audience';
import type { ProviderId } from '../lib/types';
import { contactContext } from '../lib/template';
import { Alert, Badge, Button, Card, Checkbox, Field, Input, PageHeader, Select, Spinner, Stat, cx, useAction, useConfirm, useToast } from '../ui/components';
import { MessageBubble } from '../ui/MessagePreview';
import { Pager, usePage } from '../ui/Pager';
import { useSettings } from '../ui/settingsContext';
import { useFieldKeys } from '../ui/useFieldKeys';
import { kickCloudQueue } from '../ui/runtime';

export default function NewCampaign() {
  const { id } = useParams();
  const existing = useLiveQuery(async () => (id ? (await db.campaigns.get(id)) ?? null : null), [id]);
  if (id && existing === undefined) return <Spinner />;
  if (id && (!existing || existing.status !== 'draft')) {
    return <Alert tone="amber" title="This campaign can't be edited">Only drafts can be edited. <Link className="underline" to={id ? `/campaigns/${id}` : '/campaigns'}>Back to campaign</Link></Alert>;
  }
  return <CampaignForm key={id ?? 'new'} id={id} initial={existing ?? undefined} />;
}

function CampaignForm({ id, initial }: { id?: string | undefined; initial?: CampaignDraft & { id: string } }) {
  const { settings } = useSettings();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const lists = useLiveQuery(() => db.lists.orderBy('name').toArray(), []);
  const templates = useLiveQuery(() => db.templates.orderBy('name').toArray(), []);
  const cloudReady = settings.cloudApi.enabled && settings.cloudApi.dataSharingConsent && !!settings.cloudApi.backendKey;

  const [name, setName] = useState(initial?.name ?? '');
  const [listId, setListId] = useState(initial?.listId ?? '');
  const [templateId, setTemplateId] = useState(initial?.templateId ?? '');
  const [provider, setProvider] = useState<ProviderId>(initial?.provider ?? 'manual');
  const [cloudName, setCloudName] = useState(initial?.cloudTemplate?.name ?? '');
  const [cloudLang, setCloudLang] = useState(initial?.cloudTemplate?.language ?? 'en');
  const [params, setParams] = useState<string[]>(initial?.cloudTemplate?.bodyParams ?? []);
  const [requireConsent, setRequireConsent] = useState(settings.manualRequireConsent);
  const [skipIncomplete, setSkipIncomplete] = useState(settings.skipIncomplete);
  const [audience, setAudience] = useState<AudienceEntry[] | null>(null);
  const [previewIdx, setPreviewIdx] = useState(0);
  const [filter, setFilter] = useState<'all' | 'included' | ExclusionReason>('all');
  const [page, setPage] = useState(0);
  const keys = useFieldKeys(listId || undefined);

  useEffect(() => {
    if (!listId && lists?.[0]) setListId(lists[0].id);
    if (!templateId && templates?.[0]) setTemplateId(templates[0].id);
  }, [lists, templates, listId, templateId]);

  const template = templates?.find((t) => t.id === templateId);
  useEffect(() => {
    let cancelled = false;
    if (!listId || !template) { setAudience(null); return; }
    void previewAudience(listId, template.body, provider, { requireConsent, skipIncomplete }).then((a) => { if (!cancelled) { setAudience(a); setPreviewIdx(0); setPage(0); } });
    return () => { cancelled = true; };
  }, [listId, template, provider, requireConsent, skipIncomplete]);

  const included = useMemo(() => audience?.filter((a) => !a.exclusion) ?? [], [audience]);
  const byReason = useMemo(() => {
    const m: Record<ExclusionReason, number> = { opted_out: 0, no_consent: 0, missing_fields: 0 };
    audience?.forEach((a) => { if (a.exclusion) m[a.exclusion]++; });
    return m;
  }, [audience]);
  const shown = useMemo(() => (audience ?? []).filter((a) => filter === 'all' || (filter === 'included' ? !a.exclusion : a.exclusion === filter)), [audience, filter]);
  const pg = usePage(shown, page, 25);
  const preview = included[previewIdx];

  if (!lists || !templates) return <Spinner />;
  if (lists.length === 0 || templates.length === 0) {
    return (
      <>
        <PageHeader title="New campaign" />
        <Alert tone="blue" title="Almost there">
          You need {lists.length === 0 && <><Link className="underline" to="/import">a contact list</Link>{templates.length === 0 && ' and '}</>}{templates.length === 0 && <Link className="underline" to="/templates">a message template</Link>} before creating a campaign.
        </Alert>
      </>
    );
  }

  const draft = (): CampaignDraft => ({
    name, listId, templateId, provider,
    ...(provider === 'cloud_api' ? { cloudTemplate: { name: cloudName.trim(), language: cloudLang.trim(), bodyParams: params } } : {}),
  });

  const save = () => run(async () => {
    const c = await saveDraft(draft(), id);
    navigate(`/campaigns/${c.id}/edit`, { replace: true });
    return c;
  }, 'Draft saved');

  const launch = async () => {
    const ok = await confirm({
      title: 'Start campaign?',
      confirmLabel: 'Start campaign',
      message: (
        <div className="space-y-2">
          <p><strong>{included.length}</strong> recipient(s) will be queued{audience && audience.length > included.length ? `; ${audience.length - included.length} excluded contact(s) will be recorded as skipped` : ''}.</p>
          {provider === 'manual'
            ? <p>WhatsApp Web will open each chat with the message filled in. <strong>You</strong> review it and press Send, then confirm in the helper panel.</p>
            : <p>Messages will be sent through your backend using the approved template <code>{cloudName}</code> at up to {settings.cloudApi.ratePerMinute}/minute. This continues in the background even if you close this page.</p>}
        </div>
      ),
    });
    if (!ok) return;
    await run(async () => {
      const c = await saveDraft(draft(), id);
      await launchCampaign(c.id, { requireConsent, skipIncomplete });
      if (provider === 'cloud_api') kickCloudQueue();
      toast('Campaign started');
      navigate(`/campaigns/${c.id}`);
    });
  };

  const canLaunch = !!name.trim() && included.length > 0 && (provider === 'manual' || (cloudReady && !!cloudName.trim() && !!cloudLang.trim()));

  return (
    <>
      <PageHeader title={id ? 'Edit draft campaign' : 'New campaign'} description="Configure, review every recipient, then start." />
      <div className="grid gap-6 xl:grid-cols-[1fr_24rem]">
        <div className="space-y-6">
          <Card className="space-y-4 p-5">
            <h2 className="font-semibold">Setup</h2>
            <Field label="Campaign name" htmlFor="cn"><Input id="cn" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Batch A registration confirmation" /></Field>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Contact list" htmlFor="cl"><Select id="cl" value={listId} onChange={(e) => setListId(e.target.value)}>{lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
              <Field label="Message template" htmlFor="ct" hint={<Link className="underline" to="/templates">Edit templates</Link>}><Select id="ct" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
            </div>
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-300">Sending method</legend>
              <div className="grid gap-3 md:grid-cols-2">
                {([
                  ['manual', 'WhatsApp Web helper', 'Opens each chat with the message ready. You review and press Send yourself.'],
                  ['cloud_api', 'Official WhatsApp Business API', cloudReady ? 'Sends approved templates via your backend. Delivery and read receipts via webhooks.' : 'Set up the backend in Settings first.'],
                ] as const).map(([v, label, desc]) => (
                  <label key={v} className={cx('flex cursor-pointer gap-3 rounded-lg border p-3', provider === v ? 'border-brand-500 bg-brand-50/60 dark:bg-brand-700/10' : 'border-slate-200 dark:border-slate-700', v === 'cloud_api' && !cloudReady && 'cursor-not-allowed opacity-60')}>
                    <input type="radio" name="provider" className="mt-1 accent-brand-600" checked={provider === v} disabled={v === 'cloud_api' && !cloudReady} onChange={() => setProvider(v)} />
                    <span><span className="block text-sm font-medium">{label}</span><span className="text-xs text-slate-500">{desc}</span></span>
                  </label>
                ))}
              </div>
              {!cloudReady && <p className="mt-2 text-xs text-slate-500"><Link className="underline" to="/settings">Configure the official API</Link></p>}
            </fieldset>

            {provider === 'cloud_api' && (
              <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
                <Alert tone="blue">Business-initiated messages must use a template approved in WhatsApp Manager. Map its body variables {'{{1}}, {{2}}…'} to contact fields. Your local template is used for previews and reports.</Alert>
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="Approved template name" htmlFor="ctn"><Input id="ctn" value={cloudName} onChange={(e) => setCloudName(e.target.value)} placeholder="registration_confirmation" /></Field>
                  <Field label="Language code" htmlFor="ctl"><Input id="ctl" value={cloudLang} onChange={(e) => setCloudLang(e.target.value)} placeholder="en" /></Field>
                </div>
                <div className="space-y-2">
                  {params.map((p, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="w-12 font-mono text-xs">{`{{${i + 1}}}`}</span>
                      <Select aria-label={`Field for parameter ${i + 1}`} value={p} onChange={(e) => setParams(params.map((x, j) => (j === i ? e.target.value : x)))}>{keys.map((k) => <option key={k} value={k}>{k}</option>)}</Select>
                      <Button variant="ghost" aria-label={`Remove parameter ${i + 1}`} onClick={() => setParams(params.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
                    </div>
                  ))}
                  <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setParams([...params, 'name'])}>Add body parameter</Button>
                </div>
              </div>
            )}

            <div className="space-y-3 border-t border-slate-200 pt-4 dark:border-slate-800">
              <p className="text-sm font-medium">Audience rules</p>
              <Checkbox label="Always exclude opted-out and suppressed numbers" description="Required; cannot be turned off." checked disabled onChange={() => {}} />
              <Checkbox label="Only contacts who opted in" description={provider === 'cloud_api' ? 'Required by WhatsApp Business policy for the official API.' : 'Recommended. Excludes contacts with unknown consent.'} checked={provider === 'cloud_api' || requireConsent} disabled={provider === 'cloud_api'} onChange={setRequireConsent} />
              <Checkbox label="Skip contacts with missing placeholder values" description="Otherwise they'd receive text with an empty {{placeholder}}." checked={skipIncomplete} onChange={setSkipIncomplete} />
            </div>
          </Card>

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3 dark:border-slate-800">
              <h2 className="font-semibold">Review recipients</h2>
              <Select aria-label="Filter recipients" className="w-56" value={filter} onChange={(e) => { setFilter(e.target.value as typeof filter); setPage(0); }}>
                <option value="all">Everyone ({audience?.length ?? 0})</option>
                <option value="included">Will be messaged ({included.length})</option>
                {(Object.keys(byReason) as ExclusionReason[]).map((r) => <option key={r} value={r}>{EXCLUSION_LABEL[r]} ({byReason[r]})</option>)}
              </Select>
            </div>
            {!audience ? <Spinner /> : (
              <>
                <div className="overflow-x-auto">
                  <table className="min-w-full">
                    <thead className="bg-slate-50 dark:bg-slate-900/60"><tr><th className="th">Name</th><th className="th">Phone</th><th className="th">Status</th><th className="th">Message</th></tr></thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {pg.slice.map((a) => (
                        <tr key={a.contact.id}>
                          <td className="td">{a.contact.name || <span className="italic text-slate-400">No name</span>}</td>
                          <td className="td font-mono text-xs">{a.contact.phone}</td>
                          <td className="td">{a.exclusion ? <Badge tone="amber">{EXCLUSION_LABEL[a.exclusion]}</Badge> : <Badge tone="green">Included</Badge>}</td>
                          <td className="td max-w-md"><p className="line-clamp-2 text-xs whitespace-pre-line text-slate-600 dark:text-slate-400">{a.message}</p></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pager page={pg.page} pages={pg.pages} total={shown.length} onPage={setPage} />
              </>
            )}
          </Card>
        </div>

        <div className="space-y-4 xl:sticky xl:top-6 xl:self-start">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Will be messaged" value={included.length} tone="text-emerald-600" />
            <Stat label="Excluded" value={(audience?.length ?? 0) - included.length} tone="text-amber-600" />
          </div>
          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Message preview</h3>
              {included.length > 1 && (
                <div className="flex items-center gap-1 text-xs">
                  <Button size="sm" variant="ghost" onClick={() => setPreviewIdx((i) => Math.max(0, i - 1))} aria-label="Previous recipient">‹</Button>
                  <span className="tabular-nums">{previewIdx + 1}/{included.length}</span>
                  <Button size="sm" variant="ghost" onClick={() => setPreviewIdx((i) => Math.min(included.length - 1, i + 1))} aria-label="Next recipient">›</Button>
                </div>
              )}
            </div>
            {preview ? (
              <>
                <p className="mb-2 text-xs text-slate-500">To {preview.contact.name || 'unnamed'} · {preview.contact.phone}</p>
                <MessageBubble text={preview.message} />
                {provider === 'cloud_api' && <p className="mt-2 text-xs text-slate-500">Template parameters: {params.length ? params.map((p, i) => `{{${i + 1}}} = “${contactContext(preview.contact)[p] || '(empty)'}”`).join(', ') : 'none'}</p>}
              </>
            ) : <p className="text-sm text-slate-500">No eligible recipients to preview.</p>}
          </Card>
          <div className="flex gap-2">
            <Button className="flex-1" icon={<Save className="size-4" />} loading={busy} onClick={() => void save()}>Save draft</Button>
            <Button className="flex-1" variant="primary" icon={<Rocket className="size-4" />} disabled={!canLaunch || busy} onClick={() => void launch()}>Review & start</Button>
          </div>
        </div>
      </div>
    </>
  );
}
