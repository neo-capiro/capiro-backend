import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { NotFoundException } from '@nestjs/common';
import { NewsletterOutreachService } from '../src/engagement/newsletter-outreach.service.js';
import { EngagementService } from '../src/engagement/engagement.service.js';
import { MeetingPrepJobService } from '../src/engagement/meeting-prep-job.service.js';
import { EngagementPlansService } from '../src/engagement/plans/engagement-plans.service.js';
import { insertPlan, recordPlanRevision } from '../src/engagement/plans/engagement-plan-store.js';
import { singleMailHash } from '../src/engagement/single-mail-ledger.js';
import { runtimePolicyForHandler } from '../src/engagement/runtime/engagement-runtime-route-policy.js';
import {
  clearNewsletterPublicFixture,
  newsletterPublicFixture,
  seedNewsletterPublicFixture,
} from './engagement-phase1-newsletter-fixture.js';

const source = readFileSync(path.join(__dirname, 'engagement-phase1-read-parity.ts'), 'utf8');
const ast = ts.createSourceFile('parity.ts', source, ts.ScriptTarget.Latest, true);
// Execute the actual declarations, never the script's CLI/import/DB entrypoint.
const names = new Set([
  'routePath',
  'seededRecordKind',
  'requireSeededRecordRead',
  'idForRoute',
  'queryForRoute',
  'authHeaders',
  'parity',
  'describeMismatch',
  'truncateBody',
  'errorClass',
  'requireDeniedPair',
  'main',
]);
const declarations = ast.statements
  .filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ''))
  .map((node) => node.getText(ast))
  .join('\n');
const compiled = ts.transpileModule(declarations, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const manifest = JSON.parse(
  readFileSync(
    path.join(__dirname, '../src/engagement/__fixtures__/engagement-route-manifest.v1.json'),
    'utf8',
  ),
);
const publicReads = manifest.routes.filter(
  (r: any) => r.controller === 'NewsletterPublicController' && r.method === 'GET',
);
const missing = 'ea000000-0000-4000-8000-000000000099';
const recordReads = {
  mailRequestKey: 'ea000000-0000-4000-8000-000000000113',
  meetingPrepJobId: 'ea000000-0000-4000-8000-000000000114',
  planId: 'ea000000-0000-4000-8000-000000000115',
};
const recordRoutes: Array<{ method: string; path: string; controller: string; handler: string }> = manifest.routes.filter((r: any) => r.method === 'GET' && (
  (r.controller === 'EngagementController' && ['singleMailIntent', 'prepJob'].includes(r.handler)) ||
  (r.controller === 'EngagementPlansController' && ['get', 'history'].includes(r.handler))));
const owner = {
  tenantId: 'synthetic-tenant',
  userId: 'synthetic-user',
  clerkUserId: 'synthetic-clerk',
  outreachRecordId: 'synthetic-outreach',
};

function fixtureStore() {
  const rows: Record<string, any[]> = {};
  const queries: any[] = [],
    deletes: any[] = [];
  let design: any;
  const tx: any = {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ sql: strings.join('?'), values });
      if (strings.join('').includes('INSERT INTO ws_newsletter_stage'))
        design = JSON.parse(values[6] as string);
      return 1;
    },
  };
  for (const table of [
    'integrationConnection',
    'outreachDraftArtifact',
    'outreachDraftVersion',
    'outreachSendIntent',
    'outreachDelivery',
    'newsletterRecipientAccess',
  ]) {
    rows[table] = [];
    tx[table] = {
      create: async ({ data }: any) => {
        rows[table]!.push(data);
        return data;
      },
      deleteMany: async (args: any) => {
        deletes.push({ table, ...args });
        return { count: 0 };
      },
    };
  }
  tx.newsletterRecipientAccess.findUnique = async ({ where }: any) =>
    rows.newsletterRecipientAccess!.find((r) => r.token === where.token);
  const prisma: any = {
    withSystem: async (fn: any) => fn(tx),
    withTenant: async (tenantId: string, fn: any) =>
      fn({
        outreachDelivery: {
          count: async ({ where }: any) =>
            rows.outreachDelivery!.filter(
              (r) =>
                r.tenantId === tenantId &&
                r.tenantId === where.tenantId &&
                r.draftVersionId === where.draftVersionId &&
                where.status.in.includes(r.status) &&
                rows.outreachSendIntent!.some(
                  (i) =>
                    i.id === r.sendIntentId &&
                    i.tenantId === tenantId &&
                    i.testMode === where.sendIntent.testMode,
                ),
            ).length,
        },
        $queryRaw: async (
          _strings: TemplateStringsArray,
          stageId: string,
          selectedTenant: string,
        ) =>
          selectedTenant === tenantId &&
          queries.some(
            (q) =>
              q.sql.includes('INSERT INTO ws_newsletter_stage') &&
              q.values[0] === stageId &&
              q.values[1] === tenantId,
          )
            ? [{ design }]
            : [],
        newsletterSubscription: {
          upsert: () => {
            throw Error('GET mutated subscription');
          },
        },
        newsletterRecipientAccess: {
          update: () => {
            throw Error('GET mutated survey');
          },
        },
      }),
  };
  return {
    prisma,
    rows,
    queries,
    deletes,
    service: new NewsletterOutreachService(prisma, {} as any, {} as any, {} as any, {} as any),
  };
}

