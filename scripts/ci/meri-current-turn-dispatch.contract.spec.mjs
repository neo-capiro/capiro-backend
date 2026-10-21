import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Actual current executor, request stores, binder, RP envelope, execution
// controls and single shared result classifier. Only Nest Logger/Config tokens
// and telemetry are explicit fixture ports. fetch is a local spy: no network.
// Supplying a trusted scope here does NOT authenticate a user, verify the
// controller's signed bundle, authorize Core resources, or qualify native DI.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = relative => readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
const url = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
function isolated(source, bindings = new Map(), decorated = false) {
  if (decorated) {
    assert.equal((source.match(/^@Injectable\(\)$/gm) ?? []).length, 1);
    source = source.replace(/^@Injectable\(\)\n/m, '');
  }
  const js = stripTypeScriptTypes(source, { mode: 'strip' });
  assert.doesNotMatch(js, /\b(?:require|import)\s*\(/, 'no dynamic imports or hidden require');
  const pattern = /^(import|export)\s+(\{[\s\S]*?\})\s+from\s*(['"])([^'"]+)\3\s*;/gm;
  const rows = [...js.matchAll(pattern)];
  const statements = js.match(/^(?:import|export)\s+\{[\s\S]*?\}\s+from\b/gm) ?? [];
  assert.equal(statements.length, rows.length, 'finite named external imports/reexports only');
  const seen = new Set();
  const rebound = js.replace(pattern, (_all, kind, clause, _quote, specifier) => {
    assert(bindings.has(specifier), 'unowned actual import: ' + specifier);
    const binding = bindings.get(specifier);
    const names = clause.slice(1, -1).split(',').map(v => v.trim()).filter(Boolean);
    assert.deepEqual(names.sort(), [...binding.names].sort(), 'explicit port names: ' + specifier);
    seen.add(specifier);
    return `${kind} ${clause} from ${JSON.stringify(binding.url)};`;
  });
  assert.deepEqual([...seen].sort(), [...bindings.keys()].sort(), 'complete finite port inventory');
  assert.doesNotMatch(rebound, /^import\s+(?!\{)/m, 'no default/side-effect import');
  return url(rebound);
}
const fixture = url(`
export const Injectable = () => value => value;
export class Logger { warn() {} }
export class ConfigService {}
export const emitMeriOrchestratorTelemetry = () => {};
export const withMeriOrchestratorTelemetrySpan = async (_details, fn) => fn();
export const meriOrchestratorTelemetryHeaders = () => ({});
`);
const port = (names, target = fixture) => ({ names, url: target });
const credentialsUrl = isolated(read('apps/meriv2-orchestrator/src/request/request-credentials.store.ts'),
  new Map([['node:async_hooks', port(['AsyncLocalStorage'], 'node:async_hooks')]]));
const scopeUrl = isolated(read('apps/meriv2-orchestrator/src/request/trusted-current-turn-scope.ts'),
  new Map([['node:async_hooks', port(['AsyncLocalStorage'], 'node:async_hooks')]]));
const binderUrl = isolated(read('apps/meriv2-orchestrator/src/meri/current-turn-tool-scope.ts'));
const transportUrl = isolated(read('apps/meriv2-orchestrator/src/meri/rp-tool-transport.ts'), new Map([
  ['./current-turn-tool-scope.js', port(['bindCurrentConversationToolInput', 'isCurrentConversationResearchPortfolioTool'], binderUrl)],
]));
const controlUrl = isolated(read('packages/meriv2-core/src/registry/tool-execution-control.ts'));
const executionUrl = isolated(read('apps/meriv2-orchestrator/src/meri/meri-execution-control.ts'),
  new Map([['@capiro/meriv2-core', port(['assertToolExecutionActive'], controlUrl)]]));
const classifierUrl = isolated(read('packages/shared/src/meri-read-outcome.ts'));
const executorUrl = isolated(read('apps/meriv2-orchestrator/src/meri/api-tool-executor.repo.ts'), new Map([
  ['@nestjs/common', port(['Injectable', 'Logger'])],
  ['@nestjs/config', port(['ConfigService'])],
  // Node preserves the empty import left by three inline `type` bindings.
  ['@capiro/meriv2-core', port([], url('export {};'))],
  ['./meri-execution-control.js', port(['createMeriExecutionControl'], executionUrl)],
  ['./api-tool-read-outcome.js', port(['classifyApiToolReadOutcome'], classifierUrl)],
  ['../request/request-credentials.store.js', port(['RequestCredentialsStore'], credentialsUrl)],
  ['../request/trusted-current-turn-scope.js', port(['currentTrustedCurrentTurnScope'], scopeUrl)],
  ['./current-turn-tool-scope.js', port(['bindCurrentConversationToolInput', 'isCurrentConversationResearchPortfolioTool'], binderUrl)],
  ['./rp-tool-transport.js', port(['buildResearchPortfolioToolTransport'], transportUrl)],
  ['../telemetry/meri-telemetry.runtime.js', port(['emitMeriOrchestratorTelemetry', 'withMeriOrchestratorTelemetrySpan', 'meriOrchestratorTelemetryHeaders'])],
]), true);
const { ApiToolExecutorRepo } = await import(executorUrl);
const { RequestCredentialsStore } = await import(credentialsUrl);
const { withTrustedCurrentTurnScope } = await import(scopeUrl);
const { CURRENT_CONVERSATION_RESEARCH_PORTFOLIO_TOOLS } = await import(binderUrl);
const names = [
  'get_research_portfolio', 'get_research_portfolio_analytics', 'get_research_portfolio_changes',
  'create_research_portfolio_snapshot', 'request_research_portfolio_output',
  'save_research_portfolio_output_to_client', 'watch_research_portfolio',
  'update_research_portfolio_change_state', 'get_research_portfolio_bookmarks',
  'create_research_portfolio_bookmark', 'get_research_portfolio_fit', 'get_research_portfolio_reviews',
  'add_research_portfolio_review_note', 'get_research_portfolio_rules',
  'get_research_portfolio_imports', 'get_research_portfolio_operations',
  'prepare_research_portfolio_brief', 'prepare_research_portfolio_meeting', 'manage_research_portfolio',
];
assert.equal(names.length, 19);
assert.deepEqual([...names].sort(), [...CURRENT_CONVERSATION_RESEARCH_PORTFOLIO_TOOLS].sort());
const current = Object.freeze({
  tenantId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222',
  conversationId: '33333333-3333-4333-8333-333333333333', selectedClientId: '55555555-5555-4555-8555-555555555555',
});
const other = '44444444-4444-4444-8444-444444444444';
const emptyMemoryResult = {
  tool: 'search_memory', factContentUnavailableCount: 0, contentStatus: 'empty',
  contentTruncated: false, nextCursor: null, results: [], records: [],
  coverage: { complete: true, paginationComplete: true, sources: [{
    domain: 'institutional_knowledge', sourceStatus: 'healthy', hasMore: false,
    truncated: false, paginationComplete: true, coverageComplete: true,
  }] },
};
async function harness(run, options = {}) {
  const requests = [], originalFetch = globalThis.fetch;
  globalThis.fetch = async (target, init) => {
    requests.push({ target, ...init });
    return new Response(JSON.stringify(target.endsWith('/search_memory')
      ? emptyMemoryResult : { portfolio: 'Current turn portfolio' }));
  };
  const repo = new ApiToolExecutorRepo({ get: key => key === 'INTERNAL_SERVICE_SECRET'
    ? (options.secret === false ? undefined : 'fixture-service-identity') : undefined });
  const invoke = (name, input, scope = current) => {
    const execute = () => scope === undefined ? repo.execute({}, name, input)
      : withTrustedCurrentTurnScope(scope, () => repo.execute({}, name, input));
    return options.bearer === false ? execute() : RequestCredentialsStore.run({ bearerToken: 'fixture-verified-user' }, execute);
  };
  try { await run({ requests, invoke, repo }); }
  finally { globalThis.fetch = originalFetch; }
}

// Twenty-two migrated security identities, with actual current dispatch.
for (const name of names) test('current dispatch refuses model retargeting: ' + name, () => harness(async h => {
  await assert.rejects(h.invoke(name, { conversationId: other }), /cannot target another conversation/);
  assert.equal(h.requests.length, 0);
}));
test('current dispatch injects omitted and preserves exact current conversation', () => harness(async h => {
  for (const input of [{}, { conversationId: current.conversationId }]) {
    assert.deepEqual(await h.invoke('get_research_portfolio', input), { portfolio: 'Current turn portfolio' });
    const request = h.requests.at(-1);
    assert.deepEqual(JSON.parse(request.body), { version: 1, input: { conversationId: current.conversationId }, currentTurn: current });
    assert.equal(request.headers.authorization, 'Bearer fixture-verified-user');
    assert.equal(request.headers['x-internal-service-secret'], 'fixture-service-identity');
  }
  assert.equal(h.requests.length, 2);
}));
test('ordinary delegated tool preserves supplied conversation treatment', () => harness(async h => {
  const input = { conversationId: other, query: 'funding' };
  await h.invoke('search_memory', input);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(JSON.parse(h.requests[0].body), input);
}));
test('current dispatch rejects null/empty/non-string scope attempts', () => harness(async h => {
  for (const conversationId of [null, '', 23]) {
    await assert.rejects(h.invoke('get_research_portfolio', { conversationId }), /cannot target another conversation/);
  }
  assert.equal(h.requests.length, 0);
}));

test('actual executor refuses absent trusted scope before network', () => harness(async h => {
  await assert.rejects(RequestCredentialsStore.run({ bearerToken: 'fixture' }, () =>
    h.repo.execute({}, 'get_research_portfolio', {})), /Trusted current-turn scope is unavailable/);
  assert.equal(h.requests.length, 0);
}));
test('actual typed transport refuses malformed trusted actor before network', () => harness(async h => {
  await assert.rejects(h.invoke('get_research_portfolio', {}, { ...current, userId: 'invalid' }), /scope is invalid/);
  assert.equal(h.requests.length, 0);
}));
test('actual executor refuses missing service identity before network', () => harness(async h => {
  await assert.rejects(h.invoke('get_research_portfolio', {}), /INTERNAL_SERVICE_SECRET is not configured/);
  assert.equal(h.requests.length, 0);
}, { secret: false }));
test('actual executor refuses absent request credential before network', () => harness(async h => {
  await assert.rejects(h.invoke('get_research_portfolio', {}), /No forwarded credential available/);
  assert.equal(h.requests.length, 0);
}, { bearer: false }));
test('trusted scope is immutable and does not escape its request', () => harness(async h => {
  const { currentTrustedCurrentTurnScope } = await import(scopeUrl);
  assert.equal(currentTrustedCurrentTurnScope(), undefined);
  await withTrustedCurrentTurnScope(current, async () => {
    assert(Object.isFrozen(currentTrustedCurrentTurnScope()));
    assert.deepEqual(currentTrustedCurrentTurnScope(), current);
    await h.invoke('get_research_portfolio', {});
  });
  assert.equal(currentTrustedCurrentTurnScope(), undefined);
}));
test('current native landing retains all twenty-two old safety identities without raw extraction', () => {
  const native = read('apps/meriv2-orchestrator/src/meri/research-portfolio-current-turn-dispatch.spec.ts');
  for (const name of names) assert(native.includes("'" + name + "'"));
  assert.match(native, /new ApiToolExecutorRepo\(/);
  assert.match(native, /RequestCredentialsStore\.run/);
  assert.match(native, /withTrustedCurrentTurnScope\(currentTurn/);
  assert.match(native, /not\.toHaveBeenCalled\(\)/);
  assert.doesNotMatch(native, /meri\.service|fragments\(|transpile|Object\.create/);
});
