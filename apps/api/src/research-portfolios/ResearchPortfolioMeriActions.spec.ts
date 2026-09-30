import {
  ResearchPortfolioMeriToolsService,
  isResearchPortfolioMeriTool,
} from './research-portfolio-meri-tools.service.js';
import { MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY } from './research-portfolio-meri-scope.service.js';
import { MeriToolsService } from '../meri/meri-tools.service.js';
import {
  parseResearchPortfolioManagementInput,
  researchPortfolioManagementActions,
} from './research-portfolio-management.js';
const ctx: any = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
  },
  portfolioId = '33333333-3333-4333-8333-333333333333',
  conversationId = '44444444-4444-4444-8444-444444444444';
const cases = [
  {
    action: 'portfolio_create',
    service: 'portfolios',
    method: 'create',
    parameters: {
      idempotencyKey: 'original-key',
      name: 'Owned',
    },
    ids: [],
    global: true,
    readOnly: false,
  },
  {
    action: 'portfolio_update',
    service: 'portfolios',
    method: 'update',
    parameters: {
      idempotencyKey: 'original-key',
      expectedRevision: 7,
    },
    ids: [],
    global: false,
    readOnly: false,
  },
  {
    action: 'portfolio_archive',
    service: 'portfolios',
    method: 'archive',
    parameters: {
      idempotencyKey: 'original-key',
      expectedRevision: 7,
    },
    ids: [],
    global: false,
    readOnly: false,
  },
  {
    action: 'portfolio_restore',
    service: 'portfolios',
    method: 'restore',
    parameters: {
      idempotencyKey: 'original-key',
      expectedRevision: 7,
    },
    ids: [],
    global: false,
    readOnly: false,
  },
  {
    action: 'grants_list',
    service: 'portfolios',
    method: 'listGrants',
    parameters: {},
    ids: [],
    global: false,
    readOnly: true,
  },
  {
    action: 'client_links_list',
    service: 'portfolios',
    method: 'listClientLinks',
    parameters: {},
    ids: [],
    global: false,
    readOnly: true,
  },
  {
    action: 'members_list',
    service: 'portfolios',
    method: 'listMembers',
    parameters: {},
    ids: [],
    global: false,
    readOnly: true,
  },
  {
    action: 'grant_upsert',
    service: 'portfolios',
    method: 'upsertGrant',
    parameters: {
      idempotencyKey: 'original-key',
      expectedRevision: 7,
      principalUserId: '55555555-5555-4555-8555-555555555555',
      principalType: 'user',
      role: 'owner',
    },
    ids: ['principalUserId'],
    global: false,
    readOnly: false,
  },
  {
    action: 'grant_delete',
    service: 'portfolios',
    method: 'deleteGrant',
    parameters: {
      idempotencyKey: 'original-key',
      expectedRevision: 7,
      principalUserId: '55555555-5555-4555-8555-555555555555',
    },
    ids: ['principalUserId'],
    global: false,
    readOnly: false,
  },
  {
    action: 'client_link_create',
    service: 'portfolios',
    method: 'createClientLink',
    parameters: {
      idempotencyKey: 'original-key',
      expectedRevision: 7,
      clientId: '55555555-5555-4555-8555-555555555555',
    },
    ids: [],
    global: false,
    readOnly: false,
  },
  {
    action: 'client_link_delete',
    service: 'portfolios',
    method: 'deleteClientLink',
    parameters: {
      idempotencyKey: 'original-key',
      expectedRevision: 7,
      clientId: '55555555-5555-4555-8555-555555555555',
    },
    ids: ['clientId'],
    global: false,
    readOnly: false,
  },
  {
    action: 'member_create',
    service: 'portfolios',
    method: 'createMember',
    parameters: {
      idempotencyKey: 'original-key',
      expectedRevision: 7,
      targetKind: 'program',
      targetId: 'Owned',
    },
    ids: [],
    global: false,
    readOnly: false,
  },
  {
    action: 'members_decide',
    service: 'portfolios',
    method: 'decideMembers',
    parameters: {
      idempotencyKey: 'original-key',
      expectedRevision: 7,
      decisions: [
        {
          memberId: '55555555-5555-4555-8555-555555555555',
          disposition: 'included',
          reason: 'Owned',
        },
      ],
    },
    ids: [],
    global: false,
    readOnly: false,
  },
  {
    action: 'member_resolve',
    service: 'portfolios',
    method: 'resolveMember',
    parameters: {
      idempotencyKey: 'original-key',
      expectedRevision: 7,
      memberId: '55555555-5555-4555-8555-555555555555',
      targetKind: 'program',
      targetId: 'Owned',
    },
    ids: ['memberId'],
    global: false,
    readOnly: false,
  },
  {
    action: 'rule_preview',
    service: 'rules',
    method: 'preview',
    parameters: {
      expectedRevision: 7,
      schemaVersion: 1,
      expression: {},
      readableExpression: 'Owned',
      mode: 'rules',
      qualificationPolicy: {},
      candidates: [],
    },
    ids: [],
    global: false,
    readOnly: true,
  },
  {
    action: 'rule_publish',
    service: 'rules',
    method: 'publish',
    parameters: {
      idempotencyKey: 'original-key',
      expectedRevision: 7,
      previewId: '55555555-5555-4555-8555-555555555555',
      previewHash: 'Owned',
    },
    ids: [],
    global: false,
    readOnly: false,
  },
  {
    action: 'review_assign',
    service: 'reviews',
    method: 'assignReview',
    parameters: {
      idempotencyKey: 'original-key',
      expectedRevision: 7,
      reviewId: '55555555-5555-4555-8555-555555555555',
      expectedPortfolioRevision: 7,
      assigneeUserId: '55555555-5555-4555-8555-555555555555',
      reason: 'Owned',
    },
    ids: ['reviewId'],
    global: false,
    readOnly: false,
  },
  {
    action: 'review_decide',
    service: 'reviews',
    method: 'decideReview',
    parameters: {
      idempotencyKey: 'original-key',
      expectedRevision: 7,
      reviewId: '55555555-5555-4555-8555-555555555555',
      expectedPortfolioRevision: 7,
      decisionType: 'include',
      reason: 'Owned',
    },
    ids: ['reviewId'],
    global: false,
    readOnly: false,
  },
  {
    action: 'reviews_bulk_decide',
    service: 'reviews',
    method: 'bulkDecideReviews',
    parameters: {
      idempotencyKey: 'original-key',
      expectedRevision: 7,
      items: [
        {
          reviewId: '55555555-5555-4555-8555-555555555555',
          expectedRevision: 7,
          decisionType: 'include',
          reason: 'Owned',
        },
      ],
    },
    ids: [],
    global: false,
    readOnly: false,
  },
  {
    action: 'annual_review_get',
    service: 'reviews',
    method: 'getAnnualReview',
    parameters: {},
    ids: [],
    global: false,
    readOnly: true,
  },
  {
    action: 'annual_review_refresh',
    service: 'reviews',
    method: 'refreshAnnualReview',
    parameters: {
      idempotencyKey: 'original-key',
      expectedRevision: 7,
    },
    ids: [],
    global: false,
    readOnly: false,
  },
  {
    action: 'annual_review_reopen',
    service: 'reviews',
    method: 'reopenAnnualReview',
    parameters: {
      idempotencyKey: 'original-key',
      expectedRevision: 7,
      continuityIds: ['55555555-5555-4555-8555-555555555555'],
    },
    ids: [],
    global: false,
    readOnly: false,
  },
  {
    action: 'import_create',
    service: 'imports',
    method: 'createJob',
    parameters: {
      operationKey: 'original-key',
      expectedRevision: 7,
      worksheetKind: 'membership',
      fileName: 'Owned',
      mediaType: 'text/csv',
      contentBase64: 'YQ==',
      schemaVersion: 'membership-v1',
      mapping: {},
    },
    ids: [],
    global: false,
    readOnly: false,
  },
  {
    action: 'import_action',
    service: 'imports',
    method: 'action',
    parameters: {
      jobId: '55555555-5555-4555-8555-555555555555',
      importAction: 'preview',
      operationKey: 'original-key',
    },
    ids: ['jobId', 'importAction'],
    global: false,
    readOnly: false,
  },
  {
    action: 'subscriptions_list',
    service: 'changes',
    method: 'listSubscriptions',
    parameters: {},
    ids: [],
    global: false,
    readOnly: true,
  },
  {
    action: 'deliveries_list',
    service: 'changes',
    method: 'listDeliveries',
    parameters: {},
    ids: [],
    global: false,
    readOnly: true,
  },
  {
    action: 'subscription_update',
    service: 'changes',
    method: 'updateSubscription',
    parameters: {
      subscriptionId: '55555555-5555-4555-8555-555555555555',
    },
    ids: ['subscriptionId'],
    global: false,
    readOnly: false,
  },
  {
    action: 'bookmark_update',
    service: 'phase11',
    method: 'updateBookmark',
    parameters: {
      bookmarkId: '55555555-5555-4555-8555-555555555555',
    },
    ids: ['bookmarkId'],
    global: false,
    readOnly: false,
  },
  {
    action: 'bookmark_delete',
    service: 'phase11',
    method: 'deleteBookmark',
    parameters: {
      bookmarkId: '55555555-5555-4555-8555-555555555555',
    },
    ids: ['bookmarkId'],
    global: false,
    readOnly: false,
  },
  {
    action: 'fit_refresh',
    service: 'phase11',
    method: 'refreshFit',
    parameters: {},
    ids: [],
    global: false,
    readOnly: false,
  },
  {
    action: 'watch_conversion_preview',
    service: 'phase11',
    method: 'previewWatchConversion',
    parameters: {},
    ids: [],
    global: false,
    readOnly: true,
  },
  {
    action: 'watch_conversion_apply',
    service: 'phase11',
    method: 'applyWatchConversion',
    parameters: {
      idempotencyKey: 'original-key',
      expectedRevision: 7,
      previewHash: 'Owned',
      selectedWatchIds: ['55555555-5555-4555-8555-555555555555'],
    },
    ids: [],
    global: false,
    readOnly: false,
  },
  {
    action: 'output_get',
    service: 'outputs',
    method: 'get',
    parameters: {
      jobId: '55555555-5555-4555-8555-555555555555',
    },
    ids: ['jobId'],
    global: false,
    readOnly: true,
  },
  {
    action: 'output_cancel',
    service: 'outputs',
    method: 'cancel',
    parameters: {
      jobId: '55555555-5555-4555-8555-555555555555',
    },
    ids: ['jobId'],
    global: false,
    readOnly: false,
  },
  {
    action: 'output_retry',
    service: 'outputs',
    method: 'retry',
    parameters: {
      jobId: '55555555-5555-4555-8555-555555555555',
    },
    ids: ['jobId'],
    global: false,
    readOnly: false,
  },
  {
    action: 'output_reconcile',
    service: 'outputs',
    method: 'reconcile',
    parameters: {
      jobId: '55555555-5555-4555-8555-555555555555',
    },
    ids: ['jobId'],
    global: false,
    readOnly: false,
  },
  {
    action: 'snapshots_list',
    service: 'analytics',
    method: 'listSnapshots',
    parameters: {},
    ids: [],
    global: false,
    readOnly: true,
  },
  {
    action: 'snapshot_get',
    service: 'analytics',
    method: 'snapshot',
    parameters: {
      snapshotId: '55555555-5555-4555-8555-555555555555',
    },
    ids: ['snapshotId'],
    global: false,
    readOnly: true,
  },
  {
    action: 'taxonomy_get',
    service: 'rules',
    method: 'taxonomy',
    parameters: {},
    ids: [],
    global: true,
    readOnly: true,
  },
  {
    action: 'templates_list',
    service: 'rules',
    method: 'listTemplates',
    parameters: {},
    ids: [],
    global: true,
    readOnly: true,
  },
  {
    action: 'template_version_get',
    service: 'rules',
    method: 'templateVersion',
    parameters: {
      templateId: '55555555-5555-4555-8555-555555555555',
      versionId: '55555555-5555-4555-8555-555555555555',
    },
    ids: ['templateId', 'versionId'],
    global: true,
    readOnly: true,
  },
  {
    action: 'operation_reconcile',
    service: 'phase11',
    method: 'reconcileOperation',
    parameters: {
      operationId: '55555555-5555-4555-8555-555555555555',
    },
    ids: ['operationId'],
    readOnly: false,
  },
];
function harness() {
  const services: any = {};
  for (const item of cases) {
    services[item.service] ??= {};
    services[item.service][item.method] = jest.fn(async () => ({
      actualReceipt: item.action,
      id: 'native-id',
    }));
  }
  const receipt = {
    kind: 'research_portfolio',
    researchPortfolioId: portfolioId,
    researchPortfolioName: 'Owned',
    researchPortfolioRevision: 7,
    scopeVersion: 'a'.repeat(64),
  };
  const scope = { authorize: jest.fn(async () => receipt) };
  const tx = {
    clioConversation: {
      findFirst: jest.fn(async () => ({
        metadata: { [MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY]: receipt },
      })),
    },
  };
  const institutional = {
    prepare: jest.fn(async () => ({
      artifactId: 'actual-artifact',
      conversationId,
      meetingPrepId: null,
      taskIds: [],
      sourceLineage: { sourceRevisionIds: ['actual-source'] },
      reviewStatus: 'unreviewed_draft',
      replayed: false,
    })),
  };
  const adapter = new ResearchPortfolioMeriToolsService(
    { withTenant: async (_tenant: string, work: any) => work(tx) } as any,
    scope as any,
    services.portfolios,
    services.analytics,
    services.changes,
    services.outputs,
    services.reviews,
    services.rules,
    services.phase11,
    services.imports,
    institutional as any,
  );
  return { services, scope, tx, adapter, institutional };
}
const oldFlag = process.env.RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED;
afterEach(() => {
  if (oldFlag === undefined) delete process.env.RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED;
  else process.env.RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED = oldFlag;
});
describe('Native Research Portfolio manual action parity', () => {
  it.each(cases)(
    'delegates $action to its exact native method and reauthorizes current original scope',
    async (item) => {
      const h = harness();
      const input = {
        conversationId,
        action: item.action,
        parameters: item.parameters,
        ...(item.readOnly ? {} : { confirmed: true }),
      };
      const actual = await h.adapter.execute(ctx, 'manage_research_portfolio' as any, input);
      expect(actual).toEqual({ actualReceipt: item.action, id: 'native-id' });
      expect(h.scope.authorize).toHaveBeenCalledWith(
        ctx,
        expect.objectContaining({ researchPortfolioId: portfolioId }),
      );
      const call = h.services[item.service][item.method].mock.calls[0];
      if (!call) throw new Error('Missing native call');
      expect(call[0]).toBe(ctx);
      if (!item.global) expect(call[1]).toBe(portfolioId);
      for (let n = 0; n < item.ids.length; n++) {
        const routingKey = item.ids[n];
        if (!routingKey) throw new Error('Missing routing identifier');
        expect(call[(item.global ? 1 : 2) + n]).toBe((item.parameters as any)[routingKey]);
      }
      const inputFields = Object.fromEntries(
        Object.entries(item.parameters).filter(
          ([name]) => !(item.ids as readonly string[]).includes(name),
        ),
      );
      if (item.action === 'taxonomy_get')
        expect(call).toEqual([ctx, (item.parameters as any).version]);
      else if (
        ['bookmark_update', 'subscription_update', 'operation_reconcile'].includes(item.action) ||
        Object.keys(inputFields).length
      )
        expect(call).toEqual([
          ctx,
          ...(item.global ? [] : [portfolioId]),
          ...item.ids.map((name) => (item.parameters as any)[name]),
          inputFields,
        ]);
      else
        expect(call).toEqual([
          ctx,
          ...(item.global ? [] : [portfolioId]),
          ...item.ids.map((name) => (item.parameters as any)[name]),
        ]);
      expect(h.tx.clioConversation.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: conversationId,
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            archivedAt: null,
          },
        }),
      );
    },
  );
  it('rechecks authority on every action and never retargets the chat after creating another portfolio', async () => {
    const h = harness();
    await h.adapter.execute(ctx, 'manage_research_portfolio' as any, {
      conversationId,
      action: 'portfolio_create',
      confirmed: true,
      parameters: { idempotencyKey: 'new', name: 'Another' },
    });
    h.scope.authorize.mockRejectedValueOnce(new Error('Current grant revoked'));
    await expect(
      h.adapter.execute(ctx, 'manage_research_portfolio' as any, {
        conversationId,
        action: 'fit_refresh',
        confirmed: true,
        parameters: {},
      }),
    ).rejects.toThrow('Current grant revoked');
    expect(h.services.phase11.refreshFit).not.toHaveBeenCalled();
  });
  it.each([
    { tenantId: ctx.tenantId },
    { parameters: { tenantId: ctx.tenantId } },
    { parameters: { name: 'X', unexpected: true } },
    { confirmed: false },
    { action: 'constructor' },
    { action: 'recompute' },
    { parameters: { name: 'X', unresolvedInput: { nested: [{ userId: ctx.userId }] } } },
  ])('rejects invalid authority/shape/action before native delegation (%j)', async (change) => {
    const h = harness();
    await expect(
      h.adapter.execute(ctx, 'manage_research_portfolio' as any, {
        conversationId,
        action: 'portfolio_update',
        confirmed: true,
        parameters: { idempotencyKey: 'original-key', expectedRevision: 7, name: 'Owned' },
        ...change,
      }),
    ).rejects.toThrow();
    expect(h.services.portfolios.update).not.toHaveBeenCalled();
  });
  it('requires confirmation and native request identity instead of inventing key/revision', () => {
    for (const fields of [
      { confirmed: undefined },
      { parameters: { name: 'Owned' } },
      { parameters: { idempotencyKey: 'key', expectedRevision: 0.5, name: 'Owned' } },
    ])
      expect(() =>
        parseResearchPortfolioManagementInput({
          conversationId,
          action: 'portfolio_update',
          confirmed: true,
          parameters: { idempotencyKey: 'key', expectedRevision: 7, name: 'Owned' },
          ...fields,
        }),
      ).toThrow();
  });
  it.each(['brief', 'meeting'] as const)(
    'returns actual durable %s IDs from canonical institutional delegate',
    async (kind) => {
      const h = harness();
      const input = { conversationId, operationKey: 'original-prepare-key', confirmed: true };
      const actual = await h.adapter.execute(
        ctx,
        ('prepare_research_portfolio_' + kind) as any,
        input,
      );
      expect(actual).toEqual(
        expect.objectContaining({
          artifactId: 'actual-artifact',
          taskIds: [],
          reviewStatus: 'unreviewed_draft',
        }),
      );
      expect(h.institutional.prepare).toHaveBeenCalledWith(ctx, { ...input, kind });
    },
  );
  it('passes only explicitly selected owned meeting/reviews, and refuses unsupported brief selections', async () => {
    const h = harness();
    const meetingId = '55555555-5555-4555-8555-555555555555',
      selectedReviewIds = ['66666666-6666-4666-8666-666666666666'];
    await h.adapter.execute(ctx, 'prepare_research_portfolio_meeting', {
      conversationId,
      operationKey: 'meeting-key',
      confirmed: true,
      meetingId,
      selectedReviewIds,
    });
    expect(h.institutional.prepare).toHaveBeenCalledWith(ctx, {
      conversationId,
      operationKey: 'meeting-key',
      confirmed: true,
      kind: 'meeting',
      meetingId,
      selectedReviewIds,
    });
    await expect(
      h.adapter.execute(ctx, 'prepare_research_portfolio_brief', {
        conversationId,
        operationKey: 'brief-key',
        confirmed: true,
        selectedReviewIds,
      }),
    ).rejects.toThrow();
    expect(h.institutional.prepare).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, 'false', 'TRUE'])(
    'keeps management definitions and dispatch dark for flag %s',
    async (flag) => {
      if (flag === undefined) delete process.env.RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED;
      else process.env.RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED = flag;
      const h = harness();
      const tools = Object.create(MeriToolsService.prototype);
      tools.researchPortfolioTools = h.adapter;
      const schemas = tools.anthropicToolSchemas({
        tenantId: ctx.tenantId,
        surface: 'chat',
        env: flag === undefined ? {} : { RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED: flag },
      });
      expect(schemas.some((s: any) => s.name === 'manage_research_portfolio')).toBe(false);
      await expect(
        tools.execute(ctx, 'manage_research_portfolio', {
          conversationId,
          action: 'fit_refresh',
          confirmed: true,
          parameters: {},
        }),
      ).rejects.toThrow();
      expect(h.services.phase11.refreshFit).not.toHaveBeenCalled();
    },
  );
  it('advertises one strict management capability only under explicit true and canonical parser matches dispatch', async () => {
    process.env.RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED = 'true';
    const h = harness(),
      tools = Object.create(MeriToolsService.prototype);
    tools.researchPortfolioTools = h.adapter;
    expect(isResearchPortfolioMeriTool('manage_research_portfolio')).toBe(true);
    const schemas = tools.anthropicToolSchemas({
      tenantId: ctx.tenantId,
      surface: 'chat',
      env: { RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED: 'true' },
    });
    const schema = schemas.find((s: any) => s.name === 'manage_research_portfolio')
      ?.input_schema as any;
    expect(schema.oneOf).toHaveLength(researchPortfolioManagementActions.length);
    const raw = { conversationId, action: 'fit_refresh', confirmed: true, parameters: {} };
    expect(tools.validateSideEffectingInput('manage_research_portfolio', raw)).toEqual(raw);
    await expect(tools.execute(ctx, 'manage_research_portfolio', raw)).resolves.toEqual(
      expect.objectContaining({ actualReceipt: 'fit_refresh' }),
    );
  });
});
