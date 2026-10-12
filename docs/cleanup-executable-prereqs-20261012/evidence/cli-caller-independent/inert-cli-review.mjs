import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { setImmediate as turn } from 'node:timers/promises';
import util from 'node:util';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const requireTool = createRequire('/workspace/capirov2/apps/api/package.json');
const ts = requireTool('typescript');
class Exit extends Error { constructor(code) { super(`inert exit ${code}`); this.code = code; this.__inertExit = true; } }
class Boundary extends Error { constructor(kind) { super(`inert boundary ${kind}`); this.kind = kind; } }
const subjects = [
  ['apps/api/scripts/bootstrap-roles.ts', ['--run']],
  ['apps/api/scripts/prepopulate-all.ts', ['--run']],
  ['apps/api/scripts/import-stanford-dow-directory.ts', ['--import']],
  ['apps/api/scripts/import-dow-directory-v6.ts', ['--import']],
  ['apps/api/scripts/verify-defense-budget-packages.ts', ['--verify']],
  ['apps/api-strategy/src/seed.ts', ['--run']],
  ['scripts/verify-engagement-phase3-code.mjs', ['--run']],
  ['scripts/verify-outreach-v3-phase4-code.mjs', ['--run']],
  ['scripts/verify-outreach-v3-phase5-code.mjs', ['--run']],
  ['scripts/verify-outreach-v3-phase6-code.mjs', ['--run']],
];
async function probe(relative, argv, configured = false) {
  const full = resolve(root, relative); const events = []; const output = []; const errors = [];
  const process = { argv: ['node', full, ...argv], env: configured ? { DATABASE_URL: 'inert-configured' } : {},
    platform: 'linux', cwd: () => root, exitCode: 0,
    stdout: { write: value => output.push(String(value)) }, stderr: { write: value => output.push(String(value)) },
    exit: code => { process.exitCode = code; throw new Exit(code); } };
  const stop = kind => (..._args) => { events.push(kind); throw new Boundary(kind); };
  const foreign = label => new Proxy(function () {}, {
    get(_t, key) { if (key === '__esModule') return true; if (key === 'then') return undefined; return foreign(`${label}.${String(key)}`); },
    apply: stop(`DEPENDENCY:${label}`), construct: stop(`DEPENDENCY:${label}`),
  });
  const fs = Object.fromEntries(['openSync','readFileSync','writeFileSync','appendFileSync','mkdirSync','mkdtempSync','renameSync','rmSync','cpSync','closeSync',
    'readFile','writeFile','mkdtemp','mkdir','open','rename','rm','rmdir'].map(key=>[key,stop(`FILE:${key}`)]));
  fs.existsSync = () => true;
  const modules = {
    'node:path': path, 'path': path, 'node:url': { pathToFileURL, fileURLToPath },
    'node:fs': fs, 'fs': fs, 'node:fs/promises': fs,
    'node:util': { ...util, parseArgs: opts => util.parseArgs({ ...opts, args: opts.args ?? process.argv.slice(2) }) },
    'node:child_process': Object.fromEntries(['execFile','execFileSync','execSync','spawn','spawnSync'].map(key=>[key,stop(`CHILD:${key}`)])),
    '@prisma/client': { PrismaClient: class { constructor() { stop('DATABASE:construct')(); } }, Prisma: foreign('Prisma') },
    dotenv: { config: () => { events.push('ENV_LOADER_NOOP'); return {}; } },
    '@capiro/shared': { FUNDING_SCOPES: [], FUNDING_STAGES: [], BUDGET_VEHICLE_CLASSES: [] },
    pg: { Client: class { constructor() { stop('DATABASE:pg')(); } } },
    '@nestjs/core': { NestFactory: { createApplicationContext: stop('BOOTSTRAP:Nest') } },
    '@nestjs/common': { Logger: class {} },
  };
  const module = { exports: {} };
  function require(name) { return modules[name] ?? foreign(name); }
  require.main = module;
  const source = readFileSync(full, 'utf8');
  const replaceMeta = context => { const visit = node => {
    if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression) && node.name.text === 'url')
      return ts.factory.createStringLiteral(pathToFileURL(full).href);
    return ts.visitEachChild(node, visit, context);
  }; return node => ts.visitNode(node, visit); };
  let code = ts.transpileModule(source, { fileName: `${full}.ts`, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    transformers: { before: [replaceMeta] } }).outputText;
  // Simulated process termination must bypass userland error handlers, as real exit does.
  code = code.replace(/\.catch\((\([A-Za-z_$][\w$]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g,
    (match,binding)=>`${match}if (${binding.replace(/[()]/g,'')}?.__inertExit) return;`);
  code = code.replace(/^#![^\n]*(?:\n|$)/,'');
  const console = Object.fromEntries(['log','warn','error'].map(key=>[key,(...args)=>output.push(args.join(' '))]));
  try {
    await runInNewContext(`(async () => {\n${code}\n})()`, { exports: module.exports, module, require, process, console,
      __dirname: dirname(full), __filename: full, URL, Date, Set, Map, Promise, Buffer, Error,
      fetch: stop('PROVIDER:fetch'), setTimeout: stop('TIMER'), setInterval: stop('TIMER'), clearInterval() {},
    }, { timeout: 1000 });
  } catch(error) { if (error instanceof Exit) process.exitCode = error.code; else errors.push(error.message); }
  await turn();
  return { relative, argv, configured, exitCode: process.exitCode, events, output, errors };
}
const checks=[];
for (const [file,operation] of subjects) {
  for (const args of [[],['--help'],['--unknown']]) {
    const r=await probe(file,args,true); const expected=args[0]==='--help'?0:2;
    assert.equal(r.exitCode,expected,JSON.stringify(r));
    assert.ok(r.output.some(s=>/usage:/i.test(s)),JSON.stringify(r));
    assert.deepEqual(r.events,[],JSON.stringify(r));
    checks.push({...r,expectation:'refusal/help before dependency, file, DB, provider, bootstrap, child effects'});
  }
}
for (const file of ['apps/api/scripts/diag-ingestion-health.ts','apps/api/scripts/diag-auditor-shadow.ts','apps/api/scripts/diag-blueprint-qa.ts']) {
  for (const [args,configured,expected] of [[[],false,2],[['--help'],true,0],[['--run'],true,2],[['--unknown'],true,2]]) {
    const r=await probe(file,args,configured); assert.equal(r.exitCode,expected,JSON.stringify(r));
    assert.deepEqual(r.events,[],JSON.stringify(r)); checks.push({...r,expectation:'configured no-args remains legitimate; added --run would be refused'});
  }
  const r=await probe(file,[],true); assert.ok(r.events.includes('DATABASE:construct'),JSON.stringify(r));
  checks.push({...r,expectation:'configured legacy no-args reaches only inert DB construction boundary'});
}
for (const args of [[],['--help'],['--unknown'],['--action','inspect','--service','api']]) {
  const r=await probe('scripts/meri-release.mjs',args); assert.deepEqual(r.events,[],JSON.stringify(r));
  if (!args.length) assert.equal(r.exitCode,2,JSON.stringify(r)); else if(args[0]==='--help')assert.equal(r.exitCode,0,JSON.stringify(r));
  else assert.ok(r.exitCode!==0||r.errors.length>0,JSON.stringify(r));
  checks.push({...r,expectation:'canonical positional-action parser preserved; invalid advertised legacy --action form rejected'});
}
console.log(JSON.stringify({ sourceOnly:true, checks:checks.length, subjects:subjects.length+4,
  realDependencyImport:false, databaseProviderBootstrapOrChildExecuted:false, rows:checks },null,2));
