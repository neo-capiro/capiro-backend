import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { aws } from '../meri-fresh-20261003/auth-preflight.mjs';
import { releaseOperator } from '../../meri-c1-20261002/scripts/meri-release.mjs';
import { fingerprint } from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const [evidenceCommit] = process.argv.slice(2);
assert.match(evidenceCommit ?? '', /^[a-f0-9]{40}$/);
const root = 'C:/dev/main/outputs/meri-c1-20261002';
const repo = 'C:/dev/main/meri-c1-20261002';
const arc = 'docs/meri/releases/2026-10-02/c1-no-tools-repair/';
const b = JSON.parse(readFileSync(root + '/orchestrator-no-tools-build/qualification-readback.json', 'utf8'));
const versioned = JSON.parse(execFileSync('git', ['show', evidenceCommit + ':' + arc + 'qualification.json'], {cwd:repo,encoding:'utf8',windowsHide:true}));
assert.equal(b.status, 'PASS'); assert.equal(b.sourceSha, 'cfd0adf0c54776f81f4b4e57c1a43190766e195e');
assert.equal(b.tests.numPassedTests, 1502); assert.equal(b.packagedNoToolsDirective, 'PASS');
assert.equal(versioned.sourceSha, b.sourceSha); assert.equal(versioned.image, b.image);
assert.equal(versioned.status, 'QUALIFIED_IMAGE_NOT_DEPLOYED');
const prefix = 'https://github.com/neo-capiro/capirov2/blob/' + evidenceCommit + '/' + arc;
const q = {
  schemaVersion:1, service:'meriv2-orchestrator', sourceSha:b.sourceSha, image:b.image, status:'qualified',
  reviewer:'Codex root and independent mail_defaults_review subagent; owner release approval pending',
  reviewedAt:new Date().toISOString(), expiresAt:new Date(Date.now()+23*3600000).toISOString(), schemaChange:false,
  evidence:[prefix+'qualification.json',prefix+'build-readback.json',prefix+'no-tools-v2-independent-review.json'],
  checks:[['build','build-readback.json'],['automated-tests','qualification.json'],['retirement-compatibility','qualification.json']].map(([name,file])=>({name,status:'passed',sourceSha:b.sourceSha,image:b.image,url:prefix+file})),
};
writeFileSync(root+'/orchestrator-no-tools-qualification.json',JSON.stringify(q,null,2)+'\n',{flag:'wx'});
const operator = releaseOperator({aws});
const prior = JSON.parse(readFileSync(root+'/mail-defaults-final-service-readback.json','utf8'));
const siblings = [];
for (const service of ['api','web-vnext']) {
  const inspection = await operator.snapshot(service);
  const previous = prior.identities.find(i=>i.service===service);
  assert.deepEqual(inspection.baseline,previous.baseline,service+' baseline drift');
  const container = inspection.task.containerDefinitions.find(c=>c.name===service);
  const sourceSha = container.environment?.find(e=>e.name==='RELEASE_SHA')?.value
    ?? container.environment?.find(e=>e.name==='GIT_SHA')?.value;
  assert.equal(sourceSha,previous.sourceSha,service+' source drift');
  siblings.push({service,baseline:inspection.baseline,image:container.image,sourceSha,
    rollout:inspection.service.deployments.map(d=>({id:d.id,status:d.status,rolloutState:d.rolloutState,runningCount:d.runningCount,pendingCount:d.pendingCount,failedTasks:d.failedTasks}))});
}
const m = await operator.prepare(q);
const expected = prior.identities.find(i=>i.service==='meriv2-orchestrator').baseline;
assert.deepEqual(m.baseline,expected,'orchestrator baseline drift');
assert.ok(m.baseline.taskDefinitionArn.endsWith(':109'));
assert.equal(m.baseline.imageDigest,'sha256:27418fb841c03bc1637949c45d9deda1d4de8fd5be423d05beaf83e5d1025be6');
writeFileSync(root+'/orchestrator-no-tools-manifest.json',JSON.stringify(m,null,2)+'\n',{flag:'wx'});
writeFileSync(root+'/no-tools-sibling-readback.json',JSON.stringify({observedAt:new Date().toISOString(),status:'UNCHANGED_HEALTHY',services:siblings,awsWrites:0},null,2)+'\n',{flag:'wx'});
const result = {
  action:'PREPARED_NOT_DEPLOYED', manifestHash:fingerprint(m), sourceSha:q.sourceSha, image:q.image,
  preparedAt:m.preparedAt, expiresAt:new Date(Date.parse(m.preparedAt)+3600000).toISOString(), baseline:m.baseline,
  evidenceCommit, ownerApproval:'PENDING_NEW_ARTIFACT', previousApprovedMailboxRelease:'COMPLETED',
};
writeFileSync(root+'/no-tools-release-preparation.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result,null,2));
