import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, Script } from 'node:vm';
import * as nodeCrypto from 'node:crypto';
import { isDeepStrictEqual, types as nodeTypes } from 'node:util';
import ts from 'typescript';

// Composition tests against actual service/parser/native receiving sources.
// Codec, native/session/resource/DTO I/O are synthetic. No JCS, signature,
// native frame/session/membership/grant/wall/run/fence or HTTP qualification.
const root = resolve(__dirname, '../../../..');
const source = (name: string) => readFileSync(resolve(root, 'apps/api/src', name), 'utf8');
class HttpRefusal extends Error {
  constructor(
    readonly status: number,
    readonly response: unknown,
  ) {
    super(String(response));
  }
  getStatus() {
    return this.status;
  }
}
const refusal = (status: number) =>
  class extends HttpRefusal {
    constructor(response: unknown) {
      super(status, response);
    }
  };
const decorator = () => () => undefined;
const nest = {
  Injectable: decorator,
  Inject: decorator,
  HttpException: HttpRefusal,
  BadRequestException: refusal(400),
  UnauthorizedException: refusal(401),
  ForbiddenException: refusal(403),
  NotFoundException: refusal(404),
  RequestTimeoutException: refusal(408),
  ConflictException: refusal(409),
  ServiceUnavailableException: refusal(503),
};
// One realm preserves inert-object checks across the actual imported modules.
const runtime = createContext({ Date, Buffer });
const realm = new Script('(value) => JSON.parse(JSON.stringify(value))').runInContext(runtime) as <
  T,
>(
  value: T,
) => T;
function load(text: string, ports: Record<string, unknown>): any {
  const module = { exports: {} as any };
  const compiled = ts.transpileModule(text, {
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true,
    },
  });
  expect(
    compiled.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error),
  ).toEqual([]);
  const evaluate = new Script(
    `(function(module, exports, require) { ${compiled.outputText}\n})`,
  ).runInContext(runtime);
  evaluate(module, module.exports, (id: string) => {
    if (!Object.hasOwn(ports, id)) throw new Error(`Unexpected actual-source import: ${id}`);
    return ports[id];
  });
  return module.exports;
}
const common = {
  '@nestjs/common': nest,
  'node:crypto': nodeCrypto,
  'node:util': { isDeepStrictEqual, types: nodeTypes },
};
const probe = load(
  readFileSync(resolve(root, 'packages/shared/src/core-retained-authority-probe.ts'), 'utf8'),
  common,
);
const sharedParser = load(
  readFileSync(resolve(root, 'packages/shared/src/core-retained-read-request.ts'), 'utf8'),
  {
    ...common,
    './core-retained-authority-probe.js': probe,
  },
);
const parser = load(source('auth/retained-read-request.ts'), {
  ...common,
  '@capiro/shared/core-retained-read-request': sharedParser,
});
const sharedSource = ts.createSourceFile(
  'shared.ts',
  readFileSync(resolve(root, 'packages/shared/src/index.ts'), 'utf8'),
  ts.ScriptTarget.ES2022,
);
const roleDeclaration = sharedSource.statements.find(
  (statement) =>
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(
      (value) => value.name.getText(sharedSource) === 'ROLE_RANK',
    ),
);
if (!roleDeclaration) throw new Error('Canonical role declaration missing');
const roles = load(roleDeclaration.getText(sharedSource), {});
const native = load(source('auth/retained-native-authority.ts'), {
  ...common,
  '@capiro/shared': roles,
});
const owner = load(source('auth/retained-principal.service.ts'), {
  ...common,
  '../research-portfolios/research-portfolios.service.js': {},
  '../research-portfolios/research-portfolio-changes.service.js': {},
  '../tenant/tenant-context.middleware.js': {},
  './retained-read-authority.service.js': {},
  './retained-read-request.js': parser,
  './retained-native-authority.js': native,
});

const NOW = 1_800_000_000_000;
const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const portfolioId = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const identityRevision = 'a'.repeat(64),
  resourceRevision = 'b'.repeat(64);
