const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..'), api = path.join(root, 'apps/api');
const ts = require(require.resolve('typescript', { paths: [api] }));
const globals = path.dirname(require.resolve('@jest/globals', { paths: [api] }));
const expect = require(require.resolve('expect', { paths: [globals] })).expect;
const relative = 'scripts/lib/memory-admin-self-approval-contract.spec.ts';
const source = fs.readFileSync(path.join(api, relative), 'utf8');
const ast = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true);
const fixtureRoot = 'scripts/lib/__fixtures__/legacy-ui-contracts/';
const inputs = new Map();
function collect(node) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['read', 'readWeb'].includes(node.expression.text)) {
    assert.equal(node.arguments.length, 1); assert.ok(ts.isStringLiteral(node.arguments[0]));
    const name = node.expression.text === 'readWeb' ? `${fixtureRoot}${node.arguments[0].text}.txt` : node.arguments[0].text;
    inputs.set(name, fs.readFileSync(path.join(api, name), 'utf8'));
  }
  ts.forEachChild(node, collect);
}
collect(ast);
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const caseName = 'removes the independent-approver claim from every active shared-memory UI surface';
function load(values) {
  const cases = [], reads = [];
  const fakeFs = {
    existsSync(name) { assert.ok(name === path.join(root, 'prisma/schema.prisma') || name === path.join(api, 'prisma/schema.prisma')); return name === path.join(api, 'prisma/schema.prisma'); },
    readFileSync(name, encoding) {
      assert.equal(encoding, 'utf8'); const key = path.relative(api, name); reads.push(key);
      assert.ok(inputs.has(key), `undeclared source read ${key}`);
      if (!values.has(key)) throw new Error(`missing synthetic source ${key}`);
      return values.get(key);
    },
  };
  const context = { exports: {}, process: { cwd: () => root }, require(name) {
    if (name === 'node:fs') return fakeFs;
    if (name === 'node:path') return path;
    if (name === 'typescript') return ts;
    if (name === '@jest/globals') return { expect, describe(_name, run) { run(); }, it(name, run) { cases.push({name,run}); } };
    throw new Error(`refused module ${name}`);
  } };
  vm.runInNewContext(js, context, { timeout: 1000 });
  return { cases, reads };
}
const editor = `${fixtureRoot}src/components/MemoryFileEditor.tsx.txt`;
const panel = `${fixtureRoot}src/components/PendingMemoryReviewPanel.tsx.txt`;
const shared = `${fixtureRoot}src/components/memory-file-editor-shared.ts.txt`;
const pending = `${fixtureRoot}src/components/pending-memory-review-shared.ts.txt`;
function typeOnly(value, module, name, clause = false) {
  const tree=ts.createSourceFile('input.tsx',value,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const imported=tree.statements.find(node=>ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&node.moduleSpecifier.text===module);
  if(clause){const start=imported.getStart(tree);return value.slice(0,start)+value.slice(start).replace(/^import /,'import type ');}
  const entry=imported.importClause.namedBindings.elements.find(node=>node.name.text===name);
  return value.slice(0,entry.getStart(tree))+'type '+value.slice(entry.getStart(tree));
}
function inactivePanel(value, conditional=false) {
  const tree=ts.createSourceFile('panel.tsx',value,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const fn=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='PendingMemoryReviewPanel');
  const returned=fn.body.statements.find(ts.isReturnStatement);
  const replacement=conditional?'return false ? '+returned.expression.getText(tree)+' : null;':'const inertUnusedRender = () => '+returned.expression.getText(tree)+';\nreturn null;';
  return value.slice(0,returned.getStart(tree))+replacement+value.slice(returned.end);
}
const controls = [];
function test(name, run) { run(); controls.push({name,passed:true}); }
const actual = load(inputs);
test('all seven actual repaired owner callbacks pass with declared source reads only', () => { assert.equal(actual.cases.length,7); for (const row of actual.cases) row.run(); });
const successDefinition = "export function settingsMemorySuccessMessage(result: MemorySaveSectionsResp): string {\n  return result.status === 'pending_review' ? 'Submitted for approval' : 'Saved';\n}";
const pendingDefinition = "export function pendingReviewHeadline(pending: PendingMemoryReviewState): string {\n  return pending.blocked ? 'Review blocked' : 'Waiting for approval';\n}";
const mutations = [
  ['success import specifier type-only',editor,v=>typeOnly(v,'./memory-file-editor-shared.js','settingsMemorySuccessMessage')],
  ['success import clause type-only',editor,v=>typeOnly(v,'./memory-file-editor-shared.js','settingsMemorySuccessMessage',true)],
  ['headline import specifier type-only',panel,v=>typeOnly(v,'./pending-memory-review-shared.js','pendingReviewHeadline')],
  ['headline import clause type-only',panel,v=>typeOnly(v,'./pending-memory-review-shared.js','pendingReviewHeadline',true)],
  ['mutation hook specifier type-only',editor,v=>typeOnly(v,'@tanstack/react-query','useMutation')],
  ['mutation hook shadowed with inert implementation',editor,v=>v.replace('  const api = useApi();',"  const useMutation = () => ({ mutate: () => {} });\n  const api = useApi();")],
  ['callback helper call moved into unused arrow',editor,v=>v.replace('message.success(settingsMemorySuccessMessage(result));','const unused = () => message.success(settingsMemorySuccessMessage(result));')],
  ['callback helper call under false condition',editor,v=>v.replace('message.success(settingsMemorySuccessMessage(result));','if (false) message.success(settingsMemorySuccessMessage(result));')],
  ['late mutation option spread overrides callback',editor,v=>v.replace('    onError: (error: unknown) => message.error(memorySaveErrorMessage(error)),','    onError: (error: unknown) => message.error(memorySaveErrorMessage(error)),\n    ...{ onSuccess: () => {} },')],
  ['real panel replaced by unused nested arrow',panel,v=>inactivePanel(v)],
  ['real panel Alert under false conditional return',panel,v=>inactivePanel(v,true)],
  ['early null return before live panel JSX',panel,v=>v.replace('  const reviewers = pending.eligibleReviewers ?? [];','  if (true) return null;\n  const reviewers = pending.eligibleReviewers ?? [];')],
  ['Alert props spread overrides headline',panel,v=>v.replace('message={pendingReviewHeadline(pending)}',"message={pendingReviewHeadline(pending)} {...{message: 'Approved'}}")],
  ['unexported panel cannot stand for live component',panel,v=>v.replace('export function PendingMemoryReviewPanel','function PendingMemoryReviewPanel')],
  ['defer success helper import',editor,v=>v.replace("import {\n  defaultMemoryFileType","import defer {\n  defaultMemoryFileType")],
  ['defer pending helper import',panel,v=>v.replace("import {\n  activeMemoryReviewExplanation","import defer {\n  activeMemoryReviewExplanation")],
  ['top-level editor helper assignment',editor,v=>v+"\nsettingsMemorySuccessMessage = () => 'Saved';\n"],
  ['top-level pending helper assignment',panel,v=>v+"\npendingReviewHeadline = () => 'Approved';\n"],
  ['top-level mutation hook assignment',editor,v=>v+"\nuseMutation = () => ({ mutate: () => {} });\n"],
  ['later computed callback name overrides canonical callback',editor,v=>v.replace('    onError: (error: unknown) => message.error(memorySaveErrorMessage(error)),',"    onError: (error: unknown) => message.error(memorySaveErrorMessage(error)),\n    ['on' + 'Success']: () => undefined,")],
  ['later literal-string callback duplicate overrides canonical callback',editor,v=>v.replace('    onError: (error: unknown) => message.error(memorySaveErrorMessage(error)),',"    onError: (error: unknown) => message.error(memorySaveErrorMessage(error)),\n    'onSuccess': () => undefined,")],
  ['later callback method overrides canonical callback',editor,v=>v.replace('    onError: (error: unknown) => message.error(memorySaveErrorMessage(error)),',"    onError: (error: unknown) => message.error(memorySaveErrorMessage(error)),\n    onSuccess() {},")],
  ['later callback getter overrides canonical callback',editor,v=>v.replace('    onError: (error: unknown) => message.error(memorySaveErrorMessage(error)),',"    onError: (error: unknown) => message.error(memorySaveErrorMessage(error)),\n    get onSuccess() { return () => {}; },")],
  ['approval text changed',shared,v=>v.replace("'Submitted for approval'","'Saved'")],
  ['pending-review condition changed',shared,v=>v.replace("result.status === 'pending_review'","result.status === 'accepted'")],
  ['conditional operator changed',shared,v=>v.replace("result.status === 'pending_review'","result.status !== 'pending_review'")],
  ['inert success definition comment cannot replace the live condition',shared,v=>v.replace("result.status === 'pending_review'","result.status === 'accepted'")+`\n/* ${successDefinition} */\n`],
  ['duplicate live success definition',shared,v=>v+`\n${successDefinition}\n`],
  ['success helper assignment rebinding',shared,v=>v+"\nsettingsMemorySuccessMessage = () => 'Saved';\n"],
  ['success canonical import disconnected',editor,v=>v.replaceAll('./memory-file-editor-shared.js','./unrelated-copy.js')],
  ['success renderer disconnected with inert call comment',editor,v=>v.replace('message.success(settingsMemorySuccessMessage(result));',"message.success('Saved'); // message.success(settingsMemorySuccessMessage(result));")],
  ['success local variable shadows canonical import',editor,v=>v.replace('  const api = useApi();',"  const settingsMemorySuccessMessage = () => 'Saved';\n  const api = useApi();")],
  ['success destructured binding shadows canonical import',editor,v=>v.replace('  const api = useApi();',"  const { copy: settingsMemorySuccessMessage } = {};\n  const api = useApi();")],
  ['success assignment shadows canonical import',editor,v=>v.replace('  const api = useApi();',"  settingsMemorySuccessMessage = () => 'Saved';\n  const api = useApi();")],
  ['waiting text changed',pending,v=>v.replace("'Waiting for approval'","'Approved'")],
  ['blocked branch removed',pending,v=>v.replace("pending.blocked ? 'Review blocked' : 'Waiting for approval'","false ? 'Review blocked' : 'Waiting for approval'")],
  ['inert headline definition cannot replace live blocked branch',pending,v=>v.replace("pending.blocked ?",'false ?')+`\n/* ${pendingDefinition} */\n`],
  ['duplicate live headline definition',pending,v=>v+`\n${pendingDefinition}\n`],
  ['headline assignment rebinding',pending,v=>v+"\npendingReviewHeadline = () => 'Approved';\n"],
  ['headline canonical import disconnected',panel,v=>v.replaceAll('./pending-memory-review-shared.js','./unrelated-copy.js')],
  ['Alert headline disconnected with inert JSX comment',panel,v=>v.replace('message={pendingReviewHeadline(pending)}',"message={'Approved'} /* message={pendingReviewHeadline(pending)} */")],
  ['headline local variable shadows canonical import',panel,v=>v.replace('  const reviewers = pending.eligibleReviewers ?? [];',"  const pendingReviewHeadline = () => 'Approved';\n  const reviewers = pending.eligibleReviewers ?? [];")],
  ['independent-review claim added to success owner',shared,v=>v+'\n// Submitted for independent review\n'],
  ['independent-review claim added to pending owner',pending,v=>v+'\n// independent reviewer\n'],
  ['independent-review claim added to original renderer',editor,v=>v+'\n// Submitted for independent review\n'],
];
for (const [name,key,mutate] of mutations) test(`refuses ${name}`,()=> {
  const values=new Map(inputs),before=values.get(key),after=mutate(before); assert.notEqual(before,after);values.set(key,after);
  const selected=load(values).cases.filter(row=>row.name===caseName);assert.equal(selected.length,1);assert.throws(()=>selected[0].run());
});
for(const key of [shared,pending]) test(`refuses missing ${key}`,()=>{const values=new Map(inputs);values.delete(key);assert.throws(()=>load(values),/missing synthetic source/);});
test('refuses swapped canonical helper snapshots',()=>{const values=new Map(inputs);values.set(shared,inputs.get(pending));values.set(pending,inputs.get(shared));assert.throws(()=>load(values).cases.find(row=>row.name===caseName).run());});
console.log(JSON.stringify({controls:controls.length,checks:controls,actualCaseNames:actual.cases.map(row=>row.name),declaredSourceReadPaths:actual.reads,inMemoryMutationsOnly:true,fixtureCodeImportedOrExecuted:false,onlyTestCallbacksExecuted:true,noGenericJavaScriptContainmentClaim:true},null,2));
