import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import {
  MERI_PROSPECT_SCOPE_METADATA_KEY,
  MeriProspectScopeConflictError,
} from '../business-development/bizdev-meri-scope.service.js';
import {
  authorizeMeriProspectScope,
  prospectScopeDirective,
  prospectTurnScopeReceipt,
} from './meri-prospect-scope.helpers.js';

/**
 * Phase 4 dispatch slice — focused coverage for the shared prospect-scope
 * dispatch helpers: the key-presence fail-closed matrix, unscoped
 * conversations passing unchanged, the bounded server-authored directive,
 * and the turn-scope receipt shape.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ctx = { tenantId: TENANT, userId: USER } as unknown as TenantContext;

const validScope = () => ({
  prospectId: randomUUID(),
  prospectName: 'Acme LLC',
  canonicalOrganizationId: randomUUID(),
  linkedClientId: null,
  scopeVersion: 'a'.repeat(64),
});

const scopeService = (resolve: (id: string) => Promise<unknown>) =>
  ({
    assertCurrent: jest.fn(async (_ctx: unknown, persisted: unknown) => {
      // Mirror the contract: a parseable scope re-resolves; anything else is
      // the typed conflict. The tests below only need the "usable scope"
      // branch to prove pass-through; the malformed matrix exercises the
      // helper's own fail-closed guard, which must fire BEFORE assertCurrent.
      const record = persisted as Record<string, unknown>;
      const raw = record?.[MERI_PROSPECT_SCOPE_METADATA_KEY];
      if (!raw || typeof raw !== 'object') throw new MeriProspectScopeConflictError('not_found');
      return resolve((raw as { prospectId: string }).prospectId);
    }),
  }) as never;

describe('authorizeMeriProspectScope — key-presence fail-closed matrix', () => {
  test('absent key (ordinary conversation) → null, no assertion, unchanged', async () => {
    const svc = scopeService(async () => validScope());
    await expect(
      authorizeMeriProspectScope(svc, ctx, null),
    ).resolves.toBeNull();
    await expect(
      authorizeMeriProspectScope(svc, ctx, { brand: 'Meri', runtime: 'Hermes' }),
    ).resolves.toBeNull();
    await expect(
      authorizeMeriProspectScope(svc, ctx, 'not-an-object'),
    ).resolves.toBeNull();
    expect((svc as unknown as { assertCurrent: jest.Mock }).assertCurrent).not.toHaveBeenCalled();
  });

  test('absent key with NO scope service available still returns null (ordinary path needs nothing)', async () => {
    await expect(
      authorizeMeriProspectScope(undefined, ctx, { brand: 'Meri' }),
    ).resolves.toBeNull();
  });

  test('key present with a malformed value fails closed with the typed conflict, before assertCurrent', async () => {
    const svc = scopeService(async () => validScope());
    const metadata = { [MERI_PROSPECT_SCOPE_METADATA_KEY]: 'oops' };
    await expect(authorizeMeriProspectScope(svc, ctx, metadata)).rejects.toBeInstanceOf(
      MeriProspectScopeConflictError,
    );
    expect((svc as unknown as { assertCurrent: jest.Mock }).assertCurrent).not.toHaveBeenCalled();
  });

  test.each([
    ['non-object value', 'oops'],
    ['array value', [{ prospectId: randomUUID() }]],
    ['empty object value', {}],
    ['missing prospectId', { prospectName: 'Acme LLC', scopeVersion: 'a'.repeat(64) }],
    ['non-UUID prospectId', { prospectName: 'Acme LLC', prospectId: 'not-a-uuid', scopeVersion: 'a'.repeat(64) }],
    ['empty prospectName', { prospectId: randomUUID(), prospectName: '', scopeVersion: 'a'.repeat(64) }],
    ['short scopeVersion', { prospectId: randomUUID(), prospectName: 'x', scopeVersion: 'a'.repeat(63) }],
  ] as const)('key present with invalid value (%s) throws MeriProspectScopeConflictError', async (_l, value) => {
    const svc = scopeService(async () => validScope());
    await expect(
      authorizeMeriProspectScope(svc, ctx, { [MERI_PROSPECT_SCOPE_METADATA_KEY]: value }),
    ).rejects.toBeInstanceOf(MeriProspectScopeConflictError);
  });

  test('key present but NO scope service available fails closed', async () => {
    await expect(
      authorizeMeriProspectScope(undefined, ctx, {
        [MERI_PROSPECT_SCOPE_METADATA_KEY]: validScope(),
      }),
    ).rejects.toBeInstanceOf(MeriProspectScopeConflictError);
  });

  test('valid persisted scope delegates to assertCurrent and passes its result through', async () => {
    const scope = validScope();
    const svc = scopeService(async () => scope);
    await expect(
      authorizeMeriProspectScope(svc, ctx, { [MERI_PROSPECT_SCOPE_METADATA_KEY]: scope }),
    ).resolves.toEqual(scope);
    expect((svc as unknown as { assertCurrent: jest.Mock }).assertCurrent).toHaveBeenCalledWith(
      ctx,
      { [MERI_PROSPECT_SCOPE_METADATA_KEY]: scope },
    );
  });

  test('stale scope surfaces assertCurrent typed conflict / safe 404 unchanged', async () => {
    const svc = scopeService(async () => {
      throw new MeriProspectScopeConflictError('changed');
    });
    await expect(
      authorizeMeriProspectScope(svc, ctx, { [MERI_PROSPECT_SCOPE_METADATA_KEY]: validScope() }),
    ).rejects.toBeInstanceOf(MeriProspectScopeConflictError);
  });
});

describe('prospectScopeDirective — bounded server-authored directive', () => {
  test('names the display name + prospect id only, with the no-retarget rule', () => {
    const scope = validScope();
    const directive = prospectScopeDirective(scope);
    expect(directive).toContain(`"${scope.prospectName}"`);
    expect(directive).toContain(scope.prospectId);
    expect(directive).toContain('does not retarget this chat');
    expect(directive).toContain('HARD CONSTRAINT');
    // Bounded: the directive is the whole prompt payload — no other scope
    // fields (canonical org / linked client) are disclosed.
    expect(directive).not.toContain(String(scope.canonicalOrganizationId));
  });

  test('a different prospect name never appears in the directive (free-form names cannot retarget)', () => {
    const directive = prospectScopeDirective(validScope());
    expect(directive).not.toContain('Palantir');
    expect(directive).not.toMatch(/scoped to the business-development prospect "(?!Acme LLC)/);
  });
});

describe('prospectTurnScopeReceipt — bounded receipt shape', () => {
  test('receipt carries only the bounded scope fields with prospect kind', () => {
    const scope = validScope();
    const receipt = prospectTurnScopeReceipt(scope);
    expect(receipt).toEqual({
      kind: 'prospect',
      clientId: null,
      clientName: null,
      targetHint: null,
      prospectId: scope.prospectId,
      prospectName: scope.prospectName,
      canonicalOrganizationId: scope.canonicalOrganizationId,
      linkedClientId: scope.linkedClientId,
      scopeVersion: scope.scopeVersion,
    });
  });

  test('identical scope → identical receipt (deterministic, not model-derived)', () => {
    const scope = validScope();
    expect(prospectTurnScopeReceipt(scope)).toEqual(prospectTurnScopeReceipt(scope));
  });
});
