import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '../../../..');
const require = createRequire(resolve(root, 'package.json'));
const ts = require('typescript');
const head = '11903f32f6257a47e42f49c1abe92c0e0fb0e4fb';
const main = '4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace';
const pins = {
  objective: '0716767e8b6ff323b2516d166b22edb4d2413e57',
  workspace: 'c05b85a29a75cbaaa8538fd7f9a97e298a23913e',
  sender: 'b1ac2649e134af560d41bee790cacbd61de01c9b',
  activity: 'e2c2c110edd986e799d47d43b0db50b24fab0201',
  owners: '0783423aeaaa8b65f289d0927d605142816d8cfe',
  calendar: '39b4ae45db578d121b18db9f95029a8c3ec293a2',
  contacts: '6c6f88e9e5ba077452716f3a0db0dd3bbea2963f',
  cleanup: '03d85a40e390f8f52614aab20427a3a9433786bb',
};
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trimEnd();
const at = (ref, path) => git('show', `${ref}:${path}`);
const current = (path) => at(head, path);
const printer = ts.createPrinter({ removeComments: false });
function ast(path, text = current(path)) { return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true); }
function method(path, name, ref = head) {
  const source = ast(path, at(ref, path));
  let found;
  const visit = node => {
    if (ts.isMethodDeclaration(node) && node.name?.getText(source) === name) {
      assert.equal(found, undefined, `ambiguous method ${name}`);
      found = printer.printNode(ts.EmitHint.Unspecified, node, source);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(found, `missing method ${name}`);
  return found;
}
function moduleNames(path, key) {
  const source = ast(path);
  let value;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'Module') {
      const prop = node.arguments[0]?.properties?.find(p => p.name?.getText(source) === key);
      value = prop?.initializer?.elements?.map(n => n.getText(source)) ?? [];
    }
    ts.forEachChild(node, visit);
  };
  visit(source); assert.ok(value); return value;
}
function model(schema, name) {
  const start = schema.indexOf(`model ${name} {`);
  assert.ok(start >= 0, `missing model ${name}`);
  return schema.slice(start, schema.indexOf('\n}', start) + 2);
}

