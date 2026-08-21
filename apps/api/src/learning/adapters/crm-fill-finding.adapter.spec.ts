import { describe, expect, it } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import {
  buildCrmFillFindingAcceptedSignal,
  buildCrmFillFindingRejectedSignal,
  type CrmFillFindingSignalSource,
} from './crm-fill-finding.adapter.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER_A = '22222222-2222-4222-8222-222222222222';
const USER_B = '99999999-9999-4999-8999-999999999999';
const CLIENT_A = '33333333-3333-4333-8333-333333333333';
const CLIENT_B = '55555555-5555-4555-8555-555555555555';
const OBSERVED_AT = new Date('2026-08-21T00:00:00.000Z');

function ctxFor(userId: string): TenantContext {
  return { tenantId: TENANT, tenantSlug: 't', userId, clerkUserId: 'u', role: 'user_admin' };
}

function finding(overrides: Partial<CrmFillFindingSignalSource> = {}): CrmFillFindingSignalSource {
  return {
    findingId: 'finding-1',
    runId: 'run-1',
    clientId: CLIENT_A,
    kind: 'profile_field',
    targetKey: 'website',
    source: 'public_web',
    confidence: 0.92,
    ...overrides,
  };
}

describe('buildCrmFillFindingAcceptedSignal / buildCrmFillFindingRejectedSignal', () => {
  it('accepted signal carries signalType crm_finding_accepted', () => {
    const signal = buildCrmFillFindingAcceptedSignal(ctxFor(USER_A), finding(), OBSERVED_AT);
    expect(signal.signalType).toBe('crm_finding_accepted');
  });

  it('rejected signal carries signalType crm_finding_rejected, otherwise identical shape', () => {
    const accepted = buildCrmFillFindingAcceptedSignal(ctxFor(USER_A), finding(), OBSERVED_AT);
    const rejected = buildCrmFillFindingRejectedSignal(ctxFor(USER_A), finding(), OBSERVED_AT);
    expect(rejected).toEqual({ ...accepted, signalType: 'crm_finding_rejected' });
  });

  it('always sets clientId from the finding — every CRM signal is client-scoped', () => {
    const signal = buildCrmFillFindingAcceptedSignal(ctxFor(USER_A), finding({ clientId: CLIENT_B }), OBSERVED_AT);
    expect(signal.clientId).toBe(CLIENT_B);
  });

  it('SECURITY: actorUserId always comes from ctx — the reviewing admin, never a payload field', () => {
    const signalA = buildCrmFillFindingAcceptedSignal(ctxFor(USER_A), finding(), OBSERVED_AT);
    const signalB = buildCrmFillFindingAcceptedSignal(ctxFor(USER_B), finding(), OBSERVED_AT);
    expect(signalA.actorUserId).toBe(USER_A);
    expect(signalB.actorUserId).toBe(USER_B);
  });

  it('SECURITY: a finding from client A can never be captured as a signal for client B', () => {
    const signalA = buildCrmFillFindingAcceptedSignal(
      ctxFor(USER_A),
      finding({ clientId: CLIENT_A, findingId: 'finding-a' }),
      OBSERVED_AT,
    );
    const signalB = buildCrmFillFindingAcceptedSignal(
      ctxFor(USER_A),
      finding({ clientId: CLIENT_B, findingId: 'finding-b' }),
      OBSERVED_AT,
    );
    expect(signalA.clientId).toBe(CLIENT_A);
    expect(signalB.clientId).toBe(CLIENT_B);
    // Each signal's clientId is derived solely from ITS OWN finding — never
    // borrowed from another finding processed in the same batch/session.
    expect(signalA.clientId).not.toBe(signalB.clientId);
    expect(signalA.evidenceRefs).not.toEqual(signalB.evidenceRefs);
  });

  it('proposes client-people for a person finding', () => {
    const signal = buildCrmFillFindingAcceptedSignal(ctxFor(USER_A), finding({ kind: 'person' }), OBSERVED_AT);
    expect(signal.proposedMemoryLayer).toBe('client-people');
  });

  it('proposes client-steering for every non-person finding kind', () => {
    for (const kind of ['profile_field', 'government_identity', 'facility', 'capability', 'lda_identity']) {
      const signal = buildCrmFillFindingAcceptedSignal(ctxFor(USER_A), finding({ kind }), OBSERVED_AT);
      expect(signal.proposedMemoryLayer).toBe('client-steering');
    }
  });

  it('evidence points only at the finding and run rows — never the proposed value body', () => {
    const signal = buildCrmFillFindingAcceptedSignal(ctxFor(USER_A), finding(), OBSERVED_AT);
    expect(signal.evidenceRefs).toEqual([
      { type: 'client_profile_fill_finding', id: 'finding-1' },
      { type: 'client_profile_fill_run', id: 'run-1' },
    ]);
  });

  it('does not assign a sourceAuthority in 27A (scoring is a later-phase task)', () => {
    const signal = buildCrmFillFindingAcceptedSignal(ctxFor(USER_A), finding(), OBSERVED_AT);
    expect(signal.sourceAuthority).toBeNull();
  });

  it('carries human_explicit provenance — an admin explicitly decided this', () => {
    const signal = buildCrmFillFindingAcceptedSignal(ctxFor(USER_A), finding(), OBSERVED_AT);
    expect(signal.provenanceKind).toBe('human_explicit');
  });

  it('passes through a finite confidence and nulls out a non-finite one', () => {
    const finite = buildCrmFillFindingAcceptedSignal(ctxFor(USER_A), finding({ confidence: 0.5 }), OBSERVED_AT);
    expect(finite.confidence).toBe(0.5);
    const nonFinite = buildCrmFillFindingAcceptedSignal(ctxFor(USER_A), finding({ confidence: Number.NaN }), OBSERVED_AT);
    expect(nonFinite.confidence).toBeNull();
  });
});
