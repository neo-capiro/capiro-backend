#!/usr/bin/env node
/** The Phase 26 release gate must refuse bare/unsupported modes before child work. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveContract, MISSING_DATABASE_URL_SMOKE_CONTEXT } from './contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REL = 'scripts/validate-knowledge-plane-phase26.mjs';
const SCRIPT = path.join(ROOT, REL);
const trap = [
  "import cp from 'node:child_process';",
  "import fs from 'node:fs';",
  "import net from 'node:net';",
  "import { syncBuiltinESMExports } from 'node:module';",
  "const deny=(name)=>()=>{process.stderr.write('RESOURCE_ATTEMPT:'+name+'\\n');throw new Error(name)};",
  "for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync']) cp[name]=deny('child:'+name);",
  "for(const name of ['writeFileSync','appendFileSync','mkdirSync','rmSync','renameSync']) fs[name]=deny('write:'+name);",
  "net.Socket.prototype.connect=deny('network');",
  "globalThis.fetch=deny('fetch');",
  'syncBuiltinESMExports();',
].join('\n');
const trapUrl = `data:text/javascript,${encodeURIComponent(trap)}`;
const env = { ...process.env };
delete env.NODE_OPTIONS;
delete env.DATABASE_URL;

for (const [args, expected] of [
  [[], 2],
  [['--help'], 0],
  [['-h'], 0],
  [['--unknown'], 2],
  [['--run', '--unknown'], 2],
  [['--run', '--base'], 2],
  [['--run', '--base', '-unsafe'], 2],
  [['--run', '--skip-tests', '--skip-tests'], 2],
]) {
  const result = spawnSync(process.execPath, ['--import', trapUrl, SCRIPT, ...args], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 5000, windowsHide: true,
  });
  assert.equal(result.error, undefined, `${args.join(' ')} spawn error`);
  assert.equal(result.signal, null, `${args.join(' ')} signalled`);
  assert.equal(result.status, expected, `${args.join(' ')} exit: ${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, /Usage:/, `${args.join(' ')} usage`);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /RESOURCE_ATTEMPT|\n\s+at /,
    `${args.join(' ')} attempted work or emitted uncaught stack`);
}

const contract = deriveContract(readFileSync(SCRIPT, 'utf8'), REL, MISSING_DATABASE_URL_SMOKE_CONTEXT);
assert.equal(contract.noArgs.documented, true, contract.evidence);
assert.equal(contract.noArgs.exit, 2, contract.evidence);
assert.equal(contract.help.exit, 0, contract.evidence);
console.log('Phase 26 CLI controls PASS: refused/help modes make no resource attempts');
