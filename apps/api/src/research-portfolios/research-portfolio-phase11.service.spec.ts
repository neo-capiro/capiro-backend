import { ResearchPortfolioPhase11Service } from './research-portfolio-phase11.service.js';
const ctx: any = { tenantId: 'tenant-1', userId: 'user-1', role: 'standard_user' };
describe('ResearchPortfolioPhase11Service client-fit authority', () => {
  function harness(role = 'viewer') {
    const tx: any = {
      researchPortfolio: {
        findFirst: jest
          .fn()
          .mockResolvedValue({
            id: 'portfolio-1',
            revision: 7,
            lifecycle: 'active',
            grants: [{ role }],
            clientLinks: [{ clientId: 'denied-client' }, { clientId: 'allowed-client' }],
          }),
      },
      researchPortfolioMember: { findMany: jest.fn().mockResolvedValue([]) },
      researchPortfolioRuleVersion: { findMany: jest.fn().mockResolvedValue([]) },
      client: { findFirst: jest.fn().mockResolvedValue({ id: 'allowed-client', name: 'Allowed' }) },
      clientCapability: { findMany: jest.fn().mockResolvedValue([]) },
      researchPortfolioFitVersion: {
        createMany: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      $queryRawUnsafe: jest.fn(async (_sql: string, _tenant: string, client: string) => [
        { allowed: client === 'allowed-client' },
      ]),
    };
    return {
      tx,
      service: new ResearchPortfolioPhase11Service({
        withTenantUser: async (_tenant: string, _user: string, action: any) => action(tx),
      } as any),
    };
  }
  it('filters denied client identifiers independently from public portfolio access', async () => {
    const { tx, service } = harness();
    const fit = await service.getFit(ctx, 'portfolio-1');
    expect(fit.clientFits).toEqual([expect.objectContaining({ clientId: 'allowed-client' })]);
    expect(JSON.stringify(fit)).not.toContain('denied-client');
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });
  it('uses the same current client wall after refresh and revocation', async () => {
    const { tx, service } = harness('editor');
    expect((await service.refreshFit(ctx, 'portfolio-1')).clientFits).toHaveLength(1);
    tx.$queryRawUnsafe.mockResolvedValue([{ allowed: false }]);
    expect((await service.getFit(ctx, 'portfolio-1')).clientFits).toEqual([]);
    expect((await service.refreshFit(ctx, 'portfolio-1')).clientFits).toEqual([]);
  });
  it('keeps revoked portfolio access and viewer refresh fail closed', async () => {
    const { tx, service } = harness();
    await expect(service.refreshFit(ctx, 'portfolio-1')).rejects.toThrow('editor access required');
    tx.researchPortfolio.findFirst.mockResolvedValue(null);
    await expect(service.getFit(ctx, 'portfolio-1')).rejects.toThrow('not found');
  });
});

function requiredFit(result: Awaited<ReturnType<ResearchPortfolioPhase11Service['getFit']>>) {
  const row = result.clientFits[0];
  expect(row).toBeDefined();
  expect(row?.basis).toBeDefined();
  expect(row?.memberMatches).toBeDefined();
  if (!row || !row.basis || !row.memberMatches)
    throw new Error('Expected a fit row with explicit qualified basis and member outcomes');
  return { ...row, basis: row.basis, memberMatches: row.memberMatches };
}

describe('Research portfolio qualified direct fit versions', () => {
  function harness() {
    const portfolio: any = {
      id: 'portfolio-1',
      revision: 7,
      lifecycle: 'active',
      grants: [{ role: 'editor' }],
      clientLinks: [{ clientId: 'denied-client' }, { clientId: 'allowed-client' }],
    };
    const members: any[] = [
      { id: 'member-a', revision: 1, targetKind: 'program_element', targetId: '0604115A' },
      { id: 'member-b', revision: 1, targetKind: 'program_element', targetId: '0609999A' },
      { id: 'member-c', revision: 1, targetKind: 'project', targetId: 'unsupported-project' },
      { id: 'member-d', revision: 1, targetKind: 'program_element', targetId: 'candidate-pe' },
    ];
    const capabilities: any[] = [
      {
        id: 'cap-a',
        peNumbers: ['0604115A'],
        updatedAt: new Date('2026-09-28T00:00:00Z'),
        name: 'Declared association',
      },
    ];
    const versions = new Map<string, any>();
    const tx: any = {
      researchPortfolio: { findFirst: jest.fn(async () => portfolio) },
      researchPortfolioMember: { findMany: jest.fn(async () => members) },
      researchPortfolioRuleVersion: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            {
              id: 'rule-1',
              version: 1,
              schemaVersion: 1,
              expression: { kind: 'condition', field: 'component', operator: 'eq', value: 'ARMY' },
            },
          ]),
      },
      client: {
        findFirst: jest.fn(async ({ where }: any) => ({ id: where.id, name: 'Visible client' })),
      },
      clientCapability: { findMany: jest.fn(async () => capabilities) },
      programElement: {
        findUnique: jest.fn(async ({ where }: any) => ({
          peCode: where.peCode,
          title: 'Canonical PE',
          service: 'Army',
          sourceConfidence: where.peCode === 'candidate-pe' ? null : 0.9,
          raw: {},
          sources: [
            {
              id: 'pe-source',
              sourceDocumentId: 'source-revision-1',
              confidence: 0.9,
              pageNumber: 3,
              fy: 2027,
              sourceDocument: { sha256: 'a'.repeat(64), supersededByDocumentId: null },
            },
          ],
        })),
      },
      capabilityBudgetLineMatch: { findMany: jest.fn().mockResolvedValue([]) },
      researchPortfolioFitVersion: {
        createMany: jest.fn(async ({ data }: any) => {
          for (const row of data)
            if (!versions.has(row.basisFingerprint))
              versions.set(row.basisFingerprint, {
                ...row,
                id: `fit-version-${versions.size + 1}`,
                createdAt: new Date('2026-09-28T01:00:00Z'),
              });
          return { count: 1 };
        }),
        findUnique: jest.fn(
          async ({ where }: any) =>
            versions.get(where.tenantId_portfolioId_clientId_basisFingerprint.basisFingerprint) ??
            null,
        ),
      },
      $queryRawUnsafe: jest.fn(async (_sql: string, _tenant: string, clientId: string) => [
        { allowed: clientId === 'allowed-client' },
      ]),
    };
    const prisma: any = {
      withTenantUser: jest.fn(async (_tenant: string, _user: string, work: any) => work(tx)),
    };
    return {
      tx,
      portfolio,
      members,
      capabilities,
      versions,
      prisma,
      service: new ResearchPortfolioPhase11Service(prisma),
    };
  }
  it('calculates the supported qualified subset with real native scorer/rules and reads without writing', async () => {
    const { tx, prisma, service } = harness();
    const fit = await service.getFit(ctx, 'portfolio-1');
    expect(fit.clientFits).toHaveLength(1);
    expect(requiredFit(fit)).toMatchObject({
      clientId: 'allowed-client',
      fitScore: 50,
      availability: 'partial',
      refreshedAt: null,
      basis: {
        calculationVersion: 'qualified-direct-pe-v1',
        scoreBasis: 'direct_qualified_pe_association_share',
        portfolioRevision: 7,
        totalIncludedMemberCount: 4,
        supportedMemberCount: 2,
        matchedMemberCount: 1,
      },
      ruleMatches: [{ ruleVersionId: 'rule-1', result: 'match', matched: true }],
    });
    expect(requiredFit(fit).memberMatches.map((row: any) => row.matched)).toEqual([
      true,
      false,
      null,
      null,
    ]);
    expect(JSON.stringify(fit)).not.toContain('denied-client');
    expect(tx.clientCapability.findMany).toHaveBeenCalledTimes(1);
    expect(tx.researchPortfolioFitVersion.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.researchPortfolioFitVersion.createMany).not.toHaveBeenCalled();
    expect(prisma.withTenantUser).toHaveBeenCalledWith(
      ctx.tenantId,
      ctx.userId,
      expect.any(Function),
    );
  });
  it('persists an immutable basis once and creates a new version when declared associations change', async () => {
    const { tx, capabilities, versions, service } = harness();
    const first = requiredFit(await service.refreshFit(ctx, 'portfolio-1'));
    const replay = requiredFit(await service.refreshFit(ctx, 'portfolio-1'));
    expect(replay.versionId).toBe(first.versionId);
    expect(versions.size).toBe(1);
    const original = JSON.stringify([...versions.values()][0]);
    capabilities[0].peNumbers.push('0609999A');
    expect(requiredFit(await service.getFit(ctx, 'portfolio-1')).versionId).toBeUndefined();
    expect(versions.size).toBe(1);
    const second = requiredFit(await service.refreshFit(ctx, 'portfolio-1'));
    expect(second.fitScore).toBe(100);
    expect(second.versionId).not.toBe(first.versionId);
    expect(second.basis.basisFingerprint).not.toBe(first.basis.basisFingerprint);
    expect(versions.size).toBe(2);
    expect(JSON.stringify([...versions.values()][0])).toBe(original);
    expect(tx.researchPortfolioFitVersion.createMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });
  it('returns null with explicit unavailable qualification and refuses archived or viewer persistence', async () => {
    const { tx, portfolio, members, service } = harness();
    members.splice(0, members.length, {
      id: 'unsupported',
      targetKind: 'project',
      targetId: 'project',
    });
    expect(requiredFit(await service.getFit(ctx, 'portfolio-1'))).toMatchObject({
      fitScore: null,
      availability: 'unavailable',
      basis: { supportedMemberCount: 0 },
    });
    portfolio.lifecycle = 'archived';
    await expect(service.refreshFit(ctx, 'portfolio-1')).rejects.toThrow('read-only');
    portfolio.lifecycle = 'active';
    portfolio.grants = [{ role: 'viewer' }];
    await expect(service.refreshFit(ctx, 'portfolio-1')).rejects.toThrow('editor access required');
    expect(tx.researchPortfolioFitVersion.createMany).not.toHaveBeenCalled();
  });
  it('masks durable private versions after wall revocation before any private input/history read', async () => {
    const { tx, service } = harness();
    await service.refreshFit(ctx, 'portfolio-1');
    tx.$queryRawUnsafe.mockResolvedValue([{ allowed: false }]);
    tx.clientCapability.findMany.mockClear();
    tx.researchPortfolioFitVersion.findUnique.mockClear();
    expect((await service.getFit(ctx, 'portfolio-1')).clientFits).toEqual([]);
    expect(tx.clientCapability.findMany).not.toHaveBeenCalled();
    expect(tx.researchPortfolioFitVersion.findUnique).not.toHaveBeenCalled();
  });
  it('refuses to score a confidence-only PE without a retained source hash and locator', async () => {
    const { tx, members, service } = harness();
    members.splice(0, members.length, {
      id: 'pe-member',
      revision: 1,
      targetKind: 'program_element',
      targetId: '0604115A',
    });
    tx.programElement.findUnique.mockResolvedValue({
      peCode: '0604115A',
      title: 'Confidence without provenance',
      service: 'Army',
      sourceConfidence: 1,
      raw: {},
      sources: [
        {
          id: 'unhashed-source',
          confidence: 1,
          sourceDocument: { sha256: null },
          pageNumber: null,
        },
      ],
    });
    expect(requiredFit(await service.getFit(ctx, 'portfolio-1'))).toMatchObject({
      fitScore: null,
      availability: 'unavailable',
      memberMatches: [
        {
          matched: null,
          reasons: ['canonical_pe_not_currently_qualified_with_hashed_source_and_locator'],
        },
      ],
    });
  });
  it.each([
    { pageNumber: 0 },
    { pageNumber: -1 },
    { pageNumber: 3, pageEnd: 2 },
    { pageNumber: null, metadata: { locator: {} } },
    { pageNumber: null, metadata: { locator: { xmlPath: '   ' } } },
    { pageNumber: null, metadata: { locator: { start: 9, end: 2 } } },
    { pageNumber: null, metadata: { locator: { page: 0, xmlPath: '/budget/pe' } } },
  ])(
    'withholds a direct fit denominator when hashed source coordinates are malformed %j',
    async (coordinates) => {
      const { tx, members, service } = harness();
      members.splice(0, members.length, {
        id: 'pe-member',
        revision: 1,
        targetKind: 'program_element',
        targetId: '0604115A',
      });
      tx.programElement.findUnique.mockResolvedValue({
        peCode: '0604115A',
        title: 'Canonical PE',
        service: 'Army',
        sourceConfidence: 1,
        raw: {},
        sources: [
          {
            id: 'bad-locator-source',
            confidence: 1,
            sourceDocument: { sha256: 'a'.repeat(64) },
            ...coordinates,
          },
        ],
      });
      const result = requiredFit(await service.getFit(ctx, 'portfolio-1'));
      expect(result).toMatchObject({
        fitScore: null,
        availability: 'unavailable',
        basis: { supportedMemberCount: 0 },
        memberMatches: [{ matched: null }],
      });
      expect(tx.researchPortfolioFitVersion.createMany).not.toHaveBeenCalled();
    },
  );
  it.each([
    { pageNumber: 3, pageEnd: 4 },
    { pageNumber: null, metadata: { locator: { xmlPath: '/budget/pe' } } },
    { pageNumber: null, metadata: { locator: { span: { start: 0, end: 8 } } } },
  ])(
    'retains supported direct PE association fit for an actual typed source locator %j',
    async (coordinates) => {
      const { tx, members, service } = harness();
      members.splice(0, members.length, {
        id: 'pe-member',
        revision: 1,
        targetKind: 'program_element',
        targetId: '0604115A',
      });
      tx.programElement.findUnique.mockResolvedValue({
        peCode: '0604115A',
        title: 'Canonical PE',
        service: 'Army',
        sourceConfidence: 1,
        raw: {},
        sources: [
          {
            id: 'typed-source',
            confidence: 1,
            sourceDocument: { sha256: 'a'.repeat(64) },
            ...coordinates,
          },
        ],
      });
      expect(requiredFit(await service.getFit(ctx, 'portfolio-1'))).toMatchObject({
        fitScore: 100,
        availability: 'available',
        basis: { supportedMemberCount: 1 },
        memberMatches: [{ matched: true }],
      });
    },
  );
});

