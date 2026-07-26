import { AUTH_DENIED_REASONS, authDeniedEvent } from '@capiro/shared';

// Lives here rather than in packages/shared, which has no test runner at all.
// meriv2-orchestrator both depends on @capiro/shared AND is one of the four
// packages CI actually runs tests for (ci-pr.yml:113), so putting it here means
// the reason vocabulary is gated on every PR instead of only locally.

/**
 * These reason codes are the dimension a SOC 2 auditor filters on, and the
 * CloudWatch metric filter keys off the event shape. Both are load-bearing:
 * renaming a reason silently breaks historical queries, and changing the shape
 * silently stops the metric incrementing. Pin them.
 */
describe('authDeniedEvent', () => {
  it('emits a single line of parseable JSON', () => {
    const line = authDeniedEvent({ reason: 'no_active_membership' });
    expect(line).not.toContain('\n');
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it('matches the shape the metric filter expects', () => {
    // Filter pattern: { $.security_event = "auth.denied" }, metricValue $.count
    const evt = JSON.parse(authDeniedEvent({ reason: 'org_claim_mismatch' })) as Record<
      string,
      unknown
    >;
    expect(evt.security_event).toBe('auth.denied');
    expect(evt.count).toBe(1);
  });

  it('carries the resolved and claimed tenant separately', () => {
    const evt = JSON.parse(
      authDeniedEvent({
        reason: 'tenant_claim_mismatch',
        tenantId: 'resolved-uuid',
        claimedTenantId: 'claimed-uuid',
        clerkUserId: 'user_1',
      }),
    ) as Record<string, unknown>;
    expect(evt.tenant_id).toBe('resolved-uuid');
    expect(evt.claimed_tenant_id).toBe('claimed-uuid');
    expect(evt.clerk_user_id).toBe('user_1');
  });

  it('defaults surface to http and nulls absent fields', () => {
    const evt = JSON.parse(authDeniedEvent({ reason: 'no_matching_tenant' })) as Record<
      string,
      unknown
    >;
    expect(evt.surface).toBe('http');
    expect(evt.tenant_id).toBeNull();
    expect(evt.claimed_tenant_id).toBeNull();
    expect(evt.clerk_user_id).toBeNull();
  });

  it('carries no token, email or other PII', () => {
    const line = authDeniedEvent({
      reason: 'slug_claim_mismatch',
      tenantId: 't',
      claimedTenantId: 'c',
      clerkUserId: 'u',
    });
    for (const forbidden of ['token', 'authorization', 'bearer', 'email', 'password']) {
      expect(line.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('pins the full reason vocabulary — add, never rename', () => {
    expect([...AUTH_DENIED_REASONS]).toEqual([
      'no_active_membership',
      'no_matching_tenant',
      'tenant_claim_mismatch',
      'org_claim_mismatch',
      'slug_claim_mismatch',
      'host_mismatch',
      'unauthorized_party',
      'ws_ticket_invalid',
      'missing_delegation',
    ]);
  });

  it.each([...AUTH_DENIED_REASONS])('round-trips the reason %s', (reason) => {
    const evt = JSON.parse(authDeniedEvent({ reason })) as Record<string, unknown>;
    expect(evt.reason).toBe(reason);
  });
});
