import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router-dom';
import { Download, FileUp, RotateCcw } from 'lucide-react';
import { db } from '../db/db';
import { existingPhoneMap, importRows, suppressedSet, type ExistingStrategy } from '../db/contacts';
import { createList } from '../db/lists';
import { dedupeKeys, detectMapping, issuesCsv, parseCsvFile, summarize, validateRows, type ColumnMapping, type ImportRow, type MappingTarget, type ParsedCsv, type RowStatus } from '../lib/csv';
import type { ConsentStatus } from '../lib/types';
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Select, Stat, Textarea, cx, useAction, useToast } from '../ui/components';
import { downloadText } from '../ui/download';
import { Pager, usePage } from '../ui/Pager';
import { useSettings } from '../ui/settingsContext';
import { callingCode } from '../lib/phone';

const TARGETS: { value: MappingTarget; label: string }[] = [
  { value: 'phone', label: 'Phone (required)' },
  { value: 'name', label: 'Full name' },
  { value: 'first_name', label: 'First name' },
  { value: 'last_name', label: 'Last name' },
  { value: 'email', label: 'Email' },
  { value: 'custom', label: 'Custom field' },
  { value: 'ignore', label: "Don't import" },
];

const statusTone: Record<RowStatus, 'green' | 'red' | 'amber' | 'blue'> = { valid: 'green', invalid: 'red', duplicate: 'amber', existing: 'blue' };
type Filter = 'all' | RowStatus | 'warnings';

