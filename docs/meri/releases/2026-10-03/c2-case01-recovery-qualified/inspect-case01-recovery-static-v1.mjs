import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildCase01Scope } from './case01-native-bootstrap-v2/run-case01-native.mjs';
import { inspectCase01Scope } from '../../meri-c1-20261002/evals/meri/live-v1/case01-live-capture.mjs';
import { inspectCase01PresubmissionRecoveryEvidence } from '../../meri-c1-20261002/evals/meri/live-v1/case01-presubmission-recovery-authority.mjs';
const root = 'C:/dev/main/outputs/meri-c2-20261003';
const prior = root + '/case01-native-bd35c0f4-1604-4371-b7e9-a1338369e53f';
const read = p => JSON.parse(readFileSync(p,'utf8'));
const hash = b => createHash('sha256').update(b).digest('hex');
const {config,setupProof,qualificationExpiresAt} = buildCase01Scope(read(root+'/case01-native-actual-scope-v2.json'));
config.conversationId = 'f493355c-ee97-44a1-a0b0-e05e7b104b59';
assert.deepEqual(config,read(prior+'/actual-capture-scope.json'));
const scope = inspectCase01Scope(config,{MERI_LIVE_BEARER_TOKEN:'static-no-authority'});
const proof = inspectCase01PresubmissionRecoveryEvidence({
  execution:read(prior+'/execution.json'),
  history:readFileSync(prior+'/execution-events.jsonl','utf8').trim().split('\n').map(JSON.parse),
  scope:config,checkpoint:read(prior+'/aggregate-reserved-checkpoint.json'),
  claim:read('C:/dev/cap-meri-foundation-evidence/controlled-read-claims/01-bd35c0f4-1604-4371-b7e9-a1338369e53f.json'),
  diagnostic:read(root+'/case01-browser-readiness-diagnostic-v1.json'),
});
assert.equal(proof.captureAuthority,false);
const authoritySource=readFileSync('C:/dev/main/meri-c1-20261002/evals/meri/live-v1/case01-presubmission-recovery-authority.mjs','utf8');
const fixedRefs=[...authoritySource.matchAll(/\[(['"])(C:\/[^'"]+)\1\]: '([a-f0-9]{64})'/gu)];
for(const item of fixedRefs) assert.equal(hash(readFileSync(item[2])),item[3]);
const result={status:'STATIC_SCOPE_AND_STOPPED_HISTORY_PASS',at:new Date().toISOString(),expected:scope.expected,setupProof,qualificationExpiresAt,
  captureAuthority:false,recoveryClaimAbsent:!existsSync(root+'/case01-presubmission-recovery-claim-bd35c0f4-1604-4371-b7e9-a1338369e53f.json'),
  journalSha256:hash(readFileSync('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl')),cloudCalls:0,authCalls:0,providerCalls:0};
writeFileSync(root+'/case01-recovery-static-inspection-v1.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result));