function context(fixture: any, overrides: Record<string, unknown> = {}) {
  const fixtures = {
    tenantId: owner.tenantId,
    userId: owner.userId,
    clientIds: [missing],
    meetingIds: { current: missing },
    outreachIds: { draft: missing },
    audienceIds: { list: missing },
    campaignId: missing,
    taskId: missing,
    newsletterPublic: fixture,
    recordReads: { ...recordReads },
  };
  const result: any = {
    MISSING_ID: missing,
    CROSS_USER_MEETING_ID: missing,
    CROSS_TENANT_MEETING_ID: missing,
    CROSS_USER_ID: missing,
    CROSS_TENANT_USER_ID: missing,
    CROSS_TENANT_ID: missing,
    newsletterPublicFixture,
    URLSearchParams,
    TOKEN: 'synthetic-session',
    path,
    runtimePolicyForHandler,
    MAIN_URL: 'main',
    ENGAGEMENT_URL: 'engagement',
    EVIDENCE_DIR: 'unused',
    FIXTURE_FILE: 'fixtures',
    MANIFEST_FILE: 'manifest',
    mkdir: async () => {},
    writeFile: async () => {},
    readFile: async (file: string) =>
      JSON.stringify(file === 'fixtures' ? fixtures : { routes: publicReads }),
    PrismaService: class {
      async $connect() {}
      async $disconnect() {}
      async $executeRawUnsafe() {}
    },
    ...overrides,
  };
  vm.createContext(result);
  vm.runInContext(compiled, result, { timeout: 1000 });
  return { result, fixtures };
}

// Use the real seed declarations without running its CLI, cleanup entrypoint or Prisma constructor.
const seedSource = readFileSync(path.join(__dirname, 'seed-engagement-phase0-browser-fixtures.ts'), 'utf8');
const seedAst = ts.createSourceFile('seed.ts', seedSource, ts.ScriptTarget.Latest, true);
const seedNames = new Set(['TENANT_ID', 'USER_ID', 'CLIENT_A_ID', 'MEETING_CURRENT_ID', 'READ_PARITY_IDS']);
const seedCode = seedAst.statements.filter((node) =>
  (ts.isFunctionDeclaration(node) && ['seedReadParityRecords', 'clearReadParityRecords'].includes(node.name?.text ?? '')) ||
  (ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => seedNames.has(d.name.getText(seedAst)))))
  .map((node) => node.getText(seedAst)).join('\n');
