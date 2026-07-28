import type { TenantContext } from '@capiro/shared';
import { evaluateMemoryMutation } from './memory-mutation-auth.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ctx = (role: TenantContext['role'], userId = USER) => ({ role, userId }) as TenantContext;

describe('evaluateMemoryMutation', () => {
  it.each([
    ['canonical user item', { visibility: 'user', ownerUserId: USER }],
    ['legacy user-private row', { scope: 'user_private', ownerUserId: USER }],
  ])('allows the owner to mutate %s', (_label, subject) => {
    expect(evaluateMemoryMutation(ctx('standard_user'), subject)).toEqual({
      allowed: true,
      kind: 'private',
    });
  });

  it.each([
    ['canonical user item', { visibility: 'user', ownerUserId: OTHER }],
    ['legacy user-private row', { scope: 'user_private', ownerUserId: OTHER }],
  ])('does not allow another user to mutate %s', (_label, subject) => {
    expect(evaluateMemoryMutation(ctx('standard_user'), subject)).toEqual({
      allowed: false,
      reason: 'unauthorized',
    });
  });

  it.each([
    ['firm canonical item', { visibility: 'tenant', ownerUserId: null, clientId: null }],
    ['client canonical item', { visibility: 'tenant', ownerUserId: null, clientId: OTHER }],
    ['legacy firm row', { scope: 'firm', ownerUserId: null, clientId: null }],
    ['legacy client row', { scope: 'client', ownerUserId: null, clientId: OTHER }],
  ])('denies a standard user mutation of %s even though it may be readable', (_label, subject) => {
    expect(evaluateMemoryMutation(ctx('standard_user'), subject)).toEqual({
      allowed: false,
      reason: 'unauthorized',
    });
  });

  it.each(['user_admin', 'capiro_admin'] as const)(
    'allows %s to mutate firm and client shared memory',
    (role) => {
      for (const subject of [
        { visibility: 'tenant', clientId: null },
        { visibility: 'tenant', clientId: OTHER },
        { scope: 'firm', clientId: null },
        { scope: 'client', clientId: OTHER },
      ]) {
        expect(evaluateMemoryMutation(ctx(role), subject)).toEqual({
          allowed: true,
          kind: 'shared',
        });
      }
    },
  );

  it('continues to block every caller when the row is revoked', () => {
    expect(
      evaluateMemoryMutation(ctx('capiro_admin'), {
        visibility: 'tenant',
        status: 'revoked',
      }),
    ).toEqual({ allowed: false, reason: 'revoked' });
  });

  it.each(['standard_user', 'user_admin', 'capiro_admin'] as const)(
    'legal hold overrides correction and deletion for %s',
    (role) => {
      const subject =
        role === 'standard_user'
          ? { visibility: 'user', ownerUserId: USER, legalHold: true }
          : { visibility: 'tenant', ownerUserId: null, legalHold: true };
      for (const operation of ['correct', 'forget'] as const) {
        expect(evaluateMemoryMutation(ctx(role), subject, operation)).toEqual({
          allowed: false,
          reason: 'legal_hold',
        });
      }
      expect(evaluateMemoryMutation(ctx(role), subject, 'confirm').allowed).toBe(true);
    },
  );

  it('fails closed on an unknown scope', () => {
    expect(evaluateMemoryMutation(ctx('capiro_admin'), {})).toEqual({
      allowed: false,
      reason: 'unknown_scope',
    });
  });
});
