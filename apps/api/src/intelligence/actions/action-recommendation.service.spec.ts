import { Prisma } from '@prisma/client';
import { ActionRecommendationService } from './action-recommendation.service.js';
import { isExcludedFromRecommendations } from '../../acquisition-personnel/contact-use.policy.js';

const { PrismaClientKnownRequestError } = Prisma;

/**
 * Step 3.2 — ActionRecommendationService.generate() generator behaviour.
 *
 * Uses an in-memory prisma double (with a stateful action_recommendation store so idempotency
 * is observable across two runs) and a mocked ClientPeRelevanceService so the relevant-client
 * fan-out is deterministic. The PURE cores (gating / audience / card assembly) run for real —
 * only the DB layer is faked.
 */

const TENANT = '00000000-0000-0000-0000-0000000000a1';
const CLIENT = '11111111-1111-1111-1111-111111111111';
const PE = '0604123A';

// A material delta: a House mark below the request (a CUT), well over the materiality gate.
function materialDelta(overrides: Record<string, unknown> = {}) {
  return {
    id: 'delta-1',
    peCode: PE,
    assertedFy: 2027,
    deltaType: 'mark_vs_request',
    fromRef: 'request',
    toRef: 'hascMark',
    amountFrom: { toNumber: () => 100 },
    amountTo: { toNumber: () => 60 },
    deltaPct: -0.4,
    materialityScore: 0.82,
    ...overrides,
  };
}

interface MakePrismaOpts {
  deltas?: Array<Record<string, unknown>>;
  matches?: Array<{
    status: string;
    programId: string;
    program?: { id: string; canonicalName: string };
  }>;
  personRoles?: Array<{
    id: string;
    contactUse: string;
    reviewStatus: string;
    staleAt: Date | null;
    person?: { fullName: string };
  }>;
  officeLinks?: Array<{ officeId: string }>;
  /** G5: committee report provisions linked to the PE (loadDeltaGraph shape). */
  provisionLinks?: Array<{
    provision: {
      id: string;
      committee: string;
      fy: number;
      heading: string;
      text: string;
      actionType: string | null;
    };
  }>;
  peTitle?: string;
  /** Shared store so two generate() runs see each other's writes (idempotency). */
  store?: Map<string, ActionRow>;
}

interface ActionRow {
  id: string;
  tenantId: string;
  clientId: string;
  deltaId: string | null;
  actionType: string;
  status: string;
  [k: string]: unknown;
}

// Dedupe is by (tenant, client, delta) ONLY — NOT actionType (G2): there is at most one card
// per (tenant, client, delta), so a card whose actionType flips between runs is the SAME row.
function dedupeKey(r: { tenantId: string; clientId: string; deltaId: string | null }): string {
  return `${r.tenantId}|${r.clientId}|${r.deltaId ?? ''}`;
}

function makePrisma(opts: MakePrismaOpts = {}) {
  const store = opts.store ?? new Map<string, ActionRow>();
  let seq = 0;

  const tenantTx = {
    client: {
      findUnique: jest.fn(async () => ({ name: 'Acme Defense' })),
    },
    actionRecommendation: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        // The generator looks up by (tenantId, clientId, deltaId) ONLY (no actionType) — G2.
        const key = dedupeKey({
          tenantId: where.tenantId as string,
          clientId: where.clientId as string,
          deltaId: (where.deltaId as string) ?? null,
        });
        return store.get(key) ?? null;
      }),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          for (const row of store.values()) {
            if (row.id === where.id) {
              Object.assign(row, data); // generated fields only; status untouched
              return row;
            }
          }
          throw new Error(`update: no row ${where.id}`);
        },
      ),
      create: jest.fn(async ({ data }: { data: ActionRow }) => {
        seq += 1;
        const row: ActionRow = { ...data, id: `card-${seq}` };
        store.set(dedupeKey(row), row);
        return row;
      }),
    },
  };

  const prisma = {
    programElementDelta: {
      findMany: jest.fn(async () => opts.deltas ?? [materialDelta()]),
    },
    programElement: {
      findUnique: jest.fn(async () => ({ title: opts.peTitle ?? 'Next-Gen Sensor' })),
    },
    peProgramMatch: {
      findMany: jest.fn(
        async () =>
          opts.matches ?? [
            {
              status: 'accepted',
              programId: 'prog-1',
              program: { id: 'prog-1', canonicalName: 'NGS Program' },
            },
          ],
      ),
    },
    programElementSource: {
      findMany: jest.fn(async () => [{ sourceDocumentId: 'src-doc-1', pageNumber: 42 }]),
    },
    // G5: committee report provisions linked to the PE (default none). A test
    // can supply opts.provisionLinks to exercise report-language surfacing.
    provisionPeLink: {
      findMany: jest.fn(async () => opts.provisionLinks ?? []),
    },
    programOfficeProgramLink: {
      findMany: jest.fn(async () => opts.officeLinks ?? [{ officeId: 'office-1' }]),
    },
    personRole: {
      findMany: jest.fn(async () => opts.personRoles ?? []),
    },
    withTenant: jest.fn(async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn(tenantTx),
    ),
  };

  return { prisma, store, tenantTx };
}

