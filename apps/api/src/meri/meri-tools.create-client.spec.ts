import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { MeriToolsService } from './meri-tools.service.js';
import type { TenantContext } from '@capiro/shared';

/**
 * Unit tests for the client-creation pair: lookup_client_registry (read-only
 * pre-check) and create_client (approval-gated write). The write's contract is
 * shaped by the approve-replay pipeline — the replay's RESULT is discarded by
 * the web controller, so every "nothing was created" outcome must THROW (the
 * visible action-failure channel) and never return a structured error that
 * would render as a false "Approved and completed". Under test: both duplicate
 * guards (literal name + resolved LDA entity), the direct-equals exactness
 * probe, fuzzy-candidates → throw with the candidate list, ldaClientId INT4
 * bounds + unknown-id fail-closed, skipLdaCheck, the 402 slot-limit
 * propagating untouched, and the lookup tool's guidance surface.
 */

const CTX = {
  tenantId: 'a8dce0a5-af14-46fd-bb7e-f7f754556d3e',
  userId: 'cc01a549-5381-4ebd-b714-ec8c597392f6',
} as unknown as TenantContext;

type ToolFn = (ctx: TenantContext, input: Record<string, unknown>) => Promise<any>;

function ldaRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 12345,
    name: 'OLIVET UNIVERSITY',
    state: 'CA',
    generalDescription: 'Private university',
    totalFilings: 14,
    latestFilingYear: 2026,
    ...overrides,
  };
}

/**
 * Stub the two prisma scopes the handlers touch. client.findFirst resolves
 * from `clientLookups` in call order (guard #1 = literal name, guard #2 =
 * resolved LDA entity); ldaClient.findFirst is the direct exactness probe,
 * findMany the contains-candidates window, findUnique the confirmed-id fetch.
 */
function makeService(opts: {
  clientLookups?: Array<unknown | null>;
  ldaExact?: unknown | null;
  ldaCandidates?: unknown[];
  ldaById?: unknown | null;
  createThrows?: unknown;
}) {
  const clientFindFirst = jest.fn();
  for (const value of opts.clientLookups ?? []) clientFindFirst.mockResolvedValueOnce(value);
  clientFindFirst.mockResolvedValue(null);
  const ldaFindFirst = jest.fn().mockResolvedValue(opts.ldaExact ?? null);
  const ldaFindMany = jest.fn().mockResolvedValue(opts.ldaCandidates ?? []);
  const ldaFindUnique = jest.fn().mockResolvedValue(opts.ldaById ?? null);
  const create = opts.createThrows
    ? jest.fn().mockRejectedValue(opts.createThrows)
    : jest.fn().mockResolvedValue({ id: 'client-new', name: 'Olivet University', website: null });
  const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
  (service as unknown as { prisma: unknown }).prisma = {
    withTenant: (_t: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ client: { findFirst: clientFindFirst } }),
    withSystem: (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        ldaClient: { findFirst: ldaFindFirst, findMany: ldaFindMany, findUnique: ldaFindUnique },
      }),
  };
  (service as unknown as { clients: unknown }).clients = { create };
  const svc = service as unknown as { createClient: ToolFn; lookupClientRegistry: ToolFn };
  return {
    createClient: svc.createClient.bind(service),
    lookupClientRegistry: svc.lookupClientRegistry.bind(service),
    create,
    clientFindFirst,
    ldaFindFirst,
    ldaFindMany,
    ldaFindUnique,
  };
}

describe('lookup_client_registry tool', () => {
  it('reports an existing client and steers away from create_client', async () => {
    const { lookupClientRegistry } = makeService({
      clientLookups: [{ id: 'client-1', name: 'Olivet University', website: null }],
    });
    const out = await lookupClientRegistry(CTX, { name: 'olivet university' });
    expect(out.existingClient).toMatchObject({ id: 'client-1' });
    expect(out.guidance).toMatch(/do NOT propose create_client/i);
  });

  it('reports the exact LDA match separately from close candidates', async () => {
    const { lookupClientRegistry } = makeService({
      ldaExact: ldaRow(),
      ldaCandidates: [ldaRow(), ldaRow({ id: 67890, name: 'OLIVET NAZARENE UNIVERSITY' })],
    });
    const out = await lookupClientRegistry(CTX, { name: 'Olivet University' });
    expect(out.existingClient).toBeNull();
    expect(out.ldaExactMatch).toMatchObject({ ldaClientId: 12345 });
    // the exact row is deduped out of the candidate list
    expect(out.ldaCandidates).toHaveLength(1);
    expect(out.ldaCandidates[0].ldaClientId).toBe(67890);
    expect(out.guidance).toMatch(/exact LDA registry match/i);
  });

  it('reports close candidates with ask-the-user guidance when nothing is exact', async () => {
    const { lookupClientRegistry } = makeService({
      ldaCandidates: [ldaRow(), ldaRow({ id: 67890, name: 'OLIVET NAZARENE UNIVERSITY' })],
    });
    const out = await lookupClientRegistry(CTX, { name: 'Olivet' });
    expect(out.ldaExactMatch).toBeNull();
    expect(out.ldaCandidates).toHaveLength(2);
    expect(out.guidance).toMatch(/ask the user/i);
  });

  it('reports a clean miss (manual-create guidance)', async () => {
    const { lookupClientRegistry } = makeService({});
    const out = await lookupClientRegistry(CTX, { name: 'Olivet University' });
    expect(out.existingClient).toBeNull();
    expect(out.ldaExactMatch).toBeNull();
    expect(out.ldaCandidates).toEqual([]);
    expect(out.guidance).toMatch(/manual create/i);
  });
});

