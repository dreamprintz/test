import { db } from './db';
import { newId } from '../lib/ids';
import type { MessageTemplate } from '../lib/types';

export async function saveTemplate(t: { id?: string; name: string; body: string }): Promise<MessageTemplate> {
  const name = t.name.trim();
  if (!name) throw new Error('Template name is required');
  if (!t.body.trim()) throw new Error('Template body is required');
  const now = Date.now();
  if (t.id) {
    const existing = await db.templates.get(t.id);
    if (!existing) throw new Error('Template not found');
    const next = { ...existing, name, body: t.body, updatedAt: now };
    await db.templates.put(next);
    return next;
  }
  const created: MessageTemplate = { id: newId('t'), name, body: t.body, createdAt: now, updatedAt: now };
  await db.templates.add(created);
  return created;
}

export async function duplicateTemplate(id: string): Promise<MessageTemplate> {
  const t = await db.templates.get(id);
  if (!t) throw new Error('Template not found');
  return saveTemplate({ name: `${t.name} (copy)`, body: t.body });
}

export async function deleteTemplate(id: string): Promise<void> {
  await db.templates.delete(id);
}
