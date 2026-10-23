import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { NotFoundException } from '@nestjs/common';
import { NewsletterOutreachService } from '../src/engagement/newsletter-outreach.service.js';
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
    clientIds: [missing],
    meetingIds: { current: missing },
    outreachIds: { draft: missing },
    audienceIds: { list: missing },
    campaignId: missing,
    taskId: missing,
    newsletterPublic: fixture,
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
  test('all four new public paths resolve; the four old fixture gaps remain explicit failures', () => {
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
    // Evidence of inherited blockers, NOT an exemption in the acceptance runner.
    expect(unresolved.sort()).toEqual(
      [
        '/api/engagement/mail/send-intents/:requestKey',
        '/api/engagement/meetings/:id/prep-jobs/:jobId',
        '/api/engagement/plans/:planId',
        '/api/engagement/plans/:planId/history',
      ].sort(),
    );
    const survey = publicReads.find((r: any) => r.handler === 'survey');
    const query = new URLSearchParams(result.queryForRoute(survey, fixtures));
    expect(query.get('block')).toBe(fixture.survey.block);
    expect(query.get('answer')).toBe(fixture.survey.answer);
    expect(result.authHeaders().Authorization).toBe('Bearer synthetic-session');
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