describe('Owned dormant watch conversion', () => {
  const wid = (n: number) => `ed202609-2800-4000-8000-${String(n).padStart(12, '0')}`;
  function harness() {
    const portfolio: any = {
        id: 'portfolio-1',
        tenantId: ctx.tenantId,
        revision: 7,
        lifecycle: 'active',
        grants: [{ role: 'editor' }],
        clientLinks: [],
      },
      watches: any[] = [
        {
          id: wid(8061),
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          peCode: 'PE1',
          createdAt: new Date('2026-01-01'),
        },
        {
          id: wid(8062),
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          peCode: 'PE2',
          createdAt: new Date('2026-01-01'),
        },
        {
          id: wid(8063),
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          peCode: 'PE3',
          createdAt: new Date('2026-01-01'),
        },
        {
          id: wid(8064),
          tenantId: ctx.tenantId,
          userId: 'other-user',
          peCode: 'PE1',
          createdAt: new Date('2026-01-01'),
        },
      ];
    const members: any[] = [
        { id: 'm1', targetId: 'PE1', revision: 1 },
        { id: 'm2', targetId: 'PE2', revision: 1 },
      ],
      subscriptions: any[] = [
        {
          id: 'existing-preferred',
          tenantId: ctx.tenantId,
          portfolioId: portfolio.id,
          subscriberUserId: ctx.userId,
          targetKind: 'program_element',
          targetId: 'PE2',
          channel: 'email',
          cadence: 'weekly',
          active: true,
          updatedAt: new Date('2026-01-01'),
        },
        {
          id: 'other-user-sub',
          tenantId: ctx.tenantId,
          portfolioId: portfolio.id,
          subscriberUserId: 'other-user',
          targetKind: 'program_element',
          targetId: 'PE1',
          channel: 'in_app',
          cadence: 'immediate',
          active: true,
          updatedAt: new Date('2026-01-01'),
        },
      ];
    const events = new Map<string, any>();
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: portfolio.id }]),
      researchPortfolio: {
        findFirst: jest.fn(async () => portfolio),
        updateMany: jest.fn(async () => {
          portfolio.revision++;
          return { count: 1 };
        }),
      },
      programElementWatch: {
        findMany: jest.fn(async ({ where }: any) =>
          watches.filter((w) => w.tenantId === where.tenantId && w.userId === where.userId),
        ),
        update: jest.fn(),
        deleteMany: jest.fn(),
      },
      researchPortfolioMember: { findMany: jest.fn(async () => members) },
      researchPortfolioSubscription: {
        findMany: jest.fn(async ({ where }: any) =>
          subscriptions.filter(
            (s) =>
              s.tenantId === where.tenantId &&
              s.portfolioId === where.portfolioId &&
              s.subscriberUserId === where.subscriberUserId &&
              where.targetId.in.includes(s.targetId),
          ),
        ),
        createMany: jest.fn(async ({ data }: any) => {
          subscriptions.push({ ...data[0], id: 'converted-own', updatedAt: new Date() });
          return { count: 1 };
        }),
        findFirst: jest.fn(async ({ where }: any) =>
          subscriptions.find((s) =>
            Object.entries(where).every(([key, value]) => s[key] === value),
          ),
        ),
        update: jest.fn(),
      },
      researchPortfolioEvent: {
        findFirst: jest.fn(async ({ where }: any) =>
          where.idempotencyKey
            ? (events.get(where.idempotencyKey) ?? null)
            : { id: 'baseline', occurredAt: new Date('2026-01-01') },
        ),
        create: jest.fn(async ({ data }: any) => {
          events.set(data.idempotencyKey, data);
          return data;
        }),
      },
      researchPortfolioSubscriptionDelivery: { createMany: jest.fn() },
    };
    const service = new ResearchPortfolioPhase11Service({
      withTenant: async (_tenant: string, work: any) => work(tx),
    } as any);
    const request = async (ids = [wid(8061)]) => {
      const p = await service.previewWatchConversion(ctx, portfolio.id);
      return {
        idempotencyKey: 'owned-convert',
        expectedRevision: p.expectedRevision,
        previewHash: p.previewHash,
        selectedWatchIds: ids,
      };
    };
    return { tx, service, portfolio, watches, members, subscriptions, events, request };
  }
  it('previews actual owned watches, included members and matching own subscriptions without writes', async () => {
    const h = harness(),
      result = await h.service.previewWatchConversion(ctx, h.portfolio.id);
    expect(result).toMatchObject({
      legacyWatches: 3,
      convertibleWatches: 1,
      alreadyConverted: 1,
      expectedRevision: 7,
      previewHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(result.previewItems.map((x) => x.reason)).toEqual([
      'convertible',
      'already_subscribed',
      'not_included_member',
    ]);
    expect(JSON.stringify(result)).not.toContain('other-user');
    expect(h.tx.researchPortfolioEvent.create).not.toHaveBeenCalled();
    expect(h.tx.researchPortfolioSubscription.createMany).not.toHaveBeenCalled();
  });
  it('creates only selected dormant subscriptions with quiet baseline and preserves legacy watches and existing recipient preferences', async () => {
    const h = harness(),
      preferences = JSON.stringify(h.subscriptions[0]);
    const result = await h.service.applyWatchConversion(
      ctx,
      h.portfolio.id,
      await h.request([wid(8061), wid(8062)]),
    );
    expect(result).toMatchObject({ convertedCount: 1, skippedCount: 1, revision: 8 });
    expect(h.tx.researchPortfolioSubscription.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            subscriberUserId: ctx.userId,
            targetId: 'PE1',
            active: false,
            channel: 'in_app',
            cadence: 'immediate',
            baselineRevision: 7,
            checkpoint: expect.objectContaining({
              quietFirstBaseline: true,
              dormantConversion: true,
              legacyWatchId: wid(8061),
            }),
          }),
        ],
        skipDuplicates: true,
      }),
    );
    expect(JSON.stringify(h.subscriptions[0])).toBe(preferences);
    expect(h.tx.researchPortfolioSubscription.update).not.toHaveBeenCalled();
    expect(h.tx.programElementWatch.deleteMany).not.toHaveBeenCalled();
    expect(h.tx.programElementWatch.update).not.toHaveBeenCalled();
    expect(h.tx.researchPortfolioSubscriptionDelivery.createMany).not.toHaveBeenCalled();
    const events = JSON.stringify([...h.events.values()]);
    expect(events).not.toContain(wid(8061));
    expect(events).not.toContain('converted-own');
    const lock = h.tx.$queryRaw.mock.invocationCallOrder[0],
      auth = h.tx.researchPortfolio.findFirst.mock.invocationCallOrder.at(-1);
    expect(lock).toBeDefined();
    expect(auth).toBeDefined();
    if (lock === undefined || auth === undefined) throw new Error('Lock/auth calls absent');
    expect(lock).toBeLessThan(auth);
  });
  it('does not overwrite a selected existing subscription or bump business revision for a no-op', async () => {
    const h = harness();
    const r = await h.service.applyWatchConversion(
      ctx,
      h.portfolio.id,
      await h.request([wid(8062)]),
    );
    expect(r).toMatchObject({ convertedCount: 0, skippedCount: 1, revision: 7 });
    expect(h.tx.researchPortfolioSubscription.createMany).not.toHaveBeenCalled();
    expect(h.tx.researchPortfolio.updateMany).not.toHaveBeenCalled();
  });
  it('replays the original actor/request after archive and revision drift with no duplicated effects', async () => {
    const h = harness(),
      input = await h.request(),
      receipt = await h.service.applyWatchConversion(ctx, h.portfolio.id, input);
    h.portfolio.revision = 80;
    h.portfolio.lifecycle = 'archived';
    h.tx.researchPortfolioSubscription.createMany.mockClear();
    h.tx.researchPortfolioEvent.create.mockClear();
    await expect(h.service.applyWatchConversion(ctx, h.portfolio.id, input)).resolves.toEqual(
      receipt,
    );
    expect(h.tx.researchPortfolioSubscription.createMany).not.toHaveBeenCalled();
    expect(h.tx.researchPortfolioEvent.create).not.toHaveBeenCalled();
    await expect(
      h.service.applyWatchConversion({ ...ctx, userId: 'another-editor' }, h.portfolio.id, input),
    ).rejects.toThrow('another actor');
    await expect(
      h.service.applyWatchConversion(ctx, h.portfolio.id, {
        ...input,
        selectedWatchIds: [wid(8062)],
      }),
    ).rejects.toThrow('immutable request');
    h.portfolio.grants = [{ role: 'viewer' }];
    await expect(h.service.applyWatchConversion(ctx, h.portfolio.id, input)).rejects.toThrow(
      'editor access required',
    );
  });
  it('rejects an uncertain stale preview when owned watches or preferences change', async () => {
    const h = harness(),
      input = await h.request();
    h.subscriptions[0].active = false;
    await expect(h.service.applyWatchConversion(ctx, h.portfolio.id, input)).rejects.toThrow(
      'preview changed',
    );
    expect(h.tx.researchPortfolioSubscription.createMany).not.toHaveBeenCalled();
  });
  it.each([
    { ids: [wid(8063)] },
    { ids: [wid(8064)] },
    { ids: [] },
    { ids: [wid(8061), wid(8061)] },
  ])('rejects unowned, unincluded or malformed explicit selection %j', async ({ ids }) => {
    const h = harness();
    await expect(
      h.service.applyWatchConversion(ctx, h.portfolio.id, await h.request(ids)),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.tx.researchPortfolioSubscription.createMany).not.toHaveBeenCalled();
  });
  it('rejects new archive/revision writes and bounds its actual source query', async () => {
    const h = harness(),
      input = await h.request();
    h.portfolio.lifecycle = 'archived';
    await expect(h.service.applyWatchConversion(ctx, h.portfolio.id, input)).rejects.toThrow(
      'archived',
    );
    h.portfolio.lifecycle = 'active';
    h.portfolio.revision++;
    await expect(h.service.applyWatchConversion(ctx, h.portfolio.id, input)).rejects.toThrow(
      'revision mismatch',
    );
    h.watches.splice(
      0,
      h.watches.length,
      ...Array.from({ length: 201 }, (_, n) => ({
        id: wid(9000 + n),
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        peCode: `PE${n}`,
        createdAt: new Date(),
      })),
    );
    await expect(h.service.previewWatchConversion(ctx, h.portfolio.id)).rejects.toThrow(
      'at most 200',
    );
  });
});

