import Dexie, { type EntityTable } from 'dexie';
import type { ActivityEntry, Campaign, Contact, ContactList, MessageTemplate, Recipient, SuppressionEntry } from '../lib/types';

export class AppDB extends Dexie {
  contacts!: EntityTable<Contact, 'id'>;
  lists!: EntityTable<ContactList, 'id'>;
  suppression!: EntityTable<SuppressionEntry, 'phone'>;
  templates!: EntityTable<MessageTemplate, 'id'>;
  campaigns!: EntityTable<Campaign, 'id'>;
  recipients!: EntityTable<Recipient, 'id'>;
  activity!: EntityTable<ActivityEntry, 'id'>;

  constructor(name = 'wa-campaign-manager') {
    super(name);
    this.version(1).stores({
      contacts: 'id, &phone, name, *listIds, consent, createdAt, updatedAt',
      lists: 'id, name, createdAt',
      suppression: 'phone, createdAt',
      templates: 'id, name, updatedAt',
      campaigns: 'id, status, archived, createdAt, updatedAt',
      recipients: 'id, campaignId, [campaignId+status], [campaignId+order], contactId, phone, providerMessageId',
      activity: '++id, at, campaignId',
    });
  }
}

export const db = new AppDB();
