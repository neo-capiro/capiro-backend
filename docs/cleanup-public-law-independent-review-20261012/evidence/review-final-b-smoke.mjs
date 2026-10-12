import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ts = createRequire('/workspace/capirov2/apps/api/package.json')('typescript');
const source = '364019751656acec243e49ef428044dd48425e95';
const comparedTo = 'cce0cdd9544fd82c7099f3f2c56712994e2e2439';
const testPath = 'scripts/cleanup-script-smoke/pe-core-verifier-cli-contracts.test.mjs';
const verifierPath = 'apps/api/scripts/verify-pe-phase-e-exact-sha.ts';
const contractPath = 'apps/api/scripts/lib/pe-exact-sha-loader-contract.ts';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
const blob = (ref, rel) => git('show', `${ref}:${rel}`);
const hash = text => createHash('sha256').update(text).digest('hex');
const parse = (rel, text) => ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
const old = parse(testPath, blob(comparedTo,testPath)), now = parse(testPath,blob(source,testPath));
const printer = ts.createPrinter({ removeComments:true,newLine:ts.NewLineKind.LineFeed });
const print = (node, sf) => printer.printNode(ts.EmitHint.Unspecified,node,sf);
const declaration = (sf,name) => sf.statements.filter(ts.isVariableStatement).flatMap(n=>Array.from(n.declarationList.declarations)).find(n=>n.name.getText(sf)===name);
const cases = sf => declaration(sf,'cases').initializer.elements;
const property = (obj,name) => obj.properties.find(p=>p.name.text===name)?.initializer;
const invoke = sf => sf.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text==='invoke');
const loopTest = sf => sf.statements.find(ts.isForOfStatement).statement.statements[0].expression;
const callback = sf => loopTest(sf).arguments[1].body;
assert.equal(print(invoke(now),now),print(invoke(old),old));
assert.equal(declaration(now,'probe').initializer.text,declaration(old,'probe').initializer.text);
assert.equal(loopTest(now).arguments[0].getText(now),loopTest(old).arguments[0].getText(old));
assert.deepEqual(Array.from(cases(now)).map(n=>property(n,'file').text),Array.from(cases(old)).map(n=>property(n,'file').text));
for(let i=0;i<2;i++)assert.equal(print(cases(now)[i],now),print(cases(old)[i],old),'migration subject fixture changed');
assert.deepEqual(Array.from(callback(now).statements).slice(-6).map(n=>print(n,now)),Array.from(callback(old).statements).slice(-6).map(n=>print(n,old)));
const lastTest = sf => sf.statements.filter(ts.isExpressionStatement).at(-1);
assert.equal(print(lastTest(now),now),print(lastTest(old),old));
const oldBranch=callback(old).statements.find(n=>ts.isIfStatement(n)&&n.expression.getText(old)==='subject.failure');
const branch=callback(now).statements.find(n=>ts.isIfStatement(n)&&n.expression.getText(now)==='subject.failure');
const oldStdoutRefusal=callback(old).statements.find(n=>ts.isExpressionStatement(n)&&n.getText(old).includes("'a refused policy gate emits no success output'"));
assert.deepEqual(Array.from(branch.thenStatement.statements).map(n=>print(n,now)),
  [print(oldStdoutRefusal,old),...Array.from(oldBranch.thenStatement.statements).map(n=>print(n,old))]);
const normal=callback(now).statements.filter(ts.isVariableStatement).flatMap(n=>Array.from(n.declarationList.declarations)).find(n=>n.name.text==='normal');
assert.equal(print(normal.initializer.arguments[2],now),'subject.noArgsExit ?? 1');
assert.equal(property(cases(now)[2],'noArgsExit').text,'0');
const contract = parse(contractPath,blob(source,contractPath));
const inventory = Array.from(declaration(contract,'PE_EXACT_SHA_DOLLAR_LOADERS').initializer.expression.elements).map(n=>n.text);
const loadersExpected = Array.from(property(cases(now)[2],'loadersExpected').elements).map(n=>n.text);
assert.equal(inventory.length,13);assert.deepEqual(loadersExpected,inventory);
assert.equal(blob(source,verifierPath),blob(comparedTo,verifierPath).replace('@cleanup-smoke noArgsExit=1 helpExit=0','@cleanup-smoke noArgsExit=0 helpExit=0'));
for(const rel of ['apps/api/scripts/lib/pe-public-law-facade-containment.ts','apps/api/scripts/lib/pe-public-law-facade-containment.spec.ts'])assert.equal(blob(source,rel),blob(comparedTo,rel));
assert.deepEqual(git('diff','--name-only',comparedTo,source,'--','apps','scripts','packages','.github').trim().split('\n').sort(),[testPath,verifierPath].sort());

const subject={usage:property(cases(now)[2],'usage').text,noArgsExit:0,loadersExpected};
const correct={ok:true,loadersChecked:13,loaders:inventory};
const successCases=[
  ['exact complete success',correct,'',true],
  ['ok false',{...correct,ok:false},'',false],
  ['wrong count',{...correct,loadersChecked:12},'',false],
  ['missing facade',{...correct,loaders:inventory.filter(n=>n!=='parse-defense-approps-public-law.ts')},'',false],
  ['duplicate inventory entry',{...correct,loaders:[...inventory.slice(0,-1),inventory[0]]},'',false],
  ['wrong inventory order',{...correct,loaders:[...inventory].reverse()},'',false],
  ['invented slot',{...correct,loaders:inventory.map((n,i)=>i===10?'invented.ts':n)},'',false],
  ['extra inventory slot',{...correct,loaders:[...inventory,'extra.ts']},'',false],
  ['fabricated report field',{...correct,canonicalWrites:true},'',false],
  ['unexpected stderr',correct,'unexpected failure\n',false],
  ['empty output','', '',false],
];
const rows=successCases.map(([name,report,extraStderr,expectedAccepted])=>{
  const normal={stdout:typeof report==='string'?report:JSON.stringify(report),stderr:subject.usage+extraStderr};
  const code=`const subject = JSON.parse(${JSON.stringify(JSON.stringify(subject))}); const normal = JSON.parse(${JSON.stringify(JSON.stringify(normal))}); ${print(branch.elseStatement,now)}`;
  let accepted=true,failure=null;
  try{runInNewContext(code,{assert},{timeout:1000});}catch(error){accepted=false;failure=error.message;}
  assert.equal(accepted,expectedAccepted,`${name}: wrong assertion result`);
  return{name,expectedAccepted,accepted,failure};
});
console.log(JSON.stringify({source,tree:git('rev-parse',`${source}^{tree}`).trim(),comparedTo,
  sourceOnly:true,onlyMetadataAndBoundedRootTestSourceChanged:true,verifierMetadata:'noArgsExit=0 helpExit=0',
  allFourOriginalNamesAndInvocationResourceHelpUnknownOptionalPrismaControlsPreserved:true,
  bothMigrationFixturesAndRefusalAssertionsPreserved:true,completeExactOrderedInventory:loadersExpected,
  helperAndSpecUnchanged:true,purePositiveAssertionProbes:rows.length,rows,
  testSourceSha256:hash(blob(source,testPath)),
  limits:'Pure inspected assertion branch and AST/source comparisons only; no actual subject/Prisma/native/DB/provider/child execution.'},null,2));
