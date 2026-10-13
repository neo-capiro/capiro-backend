import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { restoreReviewedPeManifest } from '../lib/reviewed-pe-manifest-contract.mjs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { contextPlaneValidationScope, contextPlaneValidationMarker } from '../lib/context-plane-validation-scope.mjs';

// Source/fake-process qualification only. No native compiler/Jest/CLI executes.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const current = fs.readFileSync(path.join(ROOT, 'scripts/validate-knowledge-plane-phase26.mjs'), 'utf8');
const ORIGINAL_HEAD = 'c8c109f7d796d5a50ae57ff6cb214d576c757847';
const boundOriginal = execFileSync('git', ['show', ORIGINAL_HEAD + ':scripts/validate-knowledge-plane-phase26.mjs'], {cwd: ROOT, encoding: 'utf8'});
const baselineBytes = fs.readFileSync(path.join(ROOT, 'scripts/knowledge-plane-phase26-typecheck-baseline.json'), 'utf8');
const baseline = JSON.parse(baselineBytes);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const plain = (value) => JSON.parse(JSON.stringify(value));
const typingControl = `if (selectedScope?.scope === 'frontend' || selectedScope?.sourceOnly) {
  console.log('SKIP  backend typing (explicit source policy)');
} else {
`;
const suiteControl = `if (selectedScope?.scope === 'frontend' || selectedScope?.sourceOnly) {
  console.log('SKIP  backend test suites (explicit source policy)');
} else if (skipTests) {`;
const compilerControl = `
  const diagnostics = (text.match(/error TS\\d+/g) ?? []).length;
  const compilerEvidence = !out.error && !out.signal && (
    (out.status === 0 && total === 0 && diagnostics === 0) ||
    ([1, 2].includes(out.status) && total > 0 && diagnostics === total)
  );`;