describe('create_client tool', () => {
  it('THROWS on a duplicate of an existing client (visible failure, no LDA lookup, no create)', async () => {
    const { createClient, create, ldaFindFirst } = makeService({
      clientLookups: [{ id: 'client-1', name: 'Olivet University' }],
    });
    await expect(createClient(CTX, { name: 'olivet university' })).rejects.toThrow(
      /Nothing was created: a client named "Olivet University" already exists/i,
    );
    expect(ldaFindFirst).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('THROWS with the candidate list when LDA matches are close but not exact', async () => {
    const { createClient, create } = makeService({
      ldaExact: null,
      ldaCandidates: [
        ldaRow(),
        ldaRow({ id: 67890, name: 'OLIVET NAZARENE UNIVERSITY', totalFilings: 3 }),
      ],
    });
    await expect(createClient(CTX, { name: 'Olivet' })).rejects.toThrow(
      /Nothing was created: close \(not exact\) LDA registry matches exist.*ldaClientId 12345.*OLIVET NAZARENE UNIVERSITY/i,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('probes exactness with a direct equals query (not the capped contains window) and creates with provenance', async () => {
    const { createClient, create, ldaFindFirst, ldaFindMany } = makeService({
      ldaExact: ldaRow(),
    });
    const out = await createClient(CTX, { name: 'Olivet University' });
    expect(out.created).toBe(true);
    expect(out.ldaMatch).toMatchObject({ ldaClientId: 12345, name: 'OLIVET UNIVERSITY' });
    expect(ldaFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { name: { equals: 'Olivet University', mode: 'insensitive' } },
      }),
    );
    // exact hit means the contains-candidates window is never needed
    expect(ldaFindMany).not.toHaveBeenCalled();
    const input = create.mock.calls[0]![1] as Record<string, unknown>;
    const intake = input.intakeData as { __meriCreate: Record<string, unknown> };
    expect(intake.__meriCreate.ldaClientId).toBe(12345);
    // the confirmed identity is seeded directly, not left to async resolution
    expect(input.ldaClientIds).toEqual([12345]);
    expect(input.description).toBe('Private university');
    expect(out.followUp).toMatch(/full profile/i);
  });

  it('guards against duplicating the RESOLVED entity (existing client with the LDA name or lda_client_ids link)', async () => {
    const { createClient, create } = makeService({
      // guard #1 (literal "Olivet Univ") misses; guard #2 (resolved entity) hits
      clientLookups: [null, { id: 'client-1', name: 'Olivet University' }],
      ldaById: ldaRow(),
    });
    await expect(createClient(CTX, { name: 'Olivet Univ', ldaClientId: 12345 })).rejects.toThrow(
      /resolves to LDA entity "OLIVET UNIVERSITY", which is already the existing client/i,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('creates manually on a clean LDA miss and says so', async () => {
    const { createClient } = makeService({});
    const out = await createClient(CTX, {
      name: 'Converge Medical Technology',
      website: 'https://convergemedical.example',
    });
    expect(out.created).toBe(true);
    expect(out.ldaMatch).toBeNull();
    expect(out.note).toMatch(/No match in the LDA/i);
  });

  it('skips the LDA lookup when the user confirmed skipLdaCheck', async () => {
    const { createClient, ldaFindFirst, ldaFindMany } = makeService({});
    const out = await createClient(CTX, { name: 'Olivet University', skipLdaCheck: true });
    expect(out.created).toBe(true);
    expect(ldaFindFirst).not.toHaveBeenCalled();
    expect(ldaFindMany).not.toHaveBeenCalled();
  });

  it('uses a confirmed ldaClientId (accepting a stringified id) and seeds the link', async () => {
    const { createClient, create, ldaFindUnique } = makeService({ ldaById: ldaRow() });
    const out = await createClient(CTX, { name: 'Olivet University', ldaClientId: '12345' });
    expect(out.created).toBe(true);
    expect(ldaFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 12345 } }));
    const input = create.mock.calls[0]![1] as Record<string, unknown>;
    expect(input.ldaClientIds).toEqual([12345]);
  });

  it('THROWS a clean message on an out-of-INT4-range ldaClientId (no raw Prisma error)', async () => {
    const { createClient, ldaFindUnique } = makeService({});
    await expect(
      createClient(CTX, { name: 'Olivet University', ldaClientId: '9999999999' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      createClient(CTX, { name: 'Olivet University', ldaClientId: 1e21 }),
    ).rejects.toThrow(/must be a positive id from lookup_client_registry/i);
    expect(ldaFindUnique).not.toHaveBeenCalled();
  });

  it('fails closed on an unknown in-range ldaClientId', async () => {
    const { createClient, create } = makeService({ ldaById: null });
    await expect(
      createClient(CTX, { name: 'Olivet University', ldaClientId: 999999 }),
    ).rejects.toThrow(/no LDA client with id 999999/i);
    expect(create).not.toHaveBeenCalled();
  });

  it('lets the billing slot-limit 402 propagate so the approve replay surfaces it as the failure', async () => {
    const slotLimit = new HttpException(
      { code: 'CLIENT_SLOT_LIMIT', message: "You've used all 10 client slots on your plan." },
      HttpStatus.PAYMENT_REQUIRED,
    );
    const { createClient } = makeService({ createThrows: slotLimit });
    await expect(createClient(CTX, { name: 'International Auto Logistics' })).rejects.toBe(
      slotLimit,
    );
  });
});
