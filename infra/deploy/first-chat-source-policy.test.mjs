import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourcePathAllowed } from './first-chat-source-policy.mjs';

const bundlePath='apps/api/scripts/funding-worker/rds-global-bundle.pem';
const result=spawnSync('git',['show',`HEAD:${bundlePath}`],{cwd:fileURLToPath(new URL('../..',import.meta.url)),maxBuffer:1000000});
assert.equal(result.status,0);
test('allows only the exact public RDS certificate blob at its required runtime path',()=>{
  assert.equal(sourcePathAllowed(bundlePath,()=>result.stdout),true);
  assert.equal(sourcePathAllowed(bundlePath,()=>Buffer.concat([result.stdout,Buffer.from('\n')])),false);
  assert.equal(sourcePathAllowed('apps/api/scripts/other.pem',()=>result.stdout),false);
});
test('ordinary secret paths remain denied without reading their contents',()=>{
  for(const path of ['.env','apps/api/.env.local','.aws','id_rsa','apps/api/service-account.json','private.key','secret.p12'])
    assert.equal(sourcePathAllowed(path,()=>{throw Error('must not read');}),false);
  assert.equal(sourcePathAllowed('apps/api/src/safe.ts',()=>{throw Error('must not read');}),true);
});
