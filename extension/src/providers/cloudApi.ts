import type { OptOut, SendRequest, SendResponse, StatusResponse } from './types';

export class BackendError extends Error {
  constructor(message: string, readonly kind: 'network' | 'auth' | 'http' | 'invalid', readonly status?: number) {
    super(message);
  }
}

export interface BackendConfig {
  backendUrl: string;
  backendKey: string;
}

/** Thin client for the user's own backend. Meta credentials never reach the extension. */
export class BackendClient {
  constructor(private readonly cfg: BackendConfig, private readonly fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
    const url = new URL(path, this.cfg.backendUrl.endsWith('/') ? this.cfg.backendUrl : `${this.cfg.backendUrl}/`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.backendKey}`, ...(init.headers ?? {}) },
      });
    } catch (e) {
      throw new BackendError(e instanceof Error && e.name === 'AbortError' ? 'Backend timed out' : 'Backend unreachable', 'network');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) throw new BackendError('Backend rejected the access key', 'auth', res.status);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new BackendError(`Backend returned HTTP ${res.status} without JSON`, 'http', res.status);
    }
    if (!res.ok) {
      const msg = (body as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
      throw new BackendError(msg, res.status >= 500 ? 'http' : 'invalid', res.status);
    }
    return body as T;
  }

  health(): Promise<{ ok: boolean; configured: boolean; apiVersion: string }> {
    return this.request('api/health', { method: 'GET' }, 10_000);
  }

  send(req: SendRequest): Promise<SendResponse> {
    return this.request('api/messages', { method: 'POST', body: JSON.stringify(req) }, 60_000);
  }

  statuses(keys: string[]): Promise<StatusResponse> {
    return this.request('api/messages/status', { method: 'POST', body: JSON.stringify({ keys }) });
  }

  optOuts(since: number): Promise<{ optouts: OptOut[] }> {
    return this.request(`api/optouts?since=${since}`, { method: 'GET' });
  }
}