export default function ImportContacts() {
  const { settings } = useSettings();
  const navigate = useNavigate();
  const { run, busy } = useAction();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [encoding, setEncoding] = useState('UTF-8');
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping[]>([]);
  const [parseError, setParseError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [existing, setExisting] = useState<Map<string, string>>(new Map());
  const [suppressed, setSuppressed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(0);
  const [listChoice, setListChoice] = useState<string>('__new');
  const [newListName, setNewListName] = useState('');
  const [strategy, setStrategy] = useState<ExistingStrategy>('keep');
  const [consent, setConsent] = useState<ConsentStatus>('unknown');
  const [consentNote, setConsentNote] = useState('');
  const lists = useLiveQuery(() => db.lists.orderBy('name').toArray(), []);

  const load = async (f: File, enc: string) => {
    setParseError(undefined);
    try {
      const p = await parseCsvFile(f, enc);
      setParsed(p);
      setMapping(detectMapping(p.headers));
      setExisting(await existingPhoneMap());
      setSuppressed(await suppressedSet());
      setNewListName(f.name.replace(/\.[^.]+$/, ''));
    } catch (e) {
      setParsed(null);
      setParseError(e instanceof Error ? e.message : 'Could not read the file');
    }
  };

  const onFile = (f: File | undefined) => {
    if (!f) return;
    if (!/\.(csv|tsv|txt)$/i.test(f.name) && !f.type.includes('csv') && f.type !== 'text/plain') {
      setParseError('Please choose a .csv file');
      return;
    }
    setFile(f);
    void load(f, encoding);
  };

  const phoneCount = mapping.filter((m) => m.target === 'phone').length;
  const { rows, validationError } = useMemo((): { rows: ImportRow[]; validationError?: string } => {
    if (!parsed || phoneCount !== 1) return { rows: [], validationError: parsed ? 'Map exactly one column to Phone.' : undefined } as { rows: ImportRow[]; validationError?: string };
    try {
      return { rows: validateRows(parsed, mapping, { defaultCountry: settings.defaultCountry, existingPhones: existing, suppressedPhones: suppressed }) };
    } catch (e) {
      return { rows: [], validationError: e instanceof Error ? e.message : String(e) };
    }
  }, [parsed, mapping, settings.defaultCountry, existing, suppressed, phoneCount]);

  useEffect(() => {
    setSelected(new Set(rows.filter((r) => r.status === 'valid' || r.status === 'existing').map((r) => r.rowNumber)));
    setPage(0);
  }, [rows]);

  const summary = useMemo(() => summarize(rows), [rows]);
  const filtered = useMemo(() => rows.filter((r) => filter === 'all' || (filter === 'warnings' ? r.issues.some((i) => i.level === 'warning') : r.status === filter)), [rows, filter]);
  const pg = usePage(filtered, page, 50);
  const selectable = (r: ImportRow) => r.status !== 'invalid';

  const setMap = (i: number, patch: Partial<ColumnMapping>) => {
    setMapping((m) => dedupeKeys(m.map((x, idx) => {
      if (idx === i) return { ...x, ...patch };
      // Only one column can be phone/name/email.
      if (patch.target && patch.target !== 'custom' && patch.target !== 'ignore' && x.target === patch.target) return { ...x, target: 'custom' };
      return x;
    })));
  };

  const reset = () => {
    setFile(null);
    setParsed(null);
    setMapping([]);
    if (fileInput.current) fileInput.current.value = '';
  };

  const doImport = () =>
    run(async () => {
      const chosen = rows.filter((r) => selected.has(r.rowNumber) && selectable(r));
      if (chosen.length === 0) throw new Error('Select at least one contact to import');
      let listId: string | undefined;
      if (listChoice === '__new') listId = (await createList(newListName || 'Imported contacts')).id;
      else if (listChoice !== '__none') listId = listChoice;
      const res = await importRows(chosen, { existing: strategy, consent, consentNote, ...(listId ? { listId } : {}) });
      reset();
      toast(`Imported: ${res.created} new, ${res.updated} existing${listId ? `, ${res.addedToList} added to list` : ''}`);
      navigate(listId ? `/contacts?list=${listId}` : '/contacts');
    });

  return (
    <>
      <PageHeader
        title="Import contacts"
        description={<>CSV files are read locally in your browser and never uploaded. Numbers without a country code are treated as <strong>{settings.defaultCountry} ({callingCode(settings.defaultCountry)})</strong>; change this in Settings.</>}
        actions={parsed && <Button icon={<RotateCcw className="size-4" />} onClick={reset}>Start over</Button>}
      />

      {!parsed && (
        <Card className="p-6">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); onFile(e.dataTransfer.files[0]); }}
            className={cx('flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-14 text-center transition-colors', dragging ? 'border-brand-500 bg-brand-50 dark:bg-brand-700/10' : 'border-slate-300 dark:border-slate-700')}
          >
            <FileUp className="size-10 text-slate-400" aria-hidden />
            <div>
              <p className="font-medium">Drag and drop a CSV file here</p>
              <p className="text-sm text-slate-500">or</p>
            </div>
            <Button variant="primary" onClick={() => fileInput.current?.click()}>Choose file</Button>
            <input ref={fileInput} type="file" accept=".csv,.tsv,.txt,text/csv" className="sr-only" aria-label="CSV file" onChange={(e) => onFile(e.target.files?.[0])} />
            <div className="mt-2 w-56">
              <Field label="File encoding" htmlFor="enc" hint="Use Windows-1252 for older Excel exports.">
                <Select id="enc" value={encoding} onChange={(e) => setEncoding(e.target.value)}>
                  <option value="UTF-8">UTF-8 (recommended)</option>
                  <option value="UTF-16LE">UTF-16 (Excel Unicode text)</option>
                  <option value="windows-1252">Windows-1252</option>
                  <option value="ISO-8859-1">ISO-8859-1</option>
                </Select>
              </Field>
            </div>
          </div>
          {parseError && <div className="mt-4"><Alert tone="red" title="Couldn't read file">{parseError}</Alert></div>}
        </Card>
      )}

      {parsed && (
        <div className="space-y-6">
          <Card className="p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold">1. Map columns</h2>
                <p className="text-sm text-slate-500">{file?.name} · {parsed.rows.length.toLocaleString()} rows · delimiter “{parsed.delimiter === '\t' ? 'tab' : parsed.delimiter}”. Custom fields become placeholders like <code>{'{{course}}'}</code>.</p>
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="enc2" className="text-sm text-slate-500">Encoding</label>
                <Select id="enc2" className="w-44" value={encoding} onChange={(e) => { setEncoding(e.target.value); if (file) void load(file, e.target.value); }}>
                  <option value="UTF-8">UTF-8</option>
                  <option value="UTF-16LE">UTF-16</option>
                  <option value="windows-1252">Windows-1252</option>
                  <option value="ISO-8859-1">ISO-8859-1</option>
                </Select>
              </div>
            </div>
            {parsed.parseErrors.length > 0 && (
              <div className="mb-4"><Alert tone="amber" title={`${parsed.parseErrors.length} parsing issue(s)`}>{parsed.parseErrors.slice(0, 3).map((e) => `Row ${e.row}: ${e.message}`).join('; ')}</Alert></div>
            )}
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800">
                    {mapping.map((m, i) => (
                      <th key={i} className="min-w-44 p-2 text-left align-top">
                        <p className="mb-1.5 truncate font-semibold" title={m.header}>{m.header}</p>
                        <Select aria-label={`Map column ${m.header}`} value={m.target} onChange={(e) => setMap(i, { target: e.target.value as MappingTarget })}>
                          {TARGETS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                        </Select>
                        {m.target === 'custom' && (
                          <Input aria-label={`Placeholder key for ${m.header}`} className="mt-1.5 font-mono text-xs" value={m.key} onChange={(e) => setMap(i, { key: e.target.value })} />
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.slice(0, 20).map((r, ri) => (
                    <tr key={ri} className="border-b border-slate-100 dark:border-slate-800/60">
                      {mapping.map((m, ci) => <td key={ci} className={cx('max-w-56 truncate px-2 py-1.5', m.target === 'ignore' && 'text-slate-400 line-through')}>{r[m.index]}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-slate-500">Showing the first {Math.min(20, parsed.rows.length)} rows.</p>
          </Card>

          {validationError ? (
            <Alert tone="red" title="Mapping incomplete">{validationError}</Alert>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
                <Stat label="Total rows" value={summary.total.toLocaleString()} />
                <Stat label="Valid new" value={summary.valid.toLocaleString()} tone="text-emerald-600" />
                <Stat label="Already saved" value={summary.existing.toLocaleString()} tone="text-sky-600" />
                <Stat label="Duplicates" value={summary.duplicates.toLocaleString()} tone="text-amber-600" />
                <Stat label="Invalid" value={summary.invalid.toLocaleString()} tone="text-red-600" />
                <Stat label="Missing name" value={summary.missingName.toLocaleString()} />
              </div>

              <Card>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3 dark:border-slate-800">
                  <h2 className="font-semibold">2. Review and select contacts</h2>
                  <div className="flex flex-wrap items-center gap-2">
                    <Select aria-label="Filter rows" className="w-48" value={filter} onChange={(e) => { setFilter(e.target.value as Filter); setPage(0); }}>
                      <option value="all">All rows ({rows.length})</option>
                      <option value="valid">Valid ({summary.valid})</option>
                      <option value="existing">Already saved ({summary.existing})</option>
                      <option value="duplicate">Duplicates ({summary.duplicates})</option>
                      <option value="invalid">Invalid ({summary.invalid})</option>
                      <option value="warnings">With warnings</option>
                    </Select>
                    <Button size="sm" onClick={() => setSelected(new Set([...selected, ...filtered.filter(selectable).map((r) => r.rowNumber)]))}>Select shown</Button>
                    <Button size="sm" onClick={() => { const s = new Set(selected); filtered.forEach((r) => s.delete(r.rowNumber)); setSelected(s); }}>Deselect shown</Button>
                    <Button size="sm" icon={<Download className="size-3.5" />} disabled={summary.invalid + summary.duplicates === 0} onClick={() => downloadText(`${newListName || 'import'}-issues.csv`, issuesCsv(parsed, rows))}>Export invalid & duplicates</Button>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full">
                    <thead className="bg-slate-50 dark:bg-slate-900/60">
                      <tr><th className="th w-10"><span className="sr-only">Select</span></th><th className="th">Row</th><th className="th">Name</th><th className="th">Phone</th><th className="th">Status</th><th className="th">Notes</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {pg.slice.map((r) => (
                        <tr key={r.rowNumber} className={cx(!selectable(r) && 'bg-red-50/40 dark:bg-red-950/10')}>
                          <td className="td">
                            <input type="checkbox" className="size-4 accent-brand-600" aria-label={`Select row ${r.rowNumber}`} disabled={!selectable(r)} checked={selected.has(r.rowNumber)}
                              onChange={(e) => { const s = new Set(selected); if (e.target.checked) s.add(r.rowNumber); else s.delete(r.rowNumber); setSelected(s); }} />
                          </td>
                          <td className="td tabular-nums text-slate-500">{r.rowNumber}</td>
                          <td className="td">{r.name || <span className="text-slate-400 italic">missing</span>}</td>
                          <td className="td font-mono text-xs">{r.phone ?? <span className="text-red-600">{r.rawPhone || '—'}</span>}</td>
                          <td className="td"><Badge tone={statusTone[r.status]}>{r.status}</Badge>{r.suppressed && <span className="ml-1"><Badge tone="red">opted out</Badge></span>}</td>
                          <td className="td text-xs">
                            {r.issues.length === 0 ? <span className="text-slate-400">—</span> : (
                              <ul className="space-y-0.5">{r.issues.map((i, k) => <li key={k} className={i.level === 'error' ? 'text-red-600 dark:text-red-400' : 'text-slate-600 dark:text-slate-400'}>{i.message}</li>)}</ul>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pager page={pg.page} pages={pg.pages} total={filtered.length} onPage={setPage} />
              </Card>

              <Card className="p-5">
                <h2 className="mb-4 font-semibold">3. Import options</h2>
                <div className="grid gap-5 md:grid-cols-2">
                  <div className="space-y-4">
                    <Field label="Add to list" htmlFor="list">
                      <Select id="list" value={listChoice} onChange={(e) => setListChoice(e.target.value)}>
                        <option value="__new">Create a new list…</option>
                        {lists?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                        <option value="__none">Don't add to a list</option>
                      </Select>
                    </Field>
                    {listChoice === '__new' && (
                      <Field label="New list name" htmlFor="lname"><Input id="lname" value={newListName} onChange={(e) => setNewListName(e.target.value)} /></Field>
                    )}
                    <Field label="Contacts that already exist" htmlFor="strategy" hint="Opt-outs are never changed by an import.">
                      <Select id="strategy" value={strategy} onChange={(e) => setStrategy(e.target.value as ExistingStrategy)}>
                        <option value="keep">Keep saved details, just add to the list</option>
                        <option value="merge">Update with non-empty values from this file</option>
                      </Select>
                    </Field>
                  </div>
                  <div className="space-y-4">
                    <Field label="Consent status for new contacts" htmlFor="consent" hint="Choose “Opted in” only if these people agreed to receive WhatsApp messages from you. The official API requires opt-in.">
                      <Select id="consent" value={consent} onChange={(e) => setConsent(e.target.value as ConsentStatus)}>
                        <option value="unknown">Unknown</option>
                        <option value="granted">Opted in</option>
                        <option value="denied">Opted out</option>
                      </Select>
                    </Field>
                    {consent !== 'unknown' && (
                      <Field label="Consent source / note" htmlFor="cnote" hint="e.g. “Registration form checkbox, Sept 2026”. Stored with each contact.">
                        <Textarea id="cnote" rows={2} value={consentNote} onChange={(e) => setConsentNote(e.target.value)} />
                      </Field>
                    )}
                  </div>
                </div>
                <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4 dark:border-slate-800">
                  <p className="text-sm text-slate-500">{selected.size.toLocaleString()} selected · {summary.invalid} invalid row(s) can't be imported; export them to fix and re-import.</p>
                  <Button variant="primary" loading={busy} disabled={selected.size === 0} onClick={() => void doImport()}>Import {selected.size.toLocaleString()} contact(s)</Button>
                </div>
              </Card>
            </>
          )}
        </div>
      )}
    </>
  );
}