type Operation =
  | 'get_research_portfolio'
  | 'get_research_portfolio_changes'
  | 'get_florida_budget_project';
const operations: Operation[] = [
  'get_research_portfolio',
  'get_research_portfolio_changes',
  'get_florida_budget_project',
];
const recipientPaths: Record<Operation, string> = {
  get_research_portfolio: '/api/clio/retained-reads/research-portfolio',
  get_research_portfolio_changes: '/api/clio/retained-reads/research-portfolio-changes',
  get_florida_budget_project: '/intel-api/internal/legiwatch/retained-florida-budget',
};
// Deliberately synthetic canonicalizer port; actual JCS is qualified separately.
const canonicalize = (value: unknown): string => JSON.stringify(value);
function bodyFor(operation: Operation, issuer = false): any {
  const context =
    operation === 'get_florida_budget_project'
      ? {
          asOf: new Date(NOW).toISOString(),
          effectiveScope: { jurisdiction: 'FL', sessionKey: '', folderId: null, clientId: null },
          clientResolution: null,
        }
      : {
          binding: {
            tenantId,
            actorId,
            conversationId: '33333333-3333-4333-8333-333333333333',
            runId: '44444444-4444-4444-8444-444444444444',
            attemptId: '55555555-5555-4555-8555-555555555555',
            workerId: '66666666-6666-4666-8666-666666666666',
            writerFence: 1,
          },
          subject: {
            kind: 'entity',
            entityType: 'research-portfolio',
            entityIds: [portfolioId],
            tenantId,
            actorId,
            authorizationDecisionId: '77777777-7777-4777-8777-777777777777',
            policyRevision: 'synthetic-policy',
            scopes: [
              {
                tenantId,
                kind: 'tenant',
                resourceId: tenantId,
                policyRevision: 'synthetic-policy',
              },
            ],
            rosterVersionId: null,
          },
        };
  return realm({
    schemaVersion: 1,
    request: {},
    context,
    ...(issuer ? { originalExpiresAtMs: NOW + 50_000 } : {}),
  });
}
function fixture(operation: Operation = 'get_research_portfolio') {
  const body = bodyFor(operation),
    req = { syntheticNativeRequest: true };
  const ctx = {
    tenantId,
    tenantSlug: 'synthetic',
    userId: actorId,
    clerkUserId: 'user_synthetic',
    role: 'standard_user',
  };
  const principal = realm({ tenantId, actorId, clerkUserId: ctx.clerkUserId });
  const capture = realm({
    principal,
    identityRevision,
    currentAuthority: '{"synthetic":"composition-only"}',
    originalExpiresAtMs: NOW + 50_000,
  });
  const facts: any = {
    identityRevision,
    resourceRevision,
    checkedAtMs: NOW,
    expiresAtMs: NOW + 45_000,
    ...(operation === 'get_florida_budget_project'
      ? { effectiveScope: body.context.effectiveScope, clientResolution: null }
      : { scope: { portfolioId } }),
  };
  const parsed = parser.parseRetainedReadBody(operation, body, { issuer: false }, canonicalize);
  let envelope: any = realm({
    ...capture,
    resourceRevision,
    ...parsed.digests,
    operation,
    recipientPath: recipientPaths[operation],
    issuedAtMs: NOW,
    originalExpiresAtMs: NOW + 20_000,
  });
  const signed = 'synthetic-opaque-signature-not-a-real-credential';
  const sign = jest.fn((input: any, _bounds: any) => {
    envelope = realm({ ...input, operation, recipientPath: recipientPaths[operation] });
    return signed;
  });
  const verify = jest.fn((authorization: unknown, _bounds: any) => {
    if (authorization !== signed) throw new nest.UnauthorizedException('synthetic codec refusal');
    return realm(envelope);
  });
  const ports: any = {
    canonicalize,
    signers: Object.fromEntries(operations.map((name) => [name, { sign }])),
    verifiers: Object.fromEntries(
      operations.map((name) => [name, { verifyCryptographically: verify }]),
    ),
  };
  const tenant = {
    captureRetainedNativeAuthority: jest.fn(
      async (_req: any, _ctx: any): Promise<any> => realm(capture),
    ),
    requiresVerifiedRetainedNativeAuthority: jest.fn(
      async (_verified: any): Promise<any> => ({
        context: ctx,
        identity: { principal, identityRevision, expiresAtMs: NOW + 50_000 },
      }),
    ),
  };
  const authority = {
    portfolio: jest.fn(async (..._args: any[]): Promise<any> => realm(facts)),
    floridaBudget: jest.fn(async (..._args: any[]): Promise<any> => realm(facts)),
    currentVerified: jest.fn(async (..._args: any[]): Promise<any> => realm(facts)),
  };
  const dto = { id: portfolioId, syntheticCanonicalDto: true };
  const portfolios = { detail: jest.fn(async (..._args: any[]): Promise<any> => dto) };
  const changes = { listChanges: jest.fn(async (..._args: any[]): Promise<any> => dto) };
  let cancelled = false;
  const control = {
    deadlineMs: NOW + 60_000,
    assertActive: jest.fn(() => {
      if (cancelled) throw new HttpRefusal(408, 'synthetic cancellation');
    }),
  };
  const service = (configured: any = ports) =>
    new owner.RetainedPrincipalService(tenant, authority, portfolios, changes, configured);
  return {
    operation,
    body,
    req,
    ctx,
    principal,
    capture,
    facts,
    ports,
    sign,
    verify,
    signed,
    tenant,
    authority,
    portfolios,
    changes,
    dto,
    control,
    service: service(),
    configured: service,
    cancel: () => {
      cancelled = true;
    },
    getEnvelope: () => realm(envelope),
    envelope: (patch: any) => {
      envelope = realm({ ...envelope, ...patch });
    },
  };
}
function noNativeOrBusinessIO(f: ReturnType<typeof fixture>) {
  for (const port of [
    f.tenant.captureRetainedNativeAuthority,
    f.tenant.requiresVerifiedRetainedNativeAuthority,
    f.authority.portfolio,
    f.authority.floridaBudget,
    f.authority.currentVerified,
    f.portfolios.detail,
    f.changes.listChanges,
  ]) {
    expect(port).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => jest.restoreAllMocks());

describe('RetainedPrincipalService actual-source composition', () => {
  it.each(['issue', 'verifyCurrent'] as const)(
    'refuses missing configuration before parsing or I/O: %s',
    async (method) => {
      const f = fixture();
      const getter = jest.fn();
      const body = Object.defineProperty(bodyFor(f.operation), 'request', {
        enumerable: true,
        get: getter,
      });
      const pending =
        method === 'issue'
          ? f.configured(null).issue(f.req, f.ctx, f.operation, body, f.control)
          : f.configured(null).verifyCurrent(f.signed, f.operation, body, f.control);
      await expect(pending).rejects.toMatchObject({ status: 503 });
      expect(getter).not.toHaveBeenCalled();
      noNativeOrBusinessIO(f);
    },
  );

  it.each(['signer', 'verifier'] as const)(
    'requires the requested operation %s before issuer I/O',
    async (missing) => {
      const f = fixture();
      delete f.ports[missing === 'signer' ? 'signers' : 'verifiers'][f.operation];
      await expect(
        f.service.issue(f.req, f.ctx, f.operation, bodyFor(f.operation, true), f.control),
      ).rejects.toMatchObject({ status: 503 });
      noNativeOrBusinessIO(f);
    },
  );

  it.each(['', '{}'])('refuses a non-preserving canonicalizer before I/O: %j', async (output) => {
    const f = fixture();
    f.ports.canonicalize = () => output;
    await expect(
      f.service.issue(f.req, f.ctx, f.operation, bodyFor(f.operation, true), f.control),
    ).rejects.toMatchObject({ status: 503 });
    noNativeOrBusinessIO(f);
    expect(f.sign).not.toHaveBeenCalled();
  });

  it.each(['operation', 'recipientPath'] as const)(
    'refuses a swapped receiving codec %s before native or resource I/O',
    async (field) => {
      const f = fixture();
      f.envelope(
        field === 'operation'
          ? { operation: 'get_research_portfolio_changes' }
          : { recipientPath: `${recipientPaths[f.operation]}/sibling` },
      );
      await expect(
        f.service.readPortfolio(f.signed, f.operation, f.body, f.control),
      ).rejects.toMatchObject({ status: 401 });
      expect(f.verify).toHaveBeenCalledTimes(1);
      noNativeOrBusinessIO(f);
    },
  );

  it.each(['operation', 'recipientPath'] as const)(
    'refuses a swapped issuer self-verification codec %s',
    async (field) => {
      const f = fixture();
      f.verify.mockImplementationOnce(() =>
        realm({
          ...f.getEnvelope(),
          ...(field === 'operation'
            ? { operation: 'get_research_portfolio_changes' }
            : { recipientPath: `${recipientPaths[f.operation]}/sibling` }),
        }),
      );
      await expect(
        f.service.issue(f.req, f.ctx, f.operation, bodyFor(f.operation, true), f.control),
      ).rejects.toMatchObject({ status: 401 });
      expect(f.sign).toHaveBeenCalledTimes(1);
      expect(f.tenant.captureRetainedNativeAuthority).toHaveBeenCalledTimes(2);
      expect(f.authority.portfolio).toHaveBeenCalledTimes(1);
      expect(f.portfolios.detail).not.toHaveBeenCalled();
    },
  );

  it.each(['extra', 'request-authority', 'conversation', 'issuer-expiry'] as const)(
    'admits the closed actual body before authority I/O: %s',
    async (kind) => {
      const f = fixture(),
        body = bodyFor(f.operation, true);
      if (kind === 'extra') body.actorId = actorId;
      if (kind === 'request-authority') body.request.portfolioId = portfolioId;
      if (kind === 'conversation')
        body.request.conversationId = '99999999-9999-4999-8999-999999999999';
      if (kind === 'issuer-expiry') delete body.originalExpiresAtMs;
      await expect(
        f.service.issue(f.req, f.ctx, f.operation, body, f.control),
      ).rejects.toMatchObject({ status: 400 });
      noNativeOrBusinessIO(f);
      expect(f.sign).not.toHaveBeenCalled();
    },
  );

  it('refuses a captured native Core principal different from the requested binding', async () => {
    const f = fixture();
    f.tenant.captureRetainedNativeAuthority.mockResolvedValueOnce(
      realm({ ...f.capture, principal: { ...f.principal, actorId: portfolioId } }),
    );
    await expect(
      f.service.issue(f.req, f.ctx, f.operation, bodyFor(f.operation, true), f.control),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.authority.portfolio).not.toHaveBeenCalled();
    expect(f.sign).not.toHaveBeenCalled();
  });

  it('refuses a receiving native Core principal different from the requested binding', async () => {
    const f = fixture();
    f.envelope({ principal: { ...f.principal, actorId: portfolioId } });
    await expect(
      f.service.readPortfolio(f.signed, f.operation, f.body, f.control),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.tenant.requiresVerifiedRetainedNativeAuthority).toHaveBeenCalledTimes(1);
    expect(f.authority.currentVerified).not.toHaveBeenCalled();
    expect(f.portfolios.detail).not.toHaveBeenCalled();
  });

  it.each(['native', 'resource'] as const)(
    'signature acceptance alone never authorizes a DTO read: %s refusal',
    async (refusing) => {
      const f = fixture();
      if (refusing === 'native')
        f.tenant.requiresVerifiedRetainedNativeAuthority.mockRejectedValueOnce(
          new nest.ForbiddenException('native revoked'),
        );
      else
        f.authority.currentVerified.mockRejectedValueOnce(
          new nest.NotFoundException('resource revoked'),
        );
      await expect(
        f.service.readPortfolio(f.signed, f.operation, f.body, f.control),
      ).rejects.toMatchObject({ status: refusing === 'native' ? 403 : 404 });
      expect(f.verify).toHaveBeenCalled();
      expect(f.tenant.requiresVerifiedRetainedNativeAuthority).toHaveBeenCalledTimes(1);
      if (refusing === 'native') expect(f.authority.currentVerified).not.toHaveBeenCalled();
      expect(f.portfolios.detail).not.toHaveBeenCalled();
    },
  );

  it('checks exact actual digests and native/resource owners before and after the canonical DTO read', async () => {
    const f = fixture();
    await expect(f.service.readPortfolio(f.signed, f.operation, f.body, f.control)).resolves.toBe(
      f.dto,
    );
    expect(f.portfolios.detail).toHaveBeenCalledWith(f.ctx, portfolioId);
    expect(f.tenant.requiresVerifiedRetainedNativeAuthority).toHaveBeenCalledTimes(2);
    expect(f.authority.currentVerified).toHaveBeenCalledTimes(2);
    const expected = parser.parseRetainedReadBody(
      f.operation,
      f.body,
      { issuer: false },
      canonicalize,
    ).digests;
    expect(
      f.verify.mock.calls.every(
        (call) => JSON.stringify(call[1].expectedDigests) === JSON.stringify(expected),
      ),
    ).toBe(true);
    expect(f.authority.currentVerified.mock.invocationCallOrder[0]).toBeLessThan(
      f.portfolios.detail.mock.invocationCallOrder[0]!,
    );
    expect(f.authority.currentVerified.mock.invocationCallOrder[1]).toBeGreaterThan(
      f.portfolios.detail.mock.invocationCallOrder[0]!,
    );
  });

  it('forwards actual normalized changes cursor and explicit default25 to its canonical DTO owner', async () => {
    const f = fixture('get_research_portfolio_changes');
    f.body.request.cursor = '  retained-event-id  ';
    f.envelope(
      parser.parseRetainedReadBody(f.operation, f.body, { issuer: false }, canonicalize).digests,
    );
    await f.service.readPortfolio(f.signed, f.operation, f.body, f.control);
    expect(f.changes.listChanges).toHaveBeenCalledWith(f.ctx, portfolioId, 'retained-event-id', 25);
    expect(f.portfolios.detail).not.toHaveBeenCalled();
  });

  it.each(['identityRevision', 'resourceRevision'] as const)(
    'refuses changed %s before any DTO read',
    async (field) => {
      const f = fixture();
      f.authority.currentVerified.mockResolvedValueOnce(
        realm({ ...f.facts, [field]: 'c'.repeat(64) }),
      );
      await expect(
        f.service.readPortfolio(f.signed, f.operation, f.body, f.control),
      ).rejects.toMatchObject({ status: 409 });
      expect(f.portfolios.detail).not.toHaveBeenCalled();
    },
  );

  it.each(['identityRevision', 'resourceRevision'] as const)(
    'refuses changed %s after a read instead of releasing its result',
    async (field) => {
      const f = fixture();
      f.authority.currentVerified
        .mockResolvedValueOnce(realm(f.facts))
        .mockResolvedValueOnce(realm({ ...f.facts, [field]: 'c'.repeat(64) }));
      await expect(
        f.service.readPortfolio(f.signed, f.operation, f.body, f.control),
      ).rejects.toMatchObject({ status: 409 });
      expect(f.portfolios.detail).toHaveBeenCalledTimes(1);
    },
  );

  it('refuses native authority revoked after the DTO read before releasing its result', async () => {
    const f = fixture();
    f.tenant.requiresVerifiedRetainedNativeAuthority
      .mockResolvedValueOnce({ context: f.ctx })
      .mockRejectedValueOnce(new nest.ForbiddenException('native revoked after read'));
    await expect(
      f.service.readPortfolio(f.signed, f.operation, f.body, f.control),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.portfolios.detail).toHaveBeenCalledTimes(1);
    expect(f.authority.currentVerified).toHaveBeenCalledTimes(1);
  });

  it('refuses a native current-owner identity change during issuance before signing', async () => {
    const f = fixture();
    f.tenant.captureRetainedNativeAuthority
      .mockResolvedValueOnce(realm(f.capture))
      .mockResolvedValueOnce(realm({ ...f.capture, identityRevision: 'c'.repeat(64) }));
    await expect(
      f.service.issue(f.req, f.ctx, f.operation, bodyFor(f.operation, true), f.control),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.sign).not.toHaveBeenCalled();
  });

  it('shortens issuance to the original requested/native/resource/deadline bounds without refreshing expiry', async () => {
    const f = fixture(),
      body = bodyFor(f.operation, true);
    body.originalExpiresAtMs = NOW + 12_000;
    f.tenant.captureRetainedNativeAuthority
      .mockResolvedValueOnce(realm({ ...f.capture, originalExpiresAtMs: NOW + 10_000 }))
      .mockResolvedValueOnce(realm({ ...f.capture, originalExpiresAtMs: NOW + 9000 }));
    f.authority.portfolio.mockResolvedValueOnce(realm({ ...f.facts, expiresAtMs: NOW + 8000 }));
    f.control.deadlineMs = NOW + 7000;
    await f.service.issue(f.req, f.ctx, f.operation, body, f.control);
    expect(f.sign.mock.calls[0]![0].originalExpiresAtMs).toBe(NOW + 7000);
    expect(f.tenant.captureRetainedNativeAuthority).toHaveBeenCalledWith(f.req, f.ctx);
    expect(f.sign.mock.calls[0]![0]).not.toHaveProperty('request');
  });

  it('keeps the signed original expiry on receiving even when current facts have a later expiry', async () => {
    const f = fixture();
    const result = await f.service.verifyCurrent(f.signed, f.operation, f.body, f.control);
    expect(result.receipt.originalExpiresAtMs).toBe(NOW + 20_000);
    expect(result.receipt.checkedAtMs).toBe(NOW);
    expect(Object.isFrozen(result.receipt)).toBe(true);
  });

  it('shortens the receiving original expiry to the current resource expiry', async () => {
    const f = fixture();
    f.authority.currentVerified.mockResolvedValueOnce(
      realm({ ...f.facts, expiresAtMs: NOW + 5000 }),
    );
    const result = await f.service.verifyCurrent(f.signed, f.operation, f.body, f.control);
    expect(result.receipt.originalExpiresAtMs).toBe(NOW + 5000);
  });

  it.each(['effectiveScope', 'clientResolution'] as const)(
    'refuses Florida %s drift before issuing a principal',
    async (field) => {
      const f = fixture('get_florida_budget_project');
      const patch =
        field === 'effectiveScope'
          ? { effectiveScope: { ...f.facts.effectiveScope, clientId } }
          : { clientResolution: { selector: clientId, clientId } };
      f.authority.floridaBudget.mockResolvedValueOnce(realm({ ...f.facts, ...patch }));
      await expect(
        f.service.issue(f.req, f.ctx, f.operation, bodyFor(f.operation, true), f.control),
      ).rejects.toMatchObject({ status: 409 });
      expect(f.sign).not.toHaveBeenCalled();
      expect(f.portfolios.detail).not.toHaveBeenCalled();
    },
  );

  it('refuses Florida effective scope drift during receiving current-authority verification', async () => {
    const f = fixture('get_florida_budget_project');
    f.authority.currentVerified.mockResolvedValueOnce(
      realm({
        ...f.facts,
        effectiveScope: { ...f.facts.effectiveScope, sessionKey: 'different-session' },
      }),
    );
    await expect(
      f.service.verifyCurrent(f.signed, f.operation, f.body, f.control),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.portfolios.detail).not.toHaveBeenCalled();
    expect(f.changes.listChanges).not.toHaveBeenCalled();
  });

  it.each(['capture', 'issue-resource', 'native', 'resource', 'dto'] as const)(
    'cancels after %s await without subsequent I/O',
    async (at) => {
      const f = fixture();
      if (at === 'capture')
        f.tenant.captureRetainedNativeAuthority.mockImplementationOnce(async () => {
          f.cancel();
          return realm(f.capture);
        });
      if (at === 'issue-resource')
        f.authority.portfolio.mockImplementationOnce(async () => {
          f.cancel();
          return realm(f.facts);
        });
      if (at === 'native')
        f.tenant.requiresVerifiedRetainedNativeAuthority.mockImplementationOnce(async () => {
          f.cancel();
          return { context: f.ctx };
        });
      if (at === 'resource')
        f.authority.currentVerified.mockImplementationOnce(async () => {
          f.cancel();
          return realm(f.facts);
        });
      if (at === 'dto')
        f.portfolios.detail.mockImplementationOnce(async () => {
          f.cancel();
          return f.dto;
        });
      const issuing = at === 'capture' || at === 'issue-resource';
      await expect(
        issuing
          ? f.service.issue(f.req, f.ctx, f.operation, bodyFor(f.operation, true), f.control)
          : f.service.readPortfolio(f.signed, f.operation, f.body, f.control),
      ).rejects.toMatchObject({ status: 408 });
      expect(f.sign).not.toHaveBeenCalled();
      if (issuing) expect(f.tenant.captureRetainedNativeAuthority).toHaveBeenCalledTimes(1);
      if (at === 'capture') expect(f.authority.portfolio).not.toHaveBeenCalled();
      if (at === 'native') expect(f.authority.currentVerified).not.toHaveBeenCalled();
      if (!issuing)
        expect(f.tenant.requiresVerifiedRetainedNativeAuthority).toHaveBeenCalledTimes(1);
      expect(f.portfolios.detail).toHaveBeenCalledTimes(at === 'dto' ? 1 : 0);
    },
  );

  it('cancels at the latest issuance capture without signing', async () => {
    const f = fixture();
    f.tenant.captureRetainedNativeAuthority
      .mockResolvedValueOnce(realm(f.capture))
      .mockImplementationOnce(async () => {
        f.cancel();
        return realm(f.capture);
      });
    await expect(
      f.service.issue(f.req, f.ctx, f.operation, bodyFor(f.operation, true), f.control),
    ).rejects.toMatchObject({ status: 408 });
    expect(f.authority.portfolio).toHaveBeenCalledTimes(1);
    expect(f.tenant.captureRetainedNativeAuthority).toHaveBeenCalledTimes(2);
    expect(f.sign).not.toHaveBeenCalled();
  });

  it.each(['native', 'resource'] as const)(
    'cancels at the final %s await after reading without releasing',
    async (at) => {
      const f = fixture();
      if (at === 'native') {
        f.tenant.requiresVerifiedRetainedNativeAuthority
          .mockResolvedValueOnce({ context: f.ctx })
          .mockImplementationOnce(async () => {
            f.cancel();
            return { context: f.ctx };
          });
      } else {
        f.authority.currentVerified
          .mockResolvedValueOnce(realm(f.facts))
          .mockImplementationOnce(async () => {
            f.cancel();
            return realm(f.facts);
          });
      }
      await expect(
        f.service.readPortfolio(f.signed, f.operation, f.body, f.control),
      ).rejects.toMatchObject({ status: 408 });
      expect(f.portfolios.detail).toHaveBeenCalledTimes(1);
      expect(f.tenant.requiresVerifiedRetainedNativeAuthority).toHaveBeenCalledTimes(2);
      expect(f.authority.currentVerified).toHaveBeenCalledTimes(at === 'native' ? 1 : 2);
      expect(f.sign).not.toHaveBeenCalled();
    },
  );

  it.each(['issuer-native', 'issuer-resource', 'receiver-native', 'receiver-resource'] as const)(
    'refuses an await settling after the original cutoff without subsequent I/O: %s',
    async (at) => {
      const f = fixture();
      const cutoff = NOW + 1000;
      const settleLate = () => jest.mocked(Date.now).mockReturnValue(cutoff + 1);
      const issuing = at.startsWith('issuer');
      const body = bodyFor(f.operation, issuing);
      if (at === 'issuer-native') {
        body.originalExpiresAtMs = cutoff;
        f.tenant.captureRetainedNativeAuthority.mockImplementationOnce(async () => {
          settleLate();
          return realm(f.capture);
        });
      } else if (at === 'issuer-resource') {
        f.tenant.captureRetainedNativeAuthority.mockResolvedValueOnce(
          realm({ ...f.capture, originalExpiresAtMs: cutoff }),
        );
        f.authority.portfolio.mockImplementationOnce(async () => {
          settleLate();
          return realm(f.facts);
        });
      } else {
        f.envelope({ originalExpiresAtMs: cutoff });
        if (at === 'receiver-native') {
          f.tenant.requiresVerifiedRetainedNativeAuthority.mockImplementationOnce(async () => {
            settleLate();
            return { context: f.ctx };
          });
        } else {
          f.authority.currentVerified.mockImplementationOnce(async () => {
            settleLate();
            return realm(f.facts);
          });
        }
      }
      await expect(
        issuing
          ? f.service.issue(f.req, f.ctx, f.operation, body, f.control)
          : f.service.readPortfolio(f.signed, f.operation, body, f.control),
      ).rejects.toMatchObject({ status: 408 });
      expect(f.sign).not.toHaveBeenCalled();
      expect(f.portfolios.detail).not.toHaveBeenCalled();
      if (issuing) expect(f.tenant.captureRetainedNativeAuthority).toHaveBeenCalledTimes(1);
      if (at === 'issuer-native') expect(f.authority.portfolio).not.toHaveBeenCalled();
      if (at === 'receiver-native') expect(f.authority.currentVerified).not.toHaveBeenCalled();
      if (!issuing)
        expect(f.tenant.requiresVerifiedRetainedNativeAuthority).toHaveBeenCalledTimes(1);
    },
  );

  it('does not release a DTO settling after the first current receipt cutoff', async () => {
    const f = fixture();
    const cutoff = NOW + 1000;
    f.authority.currentVerified.mockResolvedValueOnce(realm({ ...f.facts, expiresAtMs: cutoff }));
    f.portfolios.detail.mockImplementationOnce(async () => {
      jest.mocked(Date.now).mockReturnValue(cutoff + 1);
      return f.dto;
    });
    await expect(
      f.service.readPortfolio(f.signed, f.operation, f.body, f.control),
    ).rejects.toMatchObject({ status: 408 });
    expect(f.portfolios.detail).toHaveBeenCalledTimes(1);
    expect(f.tenant.requiresVerifiedRetainedNativeAuthority).toHaveBeenCalledTimes(1);
    expect(f.authority.currentVerified).toHaveBeenCalledTimes(1);
  });

  it('cannot extend a signed cutoff by moving the caller deadline later during an await', async () => {
    const f = fixture();
    const cutoff = NOW + 1000;
    f.envelope({ originalExpiresAtMs: cutoff });
    f.tenant.requiresVerifiedRetainedNativeAuthority.mockImplementationOnce(async () => {
      f.control.deadlineMs = NOW + 120_000;
      jest.mocked(Date.now).mockReturnValue(cutoff + 1);
      return { context: f.ctx };
    });
    await expect(
      f.service.readPortfolio(f.signed, f.operation, f.body, f.control),
    ).rejects.toMatchObject({ status: 408 });
    expect(f.tenant.requiresVerifiedRetainedNativeAuthority).toHaveBeenCalledTimes(1);
    expect(f.authority.currentVerified).not.toHaveBeenCalled();
    expect(f.portfolios.detail).not.toHaveBeenCalled();
  });
});