const processControl = `    const processEvidence = !out.error && !out.signal && (out.status === 0 ||
      (out.status === 1 && failedSuites.length > 0));
`;
function restore(source) {
  return source
    .replace("import { contextPlaneValidationScope, contextPlaneValidationMarker } from './lib/context-plane-validation-scope.mjs';\n", '')
    .replace(`let selectedScope;
try {
  selectedScope = contextPlaneValidationScope(argv);
} catch (error) {
  console.error(\`\${usage}\\n\${error.message}\`);
  process.exit(2);
}
`, '')
    .replace("let base = selectedScope?.base ?? 'origin/main';\nlet skipTests = selectedScope?.skipTests ?? false;", "let base = 'origin/main';\nlet skipTests = false;")
    .replace('!selectedScope && i < argv.length', 'i < argv.length')
    .replaceAll(' [--backend-only | --frontend-only] [--source-only]', '')
    .replace(', ...(selectedScope ? [selectedScope.flag] : [])', '')
    .replace(typingControl, '')
    .replace('}\n\n// ── 4. Context Plane + adoption test surface', '// ── 4. Context Plane + adoption test surface')
    .replace(compilerControl, '')
    .replace('regressions.length === 0 && (!selectedScope || compilerEvidence)', 'regressions.length === 0')
    .replace(suiteControl, 'if (skipTests) {')
    .replace(processControl, '')
    .replace('ranAtAll && unexpected.length === 0 && (!selectedScope || processEvidence)', 'ranAtAll && unexpected.length === 0')
    .replace('  if (selectedScope) console.error(contextPlaneValidationMarker(selectedScope, true));\n', '')
    .replace("if (selectedScope) console.log(contextPlaneValidationMarker(selectedScope));\nelse console.log('Knowledge Plane Phase 26 validation: all checks passed.');", "console.log('Knowledge Plane Phase 26 validation: all checks passed.');");
}
const original = restore(current);
function traceCLI(source, args, response = () => undefined, platform = 'linux', controls = baselineBytes) {
  const calls = []; const reads = []; const output = []; let error;
  const ctx = vm.createContext({ contextPlaneValidationScope, contextPlaneValidationMarker,
    fileURLToPath: () => path.join(ROOT, 'scripts/wrapper.mjs'), dirname: path.dirname, join: path.join, resolve: path.resolve,
    readFileSync: (filename, encoding) => {
      reads.push(filename); assert.equal(encoding, 'utf8');
      assert.equal(filename, path.join(ROOT, 'scripts/knowledge-plane-phase26-typecheck-baseline.json'));
      return controls;
    },
    spawnSync: (command, argv, options) => {
      calls.push(plain([command, argv, options]));
      return response(command, argv, options) ?? {status: 0, stdout: argv[0] === 'jest' ? 'Test Suites: 1 passed\nTests: 1 passed\n' : '', stderr: ''};
    },
    process: {argv: ['node','wrapper',...args],platform, stdout:{write:(value)=>output.push(['write',value])},
      exit: (code) => {const error = new Error(`exit ${code}`);error.exitCode=code;throw error;}},
    console:{log:(...values)=>output.push(['log',...values]),error:(...values)=>output.push(['error',...values])},
  });
  try {vm.runInContext(source.replace(/^#![^\n]*\n/,'').replace(/^import .*;\n/gm,'')
    .replaceAll('import.meta.url',"'fake-module-url'"),ctx);} catch(failure){error={message:failure.message,exitCode:failure.exitCode};}
  const legacyUsage = (value) => typeof value === 'string' ? value.replaceAll(' [--backend-only | --frontend-only] [--source-only]', '') : value;
  return {calls,reads,output:output.map((row)=>row.map(legacyUsage)),error};
}
const trace = (source, args, ...options) => traceCLI(source, ['--run', ...args], ...options);
const resultText = (result) => result.output.flat().join('\n');
const attributedDiagnostics = Object.entries(baseline.errors).flatMap(([key,count]) => {
  const [filename,code]=key.split('|');return Array.from({length:count},()=>`${filename}(1,1): error ${code}: inherited fixture`);
}).join('\n');

test('whole original Phase26 caller and exact16-error/two-suite baseline reconstruct',()=>{
  assert.equal(original, boundOriginal);
  assert.equal(digest(original),'3363dfbe27f2cf7c33a209e4b4bce140751357382479abe3c0411ce8af27fe37');
  assert.equal(digest(baselineBytes),'5a27105dcea7bd48b33d12f222ee959eae2b8cd03b093eb7caaf480da0705fe8');
  assert.equal(Object.values(baseline.errors).reduce((a,b)=>a+b,0),16);
  assert.equal(Object.keys(baseline.knownFailingSuites).length,2);
});
test('full default/typing-fast/legacy unknown/Windows traces and receipts remain exact',()=>{
  for(const platform of ['linux','win32'])for(const args of [[],['--skip-tests'],['--base','pinned'],['--legacy'],['--base']]) {
    assert.deepEqual(trace(current,args,undefined,platform),trace(original,args,undefined,platform));
  }
  assert.equal(trace(original,['--skip-tests']).calls.filter(([,args])=>args[0]==='tsc').length,6);
});
test('new source-only and malformed named modes require explicit valid scope before any effect',()=>{
  for(const args of [['--source-only'],['--SOURCE-ONLY','--backend-only'],[' --source-only ','--frontend-only'],
    ['--source-only=false','--backend-only'],['--backend-only','--source-only','--source-only'],
    ['--backend-only','--frontend-only'],['--backend-only','--base',' padded '],['--backend-only','unknown']]) {
    const result=trace(current,args);assert.ok(result.error);assert.deepEqual(result.calls,[]);assert.deepEqual(result.reads,[]);
  }
  assert.equal(contextPlaneValidationScope(['--legacy']),null);
});
test('backend source and frontend scope run only exact scoped guard/whitespace with no typing baseline read',()=>{
  for(const args of [['--backend-only','--source-only'],['--frontend-only'],['--frontend-only','--source-only']]) {
    const result=trace(current,[...args,'--base','pinned']);assert.equal(result.error,undefined);
    const scope=args[0];assert.deepEqual(result.calls.map(x=>x.slice(0,2)),[
      ['node',['scripts/check-context-plane-new-bypasses.mjs','pinned',scope]],['git',['diff','--check']],
    ]);assert.deepEqual(result.reads,[]);
    assert.match(resultText(result),new RegExp(`KNOWLEDGE_PLANE_PHASE26_${scope==='--backend-only'?'BACKEND':'FRONTEND'}_SOURCE_COMPLETE`));
    assert.doesNotMatch(resultText(result),/validation: all checks passed/);
  }
});
test('backend native and typing retain all original selectors/process options and distinct receipts',()=>{
  for(const platform of ['linux','win32'])for(const fast of [false,true]) {
    const args=['--base','pinned',...(fast?['--skip-tests']:[])];
    const before=trace(original,args,undefined,platform);const after=trace(current,[...args,'--backend-only'],undefined,platform);
    assert.equal(after.error,undefined);assert.deepEqual(after.calls.slice(1),before.calls.slice(1));assert.deepEqual(after.reads,before.reads);
    assert.equal(after.calls.filter(([,args])=>args[0]==='tsc').length,6);
    assert.match(resultText(after),new RegExp(`BACKEND_${fast?'TYPING':'NATIVE'}_COMPLETE`));
    assert.doesNotMatch(resultText(after),/BACKEND_SOURCE_COMPLETE/);
  }
});
test('all16 attributed diagnostics and exacttwo attributed Jest failures remain allowed',()=>{
  const response=(command,args,options)=>{
    if(args[0]==='tsc'&&options.cwd.endsWith('/apps/api'))return {status:2,stdout:attributedDiagnostics,stderr:''};
    if(args[0]==='jest'&&options.cwd.endsWith('/apps/api'))return {status:1,stdout:Object.keys(baseline.knownFailingSuites).map(p=>'FAIL '+p).join('\n')+'\nTest Suites: 2 failed\nTests: 0 total\n',stderr:''};
  };
  for(const args of [[],['--skip-tests']]) {
    assert.deepEqual(trace(current,args,response),trace(original,args,response));
    assert.equal(trace(current,[...args,'--backend-only'],response).error,undefined);
  }
});
test('new scoped typing refuses unmatched/increased diagnostics and failed compiler without attributed evidence',()=>{
  for(const bad of [{status:127,stdout:'compiler unavailable',stderr:''},{status:null,stdout:'',stderr:'crash'},
    {status:1,stdout:'error TS5000: unknown global failure',stderr:''},{status:0,stdout:attributedDiagnostics,stderr:''},
    {status:2,stdout:attributedDiagnostics+'\nsrc/unknown.ts(1,1): error TS2345: new',stderr:''},
    {status:2,stdout:attributedDiagnostics,stderr:'',signal:'SIGTERM'},
    {status:2,stdout:attributedDiagnostics,stderr:'',error:{message:'spawn failed'}}]) {
    const response=(command,args,options)=>args[0]==='tsc'&&options.cwd.endsWith('/apps/api')?bad:undefined;
    const result=trace(current,['--backend-only','--skip-tests'],response);
    assert.equal(result.error.exitCode,1);assert.match(resultText(result),/BACKEND_TYPING_FAILED/);assert.doesNotMatch(resultText(result),/BACKEND_TYPING_COMPLETE/);
  }
});
test('inherited full API compiler false-green remains characterized and scoped mode refuses it',()=>{
  const response=(command,args,options)=>args[0]==='tsc'&&options.cwd.endsWith('/apps/api')?{status:127,stdout:'compiler missing',stderr:''}:undefined;
  assert.deepEqual(trace(current,[],response),trace(original,[],response));assert.equal(trace(original,[],response).error,undefined);
  assert.equal(trace(current,['--backend-only'],response).error.exitCode,1);
});
test('new native mode cannot accept missing/unattributed Jest exit evidence or unknownfailed suite',()=>{
  for(const bad of [{status:3,stdout:'Test Suites: 1 passed\nTests: 1 passed\n',stderr:''},
    {status:1,stdout:'Test Suites: 1 passed\nTests: 1 passed\n',stderr:''},
    {status:0,stdout:'',stderr:''},{status:1,stdout:'FAIL src/new.spec.ts\nTest Suites: 1 failed\n',stderr:''}]) {
    const response=(command,args)=>args[0]==='jest'?bad:undefined;
    const result=trace(current,['--backend-only'],response);assert.equal(result.error.exitCode,1);
    assert.match(resultText(result),/BACKEND_NATIVE_FAILED/);
  }
});
test('guard and whitespace failures cannot produce any scoped completion',()=>{
  for(const args of [['--backend-only','--source-only'],['--frontend-only']])for(const target of ['node','git']) {
    const result=trace(current,args,(command)=>command===target?{status:1,stdout:'',stderr:'failure'}:undefined);
    assert.equal(result.error.exitCode,1);assert.doesNotMatch(resultText(result),/PHASE26_\w+_SOURCE_COMPLETE/);
  }
});
test('current package metadata/aliases survive the four exact scoped run aliases',()=>{
  const currentPackage = JSON.parse(restoreReviewedPeManifest(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'), 'root'));
  const originalPackage = JSON.parse(execFileSync('git', ['show', ORIGINAL_HEAD + ':package.json'], {cwd: ROOT, encoding: 'utf8'}));
  const aliases = Object.fromEntries([
    ['backend', '--backend-only'], ['backend:typing', '--backend-only --skip-tests'],
    ['backend:source', '--backend-only --source-only'], ['frontend', '--frontend-only'],
  ].map(([suffix, flags]) => ['validate:knowledge-plane:phase26:' + suffix,
    'node scripts/validate-knowledge-plane-phase26.mjs --run ' + flags]));
  const verify = (value) => {
    const data = structuredClone(value);
    for (const [name, command] of Object.entries(aliases)) {
      if (Object.hasOwn(data.scripts, name)) {
        assert.equal(data.scripts[name], command);
        delete data.scripts[name];
      }
    }
    assert.deepEqual(data, originalPackage);
  };
  verify(currentPackage);
  verify({...originalPackage, scripts: {...originalPackage.scripts, ...aliases}});
  for (const [name, command] of Object.entries(aliases)) {
    assert.throws(() => verify({...originalPackage, scripts: {...originalPackage.scripts,
      [name]: command.replace(' --run ', ' ')}}));
  }
  const deleted = structuredClone(originalPackage);
  delete deleted.scripts[Object.keys(deleted.scripts)[0]];
  assert.throws(() => verify(deleted));
});

test('strict run/help/noargs/unknown/base grammar fails before any process or baseline read',()=>{
  const validHelp = [['--help'], ['-h']];
  for (const args of validHelp) {
    const result=traceCLI(current,args); assert.equal(result.error.exitCode,0); assert.deepEqual(result.calls,[]); assert.deepEqual(result.reads,[]);
    assert.deepEqual(result,traceCLI(original,args));
  }
  for (const args of [[], ['--backend-only'], ['--run','--run'], ['--run','--backend-only','--run'], ['--help','--run'],
    ['--run','--help'], ['--run','--base'], ['--run','--base','x;echo'], ['--run','--base','ref','--base','ref'],
    ['--run','--backend-only','--base','x;echo'], ['--run','--backend-only','--base','ref','--base','ref'],
    ['--run','--skip-tests','--skip-tests'], ['--run','--unknown'], ['--run','--backend-only','--skip-tests','--skip-tests']]) {
    const result=traceCLI(current,args);assert.equal(result.error.exitCode,2,JSON.stringify(args));assert.deepEqual(result.calls,[]);assert.deepEqual(result.reads,[]);
  }
});
