import { db } from './db';
import { newId } from '../lib/ids';
import type { ContactList } from '../lib/types';

export async function createList(name: string, description = ''): Promise<ContactList> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('List name is required');
  const clash = await db.lists.where('name').equalsIgnoreCase(trimmed).first();
  if (clash) throw new Error('A list with this name already exists');
  const now = Date.now();
  const list: ContactList = { id: newId('l'), name: trimmed, description, createdAt: now, updatedAt: now };
  await db.lists.add(list);
  return list;
}

export async function renameList(id: string, name: string, description: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('List name is required');
  const clash = await db.lists.where('name').equalsIgnoreCase(trimmed).first();
  if (clash && clash.id !== id) throw new Error('A list with this name already exists');
  await db.lists.update(id, { name: trimmed, description, updatedAt: Date.now() });
}

/** Deletes the list only; contacts stay in the address book. */
export async function deleteList(id: string): Promise<void> {
  await db.transaction('rw', db.lists, db.contacts, async () => {
    await db.contacts.where('listIds').equals(id).modify((c) => {
      c.listIds = c.listIds.filter((l) => l !== id);
    });
    await db.lists.delete(id);
  });
}

export async function addToList(contactIds: string[], listId: string): Promise<void> {
  await db.contacts.where('id').anyOf(contactIds).modify((c) => {
    if (!c.listIds.includes(listId)) c.listIds.push(listId);
  });
}

export async function removeFromList(contactIds: string[], listId: string): Promise<void> {
  await db.contacts.where('id').anyOf(contactIds).modify((c) => {
    c.listIds = c.listIds.filter((l) => l !== listId);
  });
}
