import { DeltaEngineService } from './delta-engine.service.js';

/**
 * Step 2.3 — DeltaEngineService.getAffectedTenants must ADDITIVELY include relevance-only
 * clients (clients with NO watch and NO peNumber capability that still score relevant on an
 * evidence path) alongside the existing watches ∪ peNumber-capability union.
 *
 * getAffectedTenants is private; these tests invoke it through a typed cast (the same pattern
 * the read-service spec uses for its private internals), and mock ClientPeRelevanceService so
 * the relevance contribution is deterministic.
 */

type AffectedTenant = { tenantId: string; relatedClientIds: string[] };

function callGetAffectedTenants(service: DeltaEngineService, peCode: string): Promise<AffectedTenant[]> {
  return (
    service as unknown as { getAffectedTenants(pe: string): Promise<AffectedTenant[]> }
  ).getAffectedTenants(peCode);
}

const TENANT_A = '00000000-0000-0000-0000-0000000000a1';
const TENANT_B = '00000000-0000-0000-0000-0000000000b2';

type CapabilityRow = {
  tenantId: string;
  clientId: string;
  peNumber?: string | null;
  peNumbers?: string[];
};

function makePrisma(opts: {
  watches?: Array<{ tenantId: string }>;
  capabilities?: Array<CapabilityRow>;
}) {
  const capabilities = opts.capabilities ?? [];
  const watches = opts.watches ?? [];

  // Honor the OR(peNumber, peNumbers[] has) where so a peNumbers[]-only capability is
  // matched exactly the way Postgres would — the mock must not pass trivially.
  const capabilityFindMany = jest.fn(
    async ({ where }: { where?: Record<string, unknown> } = {}) => {
      const or = (where?.OR ?? []) as Array<Record<string, unknown>>;
      const peNumberEq = or.find((c) => 'peNumber' in c)?.peNumber as string | undefined;
      const peNumbersHas = (
        or.find((c) => 'peNumbers' in c)?.peNumbers as { has?: string } | undefined
      )?.has;
      const matched =
        or.length === 0
          ? capabilities
          : capabilities.filter(
              (c) =>
                (peNumberEq !== undefined && c.peNumber === peNumberEq) ||
                (peNumbersHas !== undefined && (c.peNumbers ?? []).includes(peNumbersHas)),
            );
      return matched.map((c) => ({ tenantId: c.tenantId, clientId: c.clientId }));
    },
  );

  // The stub tx handed to withSystem — the ONLY path on which these rows are visible,
  // because it is the path that sets app.bypass_rls.
  const systemTx = {
    programElementWatch: { findMany: jest.fn(async () => watches) },
    clientCapability: { findMany: capabilityFindMany },
  };

  // Model the live database rather than a permissive stub. BOTH client_capabilities and
  // (as of the Phase C tenant-isolation migration) program_element_watch are RLS-FORCED,
  // and the runtime role capiro_app is NOT BYPASSRLS since the 2026-07-20 role hardening.
  // So a read that skips withSystem returns ZERO rows with no error. Returning [] here —
  // instead of the fixture — is what lets these tests detect that regression at all; a
  // fake that serves the same rows on both paths cannot.
  return {
    programElementWatch: {
      findMany: jest.fn(async () => [] as Array<{ tenantId: string }>),
    },
    clientCapability: {
      findMany: jest.fn(async () => [] as Array<{ tenantId: string; clientId: string }>),
    },
    withSystem: jest.fn(async (fn: (tx: typeof systemTx) => unknown) => fn(systemTx)),
    __systemTx: systemTx,
  };
}

function makeRelevanceService(
  rows: Array<{ tenantId: string; clientId: string; score: number }> = [],
) {
  return {
    getRelevantTenantClientsForPe: jest.fn(async () => rows),
  };
}