describe('Honest domain operation status and bounded reconciliation', () => {
  const oid = 'ed202609-2800-4000-8000-000000009500',
    time = new Date('2026-09-01T00:00:00Z');
  function harness() {
    const portfolio: any = {
        id: 'portfolio-1',
        grants: [{ role: 'editor' }],
        clientLinks: [{ clientId: 'allowed-client' }],
      },
      row: any = {
        id: oid,
        portfolioId: portfolio.id,
        status: 'created',
        fileName: 'original.csv',
        createdAt: time,
        updatedAt: new Date('2026-09-02'),
      };
    const tx: any = {
      researchPortfolio: { findFirst: jest.fn(async () => portfolio) },
      researchPortfolioImportJob: { findFirst: jest.fn(async () => row) },
      researchPortfolioRecomputeJob: { findFirst: jest.fn().mockResolvedValue(null) },
      researchPortfolioOutputJob: { findFirst: jest.fn().mockResolvedValue(null) },
      researchPortfolioSnapshot: { findFirst: jest.fn().mockResolvedValue(null) },
      researchPortfolioClientFilingJob: { findFirst: jest.fn().mockResolvedValue(null) },
      researchPortfolioEvent: {
        findFirst: jest.fn().mockResolvedValue({ actorUserId: 'original-actor', occurredAt: time }),
      },
      researchPortfolioImportAttempt: { count: jest.fn().mockResolvedValue(2) },
      researchPortfolioOutputAttempt: {
        count: jest.fn().mockResolvedValue(1),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      tenantMembership: { findFirst: jest.fn().mockResolvedValue({ id: 'active-membership' }) },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
    };
    const outputs: any = {
      reconcile: jest.fn(async () => {
        row.status = 'completed';
      }),
      saveToClient: jest.fn(async () => {
        row.status = 'completed';
        row.completedAt = time;
      }),
    };
    const service = new ResearchPortfolioPhase11Service(
      { withTenantUser: async (_tenant: string, _user: string, work: any) => work(tx) } as any,
      outputs,
    );
    return { tx, portfolio, row, outputs, service };
  }
  it('uses exact immutable import creator and real retry attempts, maps pending state and leaves uncaptured dates null', async () => {
    const h = harness();
    expect(await h.service.getOperation(ctx, h.portfolio.id, oid)).toMatchObject({
      actorUserId: 'original-actor',
      status: 'queued',
      domainStatus: 'created',
      startedAt: null,
      completedAt: null,
      retryCount: 2,
    });
    expect(h.tx.researchPortfolioEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          eventKind: 'import_created',
          payload: { path: ['jobId'], equals: oid },
        }),
      }),
    );
    h.tx.researchPortfolioEvent.findFirst.mockResolvedValue(null);
    expect(await h.service.getOperation(ctx, h.portfolio.id, oid)).toMatchObject({
      actorUserId: null,
      limitations: expect.arrayContaining(['Original actor provenance was not captured.']),
    });
  });
  it.each([
    ['paused', 'paused'],
    ['compensated', 'completed'],
    ['needs_reconciliation', 'outcome_unknown'],
    ['future_unknown', 'outcome_unknown'],
  ])('reports %s with truthful original status', async (native, status) => {
    const h = harness();
    h.row.status = native;
    expect(await h.service.getOperation(ctx, h.portfolio.id, oid)).toMatchObject({
      domainStatus: native,
      status,
    });
  });
  it('uses immutable publication author and completion observation without inventing start', async () => {
    const h = harness();
    h.tx.researchPortfolioImportJob.findFirst.mockResolvedValue(null);
    h.row.status = 'partial';
    h.row.attempt = 3;
    h.tx.researchPortfolioRecomputeJob.findFirst.mockResolvedValue(h.row);
    expect(await h.service.getOperation(ctx, h.portfolio.id, oid)).toMatchObject({
      actorUserId: 'original-actor',
      retryCount: 2,
      startedAt: null,
      completedAt: time.toISOString(),
      domainStatus: 'partial',
    });
  });
  it('uses the actual output requester and completion attempt and dispatches the safe existing reconciler with editor reauthorization', async () => {
    const h = harness();
    h.tx.researchPortfolioImportJob.findFirst.mockResolvedValue(null);
    h.row.status = 'outcome_unknown';
    h.row.request = { requestedByUserId: 'request-actor' };
    h.tx.researchPortfolioOutputJob.findFirst.mockResolvedValue(h.row);
    expect(await h.service.getOperation(ctx, h.portfolio.id, oid)).toMatchObject({
      actorUserId: 'request-actor',
      retryCount: 1,
      startedAt: null,
      completedAt: null,
    });
    h.tx.researchPortfolioOutputAttempt.findFirst.mockResolvedValue({ completedAt: time });
    expect(await h.service.reconcileOperation(ctx, h.portfolio.id, oid)).toMatchObject({
      status: 'completed',
      completedAt: time.toISOString(),
    });
    expect(h.outputs.reconcile).toHaveBeenCalledWith(ctx, h.portfolio.id, oid, 'editor');
    expect(h.outputs.saveToClient).not.toHaveBeenCalled();
  });
  it('uses actual snapshot capturedAt, rechecks private access and never reads nonexistent createdAt', async () => {
    const h = harness();
    h.tx.researchPortfolioImportJob.findFirst.mockResolvedValue(null);
    h.tx.researchPortfolioSnapshot.findFirst.mockResolvedValue({
      id: oid,
      portfolioId: h.portfolio.id,
      name: 'snapshot',
      createdByUserId: 'capturer',
      capturedAt: time,
      clientAccessRequirements: ['allowed-client'],
    });
    expect(await h.service.getOperation(ctx, h.portfolio.id, oid)).toMatchObject({
      kind: 'snapshot',
      actorUserId: 'capturer',
      createdAt: time.toISOString(),
      completedAt: time.toISOString(),
      startedAt: null,
    });
    h.tx.$queryRawUnsafe.mockResolvedValue([{ allowed: false }]);
    await expect(h.service.getOperation(ctx, h.portfolio.id, oid)).rejects.toMatchObject({
      status: 404,
    });
  });
  it('requires the exact original actor key before checkpoint-only filing recovery, without exposing private identifiers', async () => {
    const h = harness();
    h.tx.researchPortfolioImportJob.findFirst.mockResolvedValue(null);
    Object.assign(h.row, {
      actorUserId: ctx.userId,
      clientId: 'allowed-client',
      artifactId: 'artifact',
      operationKey: 'caller-key',
      receiptOperationKey: 'private-hashed-key',
      externalCheckpoint: { private: 'attachment' },
      status: 'outcome_unknown',
      writerStartedAt: time,
    });
    h.tx.researchPortfolioClientFilingJob.findFirst.mockResolvedValue(h.row);
    await expect(h.service.reconcileOperation(ctx, h.portfolio.id, oid)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      h.service.reconcileOperation(ctx, h.portfolio.id, oid, { operationKey: 'changed' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.outputs.saveToClient).not.toHaveBeenCalled();
    const dto = await h.service.reconcileOperation(ctx, h.portfolio.id, oid, {
      operationKey: 'caller-key',
    });
    expect(h.outputs.saveToClient).toHaveBeenCalledWith(
      ctx,
      h.portfolio.id,
      'artifact',
      { clientId: 'allowed-client', operationKey: 'caller-key' },
      'editor',
      true,
    );
    expect(dto).toMatchObject({
      kind: 'client_filing',
      actorUserId: ctx.userId,
      status: 'completed',
    });
    expect(JSON.stringify(dto)).not.toContain('allowed-client');
    expect(JSON.stringify(dto)).not.toContain('caller-key');
    expect(JSON.stringify(dto)).not.toContain('attachment');
    expect(h.tx.researchPortfolioClientFilingJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ actorUserId: ctx.userId }) }),
    );
  });
  it('withholds filing handles after current membership, client link or wall revocation before checkpoint dispatch', async () => {
    const h = harness();
    h.tx.researchPortfolioImportJob.findFirst.mockResolvedValue(null);
    Object.assign(h.row, {
      actorUserId: ctx.userId,
      clientId: 'allowed-client',
      operationKey: 'caller-key',
    });
    h.tx.researchPortfolioClientFilingJob.findFirst.mockResolvedValue(h.row);
    h.tx.tenantMembership.findFirst.mockResolvedValue(null);
    await expect(
      h.service.reconcileOperation(ctx, h.portfolio.id, oid, { operationKey: 'caller-key' }),
    ).rejects.toMatchObject({ status: 404 });
    h.tx.tenantMembership.findFirst.mockResolvedValue({ id: 'active' });
    h.portfolio.clientLinks = [];
    await expect(h.service.getOperation(ctx, h.portfolio.id, oid)).rejects.toMatchObject({
      status: 404,
    });
    h.portfolio.clientLinks = [{ clientId: 'allowed-client' }];
    h.tx.$queryRawUnsafe.mockResolvedValue([{ allowed: false }]);
    await expect(
      h.service.reconcileOperation(ctx, h.portfolio.id, oid, { operationKey: 'caller-key' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.outputs.saveToClient).not.toHaveBeenCalled();
  });
  it('rejects unsupported import reconciliation and revoked editor access instead of reporting read status as mutation success', async () => {
    const h = harness();
    await expect(h.service.reconcileOperation(ctx, h.portfolio.id, oid)).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({
        code: 'RESEARCH_PORTFOLIO_OPERATION_RECONCILE_UNSUPPORTED',
      }),
    });
    h.portfolio.grants = [{ role: 'viewer' }];
    await expect(h.service.reconcileOperation(ctx, h.portfolio.id, oid)).rejects.toMatchObject({
      status: 403,
    });
    expect(h.outputs.reconcile).not.toHaveBeenCalled();
    expect(h.outputs.saveToClient).not.toHaveBeenCalled();
  });
});
