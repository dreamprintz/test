import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Copy, FileText, Plus, Save, Smile, Trash2 } from 'lucide-react';
import { db } from '../db/db';
import { deleteTemplate, duplicateTemplate, saveTemplate } from '../db/templates';
import { characterCount, contactContext, extractPlaceholders, renderTemplate, unknownPlaceholders, WHATSAPP_TEXT_LIMIT } from '../lib/template';
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, Textarea, cx, useAction, useConfirm } from '../ui/components';
import { MessageBubble } from '../ui/MessagePreview';
import { useFieldKeys } from '../ui/useFieldKeys';
import { fmtDate } from '../ui/download';

const EXAMPLE = 'Hello {{name}},\n\nYour registration for {{course}} has been received.\n\nYour registration number is {{registration_no}}.\n\nThank you!';
const EMOJI = ['😊', '👋', '🙏', '🎉', '✅', '📅', '📍', '📞', '⏰', '📚', '🎓', '💡', '⭐', '❤️', '👍', '🔔', '📝', '🚀'];

export default function Templates() {
  const templates = useLiveQuery(() => db.templates.orderBy('name').toArray(), []);
  const [selectedId, setSelectedId] = useState<string | 'new' | null>(null);
  useEffect(() => {
    if (templates && selectedId === null) setSelectedId(templates[0]?.id ?? 'new');
  }, [templates, selectedId]);
  if (!templates) return <Spinner />;
  const current = templates.find((t) => t.id === selectedId);
  return (
    <>
      <PageHeader title="Message templates" description="Use placeholders like {{name}} for personalisation. Add a fallback with {{name|there}}. WhatsApp formatting (*bold*, _italic_) is supported."
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setSelectedId('new')}>New template</Button>} />
      <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
        <Card className="h-fit">
          {templates.length === 0 ? <EmptyState icon={<FileText className="size-5" />} title="No templates" /> : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {templates.map((t) => (
                <li key={t.id}>
                  <button onClick={() => setSelectedId(t.id)} className={cx('w-full px-4 py-3 text-left', selectedId === t.id ? 'bg-brand-50 dark:bg-brand-700/15' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50')} aria-current={selectedId === t.id}>
                    <p className="truncate text-sm font-medium">{t.name}</p>
                    <p className="text-xs text-slate-500">Updated {fmtDate(t.updatedAt)}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {selectedId && <Editor key={selectedId} id={current?.id} initialName={current?.name ?? ''} initialBody={current?.body ?? (templates.length ? '' : EXAMPLE)} onSaved={setSelectedId} onDeleted={() => setSelectedId(null)} />}
      </div>
    </>
  );
}

function Editor({ id, initialName, initialBody, onSaved, onDeleted }: { id?: string; initialName: string; initialBody: string; onSaved: (id: string) => void; onDeleted: () => void }) {
  const [name, setName] = useState(initialName || (id ? '' : 'Registration confirmation'));
  const [body, setBody] = useState(initialBody);
  const [showEmoji, setShowEmoji] = useState(false);
  const [listId, setListId] = useState('');
  const [contactId, setContactId] = useState('');
  const textRef = useRef<HTMLTextAreaElement>(null);
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const keys = useFieldKeys();
  const lists = useLiveQuery(() => db.lists.orderBy('name').toArray(), []);
  const sample = useLiveQuery(async () => (listId ? db.contacts.where('listIds').equals(listId).limit(200).toArray() : db.contacts.limit(200).toArray()), [listId]);
  const contact = sample?.find((c) => c.id === contactId) ?? sample?.[0];

  const dirty = name !== initialName || body !== initialBody;
  const placeholders = useMemo(() => extractPlaceholders(body), [body]);
  const unknown = useMemo(() => unknownPlaceholders(body, keys), [body, keys]);
  const rendered = useMemo(() => {
    if (!contact) return renderTemplate(body, Object.fromEntries(keys.map((k) => [k, `[${k}]`])));
    return renderTemplate(body, contactContext(contact));
  }, [body, contact, keys]);
  const chars = characterCount(rendered.text);
  const missingAcrossSample = useMemo(() => {
    if (!sample) return 0;
    return sample.filter((c) => renderTemplate(body, contactContext(c)).missing.length > 0).length;
  }, [sample, body]);

  const insert = (text: string) => {
    const el = textRef.current;
    if (!el) return setBody(body + text);
    const start = el.selectionStart, end = el.selectionEnd;
    const next = body.slice(0, start) + text + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + text.length, start + text.length); });
  };

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Card className="p-5">
        <div className="space-y-4">
          <Field label="Template name" htmlFor="t-name"><Input id="t-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label htmlFor="t-body" className="text-sm font-medium text-slate-700 dark:text-slate-300">Message</label>
              <span className={cx('text-xs tabular-nums', chars > WHATSAPP_TEXT_LIMIT ? 'text-red-600' : 'text-slate-500')}>{chars} / {WHATSAPP_TEXT_LIMIT} characters (preview)</span>
            </div>
            <Textarea id="t-body" ref={textRef} rows={12} value={body} onChange={(e) => setBody(e.target.value)} />
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-slate-500">Insert:</span>
              {keys.map((k) => <button key={k} type="button" onClick={() => insert(`{{${k}}}`)} className="rounded-md border border-slate-200 px-1.5 py-0.5 font-mono text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">{`{{${k}}}`}</button>)}
              <button type="button" onClick={() => setShowEmoji(!showEmoji)} aria-expanded={showEmoji} className="rounded-md border border-slate-200 p-1 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800" aria-label="Insert emoji"><Smile className="size-3.5" /></button>
            </div>
            {showEmoji && (
              <div className="mt-2 flex flex-wrap gap-1 rounded-lg border border-slate-200 p-2 dark:border-slate-700">
                {EMOJI.map((e) => <button key={e} type="button" className="rounded p-1 text-lg hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => insert(e)} aria-label={`Insert ${e}`}>{e}</button>)}
              </div>
            )}
          </div>
          {unknown.length > 0 && <Alert tone="amber" title="Unknown placeholders">{unknown.map((u) => `{{${u}}}`).join(', ')} {unknown.length === 1 ? "doesn't" : "don't"} match any contact field. Check the spelling or import a column with that name.</Alert>}
          <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
            <Button variant="primary" icon={<Save className="size-4" />} loading={busy} disabled={!dirty && !!id} onClick={() => void run(async () => { const t = await saveTemplate({ ...(id ? { id } : {}), name, body }); onSaved(t.id); }, 'Template saved')}>Save</Button>
            {id && <Button icon={<Copy className="size-4" />} onClick={() => void run(async () => onSaved((await duplicateTemplate(id)).id), 'Template duplicated')}>Duplicate</Button>}
            {id && <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={async () => {
              if (await confirm({ title: 'Delete template?', message: 'Campaigns that already used it keep their own copy of the message.', confirmLabel: 'Delete', danger: true })) await run(async () => { await deleteTemplate(id); onDeleted(); }, 'Template deleted');
            }}>Delete</Button>}
          </div>
        </div>
      </Card>
      <Card className="p-5">
        <h2 className="mb-3 font-semibold">Live preview</h2>
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <Select aria-label="Preview list" value={listId} onChange={(e) => { setListId(e.target.value); setContactId(''); }}>
            <option value="">All contacts</option>
            {lists?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
          <Select aria-label="Preview contact" value={contact?.id ?? ''} onChange={(e) => setContactId(e.target.value)} disabled={!sample?.length}>
            {!sample?.length && <option value="">No contacts — showing field names</option>}
            {sample?.map((c) => <option key={c.id} value={c.id}>{c.name || c.phone}</option>)}
          </Select>
        </div>
        <MessageBubble text={rendered.text} />
        <div className="mt-3 space-y-2">
          {rendered.missing.length > 0 && <Alert tone="red" title="Missing values for this contact">{rendered.missing.map((m) => `{{${m}}}`).join(', ')}. Add a fallback like {`{{${rendered.missing[0]}|…}}`} or fill in the contact's data.</Alert>}
          {sample && sample.length > 0 && placeholders.length > 0 && (
            <p className="text-xs text-slate-500">{missingAcrossSample === 0 ? `All ${sample.length} previewed contacts have every value.` : `${missingAcrossSample} of ${sample.length} previewed contacts are missing at least one value.`}</p>
          )}
        </div>
      </Card>
    </div>
  );
}