describe('DeltaEngineService.getAffectedTenants (Step 2.3 relevance union)', () => {
  test('includes a relevance-only client (no watch, no peNumber capability)', async () => {
    const prisma = makePrisma({ watches: [], capabilities: [] });
    const relevance = makeRelevanceService([
      { tenantId: TENANT_A, clientId: 'client-relev-1', score: 0.72 },
    ]);
    const service = new DeltaEngineService(prisma as never, relevance as never);

    const affected = await callGetAffectedTenants(service, '0603270A');

    expect(affected).toEqual([{ tenantId: TENANT_A, relatedClientIds: ['client-relev-1'] }]);
    // The relevance service is consulted with the documented 0.5 floor.
    expect(relevance.getRelevantTenantClientsForPe).toHaveBeenCalledWith('0603270A', { minScore: 0.5 });
  });

  test('unions relevance clients with existing watch + capability signals (de-duped per tenant)', async () => {
    const prisma = makePrisma({
      watches: [{ tenantId: TENANT_A }],
      capabilities: [{ tenantId: TENANT_A, clientId: 'cap-client', peNumber: '0603270A' }],
    });
    const relevance = makeRelevanceService([
      // Same tenant, NEW client surfaced purely by relevance.
      { tenantId: TENANT_A, clientId: 'relev-client', score: 0.9 },
      // Already-known client via capability — must not duplicate.
      { tenantId: TENANT_A, clientId: 'cap-client', score: 0.6 },
      // A whole new tenant reached only via relevance.
      { tenantId: TENANT_B, clientId: 'b-client', score: 0.55 },
    ]);
    const service = new DeltaEngineService(prisma as never, relevance as never);

    const affected = await callGetAffectedTenants(service, '0603270A');
    const byTenant = new Map(affected.map((a) => [a.tenantId, [...a.relatedClientIds].sort()]));

    expect(byTenant.get(TENANT_A)).toEqual(['cap-client', 'relev-client']);
    expect(byTenant.get(TENANT_B)).toEqual(['b-client']);
  });

  test('catches a multi-PE capability that sets peNumbers[] only (no scalar peNumber)', async () => {
    // The capability names this PE ONLY via the peNumbers[] array — getAffectedTenants must
    // match it directly (OR peNumbers has), not rely on the relevance leg (which has a
    // .catch->[] fallback). Relevance reports nothing here.
    const prisma = makePrisma({
      watches: [],
      capabilities: [
        { tenantId: TENANT_A, clientId: 'multi-pe-client', peNumber: null, peNumbers: ['0603270A'] },
      ],
    });
    const relevance = makeRelevanceService([]);
    const service = new DeltaEngineService(prisma as never, relevance as never);

    const affected = await callGetAffectedTenants(service, '0603270A');

    expect(affected).toEqual([{ tenantId: TENANT_A, relatedClientIds: ['multi-pe-client'] }]);
  });

  test('relevance lookup failure is non-fatal — watch/capability recipients are preserved', async () => {
    const prisma = makePrisma({
      watches: [{ tenantId: TENANT_A }],
      capabilities: [{ tenantId: TENANT_A, clientId: 'cap-client', peNumber: '0603270A' }],
    });
    const relevance = {
      getRelevantTenantClientsForPe: jest.fn(async () => {
        throw new Error('relevance backend down');
      }),
    };
    const service = new DeltaEngineService(prisma as never, relevance as never);

    const affected = await callGetAffectedTenants(service, '0603270A');

    expect(affected).toEqual([{ tenantId: TENANT_A, relatedClientIds: ['cap-client'] }]);
  });

  test('degrades cleanly when the relevance service is not injected (CLI path)', async () => {
    const prisma = makePrisma({
      watches: [{ tenantId: TENANT_A }],
      capabilities: [],
    });
    // Construct with no relevance service, mirroring the deltas:compute CLI.
    const service = new DeltaEngineService(prisma as never);

    const affected = await callGetAffectedTenants(service, '0603270A');

    expect(affected).toEqual([{ tenantId: TENANT_A, relatedClientIds: [] }]);
  });

  test('reads program_element_watch on the bypass path so a WATCH-ONLY tenant is still routed', async () => {
    // Phase C makes program_element_watch RLS-FORCED. capiro_app is not BYPASSRLS, so a
    // read outside withSystem returns zero rows WITH NO ERROR. TENANT_B here is reachable
    // ONLY by its watch — no capability, no relevance — so if this read stops going
    // through the bypass path the tenant silently vanishes from delta alert routing and
    // nothing anywhere logs a failure. Assert the row is found AND that it came from the
    // bypass client, so the test cannot pass for the wrong reason.
    const prisma = makePrisma({ watches: [{ tenantId: TENANT_B }], capabilities: [] });
    const relevance = makeRelevanceService([]);
    const service = new DeltaEngineService(prisma as never, relevance as never);

    const affected = await callGetAffectedTenants(service, '0603270A');

    expect(affected).toEqual([{ tenantId: TENANT_B, relatedClientIds: [] }]);
    expect(prisma.withSystem).toHaveBeenCalled();
    expect(prisma.__systemTx.programElementWatch.findMany).toHaveBeenCalled();
    // The non-bypass client must never be consulted for this table.
    expect(prisma.programElementWatch.findMany).not.toHaveBeenCalled();
  });
});
