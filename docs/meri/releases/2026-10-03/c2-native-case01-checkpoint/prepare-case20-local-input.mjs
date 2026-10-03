import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { controlledReadSetupInput } from '../../meri-c1-20261002/evals/meri/live-v1/controlled-read-operator-input.mjs';
import { createControlledReadDefinition } from '../../meri-c1-20261002/evals/meri/live-v1/fixture-provisioning/controlled-read-definitions.mjs';
import { cases } from '../../meri-c1-20261002/evals/meri/live-v1/cases.mjs';
const parent = 'C:/dev/main/outputs/meri-c2-20261003';
const root = parent + '/case20-local-preparation-v1';
const repo = 'C:/dev/main/meri-c1-20261002';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestPath = parent + '/case01-recovered-auth-scope.private.json';
const manifestBytes = readFileSync(manifestPath);
assert.equal(hash(manifestBytes), 'ed9c3b1c11014825b29ee2879796e20b3f0023959ed9e478337180b96ed7a062');
const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.fixtureAuthority, false);
assert.equal(manifest.captureAuthority, false);
const sourceFiles = ['evals/meri/live-v1/controlled-read-operator-input.mjs', 'evals/meri/live-v1/fixture-provisioning/controlled-read-definitions.mjs', 'evals/meri/live-v1/cases.mjs'];
const sourceHashes = sourceFiles.map(path => {
  const local = readFileSync(repo + '/' + path);
  const deployed = execFileSync('git', ['show', '5b086a6b47ffce5aa1b93bfe38f9c7b96e297642:' + path], { cwd: repo, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(local.toString('utf8').replaceAll('\r\n', '\n'), deployed.toString('utf8').replaceAll('\r\n', '\n'));
  return { path, localSha256: hash(local), sourceSha: '5b086a6b47ffce5aa1b93bfe38f9c7b96e297642' };
});
const row = cases.find(value => value.id === '20');
assert.equal(row.actor, 'PAT'); assert.equal(row.client, 'ASTER');
const packet = { caseId: '20', clientId: '41f9ec63-3963-479f-b747-59a3767ef44b', captureRunId: randomUUID(), manifestPath };
const input = controlledReadSetupInput(manifest, packet);
const definition = createControlledReadDefinition({ ...input, tenantId: input.ctx.tenantId });
mkdirSync(root);
const save = (name, value) => {
  const fd = openSync(root + '/' + name, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
};
save('setup-plan-packet.json', packet);
save('setup-plan-input.json', input);
save('local-inspection.json', {
  status: 'LOCAL_INPUT_ONLY_NOT_RUNNABLE', at: new Date().toISOString(), caseId: '20', captureRunId: packet.captureRunId,
  manifestSha256: hash(manifestBytes), sourceHashes, originalPrompt: row.prompt,
  setupInputSha256: hash(readFileSync(root + '/setup-plan-input.json')),
  localDefinitionSha256: hash(JSON.stringify(definition)),
  fixtureAuthority: false, captureAuthority: false, paidReservation: false,
  remoteCalls: 0, providerCalls: 0, journalCalls: 0, fixtureWrites: 0,
  nextRequirements: ['Finish and settle Case01 without ambiguity before replacing its tenant binding.',
    'Verify remaining budget against the actual final checkpoint; no new budget is inferred.',
    'Use a reviewed clean operator checkout matching current source guards.',
    'Review a bounded dispatcher for existing setup/budget owners and obtain actual plan/execute/install receipts.',
    'Recheck actual source/fixture/budget/authentication and grade captured evidence; original human rubric remains.'],
});
console.log(JSON.stringify({ status: 'LOCAL_INPUT_ONLY_NOT_RUNNABLE', caseId: '20', captureRunId: packet.captureRunId, remoteCalls: 0, journalCalls: 0 }));
