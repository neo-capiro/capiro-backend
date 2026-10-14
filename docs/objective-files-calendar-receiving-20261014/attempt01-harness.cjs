// In-memory synthetic qualification of exact Git source, never full DI/native.
const cp = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const toolRoot = process.env.CAPIRO_QUALIFICATION_TOOL_ROOT ||
  '/workspace/capiro-backend-cleanup-receiving-20261014/apps/api';
const ts = require(require.resolve('typescript', { paths: [toolRoot] }));
const nest = require(require.resolve('@nestjs/common', { paths: [toolRoot] }));
const ref = '65c4918042df0930d4ff46abd6994fbdd27538c5';
const consumed = new Map();
function read(file) {
  const source = cp.execFileSync('git', ['show', `${ref}:${file}`], { cwd: root, encoding: 'utf8' });
  const blob = cp.execFileSync('git', ['rev-parse', `${ref}:${file}`], { cwd: root, encoding: 'utf8' }).trim();
  consumed.set(file, { path: file, blob, sha256: createHash('sha256').update(source).digest('hex') });
  return source;
}
function compile(source, names = {}, file = 'fixture.ts') {
  const result = ts.transpileModule(source, { fileName: file, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  assert.equal(result.diagnostics?.length ?? 0, 0);
  const module = { exports: {} };
  const requireBound = (name) => {
    assert(Object.hasOwn(names, name), `Unadmitted runtime import ${name}`);
    return names[name];
  };
  new Function('require', 'module', 'exports', result.outputText)(requireBound, module, module.exports);
  return module.exports;
}
const objective = compile(read('packages/shared/src/client-objective-destination.ts'));
const wall = compile(read('packages/shared/src/client-memory-wall.ts'));
const saved = compile(read('packages/shared/src/workspace-saved-revision.ts'), { './client-memory-wall.js': wall });
const defaults = compile(read('packages/strategy-verifier/src/planner.ts'));
const schedule = compile(read('packages/strategy-verifier/src/planner-schedule.ts'), { './planner.js': defaults });
const validation = compile(read('apps/api-strategy/src/planner/planner.validation.ts'),
  { '@nestjs/common': nest, '@capiro/strategy-verifier': { ...defaults, ...schedule } });
function select(source, functions, variables, owner, methods) {
  const parsed = ts.createSourceFile('selected.ts', source, ts.ScriptTarget.Latest, true);
  assert.equal(parsed.parseDiagnostics.length, 0);
  const pieces = [];
  for (const name of functions) {
    const node = parsed.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert(node, name); pieces.push(node.getText(parsed));
  }
  for (const name of variables) {
    const statement = parsed.statements.find((n) => ts.isVariableStatement(n) &&
      n.declarationList.declarations.some((d) => d.name.getText(parsed) === name));
    assert(statement, name); pieces.push(statement.getText(parsed));
  }
  const declaration = parsed.statements.find((n) => ts.isClassDeclaration(n) && n.name?.text === owner);
  assert(declaration, owner);
  const selected = methods.map((name) => {
    const method = declaration.members.find((n) => ts.isMethodDeclaration(n) && n.name.getText(parsed) === name);
    assert(method, name); return method.getText(parsed);
  });
  return pieces.join('\n') + '\nexport class SelectedOwner { constructor(prisma: any) { this.prisma = prisma; }\n' + selected.join('\n') + '\n}';
}
const preamble = `const { workspaceSavedOutreachRevisionWithinTx, WorkspaceRevisionUnavailable,
  normalizeClientObjectiveDestination, requireClientObjectiveDestinationRevision,
  ClientObjectiveDestinationError } = require('shared');
  const { NotFoundException, BadRequestException, ConflictException, ForbiddenException } = require('nest');
  const { createHash } = require('crypto');`;
const versions = compile(preamble + select(read('apps/workspace/src/versions/versions.service.ts'),
  [], [], 'VersionsService', ['objectiveDestination']),
{ shared: { ...objective, ...saved }, nest, crypto: { createHash } });
// Compile the real error adapters; DTO decorators are intentionally outside this seam.
const adapterSource = read('apps/api-strategy/src/strategy/objective-destination.ts');
const adapterAst = ts.createSourceFile('adapter.ts', adapterSource, ts.ScriptTarget.Latest, true);
const adapterFunctions = adapterAst.statements.filter(ts.isFunctionDeclaration).map((n) => n.getText(adapterAst)).join('\n');
const adapters = compile(preamble + adapterFunctions, { shared: objective, nest, crypto: { createHash } });
const plannerSource = read('apps/api-strategy/src/planner/planner.service.ts');
const planner = compile(`const { PLANNER_DEFAULT_TASK, PLANNER_DEFAULT_PROJECT } = require('defaults');
 const { NotFoundException, ForbiddenException } = require('nest');
 const { normalizeObjectiveDestination, requireObjectiveDestinationRevision } = require('adapters');
 const uuid = require('uuid'); const plannerActualMinutes = require('minutes');\n` +
 select(plannerSource, ['plannerProjectAccess', 'plannerTaskAccess', 'requireRole'],
 ['RANK', 'projectData', 'taskData', 'missing'], 'PlannerService', ['scope', 'projects', 'taskView', 'objectiveDestination']),
 { defaults, nest, adapters, uuid: validation.uuid, minutes: async () => new Map() });

const id = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ids = { tenant: id(1), user: id(2), client: id(3), objective: id(4), revision: id(5),
  draft: id(6), version: id(7), task: id(8), other: id(9) };
const binding = { clientId: ids.client, objectiveId: ids.objective, objectiveVersion: 3 };
const ctx = { tenantId: ids.tenant, clerkUserId: 'user_synthetic', role: 'standard_user' };
function fixture() {
  const snapshot = { docTitle: 'Saved synthetic work', config: { clientId: ids.client,
    sections: ['Update'], sectionContent: { Update: '<p>Exact saved text</p>' } },
    documents: [{ id: id(10), body: { blocks: [] } }], ask: null };
  const state = { tenant: true, member: true, client: true, grant: true, wall: true,
    draft: true, version: true, collaborator: 'viewer', draftOwner: ctx.clerkUserId,
    currentClient: ids.client, prospect: null, source: null, objective: true, objectiveVersion: 3,
    revision: true, snapshot, fail: null, error: new Error('SYNTHETIC_INFRASTRUCTURE_FAILURE') };
  const sql = [];
  async function query(text, values) {
    sql.push({ text, values });
    if (state.fail && text.includes(state.fail)) throw state.error;
    if (text.includes('set_config') || text.includes('pg_advisory_xact_lock')) return [];
    if (text.includes('FROM tenants t')) return state.tenant && state.member && state.client &&
      values.includes(ctx.clerkUserId) ? [{ userId: ids.user, memoryWall: state.wall }] : [];
    if (text.includes('FROM tenants ')) return state.tenant ? [{ id: ids.tenant }] : [];
    if (text.includes('FROM tenant_memberships')) return state.member && values[1] === ctx.clerkUserId ? [{ userId: ids.user }] : [];
    if (text.includes('FROM ws_draft')) return state.draft && values[1].toLowerCase() === ids.draft ?
      [{ ownerId: state.draftOwner, prospectId: state.prospect, config: { clientId: state.currentClient }, client: null }] : [];
    if (text.includes('FROM ws_source_action')) return state.source ? [{ sourceType: state.source }] : [];
    if (text.includes('FROM ws_collaborator')) return state.collaborator ? [{ role: state.collaborator }] : [];
    if (text.includes('FROM ws_doc_version')) return state.version && values[1].toLowerCase() === ids.draft &&
      values[2].toLowerCase() === ids.version ? [{ id: ids.version, snapshot: state.snapshot,
        authorId: 'user_original', authorKind: 'person', createdAt: new Date('2026-10-14T00:00:00Z') }] : [];
    if (text.includes('SELECT (NOT c.memory_wall')) return [{ allowed: state.client && (!state.wall || state.grant) }];
    if (text.includes('FROM clients ')) return state.client ? [{ memoryWall: state.wall }] : [];
    if (text.includes('FROM client_memory_access')) return state.grant ? [{ id: id(11) }] : [];
    if (text.includes('FROM client_objective_revisions')) return state.revision ? [{ id: ids.revision }] : [];
    if (text.includes('FROM client_objectives')) return state.objective ? [{ version: state.objectiveVersion }] : [];
    throw new Error(`Unadmitted fixture query: ${text}`);
  }
  const now = new Date('2026-10-14T00:00:00Z');
  const task = { id: ids.task, tenantId: ids.tenant, ownerId: ctx.clerkUserId, version: 5,
    archived: false, completedAt: null, createdAt: now, updatedAt: now, projectIds: [],
    data: { ...structuredClone(defaults.PLANNER_DEFAULT_TASK), name: 'Synthetic task', clientId: ids.client,
      startOn: '2026-10-14', dueOn: '2026-10-15' } };
  const tx = { $queryRawUnsafe: query,
    $queryRaw: (parts, ...values) => query(parts.join('?'), values),
    $executeRaw: (parts, ...values) => query(parts.join('?'), values),
    spPlannerTask: { findFirst: async ({ where }) => where.id === task.id && where.tenantId === task.tenantId ? task : null,
      findMany: async () => [] }, spPlannerProject: { findMany: async () => [] } };
  let transactions = 0;
  const prisma = { $transaction: async (run) => { transactions++; return run(tx); },
    withTenant: async (tenant, run) => { assert.equal(tenant, ids.tenant); transactions++; return run(tx); } };
  const fileOwner = new versions.SelectedOwner(prisma), calendarOwner = new planner.SelectedOwner(prisma);
  const file = (input = binding, actor = ctx.clerkUserId) => fileOwner.objectiveDestination(ids.tenant, ids.draft, ids.version, actor, input);
  const calendar = (input = binding) => calendarOwner.objectiveDestination(ctx, ids.task, input);
  return { state, task, sql, file, calendar, get transactions() { return transactions; } };
}
const hashSnapshot = (snapshot) => createHash('sha256').update(saved.canonicalWorkspaceSnapshot(snapshot)).digest('hex');
module.exports = { fixture, ids, binding, ctx, hashSnapshot, nest,
  sourceReceipt: () => ({ source: ref, typescript: ts.version, consumed: [...consumed.values()],
    boundary: 'Exact AST-selected owner methods and actual shared helpers; adjacent minutes and native transaction/store dependencies are synthetic. No DTO/guard/HTTP/DI/native/Postgres/RLS qualification.' }) };
