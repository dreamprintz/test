import { describe, expect, it } from 'vitest';
import { canTransitionCampaign, countRecipients, idempotencyKey, isFinished, progress, retryDecision, transitionRecipient } from './campaign';
import type { Recipient } from './types';

const r = (over: Partial<Recipient> = {}): Recipient => ({
  id: 'r1', campaignId: 'c1', contactId: 'x', phone: '+919876543210', name: 'A', message: 'hi',
  status: 'pending', attempts: 0, sendGeneration: 0, order: 0, updatedAt: 0, history: [], ...over,
});

describe('campaign status transitions', () => {
  it('allows the normal lifecycle', () => {
    expect(canTransitionCampaign('draft', 'running')).toBe(true);
    expect(canTransitionCampaign('running', 'paused')).toBe(true);
    expect(canTransitionCampaign('paused', 'running')).toBe(true);
    expect(canTransitionCampaign('running', 'completed')).toBe(true);
  });
  it('blocks invalid transitions', () => {
    expect(canTransitionCampaign('cancelled', 'running')).toBe(false);
    expect(canTransitionCampaign('draft', 'paused')).toBe(false);
    expect(canTransitionCampaign('completed', 'paused')).toBe(false);
  });
});

describe('recipient transitions', () => {
  it('records history', () => {
    const next = transitionRecipient(r(), 'processing', 'go', 5);
    expect(next.status).toBe('processing');
    expect(next.history).toEqual([{ at: 5, status: 'processing', note: 'go' }]);
  });
  it('never moves a sent message back to pending', () => {
    expect(() => transitionRecipient(r({ status: 'sent' }), 'pending')).toThrow();
    expect(() => transitionRecipient(r({ status: 'pending' }), 'sent')).toThrow();
  });
});

describe('retry behaviour', () => {
  it('retries temporary failures', () => {
    expect(retryDecision(r({ status: 'failed', retryable: true })).eligible).toBe(true);
    expect(retryDecision(r({ status: 'failed' })).eligible).toBe(true);
  });
  it('holds back permanent failures, unknown outcomes, opt-outs and sent messages', () => {
    expect(retryDecision(r({ status: 'failed', retryable: false }))).toMatchObject({ eligible: false, canForce: true });
    expect(retryDecision(r({ status: 'failed', deliveryStatus: 'failed', retryable: false }))).toMatchObject({ eligible: false, canForce: true });
    expect(retryDecision(r({ status: 'unknown' }))).toMatchObject({ eligible: false, canForce: true });
    expect(retryDecision(r({ status: 'skipped', skipReason: 'opted_out' }))).toMatchObject({ eligible: false, canForce: false });
    expect(retryDecision(r({ status: 'sent' }))).toMatchObject({ eligible: false, canForce: false });
  });
  it('keeps the idempotency key stable across ordinary retries', () => {
    expect(idempotencyKey(r())).toBe('c1:r1:0');
    expect(idempotencyKey(r({ attempts: 3 }))).toBe('c1:r1:0');
    expect(idempotencyKey(r({ sendGeneration: 1 }))).toBe('c1:r1:1');
  });
});

describe('counts', () => {
  it('counts statuses and delivery', () => {
    const c = countRecipients([r(), r({ status: 'sent', deliveryStatus: 'read' }), r({ status: 'sent', deliveryStatus: 'delivered' }), r({ status: 'skipped' })]);
    expect(c).toMatchObject({ total: 4, pending: 1, sent: 2, skipped: 1, delivered: 2, read: 1 });
    expect(progress(c)).toBe(0.75);
    expect(isFinished(c)).toBe(false);
  });
});
