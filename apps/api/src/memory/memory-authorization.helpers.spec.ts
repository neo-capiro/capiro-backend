import { describe, expect, it } from '@jest/globals';
import {
  evaluateGovernedMemoryAuthorization,
  governedMemoryEnforcementEnabled,
  type MemoryAuthorizationFacts,
} from './memory-authorization.helpers.js';

const facts = (over: Partial<MemoryAuthorizationFacts> = {}): MemoryAuthorizationFacts => ({
  userId: 'user-1',
  role: 'standard_user',
  operation: 'read',
  subject: {
    memoryClass: 'client_steering',
    scope: 'client',
    clientId: 'client-a',
    status: 'active',
  },
  ethicalWallAllowed: true,
  clientStatus: 'active',
  grantPermissions: [],
  ...over,
});

describe('governedMemoryEnforcementEnabled', () => {
  it('is off when unset', () => {
    expect(governedMemoryEnforcementEnabled(undefined)).toBe(false);
    expect(governedMemoryEnforcementEnabled('')).toBe(false);
    expect(governedMemoryEnforcementEnabled('   ')).toBe(false);
  });

  it('arms only on an explicit enforce value', () => {
    expect(governedMemoryEnforcementEnabled('enforce')).toBe(true);
    expect(governedMemoryEnforcementEnabled(' ENFORCE ')).toBe(true);
  });

  it('fails safe on truthy-looking values', () => {
    for (const raw of ['on', 'true', '1', 'yes', 'enforced']) {
      expect(governedMemoryEnforcementEnabled(raw)).toBe(false);
    }
  });
});

