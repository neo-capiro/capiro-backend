const assert = require('node:assert/strict'), fs = require('node:fs'), cp = require('node:child_process'), ts = require('typescript');
const { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual } = require('node:util');
const OUT = 'docs/cleanup-meri-local-dispatch-independent-review-20261012/evidence/';
const base = '802bbd0b2c510a44e46a9952d8127e7edc55aaaa', file = 'apps/api/src/meri/meri-tools.service.ts';
const original = cp.execFileSync('git', ['show', base + ':' + file], { encoding: 'utf8' });
const current = fs.readFileSync(file, 'utf8');
const parse = text => ts.createSourceFile('s.ts', text, ts.ScriptTarget.Latest, true);
function methodBody(text) { const sf = parse(text), cls = sf.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'MeriToolsService'); return cls.members.find(n => n.name?.getText(sf) === 'executeScoped').body.getText(sf); }
const originalAst = parse(original);
const pure = originalAst.statements.filter(n => ts.isFunctionDeclaration(n) && ['toolActor', 'assertNever'].includes(n.name?.text)).map(n => n.getText(originalAst)).join('\n');
const wrapperSource = fs.readFileSync('apps/api/src/meri/meri-rp-tool-transport.ts', 'utf8');
const wrapperAst = parse(wrapperSource);
const wrapper = wrapperAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'executeMeriResearchPortfolioToolAtCurrentUse').getText(wrapperAst).replace(/^export /, '');
const helperSource = fs.readFileSync('apps/api/src/meri/meri-local-dispatch.ts', 'utf8'), helperAst = parse(helperSource);
const helper = helperAst.statements.find(ts.isFunctionDeclaration).getText(helperAst).replace(/^export /, '');
const dependencies = ['assertMeriToolRequestActive', 'storage', 'authorizeMeriResearchPortfolioScope', 'isDeepStrictEqual', 'ForbiddenException', 'BadRequestException', 'NotFoundException', 'getResearchEvidence', 'searchCapiroData', 'readOwnPendingMemoryProposals'];
function factory(body) {
  const text = `${pure}\n${wrapper}\n${helper}\nasync function dispatch(ctx,name,input,execution)${body}`;
  const code = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }).outputText;
  const checked = parse(code); const forbidden = []; function check(node) { if (ts.isIdentifier(node) && ['require', 'fetch', 'setTimeout', 'process'].includes(node.text)) forbidden.push(node.text); ts.forEachChild(node, check); } check(checked); assert.deepEqual(forbidden, []);
  return new Function(...dependencies, code + '\nreturn dispatch;');
}
const beforeFactory = factory(methodBody(original)), afterFactory = factory(methodBody(current));
class ForbiddenException extends Error { constructor(message) { super(message); this.name = 'ForbiddenException'; } }
class BadRequestException extends Error { constructor(message) { super(message); this.name = 'BadRequestException'; } }
class NotFoundException extends Error { constructor(message) { super(message); this.name = 'NotFoundException'; } }
const cancellation = new Error('synthetic cancellation'), failure = new Error('synthetic leaf/getter marker'), value = { synthetic: 'shared leaf result' };
function harness(make, options = {}) {
  const trace = [], calls = [], storage = new AsyncLocalStorage(); let active = !options.inactive, load = 0;
  const data = { researchPortfolioScope: options.noScope ? undefined : 'synthetic scope', contextPlane: 'plane', governedMemoryCandidates: 'memory' };
  data.prisma = { withTenant(tenant, callback) { trace.push(['fakeTenant', tenant]); return callback({ clioConversation: { findFirst(query) { trace.push(['fakeRead', query]); const i = load++; return Promise.resolve(options.rows?.[i] ?? { clientId: 'client', metadata: { portfolio: 'p' } }); } } }); } };
  const leaf = (name, receiver, args) => { trace.push(['leaf', name]); calls.push({ name, receiver, args }); if (options.leafThrow) throw failure; return options.returner ? options.returner(trace) : value; };
  function port(name) { let instance; instance = new Proxy({}, { get(_t, key) { trace.push(['portGet', name, key]); if (options.getThrow) throw failure; return function(...args) { return leaf(name + '.' + key, this === instance, args); }; } }); return instance; }
  const ports = { opportunityTools: port('funding'), districtTools: port('district'), rp: port('rp'), biz: port('biz') };
  let owner; owner = new Proxy({}, { get(_t, key) {
    trace.push(['ownerGet', key]);
    if (Object.hasOwn(data, key)) return data[key];
    if (key === 'opportunityTools') return ports.opportunityTools;
    if (key === 'districtTools') return options.noDistrict ? undefined : ports.districtTools;
    if (options.getThrow) throw failure;
    if (key === 'requireResearchPortfolioTools' || key === 'requireBizDevTools') return function() { trace.push(['require', key, this === owner]); return key === 'requireResearchPortfolioTools' ? ports.rp : ports.biz; };
    return function(...args) { return leaf(key, this === owner, args); };
  } });
  const guard = () => { trace.push('active'); if (!active) throw cancellation; };
  const authorize = async (...args) => { trace.push(['fakeAuthorize', ...args]); if (options.deny) throw failure; if (options.cancelAtGrant) active = false; return options.noGrant ? false : true; };
  const dispatch = make(guard, storage, authorize, isDeepStrictEqual, ForbiddenException, BadRequestException, NotFoundException,
    (...args) => leaf('researchEvidence', true, args), (...args) => leaf('capiroData', true, args), (...args) => leaf('memoryProposal', true, args));
  return { trace, calls, data, invoke: (...args) => dispatch.call(owner, ...args), scoped: (turn, ...args) => storage.run(turn, () => dispatch.call(owner, ...args)), cancel() { active = false; } };
}
const actor = { tenantId: 'tenant', userId: 'actor', role: 'standard_user' }, input = { conversationId: 'conversation', clientId: 'client', source: 'grant', sourceRecordId: 'row', opportunities: [{ source: 's', sourceRecordId: 'r' }] };
const turn = { tenantId: 'tenant', userId: 'actor', conversationId: 'conversation', selectedClientId: 'client' };
const results = [];
async function compare(label, name, options = {}, configure = undefined, scoped = undefined) {
  const old = harness(beforeFactory, options), now = harness(afterFactory, options);
  async function run(h) {
    const args = configure ? configure(h) : [actor, name, input, { actionProposalId: 'synthetic proposal' }];
    let promise; assert.doesNotThrow(() => { promise = scoped ? h.scoped(scoped, ...args) : h.invoke(...args); }); assert(promise instanceof Promise);
    const immediate = [...h.trace]; let result, error;
    try { result = await promise; } catch (e) { error = e; }
    return { result, error, immediate, trace: h.trace, calls: h.calls.map(c => ({ ...c, args: c.args.map(a => a === h.data.prisma ? 'same fake prisma' : a) })) };
  }
  const b = await run(old), a = await run(now);
  assert.deepEqual(a.immediate, b.immediate); assert.deepEqual(a.trace, b.trace); assert.deepEqual(a.calls, b.calls);
  if (b.error) { assert(a.error); assert.equal(a.error.constructor, b.error.constructor); assert.equal(a.error.message, b.error.message); if ([failure, cancellation].includes(b.error)) assert.equal(a.error, b.error); }
  else assert.deepEqual(a.result, b.result);
  assert.equal(a.trace[0], 'active');
  results.push({ label, name: typeof name === 'symbol' ? 'Symbol' : typeof name === 'object' ? 'malformed object' : name,
    exactTraceAndArgs: true, sharedErrorRealm: true, error: a.error ? { name: a.error.name, message: a.error.message } : null,
    syntheticReads: a.trace.filter(x => Array.isArray(x) && x[0] === 'fakeRead').length, ownerCalls: a.calls.length });
  return a;
}
(async () => {
  for (const name of ['__proto__', 'constructor', 'toString', '__defineGetter__', '', 'unknown', null, undefined, 12, Symbol('name'), {}, new String('send_email')]) {
    const r = await compare('unknown/malformed/prototype', name); assert.equal(r.calls.length, 0); assert.deepEqual(r.trace, ['active']);
  }
  await compare('object unknown interpolation marker', {}, {}, () => [actor, { [Symbol.toPrimitive]() { throw failure; } }, input, undefined]);
  for (const name of ['send_email', 'get_research_portfolio', 'search_funding_opportunities']) { const r = await compare('cancelled before dispatch', name, { inactive: true }); assert.deepEqual(r.trace, ['active']); }
  for (const name of ['send_email', 'create_word', 'schedule_task']) {
    await compare('proposal getter order', name, {}, h => [actor, name, input, { get actionProposalId() { h.trace.push('proposalGet'); return 'proposal'; } }]);
    await compare('proposal getter exception', name, {}, h => [actor, name, input, { get actionProposalId() { h.trace.push('proposalGet'); throw failure; } }]);
  }
  const funding = ['search_funding_opportunities', 'get_funding_opportunity_requirements', 'get_funding_opportunity', 'explain_opportunity_match', 'get_opportunity_client_context', 'get_opportunity_government_landscape', 'compare_funding_opportunities', 'build_opportunity_action_plan'];
  for (const name of funding) await compare('all8 funding actor/input getter order', name, {}, h => [new Proxy(actor, { get(t, k) { h.trace.push(['actorGet', k]); return Reflect.get(t, k); } }), name, new Proxy(input, { get(t, k) { h.trace.push(['inputGet', k]); return Reflect.get(t, k); } }), undefined]);
  for (const options of [{}, { deny: true }, { noScope: true }, { noGrant: true }, { rows: [{ clientId: 'other', metadata: {} }] }, { rows: [{ clientId: 'client', metadata: { portfolio: 'p' } }, { clientId: 'client', metadata: { portfolio: 'changed' } }] }, { cancelAtGrant: true }]) await compare('canonical RP authority/current use', 'get_research_portfolio', options, undefined, turn);
  for (const shifted of [{ ...turn, tenantId: 'other' }, { ...turn, userId: 'other' }, { ...turn, conversationId: 'other' }]) { const r = await compare('cross actor/conversation denies before owner', 'get_research_portfolio', {}, undefined, shifted); assert.equal(r.calls.length, 0); }
  for (const [name, options] of [['get_client_context', { getThrow: true }], ['send_email', { leafThrow: true }], ['get_district_nexus_context', { noDistrict: true }], ['get_district_nexus_context', { returner: () => Promise.resolve(null) }]]) await compare('getter/error/district timing', name, options);
  for (const returner of [() => value, () => Promise.resolve(value), trace => ({ get then() { trace.push('thenGet'); return resolve => { trace.push('thenInvoke'); resolve(value); }; } }), () => ({ get then() { throw failure; } })]) await compare('plain/promise/thenable/error adoption', 'get_client_context', { returner });
  for (const make of [beforeFactory, afterFactory]) {
    let n = 0; const h = harness(make, { returner: () => ++n });
    assert.equal(await h.invoke(actor, 'send_email', input), 1); assert.equal(await h.invoke(actor, 'send_email', input), 2);
    assert.equal(h.trace.filter(x => Array.isArray(x) && x[0] === 'ownerGet' && x[1] === 'sendEmail').length, 2);
    const ctxA = { ...actor, userId: 'A' }, ctxB = { ...actor, userId: 'B' };
    const a = h.scoped({ ...turn, userId: 'A' }, ctxA, 'get_research_portfolio', input);
    const b = h.scoped({ ...turn, userId: 'B' }, ctxB, 'get_research_portfolio', input);
    await Promise.all([a, b]);
    const calls = h.calls.filter(c => c.name === 'rp.execute'); assert.equal(calls.length, 2);
    assert(calls.some(c => c.args[0] === ctxA)); assert(calls.some(c => c.args[0] === ctxB));
  }
  const result = { source: 'd3e0efacf59fb64361c612c01da5ae8a6f19e426', originalBase: base, comparisons: results.length, results,
    successiveOwnerReplays: 4, concurrentRpCallsWithIsolatedAlsContexts: 4, originalBodiesTakenDirectlyFromGitNotCandidateTable: true,
    sameHostErrorRealm: true, actualApplicationGraphImported: false, fakeDataPortsOnly: true, databaseProviderNativeCalls: 0,
    cancellationScope: 'Original cooperative guard retained; cancellation during grant has exactly original outcome, no rollback claim' };
  fs.writeFileSync(OUT + 'independent-replay.json', JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify({ comparisons: results.length, replays: 4, concurrencyCalls: 4, sameHostErrorRealm: true }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
