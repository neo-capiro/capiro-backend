import { CommunityFundingUpsertService } from './community-funding.upsert.service.js';
import type { FundingCandidate } from './community-funding.types.js';

const candidate: FundingCandidate = {
  chamber: 'house', requestType: 'cpf', fiscalYear: 2026, requesterName: 'Jane Smith', requesterState: null,
  requesterDistrict: '01', recipientName: 'Acme', recipientAddress: '1 Main St', city: 'Austin', state: 'TX', zip: null,
  projectTitle: 'Water', projectDescription: null, requestedAmountUsd: '100.00', finalAmountUsd: null,
  amountStageRaw: 'amount_requested', appropriationsAccountRaw: null, subcommittee: 'THUD',
  sourcePage: null, sourceRow: 2,
};

/**
 * In-memory fake Prisma delegate for communityFundingRequest +
 * communityFundingRequestSource, good enough to exercise the two-table upsert
 * shape (identity row + provenance row) that the real DB-backed rehearsal in
 * community-funding.cross-source-dedup.spec.ts also proves against real Postgres.
 */
function makeFakePrisma() {
  const requests = new Map<string, { id: string; data: Record<string, unknown> }>();
  const sources = new Map<string, { id: string; requestId: string; sourceDocumentId: string; sourcePage: number | null; sourceRow: number; sourceHash: string; data: Record<string, unknown> }>();
  let nextId = 1;
  const requestDelegate = {
    findUnique: jest.fn(async ({ where }: { where: { identityHash: string } }) => {
      const row = requests.get(where.identityHash);
      return row ? { id: row.id, ...row.data } : null;
    }),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const id = `req-${nextId++}`;
      requests.set(data.identityHash as string, { id, data });
      return { id, ...data };
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      for (const row of requests.values()) {
        if (row.id === where.id) { row.data = { ...row.data, ...data }; return { id: row.id, ...row.data }; }
      }
      throw new Error('not found');
    }),
  };
  const sourceDelegate = {
    findFirst: jest.fn(async ({ where }: { where: { requestId: string; sourceDocumentId: string; sourcePage: number | null; sourceRow: number } }) => {
      for (const row of sources.values()) {
        if (row.requestId === where.requestId && row.sourceDocumentId === where.sourceDocumentId && row.sourcePage === where.sourcePage && row.sourceRow === where.sourceRow) {
          return { id: row.id, sourceHash: row.sourceHash };
        }
      }
      return null;
    }),
    create: jest.fn(async ({ data }: { data: { requestId: string; sourceDocumentId: string; sourcePage: number | null; sourceRow: number; sourceHash: string } & Record<string, unknown> }) => {
      const id = `src-${nextId++}`;
      sources.set(id, { id, requestId: data.requestId, sourceDocumentId: data.sourceDocumentId, sourcePage: data.sourcePage, sourceRow: data.sourceRow, sourceHash: data.sourceHash, data });
      return { id, ...data };
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: { sourceHash: string } & Record<string, unknown> }) => {
      const row = sources.get(where.id);
      if (!row) throw new Error('not found');
      row.sourceHash = data.sourceHash; row.data = { ...row.data, ...data };
      return { id: row.id, ...row.data };
    }),
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn({ communityFundingRequest: requestDelegate, communityFundingRequestSource: sourceDelegate }),
    ),
    _requests: requests,
    _sources: sources,
  };
  return prisma;
}

