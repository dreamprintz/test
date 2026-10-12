/** Contract between the extension and the optional backend (see backend/src/routes). */
export interface SendRequest {
  idempotencyKey: string;
  /** Digits only, international format without "+". */
  to: string;
  template: { name: string; language: string; bodyParams: string[] };
}

export type BackendSendStatus = 'accepted' | 'failed' | 'unknown' | 'in_progress';

export interface BackendError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface SendResponse {
  key: string;
  status: BackendSendStatus;
  providerMessageId?: string;
  deliveryStatus?: 'sent' | 'delivered' | 'read' | 'failed';
  error?: BackendError;
}

export interface StatusResponse {
  messages: SendResponse[];
}

export interface OptOut {
  phone: string;
  at: number;
}
