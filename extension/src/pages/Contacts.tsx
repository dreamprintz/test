import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useSearchParams } from 'react-router-dom';
import { Ban, Pencil, Plus, Search, Trash2, Upload, Users } from 'lucide-react';
import { db } from '../db/db';
import { deleteContacts, setConsent, suppress, unsuppress, updateContact } from '../db/contacts';
import { addToList, removeFromList } from '../db/lists';
import { normalizePhone } from '../lib/phone';
import { toFieldKey } from '../lib/template';
import type { ConsentStatus, Contact } from '../lib/types';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select, Spinner, Textarea, cx, useAction, useConfirm } from '../ui/components';
import { ConsentBadge } from '../ui/status';
import { Pager, usePage } from '../ui/Pager';
import { useSettings } from '../ui/settingsContext';
import { downloadText, fmtDate } from '../ui/download';
import { toCsv } from '../lib/csv';

type SortKey = 'name' | 'phone' | 'createdAt' | 'updatedAt';

export default function Contacts() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'optout' ? 'optout' : 'all';
  return (
    <>
      <PageHeader
        title="Contacts"
        description="Your address book. Opted-out numbers are automatically excluded from every campaign."
        actions={<Link to="/import"><Button variant="primary" icon={<Upload className="size-4" />}>Import CSV</Button></Link>}
      />
      <div className="mb-4 flex gap-1 border-b border-slate-200 dark:border-slate-800" role="tablist">
        {(['all', 'optout'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setParams(t === 'all' ? {} : { tab: t })}
            className={cx('-mb-px border-b-2 px-4 py-2 text-sm font-medium', tab === t ? 'border-brand-600 text-brand-700 dark:text-brand-100' : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200')}>
            {t === 'all' ? 'All contacts' : 'Opt-out / suppression list'}
          </button>
        ))}
      </div>
      {tab === 'all' ? <ContactTable /> : <SuppressionTable />}
    </>
  );
}

