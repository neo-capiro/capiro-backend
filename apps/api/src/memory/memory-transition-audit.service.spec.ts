import { describe, expect, it } from '@jest/globals';
import { InvalidMemoryTransitionError } from '@capiro/meriv2-core';
import { MemoryTransitionAuditService } from './memory-transition-audit.service.js';
import type { MemoryTransitionAuditInput } from './memory-transition-audit.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const CANDIDATE = '33333333-3333-4333-8333-333333333333';
const ACTOR = '44444444-4444-4444-8444-444444444444';

type AuditRow = Record<string, unknown>;

function harness() {
  const rows: AuditRow[] = [];
  const create = jest.fn(async (args: { data: AuditRow }) => {
    rows.push(args.data);
    return { id: 'audit-1' };
  });
  const tx = { memoryTransitionAudit: { create } } as never;
  return { service: new MemoryTransitionAuditService(), tx, create, rows };
}

const base = (over: Partial<MemoryTransitionAuditInput> = {}): MemoryTransitionAuditInput => ({
  subject: { memoryItemId: ITEM },
  actorUserId: ACTOR,
  fromStatus: 'active',
  toStatus: 'revoked',
  reasonCode: 'revoked',
  reason: 'forget verb',
  ...over,
});

describe('MemoryTransitionAuditService.record', () => {
  it('writes ids, statuses and a reason on the caller transaction', async () => {
    const h = harness();
    const id = await h.service.record(h.tx, TENANT, base());
    expect(id).toBe('audit-1');
    const data = h.rows[0]!;
    expect(data).toMatchObject({
      tenantId: TENANT,
      memoryItemId: ITEM,
      memoryCandidateId: null,
      actorUserId: ACTOR,
      fromStatus: 'active',
      toStatus: 'revoked',
      reasonCode: 'revoked',
      reason: 'forget verb',
    });
  });

  /**
   * effective_tenant_id is NOT NULL with no DB default. Defaulting it to the
   * scoping tenant is what stops an impersonation-unaware caller from taking the
   * whole write down on a null violation.
   */
  it('defaults effectiveTenantId to the scoping tenant', async () => {
    const h = harness();
    await h.service.record(h.tx, TENANT, base());
    expect(h.rows[0]!.effectiveTenantId).toBe(TENANT);
  });

  it('carries an explicit effective tenant through for an impersonated act', async () => {
    const h = harness();
    await h.service.record(h.tx, TENANT, base({ effectiveTenantId: CANDIDATE }));
    expect(h.rows[0]!.effectiveTenantId).toBe(CANDIDATE);
  });

  it('accepts a candidate subject', async () => {
    const h = harness();
    await h.service.record(h.tx, TENANT, {
      subject: { memoryCandidateId: CANDIDATE },
      fromStatus: 'pending_review',
      toStatus: 'active',
      reasonCode: 'approved',
    });
    const data = h.rows[0]!;
    expect(data.memoryCandidateId).toBe(CANDIDATE);
    expect(data.memoryItemId).toBeNull();
  });

  /**
   * memory_transition_exact_subject_check requires exactly one subject. Violating
   * it would abort the caller's transaction and roll back the state change the
   * audit row exists to evidence, so it is caught in code first.
   */
  it('refuses two subjects at once', async () => {
    const h = harness();
    await expect(
      h.service.record(h.tx, TENANT, {
        subject: { memoryItemId: ITEM, memoryCandidateId: CANDIDATE } as never,
        toStatus: 'revoked',
        reasonCode: 'revoked',
      }),
    ).rejects.toThrow(/exactly one/);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('refuses no subject at all', async () => {
    const h = harness();
    await expect(
      h.service.record(h.tx, TENANT, {
        subject: {} as never,
        toStatus: 'revoked',
        reasonCode: 'revoked',
      }),
    ).rejects.toThrow(/exactly one/);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('validates the hop against the state machine when a from status is given', async () => {
    const h = harness();
    await expect(
      h.service.record(h.tx, TENANT, base({ fromStatus: 'revoked', toStatus: 'active' })),
    ).rejects.toBeInstanceOf(InvalidMemoryTransitionError);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('skips the state-machine check for a creation event with no from status', async () => {
    const h = harness();
    await h.service.record(h.tx, TENANT, base({ fromStatus: null, toStatus: 'revoked' }));
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.rows[0]!.fromStatus).toBeNull();
  });

  /** No memory bodies in SOC 2 evidence, at the service boundary as well as the helper. */
  it('strips content-bearing metadata before it reaches the row', async () => {
    const h = harness();
    await h.service.record(
      h.tx,
      TENANT,
      base({ metadata: { value: 'The firm supports the plus-up.', verb: 'forget' } }),
    );
    expect(h.rows[0]!.metadata).toEqual({ verb: 'forget' });
  });

  it('falls back to the reason code when no reason is supplied', async () => {
    const h = harness();
    await h.service.record(h.tx, TENANT, base({ reason: null, reasonCode: 'conflict_resolved' }));
    expect(h.rows[0]!.reason).toBe('conflict_resolved');
  });

  it('records a multi-hop path in order', async () => {
    const h = harness();
    const ids = await h.service.recordAll(h.tx, TENANT, [
      {
        subject: { memoryCandidateId: CANDIDATE },
        fromStatus: 'suggested',
        toStatus: 'pending_review',
        reasonCode: 'submitted_for_review',
      },
      {
        subject: { memoryCandidateId: CANDIDATE },
        fromStatus: 'pending_review',
        toStatus: 'active',
        reasonCode: 'approved',
      },
    ]);
    expect(ids).toHaveLength(2);
    expect(h.rows.map((r) => r.toStatus)).toEqual(['pending_review', 'active']);
  });
});
