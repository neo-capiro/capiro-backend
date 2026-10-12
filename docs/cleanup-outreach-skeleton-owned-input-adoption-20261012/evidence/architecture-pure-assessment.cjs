const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const ts = require(require.resolve('typescript', { paths: [path.resolve(__dirname, '../../../apps/api')] }));
const root = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(__dirname, 'outreach-architecture-source-files.ts.published-code.txt'), 'utf8');
const ast = ts.createSourceFile('owner.ts', source, ts.ScriptTarget.Latest, true);
assert.ok(ast.statements.every(statement => ts.isFunctionDeclaration(statement) || ts.isTypeAliasDeclaration(statement)));
const current = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, current, { timeout: 1000 });
const oldSource = cp.execFileSync('git', ['show', 'd587441261fd356ee5144a8fc29cb2f771d062b8:apps/api/src/outreach-v3/targets/outreach-v3-phase4-architecture.spec.ts'], { cwd: root, encoding: 'utf8' });
const oldAst = ts.createSourceFile('old.spec.ts', oldSource, ts.ScriptTarget.Latest, true);
const original = oldAst.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name.text === 'productionFiles').getText(oldAst);
const functions = current.exports;
const checks = [];
function check(name, callback) { callback(); checks.push({ name, passed: true }); }
function fixture(paths) {
  const repo = paths.resolve(paths === path.win32 ? 'C:/fixture' : '/fixture');
  const names = ['apps/api/src/app.module.ts','apps/api/src/outreach-v3/reasoning/tool.ts','apps/api/src/outreach-v3/reasoning/tool.spec.ts','apps/api/src/outreach-v3/reasoning/tool.spec.tsx','apps/api/src/outreach-v3/reasoning/tool.test.ts','apps/api/src/outreach-v3/reasoning/tool.test.tsx','apps/api/src/outreach-v3/reasoning/tool.js','apps/api/web/nested.module.ts','apps/clio-api/src/app.module.ts','apps/onboard-api/src/app.module.ts','apps/future-worker/src/app.module.ts','apps/web-mirror/src/app.module.ts','apps/web/src/future.module.ts','apps/web/src/page.tsx','apps/onboard-web/src/future.module.ts'];
  const tree = new Map();
  for (const value of names) { const parts = value.split('/'); for (let n=1;n<parts.length;n++) { const parent=paths.resolve(repo,...parts.slice(0,n)); if(!tree.has(parent)) tree.set(parent,new Set());tree.get(parent).add(parts[n]); } }
  const calls=[];
  const fileSystem={existsSync(value){calls.push(['exists',value]);return tree.has(value);},readdirSync(value){calls.push(['readDir',value]);return [...tree.get(value)];},statSync(value){calls.push(['stat',value]);return {isDirectory:()=>tree.has(value)};}};
  return {repo,calls,fileSystem,paths};
}
function baseline(f, input) {
  const context={...f.fileSystem,resolve:f.paths.resolve};
  vm.runInNewContext(ts.transpileModule(`${original}\nexports.walk=productionFiles;`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText, Object.assign(context,{exports:{}}),{timeout:1000});
  return Array.from(context.exports.walk(input));
}
function candidate(f, scope, input=f.paths.resolve(f.repo,'apps')) {
  return Array.from(functions.outreachArchitectureProductionFiles(input,{repoRoot:f.repo,scope,fileSystem:f.fileSystem,resolve:f.paths.resolve,separator:f.paths.sep}));
}
check('unset source scope remains full',()=>assert.equal(functions.outreachArchitectureSourceScope(),'full'));
for (const paths of [path.posix,path.win32]) {
  const label=paths===path.win32?'win32':'posix';
  check(`${label} full exact original output and filesystem call ordering`,()=>{
    const before=fixture(paths),after=fixture(paths);assert.deepEqual(candidate(after,'full'),baseline(before,paths.resolve(before.repo,'apps')));assert.deepEqual(after.calls,before.calls);
  });
  check(`${label} backend/frontend disjoint full complement`,()=>{
    const full=candidate(fixture(paths),'full'),back=candidate(fixture(paths),'backend-only'),front=candidate(fixture(paths),'frontend-only');assert.deepEqual([...back,...front].sort(),full.sort());assert.equal(back.some(value=>front.includes(value)),false);
  });
  check(`${label} backend anchored excludes only both declared frontend roots before metadata`,()=>{
    const f=fixture(paths),files=candidate(f,'backend-only');for(const name of ['web','onboard-web']){const prefix=paths.resolve(f.repo,'apps',name);assert.ok(f.calls.every(([,value])=>value!==prefix&&!value.startsWith(prefix+paths.sep)));}
    for(const name of ['clio-api','onboard-api','future-worker','web-mirror'])assert.ok(files.some(value=>value.includes(paths.sep+name+paths.sep)));assert.ok(files.some(value=>value.includes(paths.sep+'api'+paths.sep+'web'+paths.sep)));
  });
  for (const scope of ['full','backend-only','frontend-only']) check(`${label} ${scope} explicit API reasoning root unchanged`,()=>{
    const before=fixture(paths),after=fixture(paths);const input=paths.resolve(before.repo,'apps/api/src/outreach-v3/reasoning');assert.deepEqual(candidate(after,scope,input),baseline(before,input));assert.deepEqual(after.calls,before.calls);
  });
}
for (const scope of ['', 'typo', '--backend-only', 'backend-onlyish']) check(`invalid ${JSON.stringify(scope)} refuses before any fake filesystem call`,()=>{
  const f=fixture(path.posix);assert.throws(()=>candidate(f,scope),/Unknown Outreach architecture source scope/);assert.deepEqual(f.calls,[]);
});
console.log(JSON.stringify({ checks:checks.length, controls:checks, publishedProposal:'67fa9255b8a73f489d7a57c8fe270ed6d03fa016',baseline:'d587441261fd356ee5144a8fc29cb2f771d062b8',onlyFakeFilesystem:true,architectureSourceAdopted:false,callerClosureOrNativeAcceptance:false },null,2));