function ContactTable() {
  const [params] = useSearchParams();
  const [q, setQ] = useState('');
  const [listFilter, setListFilter] = useState(params.get('list') ?? '');
  const [consentFilter, setConsentFilter] = useState<'' | ConsentStatus | 'suppressed'>('');
  const [sort, setSort] = useState<SortKey>('name');
  const [desc, setDesc] = useState(false);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Contact | null>(null);
  const [bulkList, setBulkList] = useState('');
  const confirm = useConfirm();
  const { run } = useAction();

  const data = useLiveQuery(async () => ({
    contacts: await db.contacts.toArray(),
    lists: await db.lists.orderBy('name').toArray(),
    suppressed: new Set(await db.suppression.toCollection().primaryKeys()),
  }), []);

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    const digits = needle.replace(/\D/g, '');
    const out = data.contacts.filter((c) => {
      if (listFilter && !c.listIds.includes(listFilter)) return false;
      if (consentFilter === 'suppressed' ? !data.suppressed.has(c.phone) : consentFilter && c.consent !== consentFilter) return false;
      if (!needle) return true;
      return c.name.toLowerCase().includes(needle) || (digits.length >= 3 && c.phone.includes(digits)) || c.email.toLowerCase().includes(needle);
    });
    out.sort((a, b) => {
      const av = a[sort], bv = b[sort];
      const r = typeof av === 'number' ? av - (bv as number) : String(av).localeCompare(String(bv), undefined, { sensitivity: 'base' });
      return desc ? -r : r;
    });
    return out;
  }, [data, q, listFilter, consentFilter, sort, desc]);

  const pg = usePage(filtered, page, 50);
  if (!data) return <Spinner />;
  if (data.contacts.length === 0) {
    return <Card><EmptyState icon={<Users className="size-6" />} title="No contacts yet" description="Import a CSV file to get started." action={<Link to="/import"><Button variant="primary">Import contacts</Button></Link>} /></Card>;
  }

  const listName = new Map(data.lists.map((l) => [l.id, l.name]));
  const isOptedOut = (c: Contact) => c.consent === 'denied' || data.suppressed.has(c.phone);
  const ids = [...selected];
  const toggleSort = (k: SortKey) => { if (sort === k) setDesc(!desc); else { setSort(k); setDesc(false); } };
  const sortLabel = (k: SortKey, label: string) => (
    <button className="inline-flex items-center gap-1 uppercase" onClick={() => toggleSort(k)} aria-label={`Sort by ${label}`}>
      {label}{sort === k ? (desc ? ' ↓' : ' ↑') : ''}
    </button>
  );

  return (
    <Card>
      <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 p-4 dark:border-slate-800">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" aria-hidden />
          <Input aria-label="Search contacts" placeholder="Search by name, phone or email" className="pl-9" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
        </div>
        <Select aria-label="Filter by list" className="w-48" value={listFilter} onChange={(e) => { setListFilter(e.target.value); setPage(0); }}>
          <option value="">All lists</option>
          {data.lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
        <Select aria-label="Filter by consent" className="w-44" value={consentFilter} onChange={(e) => { setConsentFilter(e.target.value as typeof consentFilter); setPage(0); }}>
          <option value="">Any consent</option>
          <option value="granted">Opted in</option>
          <option value="unknown">Unknown</option>
          <option value="denied">Opted out</option>
          <option value="suppressed">On suppression list</option>
        </Select>
        <Button size="sm" onClick={() => downloadText('contacts.csv', contactsCsv(filtered, listName))}>Export shown</Button>
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-brand-50/60 px-4 py-2.5 text-sm dark:border-slate-800 dark:bg-brand-700/10">
          <span className="font-medium">{selected.size} selected</span>
          <Select aria-label="List for bulk action" className="w-44 py-1" value={bulkList} onChange={(e) => setBulkList(e.target.value)}>
            <option value="">Choose list…</option>
            {data.lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
          <Button size="sm" disabled={!bulkList} onClick={() => run(() => addToList(ids, bulkList), 'Added to list')}>Add to list</Button>
          <Button size="sm" disabled={!bulkList} onClick={() => run(() => removeFromList(ids, bulkList), 'Removed from list')}>Remove from list</Button>
          <Button size="sm" onClick={() => run(() => setConsent(ids, 'granted', 'Marked opted in manually'), 'Marked as opted in')}>Mark opted in</Button>
          <Button size="sm" icon={<Ban className="size-3.5" />} onClick={async () => {
            if (await confirm({ title: 'Opt out contacts?', message: `${ids.length} contact(s) will be added to the suppression list and excluded from all campaigns.`, confirmLabel: 'Opt out', danger: true }))
              await run(() => setConsent(ids, 'denied', 'Opted out manually'), 'Contacts opted out');
          }}>Opt out</Button>
          <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={async () => {
            if (await confirm({ title: 'Delete contacts?', message: `Permanently delete ${ids.length} contact(s)? Opt-out entries are kept so they stay excluded if re-imported.`, confirmLabel: 'Delete', danger: true })) {
              await run(() => deleteContacts(ids), `Deleted ${ids.length} contact(s)`);
              setSelected(new Set());
            }
          }}>Delete</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead className="bg-slate-50 dark:bg-slate-900/60">
            <tr>
              <th className="th w-10">
                <input type="checkbox" className="size-4 accent-brand-600" aria-label="Select all eligible contacts shown"
                  checked={filtered.length > 0 && filtered.filter((c) => !isOptedOut(c)).every((c) => selected.has(c.id))}
                  onChange={(e) => { const s = new Set(selected); filtered.forEach((c) => { if (e.target.checked) { if (!isOptedOut(c)) s.add(c.id); } else s.delete(c.id); }); setSelected(s); }} />
              </th>
              <th className="th">{sortLabel('name', 'Name')}</th>
              <th className="th">{sortLabel('phone', 'Phone')}</th>
              <th className="th">Lists</th>
              <th className="th">Consent</th>
              <th className="th">{sortLabel('updatedAt', 'Updated')}</th>
              <th className="th"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {pg.slice.map((c) => (
              <tr key={c.id} className={cx(isOptedOut(c) && 'opacity-70')}>
                <td className="td"><input type="checkbox" className="size-4 accent-brand-600" aria-label={`Select ${c.name || c.phone}`} checked={selected.has(c.id)} onChange={(e) => { const s = new Set(selected); if (e.target.checked) s.add(c.id); else s.delete(c.id); setSelected(s); }} /></td>
                <td className="td"><p className="font-medium">{c.name || <span className="italic text-slate-400">No name</span>}</p>{c.email && <p className="text-xs text-slate-500">{c.email}</p>}</td>
                <td className="td font-mono text-xs">{c.phone}</td>
                <td className="td"><div className="flex flex-wrap gap-1">{c.listIds.map((l) => <Badge key={l}>{listName.get(l) ?? '?'}</Badge>)}</div></td>
                <td className="td"><div className="flex flex-wrap gap-1"><ConsentBadge consent={c.consent} />{data.suppressed.has(c.phone) && <Badge tone="red">Suppressed</Badge>}</div></td>
                <td className="td text-xs text-slate-500">{fmtDate(c.updatedAt)}</td>
                <td className="td text-right"><Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(c)} aria-label={`Edit ${c.name || c.phone}`}>Edit</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <EmptyState title="No contacts match" description="Try a different search or filter." />}
      </div>
      <Pager page={pg.page} pages={pg.pages} total={filtered.length} onPage={setPage} />
      {editing && <EditContact contact={editing} suppressed={data.suppressed.has(editing.phone)} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function contactsCsv(cs: Contact[], listName: Map<string, string>): string {
  const keys = [...new Set(cs.flatMap((c) => Object.keys(c.fields)))].sort();
  return toCsv(
    ['name', 'phone', 'email', 'consent', 'consent_note', 'lists', ...keys, 'created_at'],
    cs.map((c) => [c.name, c.phone, c.email, c.consent, c.consentNote ?? '', c.listIds.map((l) => listName.get(l) ?? l).join('; '), ...keys.map((k) => c.fields[k] ?? ''), new Date(c.createdAt).toISOString()]),
  );
}

function EditContact({ contact, suppressed, onClose }: { contact: Contact; suppressed: boolean; onClose: () => void }) {
  const { settings } = useSettings();
  const { run, busy } = useAction();
  const [name, setName] = useState(contact.name);
  const [phone, setPhone] = useState(contact.phone);
  const [email, setEmail] = useState(contact.email);
  const [consent, setConsentState] = useState<ConsentStatus>(contact.consent);
  const [note, setNote] = useState(contact.consentNote ?? '');
  const [fields, setFields] = useState<[string, string][]>(Object.entries(contact.fields));
  const phoneCheck = normalizePhone(phone, settings.defaultCountry);

  const save = () => run(async () => {
    if (!phoneCheck.ok) throw new Error(phoneCheck.error ?? 'Invalid phone');
    const f: Record<string, string> = {};
    for (const [k, v] of fields) if (k.trim()) f[toFieldKey(k)] = v;
    await updateContact(contact.id, { name: name.trim(), phone: phoneCheck.e164!, email: email.trim(), fields: f });
    if (consent !== contact.consent || note !== (contact.consentNote ?? '')) await setConsent([contact.id], consent, note);
    onClose();
  }, 'Contact saved');

  return (
    <Modal open onClose={onClose} title="Edit contact" wide footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void save()}>Save</Button></>}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Name" htmlFor="c-name"><Input id="c-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Phone" htmlFor="c-phone" error={phoneCheck.ok ? undefined : phoneCheck.error} hint={phoneCheck.ok ? `Saved as ${phoneCheck.e164}${contact.rawPhone && contact.rawPhone !== contact.phone ? ` · originally “${contact.rawPhone}”` : ''}` : undefined}>
          <Input id="c-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Email" htmlFor="c-email"><Input id="c-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Consent" htmlFor="c-consent" hint={suppressed ? 'This number is on the suppression list. Remove it there to message it again.' : undefined}>
          <Select id="c-consent" value={consent} onChange={(e) => setConsentState(e.target.value as ConsentStatus)}>
            <option value="unknown">Unknown</option>
            <option value="granted">Opted in</option>
            <option value="denied">Opted out (adds to suppression list)</option>
          </Select>
        </Field>
        <div className="md:col-span-2"><Field label="Consent note" htmlFor="c-note"><Textarea id="c-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field></div>
      </div>
      <h3 className="mt-6 mb-2 text-sm font-semibold">Custom fields</h3>
      <div className="space-y-2">
        {fields.map(([k, v], i) => (
          <div key={i} className="flex gap-2">
            <Input aria-label="Field key" className="w-48 font-mono text-xs" value={k} onChange={(e) => setFields(fields.map((f, j) => (j === i ? [e.target.value, f[1]] : f)))} />
            <Input aria-label={`Value for ${k}`} value={v} onChange={(e) => setFields(fields.map((f, j) => (j === i ? [f[0], e.target.value] : f)))} />
            <Button variant="ghost" aria-label={`Remove field ${k}`} onClick={() => setFields(fields.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
          </div>
        ))}
        <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setFields([...fields, ['', '']])}>Add field</Button>
      </div>
    </Modal>
  );
}

function SuppressionTable() {
  const { settings } = useSettings();
  const { run } = useAction();
  const confirm = useConfirm();
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState('');
  const entries = useLiveQuery(() => db.suppression.orderBy('createdAt').reverse().toArray(), []);
  const check = phone ? normalizePhone(phone, settings.defaultCountry) : undefined;
  if (!entries) return <Spinner />;
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (check?.ok) void run(async () => { await suppress(check.e164!, reason || 'Added manually', 'manual'); await db.contacts.where('phone').equals(check.e164!).modify({ consent: 'denied', consentUpdatedAt: Date.now() }); setPhone(''); setReason(''); }, 'Number suppressed'); }}>
          <div className="w-56"><Field label="Phone number" htmlFor="s-phone" error={check && !check.ok ? check.error : undefined}><Input id="s-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" /></Field></div>
          <div className="min-w-56 flex-1"><Field label="Reason" htmlFor="s-reason"><Input id="s-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Replied STOP" /></Field></div>
          <Button type="submit" variant="primary" disabled={!check?.ok}>Add to opt-out list</Button>
        </form>
      </Card>
      <Card>
        {entries.length === 0 ? <EmptyState icon={<Ban className="size-5" />} title="No suppressed numbers" description="Numbers here are never messaged, even if they're re-imported." /> : (
          <table className="min-w-full">
            <thead className="bg-slate-50 dark:bg-slate-900/60"><tr><th className="th">Phone</th><th className="th">Reason</th><th className="th">Source</th><th className="th">Added</th><th className="th" /></tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {entries.map((e) => (
                <tr key={e.phone}>
                  <td className="td font-mono text-xs">{e.phone}</td><td className="td">{e.reason}</td><td className="td"><Badge>{e.source}</Badge></td><td className="td text-xs text-slate-500">{fmtDate(e.createdAt)}</td>
                  <td className="td text-right">
                    <Button size="sm" variant="ghost" onClick={async () => {
                      if (await confirm({ title: 'Remove from opt-out list?', message: 'Only do this if the person has explicitly opted back in. Their contact consent stays "opted out" until you change it.', confirmLabel: 'Remove' }))
                        await run(() => unsuppress(e.phone), 'Removed from opt-out list');
                    }}>Remove</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
