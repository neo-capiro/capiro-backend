import { describe, expect, it } from '@jest/globals';
import {
  InvalidMemoryTransitionError,
  RECALLABLE_GOVERNED_STATUSES,
  TERMINAL_GOVERNED_STATUSES,
  assertMemoryTransition,
  classifyLegacyMemory,
  filterGovernedMemory,
  fourEyesSatisfied,
  governedMemoryLifecycleEnabled,
  governedRecallEligible,
  governedRecallEligibilitySql,
  governedRecallSuppressionSql,
  instructionsAllowedFor,
  scoreGovernedMemory,
  sourceCanAnchorCandidate,
  type GovernedMemoryRecord,
} from './governance.js';

const base = (over: Partial<GovernedMemoryRecord> = {}): GovernedMemoryRecord => ({
  id: 'memory-1',
  tenantId: 'tenant-1',
  ownerUserId: null,
  clientId: null,
  memoryClass: 'institutional_authoritative',
  authority: 'firm_approved',
  scope: 'firm',
  status: 'active',
  sourceType: 'firm_playbook',
  sourceId: 'source-1',
  assertedByUserId: 'author-1',
  approvedByUserId: 'approver-1',
  approvedAt: '2026-07-20T00:00:00.000Z',
  conflictStatus: 'none',
  sensitivity: 'normal',
  ...over,
});

describe('memory lifecycle', () => {
  it('allows only the documented transition matrix', () => {
    expect(() => assertMemoryTransition('suggested', 'pending_review')).not.toThrow();
    expect(() => assertMemoryTransition('pending_review', 'active')).not.toThrow();
    expect(() => assertMemoryTransition('active', 'conflicted')).not.toThrow();
    expect(() => assertMemoryTransition('conflicted', 'superseded')).not.toThrow();
  });

  it('fails closed for invalid or terminal transitions', () => {
    expect(() => assertMemoryTransition('suggested', 'active')).toThrow(
      InvalidMemoryTransitionError,
    );
    expect(() => assertMemoryTransition('revoked', 'active')).toThrow(
      'Invalid memory transition: revoked -> active',
    );
    expect(() => assertMemoryTransition('superseded', 'revoked')).toThrow();
  });
});

describe('class-specific recall filters', () => {
  const access = {
    tenantId: 'tenant-1',
    userId: 'user-1',
    clientId: 'client-a',
    ethicalWallAllowed: true,
    allowedSensitivities: ['normal'] as const,
    now: new Date('2026-07-28T00:00:00.000Z'),
  };

  it('rejects wrong tenant, owner, and client before scoring', () => {
    expect(filterGovernedMemory(base({ tenantId: 'tenant-2' }), access)).toEqual({
      include: false,
      reason: 'wrong_tenant',
    });
    expect(
      filterGovernedMemory(
        base({
          scope: 'user_private',
          memoryClass: 'user_preference',
          authority: 'user_asserted',
          ownerUserId: 'other',
        }),
        access,
      ),
    ).toEqual({ include: false, reason: 'wrong_user' });
    expect(
      filterGovernedMemory(
        base({
          scope: 'client',
          clientId: 'client-b',
          memoryClass: 'client_steering',
          authority: 'client_approved',
        }),
        access,
      ),
    ).toEqual({ include: false, reason: 'wrong_client' });
  });

  it('enforces ethical walls even for otherwise matching client memory', () => {
    expect(
      filterGovernedMemory(
        base({
          scope: 'client',
          clientId: 'client-a',
          memoryClass: 'client_steering',
          authority: 'client_approved',
        }),
        { ...access, ethicalWallAllowed: false },
      ),
    ).toEqual({ include: false, reason: 'ethical_wall' });
  });

  it('suppresses every non-recallable governed status and invalid memories', () => {
    for (const status of [
      'suggested',
      'pending_review',
      'revoked',
      'superseded',
      'rejected',
      'expired',
    ] as const) {
      expect(filterGovernedMemory(base({ status }), access)).toEqual({
        include: false,
        reason: 'inactive_status',
      });
    }
    expect(filterGovernedMemory(base({ validUntil: '2026-07-27T00:00:00.000Z' }), access)).toEqual({
      include: false,
      reason: 'invalid_until',
    });
  });

  it('requires approval for firm/client classes and TTL for episodic memory', () => {
    expect(
      filterGovernedMemory(base({ approvedByUserId: null, approvedAt: null }), access),
    ).toEqual({ include: false, reason: 'unapproved' });
    expect(
      filterGovernedMemory(
        base({
          scope: 'user_private',
          ownerUserId: 'user-1',
          memoryClass: 'episodic_working',
          authority: 'user_asserted',
          approvedByUserId: null,
          approvedAt: null,
          sourceType: 'user_message',
          expiresAt: null,
          validUntil: null,
        }),
        access,
      ),
    ).toEqual({ include: false, reason: 'ttl_required' });
  });

  it('does not silently choose a side in an unresolved conflict', () => {
    expect(
      filterGovernedMemory(
        base({ conflictStatus: 'open', conflictGroupId: 'group-1', controllingItemId: null }),
        access,
      ),
    ).toEqual({ include: false, reason: 'conflict_unresolved' });
    expect(
      filterGovernedMemory(
        base({ conflictStatus: 'open', conflictGroupId: 'group-1', controllingItemId: 'memory-1' }),
        access,
      ),
    ).toEqual({ include: true });
    expect(
      filterGovernedMemory(
        base({
          status: 'conflicted',
          conflictStatus: 'open',
          conflictGroupId: 'group-1',
          controllingItemId: 'memory-1',
        }),
        access,
      ),
    ).toEqual({ include: true });
    expect(
      filterGovernedMemory(
        base({
          id: 'memory-2',
          status: 'conflicted',
          conflictStatus: 'open',
          conflictGroupId: 'group-1',
          controllingItemId: 'memory-1',
        }),
        access,
      ),
    ).toEqual({ include: false, reason: 'conflict_unresolved' });
  });

  it('defines one exact in-memory recallability predicate', () => {
    expect(RECALLABLE_GOVERNED_STATUSES).toEqual(['active', 'stale', 'conflicted']);
    expect(governedRecallEligible(base({ status: 'active' }))).toBe(true);
    expect(governedRecallEligible(base({ status: 'stale' }))).toBe(true);
    expect(governedRecallEligible(base({ status: 'pending_review' }))).toBe(false);
  });
});

