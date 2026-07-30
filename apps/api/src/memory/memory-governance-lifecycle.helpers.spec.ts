import { describe, expect, it } from '@jest/globals';
import { InvalidMemoryTransitionError } from '@capiro/meriv2-core';
import {
  AUDIT_METADATA_MAX_BYTES,
  candidateTransitionPath,
  classifyCandidateForGovernance,
  governedMemoryLifecycleEnabled,
  governedScopeForLegacyScope,
  governedStatusForDecision,
  normalizeAuditReason,
  normalizeGrantPermissions,
  sanitizeAuditMetadata,
} from './memory-governance-lifecycle.helpers.js';

/**
 * The switch that arms every governed write in this module. Both migrations that
 * create the columns it touches are UNAPPLIED in every environment, so an
 * armed-by-default parser would fail every memory save on a missing column.
 */
describe('governedMemoryLifecycleEnabled', () => {
  it('is off when unset', () => {
    expect(governedMemoryLifecycleEnabled(undefined)).toBe(false);
    expect(governedMemoryLifecycleEnabled('')).toBe(false);
    expect(governedMemoryLifecycleEnabled('   ')).toBe(false);
  });

  it('arms only on an explicit enforce value', () => {
    expect(governedMemoryLifecycleEnabled('enforce')).toBe(true);
    expect(governedMemoryLifecycleEnabled(' ENFORCE ')).toBe(true);
  });

  it('fails safe on truthy-looking values', () => {
    for (const raw of ['on', 'true', '1', 'yes', 'enforced', 'enforce-all']) {
      expect(governedMemoryLifecycleEnabled(raw)).toBe(false);
    }
  });
});

describe('governedScopeForLegacyScope', () => {
  it('maps the legacy vocabulary exactly as the migration backfill does', () => {
    expect(governedScopeForLegacyScope('personal')).toBe('user_private');
    expect(governedScopeForLegacyScope('client')).toBe('client');
    expect(governedScopeForLegacyScope('firm')).toBe('firm');
  });

  it('defaults an unknown or absent scope to firm, matching the column default', () => {
    expect(governedScopeForLegacyScope(null)).toBe('firm');
    expect(governedScopeForLegacyScope('nonsense')).toBe('firm');
  });
});

describe('classifyCandidateForGovernance', () => {
  it('classifies firm scope as institutional authority on approval', () => {
    expect(classifyCandidateForGovernance({ scope: 'firm' }, 'approved')).toEqual({
      memoryClass: 'institutional_authoritative',
      memoryScope: 'firm',
      memoryAuthority: 'firm_approved',
    });
  });

  it('classifies client scope as client steering on approval', () => {
    expect(classifyCandidateForGovernance({ scope: 'client' }, 'approved')).toEqual({
      memoryClass: 'client_steering',
      memoryScope: 'client',
      memoryAuthority: 'client_approved',
    });
  });

  it('grants NO authority to a rejected proposal at any scope', () => {
    for (const scope of ['firm', 'client', 'personal'] as const) {
      expect(classifyCandidateForGovernance({ scope }, 'rejected').memoryAuthority).toBeNull();
    }
  });

  it('keeps defensive machine activation inferred and promotes only reviewed extraction', () => {
    const input = { scope: 'firm', sourceKind: 'model_extraction' } as const;
    expect(classifyCandidateForGovernance(input, 'auto_committed').memoryAuthority).toBe(
      'model_inferred',
    );
    expect(classifyCandidateForGovernance(input, 'approved')).toMatchObject({
      memoryAuthority: 'analyst_verified',
      memoryClass: 'institutional_authoritative',
    });
  });

  /**
   * memory_candidate_ephemeral_ttl_check / memory_items_ephemeral_ttl_check REJECT
   * episodic_working without expires_at or valid_until. Choosing that class for a
   * TTL-less save would be a constraint violation on the approval path, not a
   * cosmetic mislabel.
   */
  it('only chooses episodic_working when a TTL exists', () => {
    expect(classifyCandidateForGovernance({ scope: 'personal' }, 'approved').memoryClass).toBe(
      'user_preference',
    );
    expect(
      classifyCandidateForGovernance({ scope: 'personal', hasTtl: true }, 'approved').memoryClass,
    ).toBe('episodic_working');
  });
});

describe('governedStatusForDecision', () => {
  it('lands committing decisions on active and rejections on rejected', () => {
    expect(governedStatusForDecision('approved')).toBe('active');
    expect(governedStatusForDecision('auto_committed')).toBe('active');
    expect(governedStatusForDecision('rejected')).toBe('rejected');
  });
});