test('frozen source and tree are exact', () => {
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(git('rev-parse', 'HEAD^{tree}'), 'b10a7ed7e2e19d371ad46bfc2a6b57efdbaa997c');
});
test('all 19 included published histories remain ancestors, full Cleanup excluded from 20 references', () => {
  const record = JSON.parse(readFileSync(resolve(import.meta.dirname, 'source-preservation-initial.json')));
  assert.equal(record.histories.length, 20);
  assert.equal(record.histories.filter(x => x.ancestor).length, 19);
  assert.deepEqual(record.histories.filter(x => !x.ancestor).map(x => x.pr), [2392]);
});
test('all 471 pre-existing migration SQL blobs are preserved', () => {
  const paths = git('ls-tree', '-r', '--name-only', main, 'apps/api/prisma/migrations', 'apps/workspace/prisma/migrations').split('\n').filter(p => p.endsWith('/migration.sql'));
  assert.equal(paths.length, 471);
  for (const path of paths) assert.equal(current(path), at(main, path), path);
});
test('Workspace migration allocation changes only names and preserves exact SQL', () => {
  for (const [oldPath, newPath] of [
    ['20281012030000_prospect_resource_origin', '20261012030000_prospect_resource_origin'],
    ['20281012040000_saved_version_immutability', '20261012040000_saved_version_immutability'],
  ]) assert.equal(current(`apps/workspace/prisma/migrations/${newPath}/migration.sql`), at(pins.workspace, `apps/workspace/prisma/migrations/${oldPath}/migration.sql`));
});
test('migration offsets remain exact main policy, Core2 Workspace0', () => {
  const path = 'scripts/migration-timestamp-offsets.json';
  assert.equal(current(path), at(main, path));
  const config = JSON.parse(current(path));
  assert.equal(config['apps/api/prisma/migrations'].yearOffset, 2);
  assert.equal(config['apps/workspace/prisma/migrations'].yearOffset, 0);
});
test('Contacts allocation preserves the reviewed SQL proposal body', () => {
  const proposal = at(pins.contacts, 'docs/portfolio-prospect-contacts/UNALLOCATED-proposal.sql');
  const allocation = current('apps/api/prisma/migrations/20281011030000_prospect_contacts/migration.sql');
  assert.equal(allocation.slice(allocation.indexOf('CREATE TABLE')), proposal.slice(proposal.indexOf('CREATE TABLE')));
  assert.ok(allocation.includes('FORCE ROW LEVEL SECURITY'));
});
test('all three narrow Cleanup guard blobs are exact', () => {
  for (const path of ['scripts/check-migration-integrity.mjs', 'scripts/check-migration-timestamps.mjs', 'scripts/cleanup-gates/lib/cli.mjs']) assert.equal(current(path), at(pins.cleanup, path));
});
test('retired Meri release guard pair and active release code remain main', () => {
  for (const path of ['scripts/execute-meriv2-ecs-release.mjs', 'scripts/validate-meri-build-isolation.py', 'scripts/meri-release.mjs']) assert.equal(current(path), at(main, path));
});
test('both cross-service authority seams are exact published bytes', () => {
  assert.equal(current('packages/shared/src/client-objective-destination.ts'), at(pins.objective, 'packages/shared/src/client-objective-destination.ts'));
  assert.equal(current('packages/shared/src/workspace-saved-revision.ts'), at(pins.workspace, 'packages/shared/src/workspace-saved-revision.ts'));
});
test('shared barrel retains all canonical source helpers', () => {
  const text = current('packages/shared/src/index.ts');
  for (const name of ['client-memory-wall', 'prospect-resource-scope', 'tenant-feature', 'workspace-saved-revision', 'client-objective-destination']) assert.equal(text.split(`./${name}.js`).length - 1, 1);
});
test('canonical additive models occur once and retain their published bodies', () => {
  const path = 'apps/api/prisma/schema.prisma'; const schema = current(path);
  for (const [name, owner] of [
    ['ClientObjective', pins.objective], ['ClientObjectiveRevision', pins.objective],
    ['ClientActivityCommand', pins.activity], ['ClientOrderedOwner', pins.owners],
    ['ProspectAttachmentUploadIntent', pins.workspace],
  ]) {
    assert.equal(schema.split(`model ${name} {`).length - 1, 1);
    assert.equal(model(schema, name), model(at(owner, path), name));
  }
  assert.equal((schema.match(/effectiveDateEvidence Json\?/g) ?? []).length, 1);
});
test('no new commitment party schema or independent task/message store', () => {
  const diff = git('diff', main, head, '--', 'apps/api/prisma/schema.prisma', 'apps/api-strategy/prisma/schema.prisma', 'apps/workspace/prisma/schema.prisma');
  assert.ok(!/^\+.*(?:weOwe|theyOwe|owedBy|counterparty|Commitment)/mi.test(diff));
  assert.ok(!/^\+model .*?(?:Message|PlannerTask|WsDraft|WsDocVersion)/m.test(diff));
});
test('ClientsModule composes Objective, activity and ordered-owner canonical registrations', () => {
  const path = 'apps/api/src/clients/clients.module.ts';
  assert.ok(moduleNames(path, 'imports').includes('ClientObjectivesModule'));
  for (const name of ['ActivityCommandController', 'ClientOrderedOwnerController']) assert.ok(moduleNames(path, 'controllers').includes(name));
  for (const name of ['ActivityCommandService', 'ActivityCommandPlanner', 'ClientOrderedOwnerService', 'ClientActivityService', 'ClientTeamService']) assert.ok(moduleNames(path, 'providers').includes(name));
});
test('Outreach imports exported canonical Objective owner and never duplicates its provider', () => {
  const path = 'apps/api/src/outreach-v3/api/outreach-v3-state.module.ts';
  assert.ok(moduleNames(path, 'imports').includes('ClientObjectivesModule'));
  assert.ok(!moduleNames(path, 'providers').includes('ClientObjectivesService'));
  assert.ok(moduleNames('apps/api/src/clients/objectives/objectives.module.ts', 'exports').includes('ClientObjectivesService'));
});
test('Contacts existing module is activated through BusinessDevelopment only', () => {
  assert.ok(moduleNames('apps/api/src/business-development/business-development.module.ts', 'imports').includes('ProspectContactsModule'));
  const path = 'apps/api/src/business-development/prospect-contacts/prospect-contacts.module.ts';
  assert.equal(current(path), at(pins.contacts, path));
  assert.deepEqual(moduleNames(path, 'controllers'), ['ProspectContactsController']);
});
test('both Outreach bounded Objective and staging routes survive manifest composition', () => {
  const manifest = current('apps/api/src/outreach-v3/__fixtures__/outreach-v3-route-manifest.v1.json');
  const controller = current('apps/api/src/outreach-v3/api/outreach-v3-state.controller.ts');
  for (const route of ['objective-destination', 'newsletter-staging']) {
    assert.ok(manifest.includes(route)); assert.ok(controller.includes(route));
  }
});
test('Planner task command and Objective owner routes survive composition', () => {
  const controller = current('apps/api-strategy/src/planner/planner.controller.ts');
  assert.ok(controller.includes("@Post('task-create-commands')"));
  assert.ok(controller.includes("@Get('task-create-commands/:requestId')"));
  assert.ok(controller.includes("@Get('tasks/:id/objective-destination')"));
  assert.equal(method('apps/api-strategy/src/planner/planner.service.ts', 'objectiveDestination'), method('apps/api-strategy/src/planner/planner.service.ts', 'objectiveDestination', pins.objective));
  for (const name of ['createTaskCommand', 'taskCreateCommand', 'taskForCreateReceipt']) assert.equal(method('apps/api-strategy/src/planner/planner.service.ts', name), method('apps/api-strategy/src/planner/planner.service.ts', name, pins.activity));
});
test('Core activity transactional owner methods remain exact with prospect read exclusion', () => {
  const path = 'apps/api/src/clients/client-activity.service.ts';
  for (const name of ['requireClientWall', 'create', 'createInTransaction', 'update', 'remove']) assert.equal(method(path, name), method(path, name, pins.activity));
  assert.ok(method(path, 'list').includes('prospectId: null'));
});
test('accepted sender command remains exact and unpublished reporting is not substituted', () => {
  const path = 'apps/api/src/engagement/engagement.service.ts';
  assert.equal(method(path, 'sendSingleMail'), method(path, 'sendSingleMail', pins.sender));
  assert.equal(method(path, 'reportOverview'), method(path, 'reportOverview', main));
});
test('calendar production evidence/checkpoint owner remains exact apart from entry lifecycle', () => {
  for (const path of ['apps/api/src/federal-register/effective-date-evidence.ts', 'apps/api/src/federal-register/federal-register-observation.ts', 'apps/api/src/federal-register/federal-register.service.ts', 'apps/api/src/ingestion/sync-run.helper.ts']) assert.equal(current(path), at(pins.calendar, path));
  const diff = git('diff', pins.calendar, head, '--', 'apps/api/scripts/sync-federal-register.ts');
  assert.ok(diff.includes('requires DATABASE_URL'));
  assert.ok(diff.includes('require.main === module'));
  assert.ok(!/^\+.*findFirst|^\+.*publicationDate|^\+.*incrementalCheckpointEligible/m.test(diff));
});
