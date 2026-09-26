import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import {
  BizDevMeriScopeService,
  MERI_PROSPECT_SCOPE_METADATA_KEY,
  MeriProspectScopeConflictError,
  computeMeriProspectScopeVersion,
  parsePersistedMeriProspectScope,
} from './bizdev-meri-scope.service.js';

/**
 * Deterministic Jest coverage for the Phase 4 Meri prospect scope resolution
 * (repository test pattern, mirrors the brief/dossier service specs). RLS is
 * NOT claimed here — the persistence contract specs own that. These tests
 * pin: flag fail-closed matrix, authorized resolve, cross-tenant safe 404,
 * deterministic scopeVersion sensitivity, the fail-closed metadata parser,
 * and the assertCurrent guard.
 */

const tenantId = randomUUID();
const tenantBId = randomUUID();
const ctx = { tenantId, userId: 'u1', role: 'standard_user' } as unknown as TenantContext;
const ctxB = { tenantId: tenantBId, userId: 'u2', role: 'standard_user' } as unknown as TenantContext;
const noTenantCtx = { userId: 'u3' } as unknown as TenantContext;

interface ProspectRow {
  id: string;
  tenantId: string;
  displayName: string;
  canonicalEntityId: string | null;
  linkedClientId: string | null;
  updatedAt: Date;
}

interface TenantRow {
  id: string;
  settings: unknown;
}

const FLAGS_ON = {
  clioFeatureFlags: {
    'businessDevelopment.enabled': true,
    'businessDevelopment.meriProspectTools.enabled': true,
  },
};

function makeHarness(fixture: {
  tenants: TenantRow[];
  prospects: ProspectRow[];
  failTenantRead?: boolean;
}) {
  const txFor = (t: string) => ({
    tenant: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        if (fixture.failTenantRead) throw new Error('tenant db read failed');
        const row = fixture.tenants.find((x) => x.id === where.id && x.id === t);
        return row ? { ...row } : null;
      }),
    },
    businessDevelopmentProspect: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = fixture.prospects.find(
          (p) => p.id === where.id && p.tenantId === t,
        );
        return row ? { ...row } : null;
      }),
    },
  });
  const prisma = {
    withTenant: jest.fn(async (t: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn(txFor(t)),
    ),
  } as never;
  const service = new BizDevMeriScopeService(prisma);
  // `fixture` is captured by the tx closures, so tests can mutate it (e.g.
  // empty `prospects`) to simulate rows disappearing between calls.
  return { service, prisma, fixture };
}

const prospect = (over: Partial<ProspectRow> = {}): ProspectRow => ({
  id: randomUUID(),
  tenantId,
  displayName: 'Acme LLC',
  canonicalEntityId: randomUUID(),
  linkedClientId: null,
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  ...over,
});

const tenantsOn = (): TenantRow[] => [
  { id: tenantId, settings: FLAGS_ON },
  { id: tenantBId, settings: FLAGS_ON },
];