describe('authority-aware ranking', () => {
  it('client-approved steering outranks a newer, perfect-similarity model inference', () => {
    const approved = scoreGovernedMemory({
      record: base({
        scope: 'client',
        clientId: 'client-a',
        memoryClass: 'client_steering',
        authority: 'client_approved',
        asOf: '2025-01-01T00:00:00.000Z',
      }),
      semanticSimilarity: 0.3,
      now: new Date('2026-07-28T00:00:00.000Z'),
    });
    const inference = scoreGovernedMemory({
      record: base({
        scope: 'user_private',
        ownerUserId: 'user-1',
        memoryClass: 'episodic_working',
        authority: 'model_inferred',
        approvedByUserId: null,
        approvedAt: null,
        asOf: '2026-07-28T00:00:00.000Z',
      }),
      semanticSimilarity: 1,
      now: new Date('2026-07-28T00:00:00.000Z'),
    });
    expect(approved.total).toBeGreaterThan(inference.total);
    expect(approved.priorityBand).toBeGreaterThan(inference.priorityBand);
  });

  it('firm doctrine outranks semantically similar episodic memory', () => {
    const firm = scoreGovernedMemory({ record: base(), semanticSimilarity: 0.2 });
    const episodic = scoreGovernedMemory({
      record: base({
        scope: 'user_private',
        ownerUserId: 'user-1',
        memoryClass: 'episodic_working',
        authority: 'user_asserted',
      }),
      semanticSimilarity: 0.99,
    });
    expect(firm.total).toBeGreaterThan(episodic.total);
  });

  it('explicit user selection has the highest priority band', () => {
    const selected = scoreGovernedMemory({
      record: base({
        explicitSelection: true,
        memoryClass: 'user_preference',
        authority: 'user_asserted',
      }),
      semanticSimilarity: 0,
    });
    const doctrine = scoreGovernedMemory({ record: base(), semanticSimilarity: 1 });
    expect(selected.total).toBeGreaterThan(doctrine.total);
    expect(selected.reason).toMatch(/Explicitly selected/);
  });
});

