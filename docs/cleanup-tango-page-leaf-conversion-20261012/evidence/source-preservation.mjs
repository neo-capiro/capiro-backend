import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const base = '802bbd0b2c510a44e46a9952d8127e7edc55aaaa';
const packet = 'docs/cleanup-tango-page-leaf-conversion-20261012/evidence/';
const originalIndex = JSON.parse(readFileSync(packet + 'ORIGINALS.json', 'utf8'));
const roles = [];
for (const owner of ['dibbs', 'sbir', 'subaward']) {
  const profile = owner === 'subaward' ? 'captured' : 'interleaved';
  const file = `apps/api/src/external/tango/tango-${owner}.client.ts`;
  const original = readFileSync(packet + `originals/tango-${owner}.client.ts.txt`, 'utf8');
  assert.equal(original, execFileSync('git', ['show', `${base}:${file}`], { encoding: 'utf8' }));
  assert.equal(createHash('sha256').update(original).digest('hex'), originalIndex.files.find((f) => f.path === file).sha256);
  const after = readFileSync(file, 'utf8');
  const beforeAst = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true);
  const afterAst = ts.createSourceFile(file, after, ts.ScriptTarget.Latest, true);
  assert.equal(afterAst.parseDiagnostics.length, 0);
  const beforeClass = beforeAst.statements.find((n) => ts.isClassDeclaration(n) && n.name?.text === `Tango${owner[0].toUpperCase()+owner.slice(1)}Client`);
  const afterClass = afterAst.statements.find((n) => ts.isClassDeclaration(n) && n.name?.text === beforeClass.name.text);
  const requiredCalls = owner === 'subaward' ? 1 : 2;
  const profileCall = `rateOf(response.headers, '${profile}')`;
  assert.equal(afterClass.getText(afterAst).split(profileCall).length - 1, requiredCalls);
  assert.equal(afterClass.getText(afterAst).replaceAll(profileCall, 'rateOf(response.headers)'), beforeClass.getText(beforeAst), 'non-leaf client body changed');
  const helperNodes = beforeAst.statements.filter((n) => ts.isFunctionDeclaration(n) && ['asCount','nextPageOf','rateOf'].includes(n.name?.text));
  assert.equal(helperNodes.length, 3);
  assert.equal(afterAst.statements.filter(ts.isFunctionDeclaration).length, 0);
  let expected = original;
  for (const node of [...helperNodes].reverse()) expected = expected.slice(0,node.getFullStart()) + expected.slice(node.end);
  expected = expected.replaceAll('rateOf(response.headers)', profileCall);
  const firstLine = expected.indexOf('\n');
  expected = expected.slice(0,firstLine+1) + "import { asCount, nextPageOf, rateOf } from './tango-rest-page.js';\n" + expected.slice(firstLine+1);
  if (owner === 'subaward') expected = expected.replace('import { TangoNotConfiguredError, type TangoRateMetadata }', 'import { TangoNotConfiguredError }');
  assert.equal(after, expected, 'client changed beyond authorized removal/import/profile operands');
  roles.push({ owner, file, profile, importedSymbols:['asCount','nextPageOf','rateOf'], import:'./tango-rest-page.js', asCountCalls:1,
    nextPageOfCalls:1, rateOfCalls:requiredCalls, classBodyByteExactAfterRemovingOnlyProfileOperands:true,
    changedAstPaths:['SourceFile/imports', 'SourceFile/functions(asCount,nextPageOf,rateOf):removed',
      `Class(${afterClass.name.text})/Method(${owner==='subaward'?'listSubawards':'list'})/try/successReturn/rate:profileOperand`,
      ...(owner==='subaward'?[]:[`Class(${afterClass.name.text})/Method(list)/try/nonOkThrow/errorRate:profileOperand`])] });
}
const helperFile = 'apps/api/src/external/tango/tango-rest-page.ts';
const helper = ts.createSourceFile(helperFile, readFileSync(helperFile,'utf8'), ts.ScriptTarget.Latest, true);
const rate = helper.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text==='rateOf');
assert.equal(rate.parameters.length,2);
assert.equal(rate.parameters[1].initializer,undefined);
assert.equal(rate.parameters[1].questionToken,undefined);
assert.equal(rate.parameters[1].type.getText(helper),'RateReadProfile');
const oldAuditSources = JSON.parse(readFileSync('docs/cleanup-next-tango-seam-audit-20261012/SOURCE-PRESERVATION.json','utf8')).files;
const protectedFiles = oldAuditSources.filter((f)=>!roles.some((role)=>role.file===f.path));
for(const item of protectedFiles) {
  const frozen = execFileSync('git',['show',`${base}:${item.path}`]);
  assert(readFileSync(item.path).equals(frozen),item.path);
}
const result = { base, tree:'6c11b1094aadcbf6645e759204f72b6f87c8982a', roles, helperFile,
  helperExports:['asCount','nextPageOf','rateOf','RateReadProfile'], privateHelper:'asRateInteger', explicitProfileRequired:true,
  protectedExistingConsumerTestConfigPlanPaths:protectedFiles.length, originalFixtureHashesVerified:true,
  wholeClientBodyExceptProfileOperandsByteExact:true, providersNativeDatabaseExecuted:false };
writeFileSync(new URL('source-preservation.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({ roles:roles.length, rateCalls:roles.reduce((n,r)=>n+r.rateOfCalls,0), protectedPaths:protectedFiles.length, wholeClientBodyByteExact:true }));
