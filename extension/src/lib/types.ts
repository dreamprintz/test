export type ConsentStatus = 'unknown' | 'granted' | 'denied';

export interface Contact {
  id: string;
  /** Normalised E.164 phone number, e.g. +919876543210. Unique. */
  phone: string;
  /** Phone exactly as it appeared in the source file, kept for auditing. */
  rawPhone: string;
  name: string;
  email: string;
  /** Custom columns keyed by placeholder-safe field key (e.g. registration_no). */
  fields: Record<string, string>;
  listIds: string[];
  consent: ConsentStatus;
  consentNote?: string;
  consentUpdatedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ContactList {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

export type SuppressionSource = 'manual' | 'contact' | 'import' | 'backend';

export interface SuppressionEntry {
  phone: string;
  reason: string;
  source: SuppressionSource;
  createdAt: number;
}

export interface MessageTemplate {
  id: string;
  name: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export type ProviderId = 'manual' | 'cloud_api';

export type CampaignStatus = 'draft' | 'running' | 'paused' | 'completed' | 'cancelled';

export interface CloudTemplateConfig {
  /** Approved Meta template name. */
  name: string;
  /** Template language code, e.g. en or en_US. */
  language: string;
  /** Contact field keys mapped to body parameters {{1}}, {{2}}, ... */
  bodyParams: string[];
}

export interface Campaign {
  id: string;
  name: string;
  listId: string;
  templateId: string;
  /** Frozen copy of the template body at launch so later edits don't alter history. */
  templateBody: string;
  provider: ProviderId;
  cloudTemplate?: CloudTemplateConfig;
  status: CampaignStatus;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  history: CampaignEvent[];
}

export interface CampaignEvent {
  at: number;
  type: string;
  note?: string;
}

export type RecipientStatus = 'pending' | 'processing' | 'sent' | 'failed' | 'skipped' | 'unknown';

/** Delivery state reported by the provider. Only Cloud API webhooks set this. */
export type DeliveryStatus = 'accepted' | 'sent' | 'delivered' | 'read' | 'failed';

export interface Recipient {
  id: string;
  campaignId: string;
  contactId: string;
  phone: string;
  name: string;
  message: string;
  status: RecipientStatus;
  /** How "sent" was established: user said so (manual) or the API accepted it. */
  sentEvidence?: 'user_confirmed' | 'api_accepted';
  deliveryStatus?: DeliveryStatus;
  providerMessageId?: string;
  attempts: number;
  /** Incremented only when the user explicitly forces a resend; part of the idempotency key. */
  sendGeneration: number;
  retryable?: boolean;
  /** Cloud API queue: don't attempt again before this time (backoff after a temporary error). */
  nextAttemptAt?: number;
  lastError?: string;
  skipReason?: string;
  order: number;
  updatedAt: number;
  history: { at: number; status: RecipientStatus; note?: string }[];
}

export interface ActivityEntry {
  id?: number;
  at: number;
  type: string;
  campaignId?: string;
  /** Must never contain phone numbers or message content. */
  message: string;
}
