/** Inert leaf ports only: never import MeriToolsService or any provider/service graph. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { executeMeriLocalDispatch } from './meri-local-dispatch.js';

const root = resolve(__dirname, '../../../..');
const packet = resolve(root, 'docs/cleanup-meri-local-dispatch-conversion-20261012');
const oracle = JSON.parse(
  readFileSync(resolve(packet, 'evidence/before-dispatch-oracle.json'), 'utf8'),
) as {
  head: string;
  executeScoped: string;
  researchPortfolioWrapper: string;
  groups: Array<{ names: string[]; statements: string }>;
  pureHelpers: Record<string, string>;
  execute: string;
  executeFromAuthenticatedUser: string;
  outsideMethodSha256: string;
};
const source = readFileSync(resolve(__dirname, 'meri-tools.service.ts'), 'utf8');
const ast = ts.createSourceFile('owner.ts', source, ts.ScriptTarget.Latest, true);
const ownerClass = ast.statements.find(
  (n): n is ts.ClassDeclaration => ts.isClassDeclaration(n) && n.name?.text === 'MeriToolsService',
)!;
const method = ownerClass.members.find(
  (n): n is ts.MethodDeclaration =>
    ts.isMethodDeclaration(n) && n.name?.getText(ast) === 'executeScoped',
)!;
const names = oracle.groups.flatMap((g) => g.names);
const ctx = Object.freeze({
  tenantId: 'tenant',
  userId: 'user',
  role: 'standard_user',
  clerkUserId: 'clerk',
  tenantSlug: 'slug',
});
const input = Object.freeze({
  clientId: 'client',
  conversationId: 'conversation',
  source: 'sam',
  sourceRecordId: 'row',
  query: 'query',
  page: 2,
  pageSize: 7,
  activeState: 'active',
  offset: 1,
  limit: 3,
  summaryOffset: 4,
  summaryLimit: 5,
  opportunities: [null, { source: 'grant', sourceRecordId: 'other' }],
});
const execution = Object.freeze({ actionProposalId: 'proposal' });
const result = Object.freeze({ sentinel: 'exact result' });
const failure = new Error('synthetic owner failure');
const activeFailure = new Error('synthetic request cancellation');
const absent = Symbol('argument explicitly undefined');
function digest(s: string) {
  return createHash('sha256').update(s).digest('hex');
}
function bodyOf(text: string) {
  const sf = ts.createSourceFile(
    'fragment.ts',
    `class Fragment { ${text} }`,
    ts.ScriptTarget.Latest,
    true,
  );
  return (sf.statements[0] as ts.ClassDeclaration).members[0] as ts.MethodDeclaration;
}
function emit(s: string) {
  return ts.transpileModule(s, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}
const frozenBody = bodyOf(oracle.executeScoped).body!.getText();
const fragments = `${Object.entries(oracle.pureHelpers)
  .filter(([k]) => k === 'toolActor' || k === 'assertNever')
  .map(([, v]) => v)
  .join('\n')}\n${oracle.researchPortfolioWrapper.replace('export ', '')}`;
const baselineCode = emit(
  `${fragments}\nasync function dispatch(ctx,name,input,execution) ${frozenBody}\ndispatch;`,
);
const candidateCode = emit(
  `${fragments}\nasync function dispatch(ctx,name,input,execution) ${method.body!.getText(ast)}\ndispatch;`,
);

type Options = {
  inactive?: boolean;
  getThrow?: boolean;
  leafThrow?: boolean;
  leafReturn?: (trace: unknown[]) => unknown;
  districtMissing?: boolean;
  scopeMissing?: boolean;
  turn?: Record<string, unknown>;
  rows?: Array<unknown>;
  grant?: unknown;
  authorizationThrow?: boolean;
  databaseThrow?: boolean;
};
function harness(code: string, opts: Options = {}) {
  const trace: unknown[] = [];
  const calls: Array<{ port: string; args: unknown[]; receiver: string }> = [];
  const data: Record<string, unknown> = {
    contextPlane: 'context plane',
    governedMemoryCandidates: 'memory candidates',
    researchPortfolioScope: opts.scopeMissing ? undefined : 'scope service',
  };
  const rows = opts.rows ?? [
    { clientId: 'client', metadata: { researchPortfolioId: 'portfolio' } },
    { clientId: 'client', metadata: { researchPortfolioId: 'portfolio' } },
  ];
  let load = 0;
  data.prisma = {
    withTenant(tenant: string, callback: (tx: unknown) => unknown) {
      trace.push(['withTenant', tenant]);
      return callback({
        clioConversation: {
          findFirst(query: unknown) {
            trace.push(['findFirst', query]);
            if (opts.databaseThrow) throw failure;
            return Promise.resolve(rows[load++]);
          },
        },
      });
    },
  };
  const leaf = (port: string, args: unknown[], receiver: string) => {
    trace.push(['leaf', port]);
    calls.push({ port, args, receiver });
    if (opts.leafThrow) throw failure;
    return opts.leafReturn ? opts.leafReturn(trace) : result;
  };
  // Each nested port has a stable receiver; constructing the registry must not read it.
  function makePort(owner: string) {
    const port = new Proxy(
      {},
      {
        get(_t, key) {
          trace.push(['get', `${owner}.${String(key)}`]);
          if (opts.getThrow) throw failure;
          return function (this: unknown, ...args: unknown[]) {
            return leaf(`${owner}.${String(key)}`, args, this === port ? owner : 'wrong');
          };
        },
      },
    );
    return port;
  }
  const ports = {
    districtTools: makePort('districtTools'),
    opportunityTools: makePort('opportunityTools'),
    researchPortfolio: makePort('researchPortfolio'),
    bizDev: makePort('bizDev'),
  };
  let fake: object;
  fake = new Proxy(
    {},
    {
      get(_t, key) {
        trace.push(['get', String(key)]);
        if (Object.prototype.hasOwnProperty.call(data, key)) return data[String(key)];
        if (key === 'districtTools') return opts.districtMissing ? undefined : ports.districtTools;
        if (key === 'opportunityTools') return ports.opportunityTools;
        if (opts.getThrow) throw failure;
        if (key === 'requireResearchPortfolioTools' || key === 'requireBizDevTools')
          return function (this: unknown) {
            trace.push(['require', String(key), this === fake]);
            return key === 'requireResearchPortfolioTools' ? ports.researchPortfolio : ports.bizDev;
          };
        return function (this: unknown, ...args: unknown[]) {
          return leaf(String(key), args, this === fake ? 'service' : 'wrong');
        };
      },
    },
  );
  class BadRequestException extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'BadRequestException';
    }
  }
  class ForbiddenException extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ForbiddenException';
    }
  }
  class NotFoundException extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'NotFoundException';
    }
  }
  const sandbox = {
    executeMeriLocalDispatch,
    assertMeriToolRequestActive() {
      trace.push('active');
      if (opts.inactive) throw activeFailure;
    },
    storage: {
      getStore() {
        trace.push('current turn');
        return opts.turn;
      },
    },
    authorizeMeriResearchPortfolioScope(scope: unknown, actor: unknown, metadata: unknown) {
      trace.push(['authorize', scope, actor, metadata]);
      if (opts.authorizationThrow) throw failure;
      return Promise.resolve(opts.grant ?? true);
    },
    isDeepStrictEqual,
    BadRequestException,
    ForbiddenException,
    NotFoundException,
    getResearchEvidence: (...args: unknown[]) => leaf('getResearchEvidence', args, 'global'),
    searchCapiroData: (...args: unknown[]) => leaf('searchCapiroData', args, 'global'),
    readOwnPendingMemoryProposals: (...args: unknown[]) =>
      leaf('readOwnPendingMemoryProposals', args, 'global'),
    fetch: undefined,
    process: undefined,
    require: undefined,
  };
  const dispatch = runInNewContext(code, sandbox, { timeout: 1000 }) as (
    ...args: unknown[]
  ) => Promise<unknown>;
  return { trace, calls, data, dispatch: (...args: unknown[]) => dispatch.call(fake, ...args) };
}
async function compare(
  name: unknown,
  options: Options = {},
  data: unknown = input,
  actor: unknown = ctx,
  exec: unknown = execution,
) {
  const before = harness(baselineCode, options),
    after = harness(candidateCode, options);
  const settle = async (h: ReturnType<typeof harness>) => {
    let p: Promise<unknown>;
    // Both are async; owner/getter throws must be rejected promises, never sync escapes.
    expect(() => {
      p = h.dispatch(
        actor === absent ? undefined : actor,
        name,
        data === absent ? undefined : data,
        exec === absent ? undefined : exec,
      );
    }).not.toThrow();
    const synchronous = [...h.trace];
    try {
      const value = await p!;
      return { synchronous, ok: true, value, exact: value === result };
    } catch (error) {
      const e = error as Error;
      return {
        synchronous,
        ok: false,
        identity: error === failure || error === activeFailure,
        name: e.name,
        message: e.message,
      };
    }
  };
  const b = await settle(before),
    a = await settle(after);
  expect(a).toEqual(b);
  expect(after.trace).toEqual(before.trace);
  const normalizeCalls = (h: ReturnType<typeof harness>) =>
    h.calls.map((c) => ({
      ...c,
      args: c.args.map((arg) => (arg === h.data.prisma ? '<same harness prisma>' : arg)),
    }));
  expect(normalizeCalls(after)).toEqual(normalizeCalls(before));
  expect(after.trace[0]).toBe('active');
  return { before, after, outcome: a };
}

describe('Meri local dispatch frozen-switch equivalence (inert ports)', () => {
  test('oracle pins exact reviewed switch and authority helper, with 134 unique cases', () => {
    expect(oracle.head).toBe('802bbd0b2c510a44e46a9952d8127e7edc55aaaa');
    expect(digest(oracle.executeScoped)).toBe(
      'a67ef2db537d518a176a734e7f0d89395e521122d731ab5e9da06bf243b71a41',
    );
    expect(digest(oracle.researchPortfolioWrapper)).toBe(
      'a0e30c9bba638844a193ed1a276edaec37a7e733c396ae807df79d3d64a99a47',
    );
    expect(names.length).toBe(134);
    expect(new Set(names).size).toBe(134);
    const rpSource = readFileSync(resolve(__dirname, 'meri-rp-tool-transport.ts'), 'utf8');
    expect(rpSource).toContain(oracle.researchPortfolioWrapper);
    const sf = ts.createSourceFile(
      'registry.ts',
      method.body!.getText(ast),
      ts.ScriptTarget.Latest,
      true,
    );
    let table: ts.ObjectLiteralExpression | undefined, rpStatement: string | undefined;
    function visit(n: ts.Node) {
      if (ts.isVariableDeclaration(n) && n.name.getText(sf) === 'registry')
        table = (n.initializer as ts.SatisfiesExpression).expression as ts.ObjectLiteralExpression;
      if (ts.isVariableDeclaration(n) && n.name.getText(sf) === 'researchPortfolio')
        rpStatement = ((n.initializer as ts.ArrowFunction).body as ts.Block).statements[0]!.getText(
          sf,
        );
      ts.forEachChild(n, visit);
    }
    visit(sf);
    expect(table!.properties.map((p) => p.name!.getText(sf))).toEqual(names);
    expect(rpStatement).toBe(oracle.groups[0]!.statements);
    const outside =
      source.slice(0, method.body!.getStart(ast)) +
      '<dispatch-body>' +
      source.slice(method.body!.end);
    expect(
      digest(
        outside.replace(
          "import { executeMeriLocalDispatch, type MeriLocalDispatchRegistry } from './meri-local-dispatch.js';\n",
          '',
        ),
      ),
    ).toBe(oracle.outsideMethodSha256);
  });
  test.each(names)(
    'exact owner, receiver, arguments and immediate leaf result: %s',
    async (name) => {
      const h = await compare(name);
      expect(h.after.calls).toHaveLength(1);
      expect(h.outcome.ok).toBe(true);
      expect(h.after.calls[0]!.receiver).not.toBe('wrong');
    },
  );
  test.each(names)('cancellation precedes every owner lookup: %s', async (name) => {
    const h = await compare(name, { inactive: true });
    expect(h.after.trace).toEqual(['active']);
    expect(h.after.calls).toEqual([]);
  });
  test.each(names)('synchronous owner exception remains async rejection: %s', async (name) => {
    await compare(name, { leafThrow: true });
  });
  test.each(names)('leaf Promise is adopted: %s', async (name) => {
    await compare(name, { leafReturn: () => Promise.resolve(result) });
  });
  test.each(names)('leaf Promise rejection preserved: %s', async (name) => {
    await compare(name, { leafReturn: () => Promise.reject(failure) });
  });
  test.each(names)('selected owner getter exception remains lazy: %s', async (name) => {
    await compare(name, { getThrow: true });
  });
  test.each([
    '__proto__',
    'constructor',
    'toString',
    'valueOf',
    'then',
    '',
    ' send_email ',
    'SEND_EMAIL',
    'not_a_tool',
  ])('unknown primitive key uses exact assertNever: %s', async (name) => {
    const h = await compare(name);
    expect(h.after.trace).toEqual(['active']);
    expect(h.outcome.ok).toBe(false);
  });
  test.each([
    null,
    undefined,
    0,
    true,
    1n,
    Symbol('tool'),
    new String('send_email'),
    { toString: () => 'send_email' },
    {
      toString: () => {
        throw failure;
      },
    },
  ])('malformed key never coerces to callable: %p', async (name) => {
    const h = await compare(name);
    expect(h.after.calls).toEqual([]);
  });
  test.each(['send_email', 'create_word', 'schedule_task'])(
    'proposal argument optional: %s',
    async (name) => {
      await compare(name, {}, input, ctx, absent);
      await compare(name, {}, input, ctx, null);
    },
  );
  test.each([undefined, 'docx', 'pdf', 'txt', 'xlsx', null, 0, 'DOCX'])(
    'Word format branch: %p',
    async (format) => {
      await compare('create_word', {}, { format });
    },
  );
  test.each(['create_word', 'search_funding_opportunities', 'compare_funding_opportunities'])(
    'malformed input preserves errors: %s',
    async (name) => {
      await compare(name, {}, null);
      await compare(name, {}, absent);
    },
  );
  test.each(['get_district_nexus_context', 'get_district_nexus_changes'])(
    'district immediate nullish fallback precedes Promise adoption: %s',
    async (name) => {
      await compare(name, { districtMissing: true });
      for (const value of [
        null,
        undefined,
        false,
        0,
        '',
        Promise.resolve(null),
        Promise.resolve(undefined),
      ])
        await compare(name, { leafReturn: () => value });
    },
  );
  test('format getters keep exact number/order and thrown identity', async () => {
    for (const throwing of [false, true]) {
      const options: Options = {};
      const run = async (code: string) => {
        const h = harness(code, options);
        let reads = 0;
        const arg = {
          get format() {
            h.trace.push(['format', ++reads]);
            if (throwing) throw failure;
            return reads === 1 ? 'docx' : 'pdf';
          },
        };
        let e: unknown;
        try {
          await h.dispatch(ctx, 'create_word', arg, execution);
        } catch (error) {
          e = error;
        }
        return {
          trace: h.trace,
          calls: h.calls.map((c) => ({
            ...c,
            args: c.args.map((a) => (a === arg ? '<input>' : a)),
          })),
          failure: e === failure,
        };
      };
      expect(await run(candidateCode)).toEqual(await run(baselineCode));
    }
  });
  test('thenable getter, invocation and adoption timing preserved', async () => {
    await compare('send_email', {
      leafReturn: (trace) => ({
        get then() {
          trace.push('then getter');
          return (resolveValue: (v: unknown) => void) => {
            trace.push('then called');
            resolveValue(result);
          };
        },
      }),
    });
    await compare('get_district_nexus_context', {
      leafReturn: (trace) => ({
        get then() {
          trace.push('then getter throw');
          throw failure;
        },
      }),
    });
  });
  const turn = {
    tenantId: 'tenant',
    userId: 'user',
    conversationId: 'conversation',
    selectedClientId: 'client',
  };
  test.each(oracle.groups[0]!.names)(
    'RP current-use owner only after grant and fresh scope: %s',
    async (name) => {
      const h = await compare(name, { turn });
      expect(h.after.calls).toHaveLength(1);
      const authorizationIndex = h.after.trace.findIndex(
        (e) => Array.isArray(e) && e[0] === 'authorize',
      );
      const requireIndex = h.after.trace.findIndex((e) => Array.isArray(e) && e[0] === 'require');
      expect(requireIndex).toBeGreaterThan(authorizationIndex);
      expect(h.after.trace.filter((e) => Array.isArray(e) && e[0] === 'findFirst')).toHaveLength(2);
    },
  );
  const validRow = { clientId: 'client', metadata: { researchPortfolioId: 'portfolio' } };
  test.each([
    { turn: { ...turn, tenantId: 'other' } },
    { turn: { ...turn, userId: 'other' } },
    { turn: { ...turn, conversationId: 'other' } },
    { turn, scopeMissing: true },
    { turn, rows: [null] },
    { turn, rows: [{ ...validRow, clientId: 'other' }] },
    { turn, grant: false },
    { turn, rows: [validRow, null] },
    { turn, rows: [validRow, { ...validRow, clientId: 'other' }] },
    { turn, rows: [validRow, { ...validRow, metadata: { researchPortfolioId: 'other' } }] },
    { turn, authorizationThrow: true },
    { turn, databaseThrow: true },
  ] as Options[])(
    'RP refusal/revocation/infrastructure failure never loads lazy owner: %p',
    async (opts) => {
      const h = await compare('get_research_portfolio', opts);
      expect(h.after.calls).toEqual([]);
      expect(h.outcome.ok).toBe(false);
      expect(h.after.trace.some((e) => Array.isArray(e) && e[0] === 'require')).toBe(false);
    },
  );
  test('only three existing tools read actionProposalId, preserving getter timing', async () => {
    for (const name of names) {
      const run = async (code: string) => {
        const h = harness(code);
        let reads = 0;
        const proposed = {
          get actionProposalId() {
            h.trace.push('proposal getter');
            reads++;
            return 'proposal';
          },
        };
        await h.dispatch(ctx, name, input, proposed);
        return {
          trace: h.trace,
          calls: h.calls.map((c) => ({
            ...c,
            args: c.args.map((a) => (a === h.data.prisma ? '<same harness prisma>' : a)),
          })),
          reads,
        };
      };
      const b = await run(baselineCode),
        a = await run(candidateCode);
      expect(a).toEqual(b);
      expect(a.reads).toBe(['send_email', 'create_word', 'schedule_task'].includes(name) ? 1 : 0);
    }
  });
  test.each([
    'search_funding_opportunities',
    'get_funding_opportunity_requirements',
    'compare_funding_opportunities',
  ])('funding adapter getter order and throws: %s', async (name) => {
    for (const throwing of [false, true]) {
      const run = async (code: string) => {
        const h = harness(code);
        const arg = new Proxy(input, {
          get(target, key) {
            h.trace.push(['input getter', String(key)]);
            if (throwing && key === 'clientId') throw failure;
            return Reflect.get(target, key);
          },
        });
        let e: unknown;
        try {
          await h.dispatch(ctx, name, arg, execution);
        } catch (error) {
          e = error;
        }
        return { trace: h.trace, calls: h.calls, failure: e === failure };
      };
      expect(await run(candidateCode)).toEqual(await run(baselineCode));
    }
  });
  test('current leaf replacements are observed on successive calls', async () => {
    for (const code of [baselineCode, candidateCode]) {
      let count = 0;
      const h = harness(code, { leafReturn: () => ++count });
      expect(await h.dispatch(ctx, 'send_email', input, execution)).toBe(1);
      expect(await h.dispatch(ctx, 'send_email', input, execution)).toBe(2);
      expect(
        h.trace.filter((e) => Array.isArray(e) && e[0] === 'get' && e[1] === 'sendEmail'),
      ).toHaveLength(2);
    }
  });
  test('frozen oracle detects argument reversal, authority removal and eager owner mutation', async () => {
    const mutations = [
      {
        from: 'this.getPeBudgetTimeline(input, ctx)',
        to: 'this.getPeBudgetTimeline(ctx, input)',
        name: 'get_pe_budget_timeline',
        options: {},
      },
      {
        from: 'assertMeriToolRequestActive();',
        to: '',
        name: 'send_email',
        options: { inactive: true },
      },
      {
        from: 'const registry = {',
        to: 'this.requireBizDevTools(); const registry = {',
        name: 'get_client_context',
        options: {},
      },
    ];
    for (const mutation of mutations) {
      expect(candidateCode).toContain(mutation.from);
      const b = harness(baselineCode, mutation.options),
        a = harness(candidateCode.replace(mutation.from, mutation.to), mutation.options);
      await b.dispatch(ctx, mutation.name, input, execution).catch(() => undefined);
      await a.dispatch(ctx, mutation.name, input, execution).catch(() => undefined);
      expect({ trace: a.trace, calls: a.calls }).not.toEqual({ trace: b.trace, calls: b.calls });
    }
  });
  test.each([
    'search_federal_contract_awards',
    'search_federal_subawards',
    'search_contract_vehicles',
    'search_procurement_forecasts',
    'get_district_federal_market',
  ])('five proxy-owned names remain outside local dispatch: %s', async (name) => {
    const h = await compare(name);
    expect(h.after.trace).toEqual(['active']);
    expect(h.after.calls).toEqual([]);
    expect(h.outcome.ok).toBe(false);
  });
  test.each(['send_email', 'create_word', 'schedule_task'])(
    'proposal getter exception preserves pre-call order: %s',
    async (name) => {
      const run = async (code: string) => {
        const h = harness(code);
        const arg = {
          get actionProposalId() {
            h.trace.push('proposal getter throw');
            throw failure;
          },
        };
        let e: unknown;
        try {
          await h.dispatch(ctx, name, input, arg);
        } catch (error) {
          e = error;
        }
        return { trace: h.trace, calls: h.calls, failure: e === failure };
      };
      expect(await run(candidateCode)).toEqual(await run(baselineCode));
    },
  );
  test('funding actor getters and exceptions preserve argument evaluation order', async () => {
    for (const throwing of [false, true]) {
      const run = async (code: string) => {
        const h = harness(code);
        const actor = new Proxy(ctx, {
          get(target, key) {
            h.trace.push(['actor getter', String(key)]);
            if (throwing && key === 'userId') throw failure;
            return Reflect.get(target, key);
          },
        });
        let e: unknown;
        try {
          await h.dispatch(actor, 'search_funding_opportunities', input, execution);
        } catch (error) {
          e = error;
        }
        return { trace: h.trace, calls: h.calls, failure: e === failure };
      };
      expect(await run(candidateCode)).toEqual(await run(baselineCode));
    }
  });
});