function makeRelevance(
  opts: {
    tenantClients?: Array<{ tenantId: string; clientId: string; score: number }>;
    paths?: Array<{
      clientId: string;
      paths: Array<{ path: string; score: number; evidence: string[] }>;
    }>;
  } = {},
) {
  const toRows = () =>
    (
      opts.paths ?? [
        {
          clientId: CLIENT,
          paths: [{ path: 'prior_award', score: 0.6, evidence: ['Holds a $40M award on this PE'] }],
        },
      ]
    ).map((p) => ({
      clientId: p.clientId,
      clientName: 'Acme Defense',
      score: 0.78,
      paths: p.paths,
    }));

  return {
    getRelevantTenantClientsForPe: jest.fn(
      async () => opts.tenantClients ?? [{ tenantId: TENANT, clientId: CLIENT, score: 0.78 }],
    ),
    // The generator resolves client-specific narrative paths via the tenantId-only method
    // (G4: no `as never` cast). Keep getRelevantClientsForPe too for the ctx-based callers.
    getRelevantClientsForPeByTenantId: jest.fn(async () => toRows()),
    getRelevantClientsForPe: jest.fn(async () => toRows()),
  };
}

function newService(p: ReturnType<typeof makePrisma>, r: ReturnType<typeof makeRelevance>) {
  return new ActionRecommendationService(p.prisma as never, r as never);
}