describe('CommunityFundingUpsertService', () => {
  it('uses one real transaction, persists a canonical row and a provenance row, and is idempotent', async () => {
    const prisma = makeFakePrisma();
    const service = new CommunityFundingUpsertService(prisma as never);
    const doc = '00000000-0000-0000-0000-000000000001';

    expect(await service.upsertMany([candidate], doc)).toMatchObject({ upserted: 1, changed: 0, unchanged: 0, provenanceInserted: 1, provenanceUnchanged: 0 });
    expect(await service.upsertMany([candidate], doc)).toMatchObject({ upserted: 0, changed: 0, unchanged: 1, provenanceInserted: 0, provenanceUnchanged: 1 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma._requests.size).toBe(1);
    expect(prisma._sources.size).toBe(1);
    const [request] = [...prisma._requests.values()];
    expect(request!.data).toMatchObject({ recipientNormalized: 'ACME' });
    // No sourceDocumentId/sourcePage/sourceRow on the canonical row at all — that's
    // the repair. Provenance carries it instead.
    expect(request!.data).not.toHaveProperty('sourceDocumentId');
    const [source] = [...prisma._sources.values()];
    expect(source).toMatchObject({ sourceDocumentId: doc, sourceRow: 2 });
  });

  it('creates a distinct canonical identity for a genuinely different request (different title), but keeps a non-identity correction on the same identity', async () => {
    const prisma = makeFakePrisma();
    const service = new CommunityFundingUpsertService(prisma as never);
    const doc = '00000000-0000-0000-0000-000000000001';

    await service.upsertMany([candidate], doc);
    await service.upsertMany([{ ...candidate, city: 'Dallas' }], doc); // non-identity field correction
    expect(prisma._requests.size).toBe(1); // still one canonical row

    await service.upsertMany([{ ...candidate, projectTitle: 'Different' }], doc); // identity-changing
    expect(prisma._requests.size).toBe(2); // now two distinct canonical rows
  });

  it('THE EXACT BUG THIS REPAIRS: the same logical request ingested from two different SourceDocuments collapses to ONE canonical row with TWO provenance rows', async () => {
    const prisma = makeFakePrisma();
    const service = new CommunityFundingUpsertService(prisma as never);
    const subcommitteePdfDoc = '00000000-0000-0000-0000-0000000000a1'; // House subcommittee CPF PDF
    const consolidatedXlsxDoc = '00000000-0000-0000-0000-0000000000a2'; // House consolidated CPF XLSX

    // Same real request, published in two different official documents with slightly
    // different row/page provenance (PDF has a page, XLSX does not) but identical
    // identity fields once normalized.
    const fromPdf: FundingCandidate = { ...candidate, sourcePage: 12, sourceRow: 3 };
    const fromXlsx: FundingCandidate = { ...candidate, sourcePage: null, sourceRow: 891, amountStageRaw: 'amount_requested' };

    await service.upsertMany([fromPdf], subcommitteePdfDoc);
    await service.upsertMany([fromXlsx], consolidatedXlsxDoc);

    expect(prisma._requests.size).toBe(1); // ONE canonical community_funding_request row
    expect(prisma._sources.size).toBe(2); // TWO community_funding_request_source rows

    const sourceDocs = new Set([...prisma._sources.values()].map((s) => s.sourceDocumentId));
    expect(sourceDocs).toEqual(new Set([subcommitteePdfDoc, consolidatedXlsxDoc])); // source document IDs differ
    // Both provenance rows remain accessible under the SAME single canonical request.
    const requestIds = new Set([...prisma._sources.values()].map((s) => s.requestId));
    expect(requestIds.size).toBe(1);

    // Re-running EITHER source again does not add duplicates.
    await service.upsertMany([fromPdf], subcommitteePdfDoc);
    await service.upsertMany([fromXlsx], consolidatedXlsxDoc);
    expect(prisma._requests.size).toBe(1);
    expect(prisma._sources.size).toBe(2);
  });

  it('precedence: never overwrites a non-null final/enacted amount with a requested-only value from a later source', async () => {
    const prisma = makeFakePrisma();
    const service = new CommunityFundingUpsertService(prisma as never);
    const docA = '00000000-0000-0000-0000-0000000000b1';
    const docB = '00000000-0000-0000-0000-0000000000b2';

    const withFinal: FundingCandidate = { ...candidate, sourceRow: 1, finalAmountUsd: '150.00', amountStageRaw: 'house_amount' };
    await service.upsertMany([withFinal], docA);

    const requestedOnlyLater: FundingCandidate = { ...candidate, sourceRow: 2, finalAmountUsd: null, amountStageRaw: 'amount_requested', requestedAmountUsd: '999.00' };
    await service.upsertMany([requestedOnlyLater], docB);

    const [request] = [...prisma._requests.values()];
    expect(request!.data.finalAmountUsd).toBe('150.00'); // preserved, never nulled out
  });

  it('precedence: escalates requestedAmountUsd/amountStageRaw only to a strictly higher-ranked stage, never demotes', async () => {
    const prisma = makeFakePrisma();
    const service = new CommunityFundingUpsertService(prisma as never);
    const docA = '00000000-0000-0000-0000-0000000000c1';
    const docB = '00000000-0000-0000-0000-0000000000c2';

    const requestedOnly: FundingCandidate = { ...candidate, sourceRow: 1, amountStageRaw: 'amount_requested', requestedAmountUsd: '100.00' };
    await service.upsertMany([requestedOnly], docA);

    const houseAmount: FundingCandidate = { ...candidate, sourceRow: 2, amountStageRaw: 'house_amount', requestedAmountUsd: '80.00' };
    await service.upsertMany([houseAmount], docB);

    let [request] = [...prisma._requests.values()];
    expect(request!.data).toMatchObject({ amountStageRaw: 'house_amount', requestedAmountUsd: '80.00' }); // escalated

    // A later, same-or-lower-ranked source must not demote it back.
    const anotherRequestedOnly: FundingCandidate = { ...candidate, sourceRow: 3, amountStageRaw: 'amount_requested', requestedAmountUsd: '5000.00' };
    await service.upsertMany([anotherRequestedOnly], docA);
    [request] = [...prisma._requests.values()];
    expect(request!.data).toMatchObject({ amountStageRaw: 'house_amount', requestedAmountUsd: '80.00' }); // unchanged
  });

  it('Senate CDS: the identity/provenance design allows multiple source documents for the same request without any House-specific assumption in the model', async () => {
    // Even though no duplicate official Senate CDS publication is currently known
    // (see identity.ts/upsert.service.ts — grep confirms zero 'house'/'senate'
    // literals in either module), the model must not special-case chamber. Prove it
    // with a Senate candidate run through the exact same multi-source path as the
    // House test above.
    const senateCandidate: FundingCandidate = {
      chamber: 'senate', requestType: 'cds', fiscalYear: 2026, requesterName: 'Boozman', requesterState: 'AR',
      requesterDistrict: null, recipientName: 'Dale Bumpers National Rice Research Center', recipientAddress: null,
      city: null, state: 'AR', zip: null, projectTitle: 'Equipment and Infrastructure Modernization.',
      projectDescription: null, requestedAmountUsd: '3100000.00', finalAmountUsd: null,
      amountStageRaw: 'senate_recommendation', appropriationsAccountRaw: 'Agricultural Research Service Buildings and Facilities',
      subcommittee: 'Agriculture', sourcePage: 1, sourceRow: 1,
    };
    const prisma = makeFakePrisma();
    const service = new CommunityFundingUpsertService(prisma as never);
    const senateSubcommitteePdf = '00000000-0000-0000-0000-0000000000d1';
    const hypotheticalSecondSenateDoc = '00000000-0000-0000-0000-0000000000d2';

    await service.upsertMany([senateCandidate], senateSubcommitteePdf);
    await service.upsertMany([{ ...senateCandidate, sourceRow: 99 }], hypotheticalSecondSenateDoc);

    expect(prisma._requests.size).toBe(1); // one canonical CDS request
    expect(prisma._sources.size).toBe(2); // two provenance rows, exactly like the House case
    const [request] = [...prisma._requests.values()];
    expect(request!.data).toMatchObject({ chamber: 'senate', requestType: 'cds' });
  });
});
