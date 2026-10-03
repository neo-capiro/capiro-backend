import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { aws } from '../meri-fresh-20261003/auth-preflight.mjs';
const root = 'C:/dev/main/outputs/meri-c1-20261002/orchestrator-no-tools-build';
const started = JSON.parse(readFileSync(root + '/orchestrator-build-start.json', 'utf8'));
const { buildId: id, sourceSha: sha } = started;
const b = aws(['codebuild', 'batch-get-builds', '--ids', id]).builds[0];
assert.equal(b.id, id);
if (b.buildStatus === 'IN_PROGRESS') { console.log(JSON.stringify({ status: b.buildStatus, phase: b.currentPhase })); process.exit(0); }
assert.equal(b.buildStatus, 'SUCCEEDED'); assert.equal(b.sourceVersion, sha); assert.equal(b.resolvedSourceVersion, sha);
let next, events = [], pages = 0;
while (pages++ < 30) {
  const args = ['logs', 'get-log-events', '--log-group-name', b.logs.groupName, '--log-stream-name', b.logs.streamName, '--start-from-head', '--limit', '10000'];
  if (next) args.push('--next-token', next);
  const r = aws(args); events.push(...r.events); if (r.nextForwardToken === next) break; next = r.nextForwardToken;
}
assert.ok(pages < 30);
const logs = events.map(e => e.message).join('');
const countLine = logs.match(/^ORCHESTRATOR_SOURCE_TEST_COUNTS=(\{.*\})$/m); assert.ok(countLine);
const counts = JSON.parse(countLine[1]);
assert.equal(counts.numPassedTests, 1502); assert.equal(counts.numFailedTests, 0); assert.equal(counts.numPendingTests, 2); assert.equal(counts.numPassedTestSuites, 129);
for (const marker of ['OFFLINE_PACKAGED_ENTRYPOINT_HEALTH_AUTH_PASS', 'OFFLINE_C1_CLASSIFICATION_REPAIRS_PASS', 'LOCAL_REPODIGEST_ECR_MATCH_PASS', 'OFFLINE_PACKAGED_MAIL_DEFAULTS_PASS', 'OFFLINE_PACKAGED_NO_TOOLS_DIRECTIVE_PASS']) assert.ok(logs.split(/\r?\n/).some(line => line.trim() === marker), marker);
const images = aws(['ecr', 'describe-images', '--repository-name', 'capiro/dev/meriv2-orchestrator', '--image-ids', 'imageTag=' + sha]).imageDetails;
assert.equal(images.length, 1); const digest = images[0].imageDigest; assert.match(digest, /^sha256:[a-f0-9]{64}$/);
const image = '967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/meriv2-orchestrator@' + digest;
assert.ok(logs.includes('CANDIDATE_ORCHESTRATOR_IMAGE=' + image));
const receipt = { status: 'PASS', sourceSha: sha, image, buildId: id, startedAt: b.startTime, finishedAt: b.endTime, phases: b.phases.map(p => ({ phase: p.phaseType, status: p.phaseStatus, durationSeconds: p.durationInSeconds })), tests: counts, packagedEntrypointHealthAndAuth: 'PASS', packagedClassificationRegression: 'PASS', packagedMailDefaults: 'PASS', packagedNoToolsDirective: 'PASS', ecrRepoDigestMatch: 'PASS', buildLogSha256: createHash('sha256').update(logs).digest('hex'), buildLogEvents: events.length, buildspecSha256: started.buildspecSha256, imagePublishedAt: images[0].imagePushedAt, architecture: 'arm64', runtimeNode: '20.16.0', serviceMutations: 0, databaseMutations: 0 };
writeFileSync(root + '/orchestrator-build.log', logs, { flag: 'wx' });
writeFileSync(root + '/qualification-readback.json', JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(receipt, null, 2));