describe('candidateTransitionPath', () => {
  /**
   * TRANSITIONS in meriv2-core has NO suggested → active edge, but a brand-new
   * candidate row is created at the column default 'suggested' and an auto-commit
   * reaches active in one service call. The honest recording is two legal hops.
   */
  it('routes a fresh suggested candidate through pending_review to active', () => {
    expect(candidateTransitionPath('suggested', 'auto_committed')).toEqual([
      { from: 'suggested', to: 'pending_review', reasonCode: 'submitted_for_review' },
      { from: 'pending_review', to: 'active', reasonCode: 'approved' },
    ]);
  });

  it('approves a queued candidate in one hop', () => {
    expect(candidateTransitionPath('pending_review', 'approved')).toEqual([
      { from: 'pending_review', to: 'active', reasonCode: 'approved' },
    ]);
  });

  it('rejects from either pre-decision state in one hop', () => {
    expect(candidateTransitionPath('suggested', 'rejected')).toEqual([
      { from: 'suggested', to: 'rejected', reasonCode: 'rejected' },
    ]);
    expect(candidateTransitionPath('pending_review', 'rejected')).toEqual([
      { from: 'pending_review', to: 'rejected', reasonCode: 'rejected' },
    ]);
  });

  it('is a no-op when the candidate is already in the target state', () => {
    expect(candidateTransitionPath('active', 'approved')).toEqual([]);
    expect(candidateTransitionPath('rejected', 'rejected')).toEqual([]);
  });

  it('refuses to resurrect terminal state instead of silently rewriting it', () => {
    expect(() => candidateTransitionPath('rejected', 'approved')).toThrow(
      InvalidMemoryTransitionError,
    );
    expect(() => candidateTransitionPath('superseded', 'approved')).toThrow(
      InvalidMemoryTransitionError,
    );
  });
});

describe('sanitizeAuditMetadata', () => {
  it('keeps ids and scalars', () => {
    expect(
      sanitizeAuditMetadata({
        memoryItemId: 'abc',
        attempts: 3,
        machine: false,
        priorGovernedStatus: null,
      }),
    ).toEqual({ memoryItemId: 'abc', attempts: 3, machine: false, priorGovernedStatus: null });
  });

  /** memory_transition_audit is documented as ids/status/reason ONLY, never bodies. */
  it('drops content-bearing keys outright', () => {
    const out = sanitizeAuditMetadata({
      value: 'The firm supports the plus-up.',
      body: 'secret',
      sections: 'secret',
      sourceExcerpt: 'secret',
      title: 'secret',
      payload: 'secret',
      keep: 'ok',
    });
    expect(out).toEqual({ keep: 'ok' });
  });

  it('drops nesting so a body cannot hide one level down', () => {
    expect(sanitizeAuditMetadata({ nested: { value: 'secret' }, list: ['secret'], ok: 1 })).toEqual(
      {
        ok: 1,
      },
    );
  });

  it('caps individual strings', () => {
    const out = sanitizeAuditMetadata({ reasonEcho: 'x'.repeat(5_000) });
    expect((out.reasonEcho as string).length).toBe(256);
  });

  /** A violated CHECK would abort the caller's tx and roll back the state change. */
  it('stays under the 32 KiB metadata CHECK even for absurd input', () => {
    const input: Record<string, unknown> = {};
    for (let i = 0; i < 400; i += 1) input[`k${i}`] = 'y'.repeat(250);
    const out = sanitizeAuditMetadata(input);
    expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThanOrEqual(
      AUDIT_METADATA_MAX_BYTES,
    );
  });

  it('returns an empty object for absent input', () => {
    expect(sanitizeAuditMetadata(null)).toEqual({});
    expect(sanitizeAuditMetadata(undefined)).toEqual({});
  });
});

describe('normalizeAuditReason', () => {
  it('collapses whitespace and falls back to the reason code', () => {
    expect(normalizeAuditReason('  approved   by   review \n', 'approved')).toBe(
      'approved by review',
    );
    expect(normalizeAuditReason('', 'approved')).toBe('approved');
    expect(normalizeAuditReason(null, 'revoked')).toBe('revoked');
  });

  it('caps the reason so it cannot become a body', () => {
    expect(normalizeAuditReason('z'.repeat(2_000), 'approved').length).toBe(500);
  });
});

describe('normalizeGrantPermissions', () => {
  it('accepts the documented vocabulary, de-duplicated and canonically ordered', () => {
    expect(normalizeGrantPermissions(['approve', 'edit', 'approve'])).toEqual(['approve', 'edit']);
  });

  /**
   * memory_access_grant_permissions_check would reject these at the DB, but a CHECK
   * violation surfaces as an opaque 500 — so the vocabulary is validated in code.
   */
  it('rejects anything outside MEMORY_PERMISSIONS', () => {
    expect(normalizeGrantPermissions(['delete'])).toBeNull();
    expect(normalizeGrantPermissions(['approve', 'admin'])).toBeNull();
    expect(normalizeGrantPermissions([42])).toBeNull();
  });

  it('rejects an empty or non-array grant', () => {
    expect(normalizeGrantPermissions([])).toBeNull();
    expect(normalizeGrantPermissions('approve')).toBeNull();
    expect(normalizeGrantPermissions(null)).toBeNull();
  });
});