describe('BizDevMeriScopeService.resolve', () => {
  test('authorized resolve returns the bounded typed scope', async () => {
    const p = prospect({ linkedClientId: randomUUID() });
    const h = makeHarness({ tenants: tenantsOn(), prospects: [p] });
    const scope = await h.service.resolve(ctx, p.id);
    expect(scope).toEqual({
      prospectId: p.id,
      prospectName: 'Acme LLC',
      canonicalOrganizationId: p.canonicalEntityId,
      linkedClientId: p.linkedClientId,
      scopeVersion: expect.any(String),
    });
    expect(scope.scopeVersion).toMatch(/^[0-9a-f]{64}$/);
    // Bounded: nothing else rides along.
    expect(Object.keys(scope).sort()).toEqual(
      [
        'prospectId',
        'prospectName',
        'canonicalOrganizationId',
        'linkedClientId',
        'scopeVersion',
      ].sort(),
    );
  });

  test('flag off (Phase 1 umbrella) fails closed with the safe 404', async () => {
    const p = prospect();
    const h = makeHarness({
      tenants: [
        {
          id: tenantId,
          settings: {
            clioFeatureFlags: {
              'businessDevelopment.enabled': false,
              'businessDevelopment.meriProspectTools.enabled': true,
            },
          },
        },
      ],
      prospects: [p],
    });
    await expect(h.service.resolve(ctx, p.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  test('meriProspectTools flag off fails closed with the safe 404', async () => {
    const p = prospect();
    const h = makeHarness({
      tenants: [
        {
          id: tenantId,
          settings: {
            clioFeatureFlags: {
              'businessDevelopment.enabled': true,
              'businessDevelopment.meriProspectTools.enabled': false,
            },
          },
        },
      ],
      prospects: [p],
    });
    await expect(h.service.resolve(ctx, p.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  test('default (no flags at all) fails closed with the safe 404', async () => {
    const p = prospect();
    const h = makeHarness({ tenants: [{ id: tenantId, settings: null }], prospects: [p] });
    await expect(h.service.resolve(ctx, p.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  test('tenant settings read error fails closed with the same safe 404', async () => {
    const p = prospect();
    const h = makeHarness({
      tenants: tenantsOn(),
      prospects: [p],
      failTenantRead: true,
    });
    await expect(h.service.resolve(ctx, p.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  test('missing tenant context fails closed with the same safe 404', async () => {
    const h = makeHarness({ tenants: tenantsOn(), prospects: [] });
    await expect(h.service.resolve(noTenantCtx, randomUUID())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  test('cross-tenant prospect id resolves to nothing (safe 404)', async () => {
    const p = prospect(); // tenant A
    const h = makeHarness({ tenants: tenantsOn(), prospects: [p] });
    await expect(h.service.resolve(ctxB, p.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  test('missing prospect id fails closed with the safe 404', async () => {
    const h = makeHarness({ tenants: tenantsOn(), prospects: [] });
    await expect(h.service.resolve(ctx, randomUUID())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('computeMeriProspectScopeVersion', () => {
  const base = {
    prospectId: randomUUID(),
    canonicalOrganizationId: randomUUID(),
    linkedClientId: randomUUID(),
  };

  test('deterministic: identical inputs produce identical digests', () => {
    expect(computeMeriProspectScopeVersion(base)).toBe(computeMeriProspectScopeVersion(base));
  });

  test.each([
    ['prospectId', () => ({ ...base, prospectId: randomUUID() })],
    ['canonicalOrganizationId', () => ({ ...base, canonicalOrganizationId: randomUUID() })],
    ['canonicalOrganizationId cleared', () => ({ ...base, canonicalOrganizationId: null })],
    ['linkedClientId', () => ({ ...base, linkedClientId: randomUUID() })],
    ['linkedClientId cleared', () => ({ ...base, linkedClientId: null })],
  ] as const)('changes when %s changes', (_label, mutated) => {
    expect(computeMeriProspectScopeVersion(mutated())).not.toBe(
      computeMeriProspectScopeVersion(base),
    );
  });
});

describe('parsePersistedMeriProspectScope (fail-closed)', () => {
  const valid = {
    prospectId: randomUUID(),
    prospectName: 'Acme LLC',
    canonicalOrganizationId: randomUUID(),
    linkedClientId: null,
    scopeVersion: 'a'.repeat(64),
  };

  test('parses a valid persisted scope', () => {
    const parsed = parsePersistedMeriProspectScope({
      [MERI_PROSPECT_SCOPE_METADATA_KEY]: valid,
    });
    expect(parsed).toEqual(valid);
  });

  test.each([
    ['null metadata', null],
    ['non-object metadata', 'nope'],
    ['missing scope key', { brand: 'Meri' }],
    ['non-object scope', { [MERI_PROSPECT_SCOPE_METADATA_KEY]: 'oops' }],
    ['missing prospectId', { [MERI_PROSPECT_SCOPE_METADATA_KEY]: { ...valid, prospectId: undefined } }],
    ['non-UUID prospectId', { [MERI_PROSPECT_SCOPE_METADATA_KEY]: { ...valid, prospectId: 'not-a-uuid' } }],
    ['empty prospectName', { [MERI_PROSPECT_SCOPE_METADATA_KEY]: { ...valid, prospectName: '' } }],
    ['missing scopeVersion', { [MERI_PROSPECT_SCOPE_METADATA_KEY]: { ...valid, scopeVersion: undefined } }],
    ['short scopeVersion', { [MERI_PROSPECT_SCOPE_METADATA_KEY]: { ...valid, scopeVersion: 'a'.repeat(63) } }],
    ['non-hex scopeVersion', { [MERI_PROSPECT_SCOPE_METADATA_KEY]: { ...valid, scopeVersion: 'z'.repeat(64) } }],
    ['numeric canonical id', { [MERI_PROSPECT_SCOPE_METADATA_KEY]: { ...valid, canonicalOrganizationId: 42 } }],
    ['missing nullable key', { [MERI_PROSPECT_SCOPE_METADATA_KEY]: { ...valid, linkedClientId: undefined } }],
    ['unexpected key', { [MERI_PROSPECT_SCOPE_METADATA_KEY]: { ...valid, providerPayload: 'nope' } }],
  ] as const)('rejects %s with null', (_label, metadata) => {
    expect(parsePersistedMeriProspectScope(metadata)).toBeNull();
  });
});

describe('BizDevMeriScopeService.assertCurrent', () => {
  test('accepts and returns the re-resolved scope when unchanged', async () => {
    const p = prospect({ linkedClientId: randomUUID() });
    const h = makeHarness({ tenants: tenantsOn(), prospects: [p] });
    const scope = await h.service.resolve(ctx, p.id);
    const persisted = {
      [MERI_PROSPECT_SCOPE_METADATA_KEY]: scope,
    };
    await expect(h.service.assertCurrent(ctx, persisted)).resolves.toEqual(scope);
  });

  test('rejects a changed selection (linked client bound) with the typed conflict', async () => {
    const p = prospect();
    const h = makeHarness({ tenants: tenantsOn(), prospects: [p] });
    const stale = await h.service.resolve(ctx, p.id);
    // Prospect is re-linked to a client after the conversation was created.
    p.linkedClientId = randomUUID();
    p.updatedAt = new Date();
    await expect(h.service.assertCurrent(ctx, stale)).rejects.toBeInstanceOf(
      MeriProspectScopeConflictError,
    );
  });

  test('keeps the same selected prospect current across ordinary row edits', async () => {
    const p = prospect();
    const h = makeHarness({ tenants: tenantsOn(), prospects: [p] });
    const stale = await h.service.resolve(ctx, p.id);
    p.updatedAt = new Date('2026-09-20T00:00:00Z');
    await expect(h.service.assertCurrent(ctx, stale)).resolves.toEqual(stale);
  });

  test('rejects a missing prospect with the typed not-found conflict', async () => {
    const p = prospect();
    const h = makeHarness({ tenants: tenantsOn(), prospects: [p] });
    const stale = await h.service.resolve(ctx, p.id);
    h.fixture.prospects.length = 0;
    await expect(h.service.assertCurrent(ctx, stale)).rejects.toBeInstanceOf(
      MeriProspectScopeConflictError,
    );
  });

  test('rejects malformed/absent persisted scope (typed not-found)', async () => {
    const h = makeHarness({ tenants: tenantsOn(), prospects: [] });
    await expect(h.service.assertCurrent(ctx, null)).rejects.toBeInstanceOf(
      MeriProspectScopeConflictError,
    );
    await expect(h.service.assertCurrent(ctx, { unrelated: true })).rejects.toBeInstanceOf(
      MeriProspectScopeConflictError,
    );
    await expect(
      h.service.assertCurrent(ctx, {
        prospectId: randomUUID(),
        prospectName: 'x',
        scopeVersion: 'zzz',
      }),
    ).rejects.toBeInstanceOf(MeriProspectScopeConflictError);
  });
});