describe('approval, source and migration governance', () => {
  it('enforces optional four-eyes separation', () => {
    expect(fourEyesSatisfied(base(), false)).toBe(true);
    expect(fourEyesSatisfied(base(), true)).toBe(false);
    expect(
      fourEyesSatisfied(
        base({ secondApprovedByUserId: 'approver-2', secondApprovedAt: '2026-07-21' }),
        true,
      ),
    ).toBe(true);
    expect(
      fourEyesSatisfied(
        base({ secondApprovedByUserId: 'approver-1', secondApprovedAt: '2026-07-21' }),
        true,
      ),
    ).toBe(false);
  });

  it('never allows assistant prose or unknown source to self-anchor', () => {
    expect(sourceCanAnchorCandidate('user_message')).toBe(true);
    expect(sourceCanAnchorCandidate('approved_document_edit')).toBe(true);
    expect(sourceCanAnchorCandidate('unknown')).toBe(false);
    expect(sourceCanAnchorCandidate('legacy_projection')).toBe(false);
  });

  it('allows instructions only for an explicitly approved firm playbook record', () => {
    expect(instructionsAllowedFor(base({ instructionsAllowed: true }))).toBe(true);
    expect(
      instructionsAllowedFor(
        base({
          instructionsAllowed: true,
          memoryClass: 'client_steering',
          authority: 'client_approved',
          scope: 'client',
          clientId: 'client-a',
        }),
      ),
    ).toBe(false);
    expect(instructionsAllowedFor(base({ instructionsAllowed: false }))).toBe(false);
  });

  it('classifies legacy steering without inventing approval', () => {
    expect(classifyLegacyMemory({ type: 'firm-soul', provenance: 'human' })).toEqual(
      expect.objectContaining({
        memoryClass: 'institutional_authoritative',
        authority: 'user_asserted',
        status: 'pending_review',
      }),
    );
    expect(
      classifyLegacyMemory({ type: 'client-compass', clientId: 'client-a', provenance: 'human' }),
    ).toEqual(
      expect.objectContaining({
        memoryClass: 'client_steering',
        authority: 'user_asserted',
        status: 'pending_review',
      }),
    );
  });

  it('quarantines ambiguous rows instead of granting authority', () => {
    expect(classifyLegacyMemory({ type: 'note', scope: 'firm' })).toEqual(
      expect.objectContaining({
        memoryClass: 'legacy_unclassified',
        authority: 'legacy_unclassified',
        status: 'pending_review',
        confidence: 'ambiguous',
      }),
    );
  });
});

/**
 * Both of these gate live memory reads in TWO apps (apps/api and
 * apps/meriv2-orchestrator), against a column that only exists after
 * 20260729010000_memory_governance_context_v2 - which is unapplied everywhere.
 * Default-off is the load-bearing property.
 */
describe('governedMemoryLifecycleEnabled', () => {
  it('is off when unset or blank', () => {
    expect(governedMemoryLifecycleEnabled(undefined)).toBe(false);
    expect(governedMemoryLifecycleEnabled('')).toBe(false);
    expect(governedMemoryLifecycleEnabled('   ')).toBe(false);
  });

  it('arms only on an explicit enforce value', () => {
    expect(governedMemoryLifecycleEnabled('enforce')).toBe(true);
    expect(governedMemoryLifecycleEnabled(' ENFORCE ')).toBe(true);
  });

  it('fails safe on truthy-looking values', () => {
    for (const raw of ['on', 'true', '1', 'yes', 'enforced']) {
      expect(governedMemoryLifecycleEnabled(raw)).toBe(false);
    }
  });
});

describe('governedRecallSuppressionSql', () => {
  it('emits nothing at all when disabled', () => {
    expect(governedRecallSuppressionSql(false)).toBe('');
    expect(governedRecallSuppressionSql(false, 'mi')).toBe('');
  });

  it('admits active/stale and only the controlling unresolved conflict', () => {
    const sql = governedRecallSuppressionSql(true, 'mi');
    expect(sql).toContain("mi.governed_status IN ('active', 'stale')");
    expect(sql).toContain("mi.governed_status = 'conflicted'");
    expect(sql).toContain('mi.controlling_item_id = mi.id');
    expect(sql).toContain('mi.conflict_status');
    for (const status of TERMINAL_GOVERNED_STATUSES) {
      expect(sql).not.toContain(`'${status}'`);
    }
  });

  it('supports an unaliased FROM memory_items', () => {
    expect(governedRecallSuppressionSql(true)).toContain(
      "governed_status IN ('active', 'stale')",
    );
    expect(governedRecallEligibilitySql()).toContain('controlling_item_id = id');
  });

  it('refuses an alias that is not a bare identifier', () => {
    expect(() => governedRecallSuppressionSql(true, 'mi; DROP TABLE memory_items --')).toThrow(
      /unsafe alias/,
    );
    expect(() => governedRecallSuppressionSql(true, 'mi.client_id')).toThrow(/unsafe alias/);
    expect(() => governedRecallEligibilitySql('mi.client_id')).toThrow(/unsafe alias/);
  });
});
