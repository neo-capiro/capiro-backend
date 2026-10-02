import type { PrismaService } from '../prisma/prisma.service.js';
import {
  currentMeriCase01FixtureAuthority,
  registerMeriCase01FixtureAuthority,
} from './meri-case01-fixture-authority-registry.js';

describe('canonical case01 fixture authority registry', () => {
  const prisma = () => ({}) as PrismaService;
  const owner = () => ({ qualifyInTx: jest.fn(async () => ({ fixtureReady: false })) });

  it('keeps authority bound to the exact server Prisma instance', () => {
    const first = prisma();
    const second = prisma();
    const authority = owner();
    const dispose = registerMeriCase01FixtureAuthority(first, authority);
    expect(currentMeriCase01FixtureAuthority(first)).toBe(authority);
    expect(currentMeriCase01FixtureAuthority(second)).toBeUndefined();
    expect(authority.qualifyInTx).not.toHaveBeenCalled();
    dispose();
    expect(currentMeriCase01FixtureAuthority(first)).toBeUndefined();
  });

  it('refuses replacing an active owner and rejects serialized ready claims', () => {
    const key = prisma();
    const authority = owner();
    const dispose = registerMeriCase01FixtureAuthority(key, authority);
    expect(() => registerMeriCase01FixtureAuthority(key, owner())).toThrow(
      'meri_case01_fixture_owner_registration_invalid',
    );
    expect(currentMeriCase01FixtureAuthority(key)).toBe(authority);
    dispose();
    expect(() => registerMeriCase01FixtureAuthority(key, { fixtureReady: true } as never)).toThrow(
      'meri_case01_fixture_owner_registration_invalid',
    );
    expect(currentMeriCase01FixtureAuthority(key)).toBeUndefined();
  });

  it('does not let an old disposer revoke a newly registered owner', () => {
    const key = prisma();
    const oldDisposer = registerMeriCase01FixtureAuthority(key, owner());
    oldDisposer();
    const replacement = owner();
    const dispose = registerMeriCase01FixtureAuthority(key, replacement);
    oldDisposer();
    expect(currentMeriCase01FixtureAuthority(key)).toBe(replacement);
    dispose();
  });
});