describe('evaluateGovernedMemoryAuthorization', () => {
  it('limits user-private memory to its owner', () => {
    expect(
      evaluateGovernedMemoryAuthorization(
        facts({
          operation: 'edit',
          subject: {
            memoryClass: 'user_preference',
            scope: 'user_private',
            ownerUserId: 'user-1',
            status: 'active',
          },
        }),
      ),
    ).toEqual({ allowed: true, basis: 'owner' });
    expect(
      evaluateGovernedMemoryAuthorization(
        facts({
          operation: 'read',
          subject: {
            memoryClass: 'user_preference',
            scope: 'user_private',
            ownerUserId: 'other-user',
            status: 'active',
          },
        }),
      ),
    ).toEqual({ allowed: false, reason: 'not_owner' });
  });

  it('requires explicit client edit permission for standard users', () => {
    expect(evaluateGovernedMemoryAuthorization(facts({ operation: 'edit' }))).toEqual({
      allowed: false,
      reason: 'missing_grant',
    });
    expect(
      evaluateGovernedMemoryAuthorization(facts({ operation: 'edit', grantPermissions: ['edit'] })),
    ).toEqual({ allowed: true, basis: 'explicit_grant' });
  });

  it('does not treat an ethical-wall read grant as an edit grant', () => {
    expect(
      evaluateGovernedMemoryAuthorization(
        facts({ operation: 'approve', ethicalWallAllowed: true, grantPermissions: [] }),
      ),
    ).toEqual({ allowed: false, reason: 'missing_grant' });
  });

  it('binds admins to ethical walls and archived-client write denial', () => {
    expect(
      evaluateGovernedMemoryAuthorization(
        facts({ role: 'user_admin', operation: 'edit', ethicalWallAllowed: false }),
      ),
    ).toEqual({ allowed: false, reason: 'ethical_wall' });
    expect(
      evaluateGovernedMemoryAuthorization(
        facts({ role: 'user_admin', operation: 'edit', clientStatus: 'archived' }),
      ),
    ).toEqual({ allowed: false, reason: 'archived_client' });
  });

  it('allows an admin to maintain an active unwalled client after the wall decision passes', () => {
    expect(
      evaluateGovernedMemoryAuthorization(facts({ role: 'user_admin', operation: 'approve' })),
    ).toEqual({ allowed: true, basis: 'admin' });
  });

  it('keeps firm mutation admin-only while tenant reads remain available', () => {
    const subject = {
      memoryClass: 'institutional_authoritative' as const,
      scope: 'firm' as const,
      status: 'active' as const,
    };
    expect(evaluateGovernedMemoryAuthorization(facts({ subject, operation: 'read' }))).toEqual({
      allowed: true,
      basis: 'tenant_read',
    });
    expect(evaluateGovernedMemoryAuthorization(facts({ subject, operation: 'edit' }))).toEqual({
      allowed: false,
      reason: 'admin_required',
    });
    expect(
      evaluateGovernedMemoryAuthorization(
        facts({ subject, operation: 'edit', role: 'user_admin' }),
      ),
    ).toEqual({ allowed: true, basis: 'admin' });
  });

  it('preserves legal hold against edit/revoke and records non-destructive confirmation as allowable', () => {
    const subject = {
      memoryClass: 'institutional_authoritative' as const,
      scope: 'firm' as const,
      status: 'active' as const,
      legalHold: true,
    };
    expect(
      evaluateGovernedMemoryAuthorization(
        facts({ subject, role: 'user_admin', operation: 'revoke' }),
      ),
    ).toEqual({ allowed: false, reason: 'legal_hold' });
    expect(
      evaluateGovernedMemoryAuthorization(
        facts({ subject, role: 'user_admin', operation: 'confirm' }),
      ),
    ).toEqual({ allowed: true, basis: 'admin' });
  });

  it('uses the real actor role under impersonation', () => {
    expect(
      evaluateGovernedMemoryAuthorization(
        facts({
          operation: 'edit',
          role: 'user_admin',
          impersonating: true,
          actorRole: 'standard_user',
        }),
      ),
    ).toEqual({ allowed: false, reason: 'missing_grant' });
  });

  it('denies mutation of terminal memory even with a grant', () => {
    expect(
      evaluateGovernedMemoryAuthorization(
        facts({
          operation: 'edit',
          grantPermissions: ['edit'],
          subject: {
            memoryClass: 'client_steering',
            scope: 'client',
            clientId: 'client-a',
            status: 'revoked',
          },
        }),
      ),
    ).toEqual({ allowed: false, reason: 'revoked_or_terminal' });
  });

  it('allows an admin proposer to approve their own shared candidate', () => {
    for (const subject of [
      {
        memoryClass: 'client_steering' as const,
        scope: 'client' as const,
        clientId: 'client-a',
        status: 'pending_review' as const,
        proposedByUserId: 'user-1',
      },
      {
        memoryClass: 'institutional_authoritative' as const,
        scope: 'firm' as const,
        status: 'pending_review' as const,
        proposedByUserId: 'user-1',
      },
    ]) {
      expect(
        evaluateGovernedMemoryAuthorization(
          facts({ role: 'user_admin', operation: 'approve', subject }),
        ),
      ).toEqual({ allowed: true, basis: 'admin' });
      expect(
        evaluateGovernedMemoryAuthorization(
          facts({ role: 'capiro_admin', operation: 'review', subject }),
        ),
      ).toEqual({ allowed: true, basis: 'admin' });
    }
  });

  it('still denies standard-user self-review on shared memory', () => {
    const subject = {
      memoryClass: 'client_steering' as const,
      scope: 'client' as const,
      clientId: 'client-a',
      status: 'pending_review' as const,
      proposedByUserId: 'user-1',
    };
    expect(
      evaluateGovernedMemoryAuthorization(
        facts({ operation: 'approve', grantPermissions: ['approve'], subject }),
      ),
    ).toEqual({ allowed: false, reason: 'self_review' });
    expect(
      evaluateGovernedMemoryAuthorization(
        facts({ operation: 'review', grantPermissions: ['review'], subject }),
      ),
    ).toEqual({ allowed: false, reason: 'self_review' });
  });

  it('allows a different admin reviewer to approve the same firm candidate', () => {
    expect(
      evaluateGovernedMemoryAuthorization(
        facts({
          userId: 'reviewer-2',
          role: 'user_admin',
          operation: 'approve',
          subject: {
            memoryClass: 'institutional_authoritative',
            scope: 'firm',
            status: 'pending_review',
            proposedByUserId: 'user-1',
          },
        }),
      ),
    ).toEqual({ allowed: true, basis: 'admin' });
  });

  it('allows a grant-holding reviewer who did not propose the client change', () => {
    expect(
      evaluateGovernedMemoryAuthorization(
        facts({
          operation: 'approve',
          grantPermissions: ['approve'],
          subject: {
            memoryClass: 'client_steering',
            scope: 'client',
            clientId: 'client-a',
            status: 'pending_review',
            proposedByUserId: 'someone-else',
          },
        }),
      ),
    ).toEqual({ allowed: true, basis: 'explicit_grant' });
  });

  it('still lets an owner approve their own user-private memory', () => {
    expect(
      evaluateGovernedMemoryAuthorization(
        facts({
          operation: 'approve',
          subject: {
            memoryClass: 'user_preference',
            scope: 'user_private',
            ownerUserId: 'user-1',
            proposedByUserId: 'user-1',
            status: 'pending_review',
          },
        }),
      ),
    ).toEqual({ allowed: true, basis: 'owner' });
  });

  it('leaves item subjects with no proposer unaffected', () => {
    expect(
      evaluateGovernedMemoryAuthorization(
        facts({
          role: 'user_admin',
          operation: 'approve',
          subject: {
            memoryClass: 'institutional_authoritative',
            scope: 'firm',
            status: 'active',
          },
        }),
      ),
    ).toEqual({ allowed: true, basis: 'admin' });
  });
});
