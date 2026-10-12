import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { ListChecks, Pencil, Plus, Trash2 } from 'lucide-react';
import { db } from '../db/db';
import { createList, deleteList, renameList } from '../db/lists';
import type { ContactList } from '../lib/types';
import { Button, Card, EmptyState, Field, Input, Modal, PageHeader, Spinner, Textarea, useAction, useConfirm } from '../ui/components';
import { fmtDate } from '../ui/download';

export default function Lists() {
  const [editing, setEditing] = useState<ContactList | 'new' | null>(null);
  const confirm = useConfirm();
  const { run } = useAction();
  const data = useLiveQuery(async () => {
    const lists = await db.lists.orderBy('name').toArray();
    const suppressed = new Set(await db.suppression.toCollection().primaryKeys());
    const stats = new Map<string, { total: number; optedIn: number; optedOut: number }>();
    await db.contacts.each((c) => {
      for (const l of c.listIds) {
        const s = stats.get(l) ?? { total: 0, optedIn: 0, optedOut: 0 };
        s.total++;
        if (c.consent === 'denied' || suppressed.has(c.phone)) s.optedOut++;
        else if (c.consent === 'granted') s.optedIn++;
        stats.set(l, s);
      }
    });
    return { lists, stats };
  }, []);
  if (!data) return <Spinner />;
  return (
    <>
      <PageHeader title="Contact lists" description="Named audiences. A contact can belong to several lists; duplicates across lists are merged into one contact by phone number."
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>New list</Button>} />
      {data.lists.length === 0 ? (
        <Card><EmptyState icon={<ListChecks className="size-6" />} title="No lists yet" description="Lists are created when you import a CSV, or you can create one here." action={<Button variant="primary" onClick={() => setEditing('new')}>Create list</Button>} /></Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.lists.map((l) => {
            const s = data.stats.get(l.id) ?? { total: 0, optedIn: 0, optedOut: 0 };
            return (
              <Card key={l.id} className="flex flex-col p-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="truncate font-semibold">{l.name}</h2>
                    {l.description && <p className="mt-0.5 text-sm text-slate-500">{l.description}</p>}
                  </div>
                  <div className="flex shrink-0">
                    <Button size="sm" variant="ghost" aria-label={`Edit ${l.name}`} onClick={() => setEditing(l)}><Pencil className="size-3.5" /></Button>
                    <Button size="sm" variant="ghost" aria-label={`Delete ${l.name}`} onClick={async () => {
                      if (await confirm({ title: `Delete “${l.name}”?`, message: 'The list is removed; its contacts stay in your address book.', confirmLabel: 'Delete list', danger: true }))
                        await run(() => deleteList(l.id), 'List deleted');
                    }}><Trash2 className="size-3.5" /></Button>
                  </div>
                </div>
                <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <div><dt className="text-xs text-slate-500">Contacts</dt><dd className="text-lg font-semibold tabular-nums">{s.total}</dd></div>
                  <div><dt className="text-xs text-slate-500">Opted in</dt><dd className="text-lg font-semibold tabular-nums text-emerald-600">{s.optedIn}</dd></div>
                  <div><dt className="text-xs text-slate-500">Opted out</dt><dd className="text-lg font-semibold tabular-nums text-red-600">{s.optedOut}</dd></div>
                </dl>
                <div className="mt-4 flex items-center justify-between border-t border-slate-200 pt-3 text-xs text-slate-500 dark:border-slate-800">
                  <span>Created {fmtDate(l.createdAt)}</span>
                  <Link className="font-medium text-brand-700 hover:underline dark:text-brand-100" to={`/contacts?list=${l.id}`}>View contacts →</Link>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {editing && <ListEditor list={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function ListEditor({ list, onClose }: { list?: ContactList; onClose: () => void }) {
  const [name, setName] = useState(list?.name ?? '');
  const [description, setDescription] = useState(list?.description ?? '');
  const { run, busy } = useAction();
  const save = () => run(async () => {
    if (list) await renameList(list.id, name, description);
    else await createList(name, description);
    onClose();
  }, list ? 'List updated' : 'List created');
  return (
    <Modal open onClose={onClose} title={list ? 'Edit list' : 'New list'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void save()}>Save</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="Name" htmlFor="l-name"><Input id="l-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        <Field label="Description" htmlFor="l-desc"><Textarea id="l-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      </form>
    </Modal>
  );
}