const seedContext: any = { insertPlan, recordPlanRevision, singleMailHash };
vm.createContext(seedContext);
vm.runInContext(ts.transpileModule(seedCode + '\nconst fixtureIdentity = { TENANT_ID, USER_ID, CLIENT_A_ID, MEETING_CURRENT_ID, READ_PARITY_IDS };',
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, seedContext);
const identity = vm.runInContext('fixtureIdentity', seedContext);

function recordStore() {
  const ctx = { tenantId: identity.TENANT_ID, userId: identity.USER_ID, clerkUserId: 'fixture-clerk',
    tenantSlug: 'phase0-engagement-baseline', role: 'user_admin' as const };
  const rows: Record<string, any> = {};
  const deletes: any[] = [], queries: any[] = [];
  const flags = { member: true, wall: true };
  const tx: any = {};
  const matches = (row: any, where: any) => row && Object.entries(where).every(([key, value]) => row[key] === value);
  for (const table of ['integrationConnection', 'meetingPrepJob']) {
    tx[table] = {
      create: async ({ data }: any) => rows[table] = { ...data, createdAt: new Date(), updatedAt: new Date(), prepId: null, errorCode: null },
      findFirst: async ({ where }: any) => matches(rows[table], where) ? rows[table] : null,
      deleteMany: async ({ where }: any) => { deletes.push({ table, where }); if (matches(rows[table], where)) delete rows[table]; },
    };
  }
  tx.engagementPlan = { deleteMany: async ({ where }: any) => {
    deletes.push({ table: 'engagementPlan', where });
    if (matches(rows.plan, where)) { delete rows.plan; delete rows.revision; }
  } };
  tx.tenantMembership = { findFirst: async ({ where }: any) => flags.member && where.tenantId === ctx.tenantId && where.userId === ctx.userId ? { id: 'membership', role: ctx.role } : null };
  tx.client = { findFirst: async ({ where }: any) => where.tenantId === ctx.tenantId && where.id === identity.CLIENT_A_ID && (!where.OR || flags.wall) ? { id: identity.CLIENT_A_ID } : null };
  tx.meeting = { findFirst: async ({ where }: any) => where.tenantId === ctx.tenantId && where.id === identity.MEETING_CURRENT_ID && where.OR[0].createdByUserId === ctx.userId ? {
    clientId: identity.CLIENT_A_ID, status: 'scheduled', isInternal: false, attendees: [],
  } : null };
  tx.$executeRaw = async (parts: TemplateStringsArray, ...v: any[]) => {
    const sql = parts.join('?'); queries.push({ sql, values: v });
    if (sql.includes('INSERT INTO single_mail_intents')) {
      rows.mail = { id: v[0], tenant_id: v[1], actor_id: v[2], request_key: v[3], request_hash: v[4],
        connection_id: v[5], client_id: v[6], state: 'failed', snapshot: JSON.parse(v[7]), receipt: null };
    } else if (sql.includes('DELETE FROM single_mail_intents')) {
      deletes.push({ table: 'single_mail_intents', values: v });
      if (rows.mail?.tenant_id === v[0] && rows.mail?.actor_id === v[1] && rows.mail?.id === v[2]) delete rows.mail;
    } else if (!sql.includes('pg_advisory_xact_lock') && !sql.includes('engagement_report_target_offices')) throw Error('Unexpected write');
    return 1;
  };
  tx.$queryRaw = async (sql: any) => {
    queries.push({ sql: sql.sql, values: sql.values });
    if (!sql.sql.includes('FROM single_mail_intents')) throw Error('Unexpected tagged read');
    const [tenant, actor, key] = sql.values;
    return rows.mail?.tenant_id === tenant && rows.mail?.actor_id === actor && rows.mail?.request_key === key ? [rows.mail] : [];
  };
  tx.$executeRawUnsafe = async (sql: string, ...v: any[]) => {
    queries.push({ sql, values: v });
    if (sql.includes('INSERT INTO engagement_plans')) rows.plan = { id: v[0], tenantId: v[1], clientId: v[2], title: v[3], officeReferences: JSON.parse(v[4]), objectiveBinding: null,
      createdByUserId: v[6], lifecycle: 'draft', version: 1, reviewedPlanVersion: null, reviewedAt: null, reviewDueAt: null, reviewedByUserId: null, createdAt: new Date(), updatedAt: new Date() };
    else if (sql.includes('INSERT INTO engagement_plan_revisions')) rows.revision = { tenantId: v[1], clientId: v[2], planId: v[3], version: v[4], operation: v[5], actorUserId: v[6], snapshot: JSON.parse(v[7]) };
    else throw Error('Unexpected raw write');
    return 1;
  };
  tx.$queryRawUnsafe = async (sql: string, ...v: any[]) => {
    queries.push({ sql, values: v });
    if (sql.includes(' AS allowed')) return [{ allowed: flags.wall && v[0] === ctx.tenantId && v[1] === identity.CLIENT_A_ID && v[2] === ctx.userId }];
    if (sql.includes('FROM tenants t')) return flags.member && v[0] === ctx.tenantId && v[1] === ctx.userId && v[2] === ctx.clerkUserId ? [{ role: ctx.role }] : [];
    if (sql.includes('FROM client_memory_access')) return [];
    if (sql.includes('FROM clients')) return v[0] === ctx.tenantId && v[1] === identity.CLIENT_A_ID ? [{ id: identity.CLIENT_A_ID, memoryWall: !flags.wall }] : [];
    if (sql.includes('FROM engagement_plan_waves')) return [];
    if (sql.includes('FROM engagement_plan_revisions')) return rows.revision?.tenantId === v[0] && rows.revision?.clientId === v[1] && rows.revision?.planId === v[2] ? [rows.revision] : [];
    if (sql.includes('FROM engagement_plans')) return rows.plan?.tenantId === v[0] && rows.plan?.id === v.at(-1) && (v.length === 2 || rows.plan?.clientId === v[1]) ? [rows.plan] : [];
    throw Error('Unexpected raw read');
  };
  const prisma: any = { withTenant: async (_tenant: string, run: any) => run(tx),
    withTenantUser: async (tenant: string, actor: string, run: any) => { queries.push({ tenant, actor }); return run(tx); } };
  const mail = Object.assign(Object.create(EngagementService.prototype), { prisma }) as EngagementService;
  const prep = new MeetingPrepJobService(prisma, {} as never, {} as never, {} as never);
  const plans = new EngagementPlansService(prisma);
  return { ctx, prisma, rows, flags, deletes, queries, mail, prep, plans };
}

describe('persisted read fixtures use canonical stores and current service authorization', () => {
  const previousFlag = process.env.MEETING_PREP_COMPREHENSIVE_ENABLED;
  beforeEach(() => { process.env.MEETING_PREP_COMPREHENSIVE_ENABLED = 'true'; });
  afterEach(() => {
    if (previousFlag === undefined) delete process.env.MEETING_PREP_COMPREHENSIVE_ENABLED;
    else process.env.MEETING_PREP_COMPREHENSIVE_ENABLED = previousFlag;
  });
  async function seeded() {
    const h = recordStore();
    expect(await seedContext.seedReadParityRecords(h.prisma, h.ctx.clerkUserId)).toEqual(recordReads);
    return h;
  }
  test('real readers return the seeded terminal mail/prep and actual plan creation history', async () => {
    const h = await seeded();
    expect(h.rows.integrationConnection).toMatchObject({ status: 'needs_configuration', createdByUserId: h.ctx.userId });
    expect(h.rows.integrationConnection).not.toHaveProperty('accessToken');
    expect(h.rows.mail.state).toBe('failed');
    expect(h.rows.meetingPrepJob).toMatchObject({ status: 'cancelled', stage: 'cancelled', input: {} });
    expect(new Date(h.rows.meetingPrepJob.deadlineAt).getTime()).toBeLessThan(Date.now());
    const beforeReads = h.queries.length;
    const bodies = [await h.mail.getSingleMailIntent(h.ctx, recordReads.mailRequestKey),
      await h.prep.get(h.ctx, identity.MEETING_CURRENT_ID, recordReads.meetingPrepJobId),
      await h.plans.get(h.ctx, recordReads.planId), await h.plans.history(h.ctx, recordReads.planId, { limit: 20 })];
    const { result, fixtures } = context({});
    Object.assign(fixtures, { userId: h.ctx.userId, clientIds: [identity.CLIENT_A_ID], meetingIds: { current: identity.MEETING_CURRENT_ID } });
    for (const [handler, body] of ['singleMailIntent', 'prepJob', 'get', 'history'].map((handler, i) => [handler, bodies[i]] as const)) {
      const route = recordRoutes.find((r: any) => r.handler === handler);
      expect(() => result.requireSeededRecordRead(route, fixtures, { status: 200, body })).not.toThrow();
    }
    expect(h.rows.revision.snapshot).toMatchObject({ id: recordReads.planId, title: 'Phase 1 read parity plan', version: 1, waves: [] });
    expect(h.queries.slice(beforeReads).filter((q) => /\b(INSERT|UPDATE|DELETE)\s+(INTO|FROM|single_mail_intents|engagement_plans)\b/.test(q.sql ?? ''))).toEqual([]);
  });
  test.each(['member', 'wall'] as const)('fresh %s revocation refuses all three real readers', async (flag) => {
    const h = await seeded(); h.flags[flag] = false;
    await expect(h.mail.getSingleMailIntent(h.ctx, recordReads.mailRequestKey)).rejects.toThrow();
    await expect(h.prep.get(h.ctx, identity.MEETING_CURRENT_ID, recordReads.meetingPrepJobId)).rejects.toThrow();
    await expect(h.plans.get(h.ctx, recordReads.planId)).rejects.toThrow();
    await expect(h.plans.history(h.ctx, recordReads.planId, { limit: 20 })).rejects.toThrow();
  });
  test('foreign tenant/actor/meeting and disabled prep remain refusals or explicit unavailable results', async () => {
    const h = await seeded();
    for (const ctx of [{ ...h.ctx, tenantId: missing }, { ...h.ctx, userId: missing }]) {
      await expect(h.mail.getSingleMailIntent(ctx, recordReads.mailRequestKey)).rejects.toThrow();
      await expect(h.prep.get(ctx, identity.MEETING_CURRENT_ID, recordReads.meetingPrepJobId)).rejects.toThrow();
      await expect(h.plans.get(ctx, recordReads.planId)).rejects.toThrow();
    }
    await expect(h.prep.get(h.ctx, missing, recordReads.meetingPrepJobId)).rejects.toThrow();
    process.env.MEETING_PREP_COMPREHENSIVE_ENABLED = 'false';
    expect(await h.prep.get(h.ctx, identity.MEETING_CURRENT_ID, recordReads.meetingPrepJobId)).toBeNull();
    await seeded();
    expect(process.env.MEETING_PREP_COMPREHENSIVE_ENABLED).toBe('false');
  });
  test('cleanup is tenant/actor/ID bounded, uses the plan parent cascade, and allows reseeding', async () => {
    const h = await seeded();
    await seedContext.clearReadParityRecords(h.prisma);
    expect(h.deletes.map((d) => d.table)).toEqual(['engagementPlan', 'meetingPrepJob', 'single_mail_intents', 'integrationConnection']);
    for (const d of h.deletes) expect(d.where?.tenantId ?? d.values[0]).toBe(h.ctx.tenantId);
    expect(h.deletes[0].where.id).toBe(recordReads.planId);
    expect(h.deletes[1].where.id).toBe(recordReads.meetingPrepJobId);
    expect(h.deletes[1].where.userId).toBe(h.ctx.userId);
    expect(h.deletes[2].values).toEqual([h.ctx.tenantId, h.ctx.userId, identity.READ_PARITY_IDS.mailIntent]);
    expect(h.deletes[3].where.createdByUserId).toBe(h.ctx.userId);
    expect(h.deletes[3].where.id).toBe(identity.READ_PARITY_IDS.connection);
    expect(Object.keys(h.rows)).toEqual([]);
    await seedContext.seedReadParityRecords(h.prisma, h.ctx.clerkUserId);
    expect((await h.plans.history(h.ctx, recordReads.planId, { limit: 20 })).items).toHaveLength(1);
  });
});

describe('Newsletter public parity fixture and real service contract', () => {
  test('seed links an actual non-test completed delivery, a survey and an unpublished refusal', async () => {
    const h = fixtureStore(),
      fixture = await seedNewsletterPublicFixture(h.prisma, owner);
    const [access, unpublished] = h.rows.newsletterRecipientAccess!;
    const version = h.rows.outreachDraftVersion![0],
      delivery = h.rows.outreachDelivery![0],
      intent = h.rows.outreachSendIntent![0];
    expect(access.draftVersionId).toBe(version.id);
    expect(delivery.draftVersionId).toBe(version.id);
    expect(delivery.sendIntentId).toBe(intent.id);
    expect(intent.testMode).toBe(false);
    expect(intent.status).toBe('complete');
    expect(delivery.status).toBe('sent');
    expect(unpublished.draftVersionId).toBeNull();
    expect(h.rows.integrationConnection![0]).toMatchObject({
      provider: 'microsoft_365',
      status: 'needs_configuration',
      accountEmail: 'newsletter-parity@example.test',
    });
    expect(await h.service.publicArchive(fixture.token)).toBe(access.html);
    expect(await h.service.preferences(fixture.token)).toContain('Newsletter preferences');
    expect(
      await h.service.survey(fixture.token, fixture.survey.block, fixture.survey.answer),
    ).toContain('Useful &amp; clear');
    await expect(h.service.publicArchive(fixture.unpublishedToken)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(h.service.publicArchive('invalid-token')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(h.service.publicArchive('0'.repeat(64))).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      h.service.survey(fixture.token, 'missing', fixture.survey.answer),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      h.service.survey(fixture.token, fixture.survey.block, 'not-an-option'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  test.each(['test', 'held', 'foreign-tenant', 'wrong-version'])(
    'real service rejects a %s delivery',
    async (mode) => {
      const h = fixtureStore(),
        fixture = await seedNewsletterPublicFixture(h.prisma, owner);
      if (mode === 'test') h.rows.outreachSendIntent![0].testMode = true;
      if (mode === 'held') h.rows.outreachDelivery![0].status = 'held';
      if (mode === 'foreign-tenant') h.rows.outreachDelivery![0].tenantId = 'foreign';
      if (mode === 'wrong-version') h.rows.outreachDelivery![0].draftVersionId = 'other';
      await expect(h.service.publicArchive(fixture.token)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    },
  );

  test('cleanup names only owned rows in the selected synthetic tenant, children first', async () => {
    const h = fixtureStore();
    await clearNewsletterPublicFixture(h.prisma, owner.tenantId);
    expect(h.deletes.map((x) => x.table)).toEqual([
      'newsletterRecipientAccess',
      'outreachDelivery',
      'outreachSendIntent',
      'outreachDraftVersion',
      'outreachDraftArtifact',
      'integrationConnection',
    ]);
    for (const deletion of h.deletes) {
      expect(deletion.where.tenantId).toBe(owner.tenantId);
      expect(deletion.where.id).toBeDefined();
    }
    expect(h.queries).toHaveLength(2);
    for (const q of h.queries) {
      expect(q.sql).toContain('AND tenant_id =');
      expect(q.values[1]).toBe(owner.tenantId);
    }
    expect(h.queries[0].sql).toContain('ws_newsletter_stage');
    expect(h.queries[1].sql).toContain('ws_newsletter_document');
  });
});

describe('actual parity request construction and fail-closed checks', () => {
  const fixture = {
    token: 'a'.repeat(64),
    unpublishedToken: 'b'.repeat(64),
    survey: { block: 'survey', answer: 'Useful & clear' },
  };
  test.each([
    undefined,
    {},
    { ...fixture, token: 'bad' },
    { ...fixture, token: [fixture.token] },
    { ...fixture, unpublishedToken: fixture.token },
    { ...fixture, survey: {} },
    { ...fixture, survey: { block: '', answer: 'a' } },
    { ...fixture, survey: { block: 'survey', answer: '' } },
  ])('missing or malformed public fixture refuses', (value) => {
    expect(() => newsletterPublicFixture(value)).toThrow(/seeded Newsletter/);
  });
  test('all selected reads resolve, including four public and four persisted-record paths', () => {
    const { result, fixtures } = context(fixture);
    const unresolved: string[] = [];
    const reads = manifest.routes.filter(
      (r: any) =>
        r.method === 'GET' &&
        r.path.startsWith('/api/engagement') &&
        !runtimePolicyForHandler(r.controller, r.handler),
    );
    for (const route of reads) {
      try {
        result.routePath(route, fixtures);
      } catch {
        unresolved.push(route.path);
      }
    }
    expect(publicReads).toHaveLength(4);
    expect(reads).toHaveLength(49);
    expect(unresolved).toEqual([]);
    expect(recordRoutes).toHaveLength(4);
    for (const route of recordRoutes) {
      const value = route.handler === 'singleMailIntent' ? recordReads.mailRequestKey :
        route.handler === 'prepJob' ? recordReads.meetingPrepJobId : recordReads.planId;
      expect(result.routePath(route, fixtures)).toContain(value);
    }
    const survey = publicReads.find((r: any) => r.handler === 'survey');
    const query = new URLSearchParams(result.queryForRoute(survey, fixtures));
    expect(query.get('block')).toBe(fixture.survey.block);
    expect(query.get('answer')).toBe(fixture.survey.answer);
    expect(result.authHeaders().Authorization).toBe('Bearer synthetic-session');
  });

  test.each(recordRoutes)('$handler refuses absent/malformed record mapping without falling back to a missing ID', (route: any) => {
    const { result, fixtures } = context(fixture);
    for (const value of [undefined, {}, { mailRequestKey: [], meetingPrepJobId: 'bad', planId: null }]) {
      expect(() => result.routePath(route, { ...fixtures, recordReads: value })).toThrow(/requires the seeded/);
    }
  });

  async function recordLoop(badHandler?: string, status = 200, replacement?: unknown) {
    const calls: any[] = [], stop = new Error('reached unchanged public denial checks');
    const bodies: Record<string, unknown> = {
      singleMailIntent: { requestKey: recordReads.mailRequestKey, state: 'failed', retryable: false },
      prepJob: { jobId: recordReads.meetingPrepJobId, meetingId: missing, status: 'cancelled' },
      get: { id: recordReads.planId, clientId: missing, version: 1, title: 'Phase 1 read parity plan' },
      history: { planId: recordReads.planId, clientId: missing, planVersion: 1, items: [{ version: 1, operation: 'create_plan', actorUserId: owner.userId,
        snapshot: { id: recordReads.planId, clientId: missing, title: 'Phase 1 read parity plan' } }] },
    };
    const { result, fixtures } = context(fixture, {
      readFile: async (file: string) => JSON.stringify(file === 'fixtures' ? fixtures : { routes: recordRoutes }),
      probe: async (base: string, pathname: string, init: any) => {
        if (pathname.startsWith('/api/engagement/newsletter-public/')) throw stop;
        const route = recordRoutes.find((r: any) => result.routePath(r, fixtures) === pathname);
        if (!route) throw Error('Unexpected record probe');
        calls.push({ base, pathname, init });
        return { status: route.handler === badHandler ? status : 200, contentType: 'application/json', serviceHeader: 'engagement-api',
          body: route.handler === badHandler ? replacement : bodies[route.handler] };
      },
    });
    let error: any;
    try { await result.main(); } catch (caught) { error = caught; }
    return { calls, stop, error };
  }
  test('actual loop requests all four persisted records on both services with bearer auth', async () => {
    const { calls, stop, error } = await recordLoop();
    expect(error).toBe(stop); expect(calls).toHaveLength(8);
    expect(calls.filter((c) => c.base === 'main')).toHaveLength(4);
    expect(calls.every((c) => c.init.headers.Authorization === 'Bearer synthetic-session')).toBe(true);
  });
  test.each(recordRoutes)('$handler cannot pass with matching404, empty200 or another record', async (route: any) => {
    for (const [status, body] of [[404, { message: 'not found' }], [200, null], [200, { id: missing }]] as const) {
      expect((await recordLoop(route.handler, status, body)).error.message).toMatch(/must return its expected record/);
    }
  });
  test('history requires a real creator revision, and disabled prep has an explicit configuration error', async () => {
    const { result, fixtures } = context(fixture);
    const history = recordRoutes.find((r: any) => r.handler === 'history');
    for (const items of [[], [{ version: 1, operation: 'create_plan', actorUserId: 'other', snapshot: { id: recordReads.planId, clientId: missing, title: 'Phase 1 read parity plan' } }]]) {
      expect(() => result.requireSeededRecordRead(history, fixtures, { status: 200, body: { planId: recordReads.planId, clientId: missing, planVersion: 1, items } })).toThrow(/expected record/);
    }
    expect((await recordLoop('prepJob', 200, null)).error.message).toMatch(/comprehensive prep must be configured on both services/);
  });

  async function run(status = 200, mismatch = false, denialStatus = 404) {
    const calls: any[] = [],
      stop = new Error('reached unchanged session-auth checks');
    const { result } = context(fixture, {
      probe: async (base: string, pathname: string, init: any = {}) => {
        if (pathname === '/api/engagement/meetings') throw stop;
        calls.push({ base, pathname, init });
        const negative =
          pathname.includes('invalid-token') ||
          pathname.includes('0'.repeat(64)) ||
          pathname.includes(fixture.unpublishedToken) ||
          pathname.includes('phase1-missing');
        const missingQuery = pathname.endsWith('/survey');
        return {
          status: negative ? denialStatus : missingQuery ? 400 : status,
          contentType: 'text/html',
          serviceHeader: 'engagement-api',
          body: mismatch && base === 'engagement' ? 'different' : 'same',
        };
      },
    });
    let error: any;
    try {
      await result.main();
    } catch (caught) {
      error = caught;
    }
    return { calls, error, stop };
  }
  test('actual public loop omits bearer, requires real positive responses and checks denials on both services', async () => {
    const { calls, error, stop } = await run();
    expect(error).toBe(stop);
    expect(calls).toHaveLength(18);
    expect(calls.filter((c) => c.base === 'main')).toHaveLength(9);
    for (const call of calls) expect(call.init.headers?.Authorization).toBeUndefined();
    expect(calls.find((c) => c.pathname.includes('/survey?block=survey'))?.pathname).toContain(
      'answer=Useful+%26+clear',
    );
  });
  test('matching404s cannot qualify published reads and the error does not reveal the capability', async () => {
    const { error } = await run(404);
    expect(error.message).toMatch(/Seeded public read must succeed/);
    expect(error.message).not.toContain(fixture.token);
  });
  test('body drift and a successful refusal probe both fail the real loop', async () => {
    expect((await run(200, true)).error.message).toMatch(/Read parity mismatch/);
    expect((await run(200, false, 200)).error.message).toMatch(/expected one of 404/);
  });
});
