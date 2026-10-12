import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ts = createRequire('/workspace/capirov2/apps/api/package.json')('typescript');
const source = process.argv[2]; assert.match(source, /^[a-f0-9]{40}$/);
const base = '1bf52945b9fa01496ce41a349f8eaace490ad4ac';
const facadePath = 'apps/api/scripts/parse-defense-approps-public-law.ts';
const helperPath = 'apps/api/scripts/lib/pe-public-law-facade-containment.ts';
const verifierPath = 'apps/api/scripts/verify-pe-phase-e-exact-sha.ts';
const contractPath = 'apps/api/scripts/lib/pe-exact-sha-loader-contract.ts';
const hash = str => createHash('sha256').update(str).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const blobs = new Map();
const blob = (ref, rel) => { const key = `${ref}:${rel}`; if (!blobs.has(key)) blobs.set(key, git('show', key)); return blobs.get(key); };
const parse = (rel, text) => ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const emit = (rel, text) => ts.transpileModule(text, { fileName: rel, compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText;
const facade = blob(source, facadePath); assert.equal(facade, blob(base, facadePath));
const helper = blob(source, helperPath);
const module = { exports: {} };
runInNewContext(emit(helperPath, helper), { module, exports: module.exports, require: name => {
  assert.equal(name, 'typescript'); return ts;
} }, { timeout: 1000 });
const failures = module.exports.publicLawFacadeContainmentFailures;
assert.equal(typeof failures, 'function');
const modify = (needle, replacement) => {
  assert.ok(facade.includes(needle)); const mutant = facade.replace(needle, replacement);
  assert.notEqual(mutant, facade); return mutant;
};
const grammarCases = [
  ['exact immutable owner', facade, true],
  ['comment and CRLF trivia', ('// inert comment\n'+facade).replaceAll('\n','\r\n'), true],
  ['equivalent quoted values', facade.replaceAll("'", '"'), true],
  ['equivalent escaped identifier', modify('canonicalWrites: false','canonical\\u0057rites: false'), true],
  ...['+','-','~','++','--'].map(op => [`non-child prefix operator ${op}`, modify('if (!Array.isArray(candidatesRaw))',`if (${op}Array.isArray(candidatesRaw))`), false]),
  ['non-child deferred fs import', modify("import * as fs from 'node:fs';", "import defer * as fs from 'node:fs';"), false],
  ['non-child deferred schema import', modify('import {\n  defenseBudget','import defer {\n  defenseBudget'), false],
  ...['readonly','public','async','abstract','static'].map(modifier => [`object modifier ${modifier}`, modify('canonicalWrites: false',`${modifier} canonicalWrites: false`), false]),
  ['optional report member', modify('canonicalWrites: false','canonicalWrites?: false'), false],
  ['asserted report member', modify('canonicalWrites: false','canonicalWrites!: false'), false],
  ['missing commit refusal', modify("if (process.argv.includes('--commit'))", 'if (false)'), false],
  ['approval-conditioned refusal', modify("if (process.argv.includes('--commit'))", "if (!process.env.APPROVED && process.argv.includes('--commit'))"), false],
  ['side-effect proof import', "import './write-to-ledger.js';\n"+facade, false],
  ['filesystem import rebinding', modify("import * as fs from 'node:fs';", "import * as fs from 'node:fs/promises';"), false],
  ['schema import changed module', modify('enactment-proof-v1.js','not-a-schema.js'), false],
  ['type-only filesystem import', modify('import * as fs','import type * as fs'), false],
  ['import schema local alias', modify('defenseBudgetEnactmentProofV1Schema,','defenseBudgetEnactmentProofV1Schema as bypass,'), false],
  ['type-only proof binding', modify('  defenseBudgetEnactmentProofV1Schema,','  type defenseBudgetEnactmentProofV1Schema,'), false],
  ['filesystem rebind', modify('function main(): void {','function main(): void { fs.readFileSync = (()=>"{}") as never;'), false],
  ['schema rebind', modify('function main(): void {','function main(): void { enactedLineCandidateV1Schema.parse = ((x: unknown)=>x) as never;'), false],
  ['schema shadow', modify('function main(): void {','function main(): void { const defenseBudgetEnactmentProofV1Schema = {parse:(x:unknown)=>x};'), false],
  ['read before commit refusal', modify('function main(): void {',"function main(): void { fs.readFileSync('before.json','utf8');"), false],
  ['commit refusal operation becomes optional', modify("process.argv.includes('--commit')","process.argv.includes?.('--commit')"), false],
  ['proof validation result bypass', modify('defenseBudgetEnactmentProofV1Schema.parse(', 'JSON.parse('), false],
  ['proof safeParse result ignored', modify('defenseBudgetEnactmentProofV1Schema.parse(', 'defenseBudgetEnactmentProofV1Schema.safeParse('), false],
  ['candidate validation bypass', modify('enactedLineCandidateV1Schema.parse(candidate)','candidate'), false],
  ['candidate parsing optional chain', modify('enactedLineCandidateV1Schema.parse(candidate)','enactedLineCandidateV1Schema.parse?.(candidate)'), false],
  ['mutable proof binding', modify('const proof =', 'let proof ='), false],
  ['using disposal binding', modify('const proof =','using proof ='), false],
  ['await-using disposal binding', modify('const proof =','await using proof ='), false],
  ['candidates array condition inversion', modify('if (!Array.isArray(candidatesRaw))','if (Array.isArray(candidatesRaw))'), false],
  ['truthful read-only mode altered', modify("mode: 'INSPECT_ONLY'", "mode: 'COMMIT'"), false],
  ['write success reported', modify('canonicalWrites: false','canonicalWrites: true'), false],
  ['fake certification reported', modify('candidateCount: candidates.length,','candidateCount: candidates.length, certified: true,'), false],
  ['wrong candidate count', modify('candidateCount: candidates.length','candidateCount: 0'), false],
  ['proof identity reported from raw argv', modify('proofId: proof.proofId','proofId: process.argv[2]'), false],
  ['provider call after output', modify('process.exitCode = 1;', 'process.exitCode = 1; fetch("https://invalid.example");'), false],
  ['successful caught-error exit', modify('process.exitCode = 1','process.exitCode = 0'), false],
  ['main not called', modify('  main();','  void main;'), false],
  ['main called twice', modify('  main();','  main(); main();'), false],
  ['extra executable function', facade+'\nfunction unsafe() { fetch("https://invalid.example"); }', false],
  ['dynamic provider import', modify('function main(): void {','function main(): void { void import("@prisma/client");'), false],
  ['global binding replacement', facade+'\nArray.isArray = () => false;', false],
  ['marker-only replacement', '// INSPECT_ONLY canonicalWrites false disabled --commit\n', false],
  ['malformed escape template', modify('`--${name}`','`\\8--${name}`'), false],
  ['malformed TypeScript', facade+'\nfunction invalid({', false],
];
const grammarRows = grammarCases.map(([name, text, expected]) => ({ name, expectedAccepted: expected,
  accepted: failures(text).length === 0, failures: Array.from(failures(text)), sourceSha256: hash(text) }));

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const normalizeVerifier = ref => {
  const sf = parse(verifierPath, blob(ref, verifierPath));
  const tree = ts.transform(sf, [context => {
    const visit = node => {
      if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === './lib/pe-public-law-facade-containment.js') return undefined;
      if (ts.isIfStatement(node) && node.expression.getText(sf) === "fileName === 'parse-defense-approps-public-law.ts'") return undefined;
      return ts.visitEachChild(node, visit, context);
    }; return node => ts.visitNode(node, visit);
  }]);
  const printed = printer.printFile(tree.transformed[0]); tree.dispose(); return printed;
};
assert.equal(normalizeVerifier(source), normalizeVerifier(base), 'unrelated verifier predicates/statements changed');
assert.equal(blob(source, contractPath), blob(base, contractPath), 'exact ordered inventory changed');
const contractSf = parse(contractPath, blob(source, contractPath));
const inventoryDecl = contractSf.statements.filter(ts.isVariableStatement).flatMap(n=>Array.from(n.declarationList.declarations))
  .find(n=>n.name.getText(contractSf)==='PE_EXACT_SHA_DOLLAR_LOADERS');
const inventory = Array.from(inventoryDecl.initializer.expression.elements).map(n=>n.text);
assert.equal(inventory.length,13);
const preserved = [facadePath, contractPath, ...inventory.filter(name=>name!==path.basename(facadePath)).map(name=>`apps/api/scripts/${name}`),
  'apps/api/src/defense-budget/stages/enacted/enactment-proof-v1.ts',
  'apps/api/src/defense-budget/contracts/canonical-json.ts',
  'apps/api/src/defense-budget/contracts/extraction-artifact-v1.ts',
].map(rel=>{assert.equal(blob(source,rel),blob(base,rel));return{path:rel,sha256:hash(blob(source,rel))};});

function facadeProbe(argv, files, env = {}) {
  const reads=[],parses=[],output=[],errors=[],effects=[];
  const fakeProcess={argv:['node','inert-facade.ts',...argv],env,exitCode:undefined};
  const fakeFs=Object.freeze({readFileSync:(rel,encoding)=>{assert.equal(encoding,'utf8');reads.push(rel);if(!Object.hasOwn(files,rel))throw new Error('inert missing file');return files[rel];}});
  const schemas=Object.freeze({defenseBudgetEnactmentProofV1Schema:Object.freeze({parse:value=>{parses.push('proof');if(value?.valid!==true)throw new Error('inert proof refusal');return value;}}),
    enactedLineCandidateV1Schema:Object.freeze({parse:value=>{parses.push('candidate');if(value?.valid!==true)throw new Error('inert candidate refusal');return value;}})});
  runInNewContext(emit(facadePath,facade),{exports:{},process:fakeProcess,Error,
    require:name=>{if(name==='node:fs')return fakeFs;if(name==='../src/defense-budget/stages/enacted/enactment-proof-v1.js')return schemas;effects.push(name);throw new Error('forbidden dependency');},
    console:{log:text=>output.push(text),error:text=>errors.push(text)},
    fetch:()=>{effects.push('PROVIDER');throw new Error('forbidden provider');},
  },{timeout:1000});
  return{argv,exitCode:fakeProcess.exitCode??0,reads,parses,output,errors,effects};
}
const proof={valid:true,proofId:'synthetic-proof',publicLawNumber:'synthetic-law',proofType:'statutory_line_item'};
const good={'proof.json':JSON.stringify(proof),'candidates.json':JSON.stringify([{valid:true},{valid:true}])};
const args=['--proof','proof.json','--candidates','candidates.json'];
const facadeRows=[];
for(const argv of [['--commit'],[...args,'--commit'],[...args,'--approved-sha256','a'.repeat(64),'--commit'],['--commit',...args,'--extract-only']]){
  const row=facadeProbe(argv,good,{PE_LEGACY_BUDGET_WRITES:'allow',PE_SNAPSHOT_READ_MODE:'legacy'});
  assert.equal(row.exitCode,1);assert.deepEqual(row.reads,[]);assert.deepEqual(row.parses,[]);assert.deepEqual(row.output,[]);assert.deepEqual(row.effects,[]);
  assert.ok(row.errors.join('').includes('canonical enacted commit is disabled'));facadeRows.push(row);
}
for(const argv of [[],['--proof','proof.json'],['--candidates','candidates.json']]){
  const row=facadeProbe(argv,good);assert.equal(row.exitCode,1);assert.deepEqual(row.reads,[]);assert.deepEqual(row.output,[]);assert.deepEqual(row.effects,[]);facadeRows.push(row);
}
const inspect=facadeProbe(args,good);assert.equal(inspect.exitCode,0);assert.deepEqual(inspect.reads,['proof.json','candidates.json']);assert.deepEqual(inspect.parses,['proof','candidate','candidate']);assert.deepEqual(inspect.effects,[]);
assert.deepEqual(JSON.parse(inspect.output[0]),{mode:'INSPECT_ONLY',canonicalWrites:false,proofId:proof.proofId,publicLawNumber:proof.publicLawNumber,proofType:proof.proofType,candidateCount:2,next:'verify the Phase 6 enacted proof chain; no canonical promotion is available here'});facadeRows.push(inspect);
for(const [name,files,expectedReads,expectedParses]of[
  ['malformed proof JSON',{...good,'proof.json':'{'},['proof.json'],[]],
  ['invalid proof schema',{...good,'proof.json':'{"valid":false}'},['proof.json'],['proof']],
  ['non-array candidates',{...good,'candidates.json':'{}'},['proof.json','candidates.json'],['proof']],
  ['second candidate invalid',{...good,'candidates.json':'[{"valid":true},{"valid":false}]'},['proof.json','candidates.json'],['proof','candidate','candidate']],
]){
  const row=facadeProbe(args,files);assert.equal(row.exitCode,1);assert.deepEqual(row.reads,expectedReads);assert.deepEqual(row.parses,expectedParses);assert.deepEqual(row.output,[]);assert.deepEqual(row.effects,[]);facadeRows.push({name,...row});
}

class Exit extends Error{constructor(code){super('inert exit');this.code=code;}}
function verifierProbe(argv,replacements={}){
  const reads=[],output=[],errors=[],effects=[];const fakeProcess={argv:['node',verifierPath,...argv],cwd:()=>root,exit:code=>{throw new Exit(code);}};
  const fakeFs={existsSync:()=>true,readFileSync:(full,encoding)=>{assert.equal(encoding,'utf8');const rel=path.relative(root,full).replaceAll('\\','/');assert.ok(inventory.some(name=>rel===`apps/api/scripts/${name}`));reads.push(rel);return Object.hasOwn(replacements,rel)?replacements[rel]:blob(source,rel);}};
  let exitCode=0,uncaught=null;
  try{runInNewContext(emit(verifierPath,blob(source,verifierPath)),{exports:{},process:fakeProcess,Error,
    require:name=>{if(name==='node:fs')return fakeFs;if(name==='node:path')return path;if(name==='./lib/pe-exact-sha-loader-contract.js')return{PE_EXACT_SHA_DOLLAR_LOADERS:inventory};if(name==='./lib/pe-public-law-facade-containment.js')return module.exports;effects.push(name);throw new Error('forbidden verifier dependency');},
    console:{log:text=>output.push(text),error:text=>errors.push(text)},fetch:()=>{effects.push('PROVIDER');throw new Error('forbidden provider');}}, {timeout:1000});}
  catch(error){if(error instanceof Exit)exitCode=error.code;else{exitCode=1;uncaught=error.message;}}
  return{argv,exitCode,uncaught,reads,output,errors,effects};
}
const verifierRows=[];
for(const argv of [['--help'],['--unknown'],['--help','--unknown']]){
  const row=verifierProbe(argv);assert.equal(row.exitCode,argv.length===1&&argv[0]==='--help'?0:2);assert.deepEqual(row.reads,[]);assert.deepEqual(row.effects,[]);assert.equal(row.uncaught,null);verifierRows.push(row);
}
const baselineVerifier=verifierProbe([]);assert.equal(baselineVerifier.exitCode,0);assert.equal(baselineVerifier.uncaught,null);assert.equal(baselineVerifier.reads.length,13);assert.deepEqual(baselineVerifier.effects,[]);
assert.deepEqual(JSON.parse(baselineVerifier.output[0]),{ok:true,loadersChecked:13,loaders:inventory});verifierRows.push(baselineVerifier);
for(const mutant of grammarRows.filter(row=>row.expectedAccepted===false)){
  const text=grammarCases.find(row=>row[0]===mutant.name)[1];const row=verifierProbe([],{[facadePath]:text});
  verifierRows.push({name:mutant.name,...row,expectedExit:1});
}
const changed=git('diff','--name-only',base,source,'--','apps','scripts','packages','.github').trim().split('\n').filter(Boolean);
const failuresByName=grammarRows.filter(row=>row.accepted!==row.expectedAccepted).map(row=>row.name);
const badIntegration=verifierRows.filter(row=>row.expectedExit!==undefined&&row.exitCode!==row.expectedExit).map(row=>row.name);
console.log(JSON.stringify({source,tree:git('rev-parse',`${source}^{tree}`).trim(),base,typescriptVersion:ts.version,sourceOnly:true,
  grammarCases:grammarRows.length,grammarRows,facadeInertCases:facadeRows.length,facadeRows,verifierInertCases:verifierRows.length,verifierRows,
  facadeInventoryOtherLoaderPredicatesAndOwnersPreserved:true,preserved,sourceDelta:changed,
  grammarBlockers:failuresByName,verifierIntegrationBlockers:badIntegration,
  smokeMetadata:blob(source,verifierPath).match(/@cleanup-smoke[^\n]*/)?.[0],
  limits:'Only source parsing and fake/inert VM execution; no real artifact, provider, DB, schema, migration, Prisma/native/subject child, full Core or deployment.'},null,2));
assert.deepEqual(failuresByName,[],'closed grammar accepted executable divergence');
assert.deepEqual(badIntegration,[],'13-loader verifier accepted a mutated facade');
