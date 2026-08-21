import { describe, expect, it } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { buildMeriFeedbackSignal } from './meri-feedback.adapter.js';
import type { NormalizedFeedback } from '../../meri/meri-feedback.helpers.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER_A = '22222222-2222-4222-8222-222222222222';
const USER_B = '99999999-9999-4999-8999-999999999999';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const OBSERVED_AT = new Date('2026-08-21T00:00:00.000Z');

function ctxFor(userId: string): TenantContext {
  return { tenantId: TENANT, tenantSlug: 't', userId, clerkUserId: 'u', role: 'standard_user' };
}

const source = { messageId: 'msg-1', conversationId: 'conv-1', clientId: null, contextPacketId: 'packet-1' };
const negative: NormalizedFeedback = { rating: 'down', reasons: ['factually_wrong'], note: 'this was wrong' };
const positive: NormalizedFeedback = { rating: 'up', reasons: [], note: null };

describe('buildMeriFeedbackSignal', () => {
  it('returns null when the rating is cleared (not itself a new signal)', () => {
    expect(buildMeriFeedbackSignal(ctxFor(USER_A), source, { rating: null, reasons: [], note: null }, OBSERVED_AT)).toBeNull();
  });

  it('maps a thumbs-up to meri_feedback_positive', () => {
    const signal = buildMeriFeedbackSignal(ctxFor(USER_A), source, positive, OBSERVED_AT);
    expect(signal?.signalType).toBe('meri_feedback_positive');
  });

  it('maps a thumbs-down to meri_feedback_negative', () => {
    const signal = buildMeriFeedbackSignal(ctxFor(USER_A), source, negative, OBSERVED_AT);
    expect(signal?.signalType).toBe('meri_feedback_negative');
  });

  it('always sets tenantId from ctx, never from the source object', () => {
    const signal = buildMeriFeedbackSignal(ctxFor(USER_A), source, negative, OBSERVED_AT);
    expect(signal?.tenantId).toBe(TENANT);
  });

  it('SECURITY: actorUserId always comes from ctx — the same source/feedback under two different actors never cross-attributes', () => {
    const signalA = buildMeriFeedbackSignal(ctxFor(USER_A), source, negative, OBSERVED_AT);
    const signalB = buildMeriFeedbackSignal(ctxFor(USER_B), source, negative, OBSERVED_AT);
    expect(signalA?.actorUserId).toBe(USER_A);
    expect(signalB?.actorUserId).toBe(USER_B);
    expect(signalA?.actorUserId).not.toBe(signalB?.actorUserId);
  });

  it('proposes user-voice when there is no client context', () => {
    const signal = buildMeriFeedbackSignal(ctxFor(USER_A), source, negative, OBSERVED_AT);
    expect(signal?.proposedMemoryLayer).toBe('user-voice');
  });

  it('proposes client-steering when the conversation is client-scoped', () => {
    const signal = buildMeriFeedbackSignal(ctxFor(USER_A), { ...source, clientId: CLIENT }, negative, OBSERVED_AT);
    expect(signal?.proposedMemoryLayer).toBe('client-steering');
    expect(signal?.clientId).toBe(CLIENT);
  });

  it('never copies the free-text note into the signal — only whether one was left', () => {
    const signal = buildMeriFeedbackSignal(ctxFor(USER_A), source, negative, OBSERVED_AT);
    expect(JSON.stringify(signal)).not.toContain('this was wrong');
    expect(signal?.provenance?.hasNote).toBe(true);
  });

  it('does not assign a sourceAuthority in 27A (scoring is a later-phase task)', () => {
    const signal = buildMeriFeedbackSignal(ctxFor(USER_A), source, negative, OBSERVED_AT);
    expect(signal?.sourceAuthority).toBeNull();
  });

  it('always carries human_explicit provenance for an explicit rating', () => {
    const signal = buildMeriFeedbackSignal(ctxFor(USER_A), source, negative, OBSERVED_AT);
    expect(signal?.provenanceKind).toBe('human_explicit');
  });

  it('points evidence at the message and conversation, never a copy of the body', () => {
    const signal = buildMeriFeedbackSignal(ctxFor(USER_A), source, negative, OBSERVED_AT);
    expect(signal?.evidenceRefs).toEqual([
      { type: 'clio_message', id: 'msg-1' },
      { type: 'clio_conversation', id: 'conv-1' },
    ]);
  });
});