describe('ActionRecommendationService.generate (Step 3.2 generator)', () => {
  test('a material delta + relevant client => exactly ONE card with all §10 fields populated', async () => {
    const p = makePrisma();
    const r = makeRelevance();
    const service = newService(p, r);

    const { generated } = await service.generate();

    expect(generated).toBe(1);
    expect(p.store.size).toBe(1);
    const card = [...p.store.values()][0]!;

    // §10 narrative fields all populated.
    expect(card.issueTitle).toEqual(expect.any(String));
    expect((card.issueTitle as string).length).toBeGreaterThan(0);
    expect(card.whatChanged).toMatch(/0604123A/);
    expect(card.whyItMatters).toMatch(/Acme Defense/);
    expect(card.recommendedAction).toEqual(expect.any(String));
    expect((card.recommendedAction as string).length).toBeGreaterThan(0);
    expect(card.suggestedArtifactType).toEqual(expect.any(String));

    // A request->mark CUT (100 -> 60) maps to restore_cut.
    expect(card.actionType).toBe('restore_cut');

    // Linkage + scoring fields.
    expect(card.deltaId).toBe('delta-1');
    expect(card.peCode).toBe(PE);
    expect(card.programId).toBe('prog-1');
    expect(card.status).toBe('new');
    expect(card.priority).toBeGreaterThan(0);

    // Confidence bands (all four dimensions assessed).
    const confidence = card.confidence as Record<string, string>;
    expect(confidence.delta).toBe('high'); // 0.82 materiality
    expect(confidence.programMatch).toBe('high'); // accepted match
    expect(confidence.clientRelevance).toBe('high'); // 0.78 relevance

    // Evidence: a delta ref + at least one source ref + the program match.
    // G5: the relied-upon PE↔program match is now its own 'program_match' kind
    // (it previously borrowed 'provision', which collided with real
    // committee-report provision refs — none of which exist in this fixture).
    const evidence = card.evidence as Array<{
      kind: string;
      deltaId?: string;
      sourceDocumentId?: string;
    }>;
    expect(evidence.some((e) => e.kind === 'delta' && e.deltaId === 'delta-1')).toBe(true);
    expect(evidence.some((e) => e.kind === 'source' && e.sourceDocumentId === 'src-doc-1')).toBe(
      true,
    );
    expect(evidence.some((e) => e.kind === 'program_match')).toBe(true);
    // No committee report provisions linked in this fixture → no 'provision' refs.
    expect(evidence.some((e) => e.kind === 'provision')).toBe(false);
  });

  test('GATING — sub-threshold MATERIALITY produces NO card', async () => {
    const p = makePrisma({ deltas: [materialDelta({ materialityScore: 0.39 })] });
    const r = makeRelevance();
    const service = newService(p, r);

    const { generated } = await service.generate();
    // The delta is below the candidate materiality gate, so it is never even loaded as a
    // candidate; even if it were, shouldGenerate would reject it.
    expect(generated).toBe(0);
    expect(p.store.size).toBe(0);
  });

  test('GATING — sub-threshold RELEVANCE produces NO card', async () => {
    const p = makePrisma();
    const r = makeRelevance({
      tenantClients: [{ tenantId: TENANT, clientId: CLIENT, score: 0.49 }],
    });
    const service = newService(p, r);

    const { generated } = await service.generate();
    expect(generated).toBe(0);
    expect(p.store.size).toBe(0);
  });

  test('GUARDRAIL — an official_procurement_poc person is NEVER in the target audience', async () => {
    const p = makePrisma({
      personRoles: [
        {
          id: 'role-co',
          contactUse: 'official_procurement_poc',
          reviewStatus: 'accepted',
          staleAt: null,
          person: { fullName: 'Contracting Officer Smith' },
        },
        {
          id: 'role-pm',
          contactUse: 'lobbying_contact',
          reviewStatus: 'accepted',
          staleAt: null,
          person: { fullName: 'Program Manager Jones' },
        },
      ],
    });
    const r = makeRelevance();
    const service = newService(p, r);

    await service.generate();
    const card = [...p.store.values()][0]!;
    const audience = card.targetAudience as Array<{ id: string; contactUse?: string }>;

    expect(audience.find((a) => a.id === 'role-co')).toBeUndefined();
    expect(
      audience.every((a) => !a.contactUse || !isExcludedFromRecommendations(a.contactUse as never)),
    ).toBe(true);
    // The clean lobbying contact is allowed.
    expect(audience.find((a) => a.id === 'role-pm')).toBeDefined();
  });

  test('GUARDRAIL — a CANDIDATE program match forces escalate_uncertainty + sets uncertainty', async () => {
    const p = makePrisma({
      matches: [
        {
          status: 'candidate',
          programId: 'prog-1',
          program: { id: 'prog-1', canonicalName: 'NGS Program' },
        },
      ],
    });
    const r = makeRelevance();
    const service = newService(p, r);

    await service.generate();
    const card = [...p.store.values()][0]!;

    expect(card.actionType).toBe('escalate_uncertainty');
    expect(card.uncertainty).toEqual(expect.any(String));
    expect(card.uncertainty as string).toMatch(/candidate/);
  });

  test('IDEMPOTENCY — running generate twice yields ONE card and does not reset a triaged card', async () => {
    const store = new Map<string, ActionRow>();
    const p1 = makePrisma({ store });
    const r1 = makeRelevance();
    await newService(p1, r1).generate();
    expect(store.size).toBe(1);

    // A human triages the card (status + owner set by the API layer).
    const card = [...store.values()][0]!;
    card.status = 'triaged';
    card.ownerUserId = 'user-7';

    // Second run on the SAME store: no duplicate, and the human-managed status/owner persist.
    const p2 = makePrisma({ store });
    const r2 = makeRelevance();
    const { generated } = await newService(p2, r2).generate();

    expect(generated).toBe(1); // it re-wrote the existing card (an update), not a new row
    expect(store.size).toBe(1); // still exactly one card
    const after = [...store.values()][0]!;
    expect(after.status).toBe('triaged'); // NOT reset to 'new'
    expect(after.ownerUserId).toBe('user-7'); // owner preserved
    // The update path was used, not create.
    expect(p2.tenantTx.actionRecommendation.update).toHaveBeenCalledTimes(1);
    expect(p2.tenantTx.actionRecommendation.create).not.toHaveBeenCalled();
  });

  test('G1 — dryRun computes + COUNTS the card but performs ZERO DB writes', async () => {
    const p = makePrisma();
    const r = makeRelevance();
    const service = newService(p, r);

    const { generated } = await service.generate({ dryRun: true });

    // It still counts the card it WOULD generate...
    expect(generated).toBe(1);
    // ...but NO card was persisted: the upsert (find + create/update) is skipped entirely and
    // the store stays empty. (resolveClientName may still read under withTenant — what matters
    // is that NO write occurs.)
    expect(p.store.size).toBe(0);
    expect(p.tenantTx.actionRecommendation.findFirst).not.toHaveBeenCalled();
    expect(p.tenantTx.actionRecommendation.create).not.toHaveBeenCalled();
    expect(p.tenantTx.actionRecommendation.update).not.toHaveBeenCalled();
  });

  test('G2 — a re-run where the match flips accepted→candidate UPDATES the same card to escalate_uncertainty (no duplicate)', async () => {
    const store = new Map<string, ActionRow>();

    // Run 1: an ACCEPTED match → a normal restore_cut card.
    const p1 = makePrisma({
      store,
      matches: [
        {
          status: 'accepted',
          programId: 'prog-1',
          program: { id: 'prog-1', canonicalName: 'NGS Program' },
        },
      ],
    });
    await newService(p1, makeRelevance()).generate();
    expect(store.size).toBe(1);
    expect([...store.values()][0]!.actionType).toBe('restore_cut');

    // Run 2: the SAME delta's match is now a CANDIDATE → the card must flip to
    // escalate_uncertainty. Because lookup is by (tenant, client, delta) only, this updates the
    // SAME row instead of orphaning the first and creating a second.
    const p2 = makePrisma({
      store,
      matches: [
        {
          status: 'candidate',
          programId: 'prog-1',
          program: { id: 'prog-1', canonicalName: 'NGS Program' },
        },
      ],
    });
    const { generated } = await newService(p2, makeRelevance()).generate();

    expect(generated).toBe(1);
    expect(store.size).toBe(1); // still ONE card — no duplicate row
    const after = [...store.values()][0]!;
    expect(after.actionType).toBe('escalate_uncertainty'); // actionType is a generated field, updated
    expect(p2.tenantTx.actionRecommendation.update).toHaveBeenCalledTimes(1);
    expect(p2.tenantTx.actionRecommendation.create).not.toHaveBeenCalled();
  });

  test('G2 — a concurrent P2002 on create re-finds and UPDATES instead of duplicating', async () => {
    const p = makePrisma();
    const r = makeRelevance();
    const service = newService(p, r);

    // Simulate a race: our findFirst sees nothing, but create hits the dedupe unique index
    // (a concurrent generate already inserted the row). The first create throws P2002; the
    // catch re-finds and updates. We make findFirst return null the FIRST time (pre-create
    // probe) and the racing row on the re-find.
    const racingRow: ActionRow = {
      id: 'card-raced',
      tenantId: TENANT,
      clientId: CLIENT,
      deltaId: 'delta-1',
      actionType: 'restore_cut',
      status: 'new',
    };
    // The row exists in the store (a concurrent generate inserted it), so the in-memory
    // update mock can find it by id when the catch-block re-find + update runs.
    p.store.set(`${TENANT}|${CLIENT}|delta-1`, racingRow);
    let findCalls = 0;
    p.tenantTx.actionRecommendation.findFirst.mockImplementation(async () => {
      findCalls += 1;
      return findCalls === 1 ? null : racingRow;
    });
    const p2002 = new PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
    p.tenantTx.actionRecommendation.create.mockRejectedValueOnce(p2002);

    const { generated } = await service.generate();

    expect(generated).toBe(1);
    expect(p.tenantTx.actionRecommendation.create).toHaveBeenCalledTimes(1);
    expect(p.tenantTx.actionRecommendation.update).toHaveBeenCalledTimes(1);
    expect(p.tenantTx.actionRecommendation.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'card-raced' } }),
    );
  });

  test('G3 — accepted + candidate match: card is NOT over-escalated (stays restore_cut)', async () => {
    const p = makePrisma({
      matches: [
        {
          status: 'accepted',
          programId: 'prog-1',
          program: { id: 'prog-1', canonicalName: 'NGS Program' },
        },
        {
          status: 'candidate',
          programId: 'prog-2',
          program: { id: 'prog-2', canonicalName: 'Other Program' },
        },
      ],
    });
    const r = makeRelevance();
    const service = newService(p, r);

    await service.generate();
    const card = [...p.store.values()][0]!;

    // The card relies on the ACCEPTED match, so the stray candidate must NOT force escalation.
    expect(card.actionType).toBe('restore_cut');
    expect(card.uncertainty).toBeNull();
  });

  test('G3 — ONLY a candidate match (no accepted): the card DOES escalate_uncertainty', async () => {
    const p = makePrisma({
      matches: [
        {
          status: 'candidate',
          programId: 'prog-1',
          program: { id: 'prog-1', canonicalName: 'NGS Program' },
        },
      ],
    });
    const r = makeRelevance();
    const service = newService(p, r);

    await service.generate();
    const card = [...p.store.values()][0]!;

    expect(card.actionType).toBe('escalate_uncertainty');
    expect(card.uncertainty as string).toMatch(/candidate/);
  });
});
