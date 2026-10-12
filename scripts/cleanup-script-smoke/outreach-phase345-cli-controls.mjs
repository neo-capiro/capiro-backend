#!/usr/bin/env node
/** Outreach V3 release verifiers refuse accidental runs before subprocess work. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveContract, MISSING_DATABASE_URL_SMOKE_CONTEXT } from './contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
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

for (const phase of [3, 4, 5]) {
  const rel = `scripts/verify-outreach-v3-phase${phase}-code.mjs`;
  const script = path.join(ROOT, rel);
  const contract = deriveContract(readFileSync(script, 'utf8'), rel, MISSING_DATABASE_URL_SMOKE_CONTEXT);
  assert.equal(contract.noArgs.documented, true, contract.evidence);
  assert.equal(contract.noArgs.exit, 2, contract.evidence);
  assert.equal(contract.help.exit, 0, contract.evidence);
  for (const [args, expected] of [
    [[], 2],
    [['--help'], 0],
    [['--unknown'], 2],
    [['--run', '--unknown'], 2],
  ]) {
    const result = spawnSync(process.execPath, ['--import', trapUrl, script, ...args], {
      cwd: ROOT, env, encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    const label = `${rel} ${args.join(' ') || '(noargs)'}`;
    assert.equal(result.error, undefined, `${label}: spawn error`);
    assert.equal(result.signal, null, `${label}: signalled`);
    assert.equal(result.status, expected, `${label}: exit ${result.status}: ${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /Usage:/, `${label}: missing usage`);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /RESOURCE_ATTEMPT|\n\s+at /,
      `${label}: attempted a resource or emitted an uncaught stack`);
  }
  const configured = spawnSync(process.execPath, ['--import', trapUrl, script, '--run'], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 5000, windowsHide: true,
  });
  assert.match(configured.stderr, /RESOURCE_ATTEMPT:child:/,
    `${rel}: --run must reach its unchanged validation subprocess path`);
}
console.log('Outreach Phase 3/4/5 CLI controls PASS: refused modes stop before resources');
