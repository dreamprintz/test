import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';

/** All placeholder keys available from imported contacts, plus the built-ins. */
export function useFieldKeys(listId?: string): string[] {
  return useLiveQuery(async () => {
    const keys = new Set<string>();
    const coll = listId ? db.contacts.where('listIds').equals(listId) : db.contacts.toCollection();
    await coll.each((c) => Object.keys(c.fields).forEach((k) => keys.add(k)));
    return ['name', 'first_name', 'phone', 'email', ...[...keys].sort()];
  }, [listId]) ?? ['name', 'first_name', 'phone', 'email'];
}
