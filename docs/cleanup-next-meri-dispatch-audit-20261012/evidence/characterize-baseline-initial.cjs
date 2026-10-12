// Inert source-fragment characterization; no production imports or tool owners.
// This qualifies a baseline oracle for a future differential check. It is not acceptance of an extraction.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const ts = require(process.argv[2]);
const root = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(root, 'apps/api/src/meri/meri-tools.service.ts'), 'utf8');
const sf = ts.createSourceFile('baseline.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const cls = sf.statements.find((n) => ts.isClassDeclaration(n) && n.name.text === 'MeriToolsService');
const method = cls.members.find((n) => n.name?.getText(sf) === 'executeScoped');
const pureFunctions = ['toolActor', 'assertNever'].map((name) => sf.statements.find((n) => ts.isFunctionDeclaration(n) && n.name.text === name).getText(sf));
const map = JSON.parse(fs.readFileSync(path.join(__dirname, 'dispatch-map.json'), 'utf8'));
const globals = new Set(['assertMeriToolRequestActive', 'executeMeriResearchPortfolioToolAtCurrentUse', 'getResearchEvidence', 'searchCapiroData', 'readOwnPendingMemoryProposals', 'toolActor', 'assertNever', 'String', 'Array.isArray', 'input.opportunities as Array<Record<string, unknown>>']);
const directMethods = new Set();
const terminalServiceMethods = { districtTools: new Set(), opportunityTools: new Set() };
for (const row of map.rows) for (const call of row.calls) {
  const direct = /^this\.([A-Za-z0-9]+)$/.exec(call.target);
  const nested = /^this\.(districtTools|opportunityTools)(?:\?\.)?\.?(\w+)$/.exec(call.target);
  if (direct) directMethods.add(direct[1]);
  else if (nested) terminalServiceMethods[nested[1]].add(nested[2]);
  else if (!globals.has(call.target) && !call.target.includes('this.requireResearchPortfolioTools().execute') && !call.target.includes('this.requireBizDevTools().') && !call.target.includes('input.opportunities') && !call.target.endsWith('.map')) throw new Error(`Unreviewed source call: ${call.target}`);
}
const generated = ts.transpileModule(`async function baseline(ctx,name,input,execution) ${method.body.getText(sf)}\n${pureFunctions.join('\n')}\n baseline;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const checks = [];
function harness(options = {}) {
  const events = [];
  const terminal = [];
  const sentinel = { exactResult: true };
  const failure = new Error('synthetic owner error');
  const activeError = new Error('synthetic cancelled request');
  const data = { prisma: { marker: 'prisma' }, researchPortfolioScope: { marker: 'scopeService' }, contextPlane: { marker: 'contextPlane' }, governedMemoryCandidates: { marker: 'memoryCandidates' } };
  const run = (port, args) => {
    events.push(`owner:${port}`);
    terminal.push({ port, args });
    if (options.throwOwner) throw failure;
    if (options.promiseOwner) return Promise.resolve(sentinel);
    return sentinel;
  };
  const districtTools = Object.fromEntries([...terminalServiceMethods.districtTools].map((name) => [name, (...args) => options.districtNull ? null : run(`districtTools.${name}`, args)]));
  const opportunityTools = Object.fromEntries([...terminalServiceMethods.opportunityTools].map((name) => [name, (...args) => run(`opportunityTools.${name}`, args)]));
  const fake = new Proxy({}, { get(_target, key) {
    if (key in data) return data[key];
    if (key === 'districtTools') return options.districtMissing ? undefined : districtTools;
    if (key === 'opportunityTools') return opportunityTools;
    if (key === 'requireResearchPortfolioTools') return () => { events.push('requireResearchPortfolioTools'); return { execute: (...args) => run('researchPortfolio.execute', args) }; };
    if (key === 'requireBizDevTools') return () => { events.push('requireBizDevTools'); return new Proxy({}, { get(_unused, name) { return (...args) => run(`bizDev.${String(name)}`, args); } }); };
    if (directMethods.has(key)) return (...args) => run(String(key), args);
    throw new Error(`Unexpected fake port access: ${String(key)}`);
  } });
  class BadRequestException extends Error { getStatus() { return 400; } }
  const sandbox = {
    assertMeriToolRequestActive() { events.push('active'); if (options.inactive) throw activeError; },
    executeMeriResearchPortfolioToolAtCurrentUse(o) { events.push('rp-current-use'); if (options.refuseRp) throw failure; events.push('rp-authorized'); return o.execute(); },
    getResearchEvidence: (...args) => run('getResearchEvidence', args),
    searchCapiroData: (...args) => run('searchCapiroData', args),
    readOwnPendingMemoryProposals: (...args) => run('readOwnPendingMemoryProposals', args),
    BadRequestException,
    // No require/process/fetch/owner service bindings are available to the fragment.
    fetch: undefined, process: undefined, require: undefined,
  };
  const baseline = vm.runInNewContext(generated, sandbox, { timeout: 1000 });
  return { baseline: (...args) => baseline.call(fake, ...args), events, terminal, sentinel, failure, activeError, data };
}
const ctx = Object.freeze({ tenantId: 'synthetic-tenant', userId: 'synthetic-user', role: 'standard_user', clerkUserId: 'synthetic-clerk', tenantSlug: 'synthetic-slug' });
const input = Object.freeze({ marker: 'exact-input', clientId: 'client-1', source: 'sam', sourceRecordId: 'source-1', query: 'query-1', page: 2, pageSize: 7, activeState: 'active', offset: 1, limit: 3, summaryOffset: 4, summaryLimit: 5, opportunities: [null, { source: 'grant', sourceRecordId: 'row-2' }] });
const execution = Object.freeze({ actionProposalId: 'synthetic-proposal' });
async function check(name, run) { await run(); checks.push(name); }
(async () => {
  for (const row of map.rows) await check(`all-case:${row.name}`, async () => {
    const h = harness();
    const promise = h.baseline(ctx, row.name, input, execution);
    assert.equal(h.events[0], 'active');
    assert.equal(h.terminal.length, 1, row.name);
    assert.strictEqual(await promise, h.sentinel);
    const terminal = h.terminal[0];
    const direct = row.calls.find((c) => /^this\.(?!require)\w+$/.test(c.target));
    if (direct && !['create_word', 'create_excel', 'create_powerpoint'].includes(row.name)) {
      const expected = direct.args.map((arg) => {
        if (arg === 'ctx') return ctx;
        if (arg === 'input') return input;
        if (arg === 'execution?.actionProposalId') return execution.actionProposalId;
        throw new Error(`Unqualified direct arg ${arg}`);
      });
      assert.deepEqual(terminal.args, expected);
    }
    if (row.group[0] === 'manage_research_portfolio') {
      assert.deepEqual(h.events, ['active', 'rp-current-use', 'rp-authorized', 'requireResearchPortfolioTools', 'owner:researchPortfolio.execute']);
      assert.deepEqual(terminal.args, [ctx, row.name, input]);
    }
  });
  for (const row of map.rows) await check(`inactive:${row.name}`, async () => {
    const h = harness({ inactive: true });
    const promise = h.baseline(ctx, row.name, input, execution);
    assert.deepEqual(h.events, ['active']);
    assert.equal(h.terminal.length, 0);
    await assert.rejects(promise, (error) => error === h.activeError);
  });
  for (const name of ['not_a_tool', '__proto__', 'constructor', 'toString', ' send_email ']) await check(`unknown:${name}`, async () => {
    const h = harness();
    await assert.rejects(h.baseline(ctx, name, input, execution), (error) => error.message === `Unhandled Meri tool: ${name}` && error.name === 'Error');
    assert.equal(h.terminal.length, 0);
    assert.deepEqual(h.events, ['active']);
  });
  for (const name of ['send_email', 'schedule_task', 'create_word']) await check(`execution-absent:${name}`, async () => {
    const h = harness(); await h.baseline(ctx, name, input);
    assert.equal(h.terminal[0].args.at(-1), undefined);
  });
  for (const format of [undefined, 'docx', 'pdf', 'txt']) await check(`word-format:${String(format)}`, async () => {
    const h = harness(); const wordInput = { format }; await h.baseline(ctx, 'create_word', wordInput, execution);
    assert.deepEqual(h.terminal[0].args, [ctx, wordInput, format ?? 'docx', execution.actionProposalId]);
  });
  await check('word-invalid-format-before-owner', async () => {
    const h = harness(); await assert.rejects(h.baseline(ctx, 'create_word', { format: 'xlsx' }, execution), (error) => error.message === 'Document format must be docx, pdf or txt' && error.getStatus() === 400);
    assert.equal(h.terminal.length, 0);
  });
  for (const [name, format] of [['create_excel', 'xlsx'], ['create_powerpoint', 'pptx']]) await check(`document-no-execution:${name}`, async () => {
    const h = harness(); await h.baseline(ctx, name, input, execution); assert.deepEqual(h.terminal[0].args, [ctx, input, format]);
  });
  for (const name of ['get_district_nexus_context', 'get_district_nexus_changes']) for (const option of ['districtMissing', 'districtNull']) await check(`district-fallback:${name}:${option}`, async () => {
    const h = harness({ [option]: true }); const value = await h.baseline(ctx, name, input); assert.equal(value.available, false); assert.equal(value.reason, 'feature_disabled');
  });
  await check('funding-actor-narrowing-and-shaping', async () => {
    const h = harness(); await h.baseline(ctx, 'search_funding_opportunities', input, execution); const args = h.terminal[0].args;
    assert.deepEqual(Object.keys(args[0]).sort(), ['role', 'tenantId', 'userId']);
    assert.equal(args[0].clerkUserId, undefined); assert.equal(args[0].tenantSlug, undefined);
    assert.equal(JSON.stringify(args[1]), JSON.stringify({ clientId: 'client-1', source: 'sam', query: 'query-1', page: 2, pageSize: 7, activeState: 'active' }));
  });
  await check('funding-comparison-null-entry-shaping', async () => {
    const h = harness(); await h.baseline(ctx, 'compare_funding_opportunities', input); assert.equal(JSON.stringify(h.terminal[0].args[1]), JSON.stringify({ clientId: 'client-1', opportunities: [{ source: '', sourceRecordId: '' }, { source: 'grant', sourceRecordId: 'row-2' }] }));
  });
  await check('rp-refusal-before-lazy-owner', async () => {
    const h = harness({ refuseRp: true }); await assert.rejects(h.baseline(ctx, 'get_research_portfolio', input), (error) => error === h.failure); assert.deepEqual(h.events, ['active', 'rp-current-use']); assert.equal(h.terminal.length, 0);
  });
  await check('synchronous-fake-owner-start-before-first-await', async () => {
    const h = harness(); const result = h.baseline(ctx, 'search_memory', input); assert.deepEqual(h.events, ['active', 'owner:searchMemory']); assert.strictEqual(await result, h.sentinel);
  });
  await check('owner-error-identity-through-async-dispatch', async () => {
    const h = harness({ throwOwner: true }); const result = h.baseline(ctx, 'search_memory', input); await assert.rejects(result, (error) => error === h.failure);
  });
  await check('owner-promise-adoption', async () => {
    const h = harness({ promiseOwner: true }); assert.strictEqual(await h.baseline(ctx, 'search_memory', input), h.sentinel);
  });
  const result = { frozenHead: map.frozenHead, scope: 'inert exact executeScoped source fragment + pure toolActor/assertNever; all owner ports fake', total: checks.length, passed: checks.length, failed: 0, checks, productionModulesLoaded: 0, realToolOwnersInvoked: 0, candidateImplementationExists: false, behavioralEquivalenceAccepted: false, nativeAcceptance: false };
  fs.writeFileSync(path.join(__dirname, 'baseline-characterization.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ passed: checks.length, candidateImplementationExists: false, behavioralEquivalenceAccepted: false, nativeAcceptance: false }));
})().catch((error) => { fs.writeFileSync(path.join(__dirname, 'baseline-characterization-failure.json'), JSON.stringify({ error: error.message, stack: error.stack, checksPassedBeforeFailure: checks }, null, 2) + '\n'); console.error(error); process.exitCode = 1; });
