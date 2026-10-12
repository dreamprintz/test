import { useMemo, useState } from 'react';
import { getCountries, getCountryCallingCode, type CountryCode } from 'libphonenumber-js';
import { CheckCircle2, Download, Plug, ShieldCheck, Trash2 } from 'lucide-react';
import { deleteAllData, exportAll, purgeFinishedCampaignContent } from '../db/maintenance';
import { BackendClient } from '../providers/cloudApi';
import { originPattern, type Settings as S } from '../settings/settings';
import { Alert, Button, Card, Checkbox, Field, Input, PageHeader, Select, useAction, useConfirm, useToast } from '../ui/components';
import { useSettings } from '../ui/settingsContext';
import { downloadText } from '../ui/download';
import { isExtension } from '../ui/runtime';

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card className="grid gap-6 p-5 md:grid-cols-[16rem_1fr]">
      <div><h2 className="font-semibold">{title}</h2>{description && <p className="mt-1 text-sm text-slate-500">{description}</p>}</div>
      <div className="space-y-4">{children}</div>
    </Card>
  );
}

export default function Settings() {
  const { settings, update } = useSettings();
  const toast = useToast();
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const [api, setApi] = useState(settings.cloudApi);
  const [health, setHealth] = useState<string>();
  const countries = useMemo(() => {
    const names = new Intl.DisplayNames(undefined, { type: 'region' });
    return getCountries().map((c) => ({ code: c, label: `${names.of(c) ?? c} (+${getCountryCallingCode(c)})` })).sort((a, b) => a.label.localeCompare(b.label));
  }, []);
  const set = (patch: Partial<S>) => void update({ ...settings, ...patch }).then(() => toast('Settings saved'));
  const apiDirty = JSON.stringify(api) !== JSON.stringify(settings.cloudApi);

  let urlError: string | undefined;
  try {
    const u = new URL(api.backendUrl);
    if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) urlError = 'Use https:// (plain http is only allowed for localhost)';
  } catch {
    urlError = 'Enter a valid URL';
  }

  const requestPermission = async (): Promise<boolean> => {
    if (!isExtension() || !chrome.permissions) return true;
    return chrome.permissions.request({ origins: [originPattern(api.backendUrl)] });
  };

  const saveApi = () => run(async () => {
    if (api.enabled) {
      if (urlError) throw new Error(urlError);
      if (!api.backendKey) throw new Error('Enter the backend access key');
      if (!api.dataSharingConsent) throw new Error('Confirm the data-sharing notice to enable the official API');
      if (!(await requestPermission())) throw new Error('Chrome permission to reach the backend was declined');
    }
    await update({ ...settings, cloudApi: { ...api, ratePerMinute: Math.max(1, Math.min(600, Math.round(api.ratePerMinute) || 20)) } });
  }, 'API settings saved');

  const test = () => run(async () => {
    if (urlError) throw new Error(urlError);
    if (!(await requestPermission())) throw new Error('Permission declined');
    const h = await new BackendClient(api).health();
    setHealth(h.configured ? `Connected. Backend is configured for Graph API ${h.apiVersion}.` : 'Connected, but the backend has no Meta credentials configured yet.');
  });

  return (
    <>
      <PageHeader title="Settings" />
      <div className="space-y-6">
        <Section title="General" description="Defaults used when importing and personalising.">
          <Field label="Default country for phone numbers" htmlFor="country" hint="Numbers without a + or 00 prefix are interpreted in this country.">
            <Select id="country" value={settings.defaultCountry} onChange={(e) => set({ defaultCountry: e.target.value as CountryCode })}>
              {countries.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </Select>
          </Field>
          <Field label="Appearance" htmlFor="theme">
            <Select id="theme" value={settings.theme} onChange={(e) => set({ theme: e.target.value as S['theme'] })}>
              <option value="system">Match system</option><option value="light">Light</option><option value="dark">Dark</option>
            </Select>
          </Field>
        </Section>

        <Section title="Campaign defaults">
          <Checkbox label="WhatsApp Web helper: only message contacts who opted in" description="The official API always requires opt-in." checked={settings.manualRequireConsent} onChange={(v) => set({ manualRequireConsent: v })} />
          <Checkbox label="Skip contacts with missing placeholder values" checked={settings.skipIncomplete} onChange={(v) => set({ skipIncomplete: v })} />
        </Section>

        <Section title="Official WhatsApp Business API" description="Optional. Messages are sent by your own backend server, which holds your Meta access token. The token never enters this extension.">
          <Checkbox label="Enable official API sending" checked={api.enabled} onChange={(v) => setApi({ ...api, enabled: v })} />
          <Field label="Backend URL" htmlFor="burl" error={api.enabled ? urlError : undefined} hint="Where you deployed the /backend server.">
            <Input id="burl" value={api.backendUrl} onChange={(e) => setApi({ ...api, backendUrl: e.target.value.trim() })} placeholder="https://wa-backend.example.com" />
          </Field>
          <Field label="Backend access key" htmlFor="bkey" hint="The BACKEND_API_KEY value from your backend's .env. This is not your Meta token.">
            <Input id="bkey" type="password" autoComplete="off" value={api.backendKey} onChange={(e) => setApi({ ...api, backendKey: e.target.value })} />
          </Field>
          <Field label="Send rate (messages per minute)" htmlFor="rate" hint="Stay within your WhatsApp messaging limits and quality rating.">
            <Input id="rate" type="number" min={1} max={600} value={api.ratePerMinute} onChange={(e) => setApi({ ...api, ratePerMinute: Number(e.target.value) })} className="w-32" />
          </Field>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
            <Checkbox label="I understand that recipients' phone numbers and template parameter values will be sent to this backend and to Meta" description="Only for contacts who have opted in. Nothing is sent unless this is checked and a campaign uses the official API." checked={api.dataSharingConsent} onChange={(v) => setApi({ ...api, dataSharingConsent: v })} />
          </div>
          {health && <Alert tone="green">{health}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={busy} disabled={!apiDirty} onClick={() => void saveApi()}>Save API settings</Button>
            <Button icon={<Plug className="size-4" />} onClick={() => void test()}>Test connection</Button>
          </div>
        </Section>

        <Section title="Privacy & data" description="Everything is stored locally in this browser profile (IndexedDB). No analytics or tracking.">
          <ul className="space-y-1.5 text-sm text-slate-600 dark:text-slate-300">
            <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />CSV files are parsed locally and never uploaded.</li>
            <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />Opted-out numbers are excluded from every campaign, and stay suppressed even if a contact is deleted.</li>
            <li className="flex gap-2"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />The WhatsApp Web helper never sends anything on its own. You press Send.</li>
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button icon={<Download className="size-4" />} onClick={() => void run(async () => downloadText(`wa-campaigns-backup-${new Date().toISOString().slice(0, 10)}.json`, await exportAll(), 'application/json'), 'Data exported')}>Export all data (JSON)</Button>
            <Button onClick={async () => {
              if (await confirm({ title: 'Remove message content from finished campaigns?', message: 'Names and message text are erased from completed and cancelled campaigns. Statuses and counts are kept.', confirmLabel: 'Remove content' })) {
                const n = await run(() => purgeFinishedCampaignContent());
                if (n !== undefined) toast(`Cleared content from ${n} recipient record(s)`);
              }
            }}>Purge finished campaign content</Button>
            <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={async () => {
              if (await confirm({ title: 'Delete ALL data?', danger: true, confirmLabel: 'Delete everything', message: 'All contacts, lists, the opt-out list, templates and campaigns will be permanently erased from this browser. Export a backup first if you need one.' }))
                await run(() => deleteAllData(), 'All data deleted');
            }}>Delete all data</Button>
          </div>
        </Section>
      </div>
    </>
  );
}
