import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from './store.js';
import { classifyMetaError } from './meta.js';

describe('store', () => {
  it('persists atomically with private permissions and drops expired records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-store-'));
    const s = new Store(dir, 1000);
    s.put({ key: 'a', to: '1', status: 'accepted', providerMessageId: 'w1', attempts: 1, createdAt: Date.now(), updatedAt: Date.now() });
    s.put({ key: 'old', to: '1', status: 'accepted', attempts: 1, createdAt: 0, updatedAt: 0 });
    const reloaded = new Store(dir, 1000);
    expect(reloaded.getByProviderId('w1')?.key).toBe('a');
    expect(reloaded.get('old')).toBeUndefined();
    expect(statSync(join(dir, 'store.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8')).messages).toHaveLength(1);
  });
});

describe('error classification', () => {
  it('classifies Meta errors', () => {
    expect(classifyMetaError(400, { error: { code: 131026, message: 'x' } }).retryable).toBe(false);
    expect(classifyMetaError(400, { error: { code: 130429 } }).retryable).toBe(true);
    expect(classifyMetaError(401, { error: { code: 190, message: 'Token expired' } })).toEqual({ code: '190', message: 'Token expired', retryable: false });
    expect(classifyMetaError(502, null).retryable).toBe(true);
  });
});
