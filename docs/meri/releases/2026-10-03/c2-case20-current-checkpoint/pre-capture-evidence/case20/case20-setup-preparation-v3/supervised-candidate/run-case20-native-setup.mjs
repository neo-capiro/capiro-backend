#!/usr/bin/env node
// Case20 bounded setup-only one-shot dispatcher. This program is intentionally
// never run by its authoring session. Artifact, approval, budget-checkpoint and
// live identity gates all precede root creation, intent, or any AWS call.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const read = readFile;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUTPUTS = 'C:/dev/main/outputs';
const PARENT = `${OUTPUTS}/meri-c2-20261003`;
const REPO = 'C:/dev/main/meri-c1-20261002';
const RUN = 'f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b';
const SOURCE = '4f0253874357c272fda1ae2a5271ee4af645f0bc';
const INPUT = `${PARENT}/case20-local-preparation-v1/setup-plan-input.json`;
const INPUT_SHA256 = 'a72c2d69bebb9694edb38bc4131a60a093e6488f8cd3528fafd92db7f84a082d';
const AGGREGATE = `${PARENT}/case01-terminal-cost-executed-v1/aggregate-checkpoint.json`;
const TEMPLATE = `${PARENT}/corpus-read-definition-input.json`;
const CLUSTER = 'capiro-dev';
const REGION = 'us-east-1';
const ACCOUNT = '967807252336';
const APPROVAL_SCOPE = 'EXACT_C2_CAPTURE_CONTRACT_RELEASE';
const PREFIX = 'C2_CASE20_NATIVE_SETUP_RECEIPT ';
const PLAN_ROOT = `${PARENT}/case20-native-setup-plan-v1`;
const EXECUTE_ROOT = `${PARENT}/case20-native-setup-execute-v1`;
const PRIOR_PLAN_ROOT = PLAN_ROOT;
const FIXTURE_NAMESPACE = 'meri-foundation-20260928';
const API_SERVICE = 'api';
const SERVICES = ['api', 'meriv2-orchestrator'];
const shaField = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (code) => { throw new Error(code); };
const json = (bytes, label) => {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { fail(`${label}_JSON_INVALID`); }
};
const canonicalFingerprint = (value) => createHash('sha256')
  .update(JSON.stringify(sortObject(value))).digest('hex');
function sortObject(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortObject);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
}
const readJson = async (file, label) => json(await read(file), label);
const safeHash = (fileBytes) => hash(fileBytes);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join('|') === [...keys].sort().join('|');

// Supervisor must freeze the current saved aggregate checkpoint file bytes.
// Null is a deliberate fail-closed review slot, not a runtime caller override.
const REVIEWED = Object.freeze({ aggregateCheckpointSha256: 'dfa616afc2622d01d3380bd373cbce3886157fbbb9123297d2a834c189fd734d' });
const SOURCE_FILES = Object.freeze([
  ['evals/meri/live-v1/controlled-read-operator-input.mjs', 'ce6244bb6ffc52e0c1661779290995aad53ab287023f0706480509414ee5ef2a'],
  ['evals/meri/live-v1/fixture-provisioning/controlled-read-definitions.mjs', '56a6f30e198e78db778c1ac2b02a00a4f6eae17646d56bc94f8ece66d63adf05'],
  ['evals/meri/live-v1/cases.mjs', '5464412ee66b73f677cc923bda09b4785a866b20ef0ee6a3410936c431c5ba0a'],
]);
const RUNTIME_SOURCE_FILES = Object.freeze([
  'apps/api/scripts/meri-controlled-read-setup.mjs',
  'apps/api/scripts/lib/pe-compose-database-url.js',
  'evals/meri/live-v1/fixture-provisioning/controlled-read-owner.mjs',
  'evals/meri/live-v1/fixture-provisioning/controlled-read-definitions.mjs',
  'evals/meri/live-v1/controlled-read-operator-input.mjs',
  'scripts/meri-release.mjs',
  'scripts/lib/meri-release-policy.mjs',
]);

function withExplicitEcsDefaults(input) {
  const output = structuredClone(input);
  assert.ok(Array.isArray(output.containerDefinitions));
  for (const key of ['volumes', 'placementConstraints']) if (!Object.hasOwn(output, key)) output[key] = [];
  for (const container of output.containerDefinitions) {
    if (!Object.hasOwn(container, 'cpu')) container.cpu = 0;
    for (const key of ['portMappings', 'mountPoints', 'volumesFrom', 'systemControls'])
      if (!Object.hasOwn(container, key)) container[key] = [];
  }
  return output;
}
function normalizeTaskEnvironment(input) {
  const output = structuredClone(input);
  assert.ok(Array.isArray(output.containerDefinitions));
  for (const container of output.containerDefinitions) {
    assert.ok(Array.isArray(container.environment));
    const names = new Set();
    for (const entry of container.environment) {
      assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry));
      assert.equal(typeof entry.name, 'string');
      assert.ok(entry.name.length > 0);
      assert.equal(typeof entry.value, 'string');
      assert.ok(!names.has(entry.name), 'Duplicate environment name');
      names.add(entry.name);
    }
    container.environment.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }
  return output;
}

function validateCheckpoint(checkpoint, bytes) {
  assert.ok(shaField(REVIEWED.aggregateCheckpointSha256), 'REVIEWED_AGGREGATE_CHECKPOINT_HASH_REQUIRED');
  assert.equal(hash(bytes), REVIEWED.aggregateCheckpointSha256, 'Saved checkpoint bytes changed');
  assert.equal(checkpoint.kind, 'meri-fresh-capture-spend-checkpoint');
  const state = checkpoint.state;
  assert.ok(state && typeof state === 'object');
  assert.equal(state.files?.['fresh-spend.jsonl']?.sha256,
    'a8c8101a4d806ef8080e1648c9e46568a55b7b5f93cb0f053a3d601404bfe3b5');
  const snapshot = checkpoint.snapshot;
  assert.equal(snapshot?.eventCount, 22);
  assert.equal(snapshot?.activeRun, null);
  assert.equal(snapshot?.knownSettledCostMicros, 12133883);
  assert.equal(snapshot?.committedCostMicros, 12133883);
  assert.equal(snapshot?.remainingReservationMicros, 17866117);
  assert.equal(snapshot?.perCaseMaxCostMicros, 15000000);
  assert.equal(snapshot.knownSettledCostMicros + snapshot.remainingReservationMicros, 30000000);
  const original = snapshot.runs?.['01:bd35c0f4-1604-4371-b7e9-a1338369e53f'];
  assert.equal(original?.captureStatus, 'CAPTURE_UNCERTAIN');
  assert.equal(original?.captureAuthority, false);
  return { aggregateCheckpointSha256: hash(bytes), journalSha256: state.files['fresh-spend.jsonl'].sha256 };
}

function validatePacket(packet, approval, receipts, receiptBytes) {
  assert.ok(packet && typeof packet === 'object' && !Array.isArray(packet));
  assert.equal(packet.status, 'AWAITING_HUMAN_REVIEW');
  assert.match(packet.evidenceCommit ?? '', /^[a-f0-9]{40}$/u);
  assert.ok(shaField(packet.qualificationSha256));
  assert.ok(Array.isArray(packet.services));
  const names = packet.services.map(s => s.service);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every(name => [...SERVICES, 'web-vnext'].includes(name)));
  for (const service of SERVICES) assert.equal(names.filter(name => name === service).length, 1);
  const web = packet.services.find(s => s.service === 'web-vnext');
  if (web) assert.equal(web.change, 'NONE');
  const packetHash = canonicalFingerprint(packet);
  assert.equal(approval.status, 'APPROVED');
  assert.equal(approval.scope, APPROVAL_SCOPE);
  assert.equal(approval.packetSha256, packetHash);
  assert.equal(approval.paidCaptureAuthority, false);
  assert.ok(Number.isFinite(Date.parse(approval.approvedAt)) && Date.parse(approval.approvedAt) <= Date.now());
  assert.ok(Array.isArray(approval.scopeDetails));
  const expected = packet.services.filter(s => SERVICES.includes(s.service)).map(s => ({
    service: s.service, sourceSha: s.candidate?.sourceSha, image: s.candidate?.image,
  })).sort((a,b) => a.service.localeCompare(b.service));
  assert.deepEqual(approval.scopeDetails.map(s => ({service:s.service,sourceSha:s.sourceSha,image:s.image}))
    .sort((a,b) => a.service.localeCompare(b.service)), expected);
  const services = {};
  for (const service of SERVICES) {
    const row = packet.services.find(s => s.service === service);
    assert.equal(row.candidate.sourceSha, SOURCE);
    const prefix = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/capiro/dev/${service}@`;
    assert.equal(typeof row.candidate.image, 'string');
    assert.ok(row.candidate.image.startsWith(prefix));
    assert.match(row.candidate.image.slice(prefix.length), /^sha256:[a-f0-9]{64}$/u);
    assert.ok(shaField(row.candidateTaskSha256) && shaField(row.baseline?.configHash));
    const receipt = receipts[service];
    assert.equal(receipt.status, 'ecs-healthy-manual-acceptance-required');
    assert.equal(receipt.service, service);
    assert.equal(receipt.candidateImage, row.candidate.image);
    assert.equal(receipt.candidateTaskHash, row.candidateTaskSha256);
    assert.equal(receipt.configHash, row.baseline.configHash);
    // The promotion owner hashes its own technical manifest, not this review packet.
    assert.ok(shaField(receipt.manifestHash));
    assert.match(receipt.candidateTaskDefinition ?? '',
      new RegExp(`^arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/capiro-dev-${service}:[1-9][0-9]*$`, 'u'));
    services[service] = {service,sourceSha:SOURCE,image:row.candidate.image,
      candidateTaskSha256:row.candidateTaskSha256,configHash:row.baseline.configHash,
      receipt:structuredClone(receipt),receiptSha256:hash(receiptBytes[service])};
  }
  return {packetSha256:packetHash,services};
}

function verifyReceiptBytes(records, binding) {
  assert.ok(Array.isArray(records));
  const phases = new Set(['BEGIN','CHUNK','END','FAILURE']);
  assert.ok(records.every(row => row && typeof row === 'object' && phases.has(row.phase)), 'Unknown receipt phase');
  const failures = records.filter(row => row.phase === 'FAILURE');
  const frames = records.filter(row => row.phase !== 'FAILURE');
  assert.ok(frames.filter(row => row.phase === 'BEGIN').length <= 1);
  assert.ok(frames.filter(row => row.phase === 'END').length <= 1);
  if (!frames.some(row => row.phase === 'END')) return {complete:false,failures,successful:false};
  assert.equal(frames[0]?.phase,'BEGIN'); assert.equal(frames.at(-1)?.phase,'END');
  const {phase:_begin,...meta}=frames[0], {phase:_end,...end}=frames.at(-1);
  assert.deepEqual(meta,end);
  assert.ok(exactKeys(meta,['version','kind','mode','sourceSha','inputSha256','scriptSha256','captureRunId',
    'outputPath','byteLength','base64Length','chunks','sha256','childExitCode','childSignal','ownerOutput']));
  assert.equal(meta.version,1); assert.equal(meta.kind,'case20-native-setup-json');
  assert.equal(meta.mode,binding.mode); assert.equal(meta.sourceSha,SOURCE); assert.equal(meta.inputSha256,INPUT_SHA256);
  assert.equal(meta.scriptSha256,binding.innerScriptSha256); assert.equal(meta.captureRunId,RUN);
  assert.equal(meta.outputPath,binding.outputPath); assert.ok(shaField(meta.sha256));
  assert.ok(Number.isSafeInteger(meta.byteLength) && meta.byteLength>0 && meta.byteLength<=1024*1024);
  assert.equal(meta.base64Length,4*Math.ceil(meta.byteLength/3)); assert.equal(meta.chunks,Math.ceil(meta.base64Length/8192));
  assert.equal(frames.length,meta.chunks+2);
  const chunks=frames.slice(1,-1);
  for (const [i,part] of chunks.entries()) {
    assert.ok(exactKeys(part,['phase','sha256','index','data'])); assert.equal(part.phase,'CHUNK');
    assert.equal(part.sha256,meta.sha256); assert.equal(part.index,i+1); assert.equal(typeof part.data,'string');
    assert.equal(part.data.length,Math.min(8192,meta.base64Length-i*8192));
  }
  const encoded=chunks.map(part=>part.data).join(''), bytes=Buffer.from(encoded,'base64');
  assert.equal(bytes.toString('base64'),encoded); assert.equal(bytes.length,meta.byteLength); assert.equal(hash(bytes),meta.sha256);
  let owner=null, ownerParseValid=false;
  try { const text=bytes.toString('utf8'); assert.ok(Buffer.from(text,'utf8').equals(bytes));
    owner=JSON.parse(text); ownerParseValid=!!owner && typeof owner==='object' && !Array.isArray(owner); } catch {}
  const ownerSuccess=ownerParseValid && meta.ownerOutput==='OWNER_SUCCESS' && meta.childExitCode===0 && meta.childSignal===null &&
    (binding.mode==='plan' ? owner.kind==='meri-controlled-read-setup-plan' && owner.version===1 : owner.status==='CONTROLLED_READ_BOUND') &&
    owner.liveAcceptance==='NOT_RUN';
  const ownerFailure=ownerParseValid && owner.status==='RECONCILIATION_REQUIRED';
  return {complete:true,meta,bytes,owner,ownerParseValid,ownerFailure,failures,successful:ownerSuccess && failures.length===0};
}

function fsyncWrite(file, bytes, exclusive = true) {
  const fd = openSync(file, exclusive ? 'wx' : 'w');
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function save(root, name, value) {
  fsyncWrite(`${root}/${name}`, Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8'));
}
function saveBytes(root, name, bytes) { fsyncWrite(`${root}/${name}`, bytes); }
function errorShape(error) {
  return { errorClass: error?.name ?? 'Error', code: /^[A-Z0-9_]{1,100}$/u.test(error?.code ?? '') ? error.code : null };
}

async function recheckAccountingFiles(checkpoint) {
  assert.equal(path.resolve(checkpoint.state.root), path.resolve(`${OUTPUTS}/meri-fresh-20261003`), 'Accounting root changed');
  assert.ok(exactKeys(checkpoint.state.files, ['run-authorization.json', 'fresh-spend.jsonl']));
  const observed = {};
  for (const name of ['run-authorization.json', 'fresh-spend.jsonl']) {
    const expected = checkpoint.state.files[name];
    assert.ok(shaField(expected.sha256) && Number.isSafeInteger(expected.bytes) && expected.bytes > 0);
    const bytes = await read(path.join(checkpoint.state.root, name));
    assert.equal(bytes.length, expected.bytes, `Current accounting size changed: ${name}`);
    assert.equal(hash(bytes), expected.sha256, `Current accounting bytes changed: ${name}`);
    observed[name] = { sha256: hash(bytes), bytes: bytes.length };
  }
  return { checkedAt: new Date().toISOString(), files: observed, readOnly: true };
}

async function localGates() {
  const inputBytes = await read(INPUT);
  assert.equal(hash(inputBytes), INPUT_SHA256);
  const input = json(inputBytes, 'INPUT');
  assert.equal(input.target, CLUSTER);
  assert.equal(input.fixtureNamespace, FIXTURE_NAMESPACE);
  assert.equal(input.caseId, '20');
  assert.equal(input.captureRunId, RUN);
  assert.equal(input.ctx?.role, 'standard_user');
  const checkpointBytes = await read(AGGREGATE);
  const checkpoint = json(checkpointBytes, 'CHECKPOINT');
  const checkpointProof = validateCheckpoint(checkpoint, checkpointBytes);
  const currentAccounting = await recheckAccountingFiles(checkpoint);
  for (const [relative, expected] of SOURCE_FILES) {
    const bytes = await read(path.join(REPO, relative));
    assert.equal(hash(bytes), expected, `Frozen source binding changed: ${relative}`);
  }
  const runtimeSources = {};
  for (const relative of RUNTIME_SOURCE_FILES) {
    const bytes = await read(path.join(REPO, relative));
    const committed = execFileSync('git', ['-C', REPO, 'show', `${SOURCE}:${relative}`], {
      encoding: 'buffer', windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(hash(bytes), hash(committed), `Runtime helper differs from fixed source ${SOURCE}: ${relative}`);
    runtimeSources[relative] = hash(bytes);
  }
  const innerBytes = await read(path.join(ROOT, 'case20-native-setup-inner.mjs'));
  const outerBytes = await read(path.join(ROOT, 'run-case20-native-setup.mjs'));
  return { input, inputBytes, inputSha256: hash(inputBytes), checkpointProof, checkpoint, currentAccounting,
    checkpointBytesSha256: hash(checkpointBytes), runtimeSources, innerScriptSha256: hash(innerBytes),
    outerScriptSha256: hash(outerBytes) };
}

async function gateRelease() {
  // Fixed owner artifact names only. Do not discover alternate files or treat
  // old clock/provider approval bytes as authority.
  const packetPath = `${PARENT}/capture-contract-release-packet.json`;
  const approvalPath = `${PARENT}/capture-contract-human-approval.json`;
  const apiReceiptPath = `${PARENT}/api-capture-contract-promotion-receipt.json`;
  const orchestratorReceiptPath = `${PARENT}/meriv2-orchestrator-capture-contract-promotion-receipt.json`;
  const [packetBytes, approvalBytes, apiReceiptBytes, orchestratorReceiptBytes] = await Promise.all([
    read(packetPath), read(approvalPath), read(apiReceiptPath), read(orchestratorReceiptPath),
  ]);
  const packet = json(packetBytes, 'RELEASE_PACKET');
  const approval = json(approvalBytes, 'HUMAN_APPROVAL');
  const receiptBytes = { api: apiReceiptBytes, 'meriv2-orchestrator': orchestratorReceiptBytes };
  const receipts = {
    api: json(apiReceiptBytes, 'API_PROMOTION_RECEIPT'),
    'meriv2-orchestrator': json(orchestratorReceiptBytes, 'ORCHESTRATOR_PROMOTION_RECEIPT'),
  };
  const release = validatePacket(packet, approval, receipts, receiptBytes, canonicalFingerprint(packet));
  const qualificationLinks=(packet.evidence??[]).filter(link => typeof link==='string' &&
    link.startsWith(`https://github.com/neo-capiro/capirov2/blob/${packet.evidenceCommit}/`) &&
    link.endsWith('/release-qualification.json'));
  assert.equal(qualificationLinks.length,1,'Exactly one versioned qualification is required');
  const relative=qualificationLinks[0].split(`/blob/${packet.evidenceCommit}/`)[1];
  assert.match(relative,/^docs\/meri\/releases\/[a-zA-Z0-9_./-]+\/release-qualification\.json$/u);
  assert.ok(!relative.split('/').includes('..'));
  const qualificationBytes=execFileSync('git',['show',`${packet.evidenceCommit}:${relative}`],{cwd:REPO,windowsHide:true,maxBuffer:1024*1024});
  const qualification=json(qualificationBytes,'VERSIONED_QUALIFICATION');
  assert.equal(canonicalFingerprint(qualification),packet.qualificationSha256);
  for(const service of SERVICES) {
    assert.deepEqual(qualification.candidates?.[service],{sourceSha:SOURCE,image:release.services[service].image});
    const build=qualification.builds?.[service];
    assert.match(build?.buildId??'',/^capiro-build-web-dev:[a-f0-9-]{36}$/u);
    assert.ok(shaField(build.buildspecSha256) && shaField(build.buildLogSha256));
    assert.equal(build.architecture,'arm64');
    assert.ok(Array.isArray(build.markers) && build.markers.includes('LOCAL_REPODIGEST_ECR_MATCH_PASS'));
  }
  release.qualificationSha256=canonicalFingerprint(qualification);
  release.qualificationBytesSha256=hash(qualificationBytes);
  release.evidenceCommit=packet.evidenceCommit;

  return { packet, release, approvalSha256: hash(approvalBytes), packetBytesSha256: hash(packetBytes),
    packetPath, approvalPath, receiptPaths: { api: apiReceiptPath, 'meriv2-orchestrator': orchestratorReceiptPath } };
}

function validateLiveCandidate(service, snapshot, releaseService) {
  const receipt = releaseService.receipt;
  assert.equal(snapshot.service?.serviceName, `capiro-dev-${service}`);
  assert.equal(snapshot.service?.taskDefinition, receipt.candidateTaskDefinition);
  assert.equal(snapshot.baseline?.taskDefinitionArn, receipt.candidateTaskDefinition);
  assert.equal(snapshot.baseline?.taskHash, receipt.candidateTaskHash);
  assert.equal(snapshot.baseline?.configHash, receipt.configHash);
  assert.equal(snapshot.baseline?.imageDigest, releaseService.image.split('@')[1]);
  const named = snapshot.task.containerDefinitions.filter((c) => c.name === service);
  assert.equal(named.length, 1);
  assert.equal(named[0].image, releaseService.image);
  const releaseValues = (named[0].environment ?? []).filter((e) => e.name === 'RELEASE_SHA');
  assert.equal(releaseValues.length, 1);
  assert.equal(releaseValues[0].value, SOURCE);
}

function buildTaskDefinition(liveApi, local, release) {
  const containers=liveApi.task.containerDefinitions.filter(c=>c.name==='api'); assert.equal(containers.length,1);
  const api=containers[0]; assert.equal(api.environmentFiles?.length??0,0);
  assert.match(liveApi.task.executionRoleArn??'',new RegExp(`^arn:aws:iam::${ACCOUNT}:role/[^\\s]+$`,'u'));
  assert.equal(api.logConfiguration?.logDriver,'awslogs');
  assert.equal(api.logConfiguration.secretOptions?.length??0,0);
  assert.equal(api.logConfiguration.options?.['awslogs-region'],REGION);
  for(const key of ['awslogs-group','awslogs-stream-prefix']) assert.ok(typeof api.logConfiguration.options[key]==='string' && api.logConfiguration.options[key]);
  const env=api.environment??[];
  const db=env.filter(e=>e.name==='DB_NAME'); assert.equal(db.length,1); assert.equal(db[0].value,'capiro');
  const names=['DB_HOST','DB_PASSWORD','DB_PORT','DB_USER'];
  const secrets=(api.secrets??[]).filter(secret=>names.includes(secret.name));
  assert.deepEqual(secrets.map(secret=>secret.name).sort(),names);
  for(const secret of secrets) assert.match(secret.valueFrom??'',new RegExp(`^arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:`,'u'));
  assert.equal(liveApi.task.runtimePlatform?.cpuArchitecture,'ARM64');
  assert.equal(liveApi.task.runtimePlatform?.operatingSystemFamily,'LINUX');
  const input={family:'capiro-dev-meri-c2-case20-setup-20261003',executionRoleArn:liveApi.task.executionRoleArn,
    networkMode:'awsvpc',requiresCompatibilities:['FARGATE'],cpu:'512',memory:'1024',
    runtimePlatform:structuredClone(liveApi.task.runtimePlatform),containerDefinitions:[{
      name:'case20-native-setup',image:release.services.api.image,essential:true,
      environment:Object.entries({DB_NAME:'capiro',PGSSLMODE:'require',AWS_REGION_DEFAULT:REGION,
        MERI_SYNTHETIC_FIXTURE_NAMESPACE:FIXTURE_NAMESPACE,RELEASE_SHA:SOURCE,GIT_SHA:SOURCE}).map(([name,value])=>({name,value})),
      secrets:secrets.map(({name,valueFrom})=>({name,valueFrom})),logConfiguration:structuredClone(api.logConfiguration),
      entryPoint:['/usr/bin/dumb-init','--','node','--input-type=module','-e'],command:[],
    }]};
  assert.equal(Object.hasOwn(input,'taskRoleArn'),false);
  return normalizeTaskEnvironment(withExplicitEcsDefaults(input));
}

function exactTaskArn(value, definitionArn, request, expectedArn = null) {
  assert.match(value?.taskArn ?? '', new RegExp(`^arn:aws:ecs:${REGION}:${ACCOUNT}:task/${CLUSTER}/[a-f0-9]{32}$`, 'u'));
  if (expectedArn) assert.equal(value.taskArn, expectedArn);
  assert.equal(value?.taskDefinitionArn, definitionArn);
  assert.equal(value?.clusterArn, `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/${CLUSTER}`);
  assert.equal(value?.startedBy, request.startedBy);
}

// Run and cleanup implementation is deliberately structurally ported from the
// mature Case01 dispatcher, without importing its Case01 gate/proof/install work.
async function runNativeTask({ aws, awsSingleAttempt, operator, mode, root, local, release,
  packetGate, liveApi, definitionInput, wrapper, innerBytes, inputBytes, ownerInput, priorPlan, validateOwnerReceipt, policyTaskInput }) {
  const logsContainer = definitionInput.containerDefinitions[0];
  const planResult = priorPlan?.result ?? null;
  const planReceiptBytes = priorPlan?.receiptBytes ?? null;
  const outputPath = `/dev/shm/case20-native-setup-${mode}-owner.json`;
  const planOutputPath = '/dev/shm/case20-native-setup-plan-owner.json';
  const startBy = `meri-c2-c20-${mode}-${randomUUID().slice(0, 8)}`;
  const clientToken = randomUUID();
  const request = {
    cluster: CLUSTER, taskDefinition: null, launchType: 'FARGATE', count: 1,
    networkConfiguration: liveApi.service.networkConfiguration,
    platformVersion: liveApi.service.platformVersion,
    startedBy: startBy, clientToken,
  };
  let taskDefinitionArn = null;
  let taskArn = null;
  let task = null;
  let taskRequest = null;
  let runDispatched = false;
  let stopAttempted = false;
  let deregisterAttempted = false;
  let cleanupStopped = false;
  let cleanupInactive = false;
  let evidencePersistenceFailed = false;
  let receiptFrame = null;
  let events = [];
  let failures = [];
  let successfulReceipt = false;
  let fatal = false;
  let taskReadNo = 0;
  let pageNo = 0;
  let observationNo = 0;
  const observations = [];
  const rawEvents = [];
  const logRecords = [];
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const recordFailure = (phase, error, isFatal = true) => {
    fatal ||= isFatal;
    const observation = { at: new Date().toISOString(), phase, fatal: isFatal, ...errorShape(error), automaticRetryAllowed: false };
    observations.push(observation);
    try { save(root, `observation-${String(++observationNo).padStart(3, '0')}.json`, observation); }
    catch { evidencePersistenceFailed = true; }
  };
  const taskRead = () => {
    const raw = aws(['ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', taskArn]);
    save(root, `task-read-${String(++taskReadNo).padStart(3, '0')}.json`, raw);
    assert.equal(raw.failures?.length ?? 0, 0);
    assert.equal(raw.tasks?.length, 1);
    exactTaskArn(raw.tasks[0], taskDefinitionArn, request, taskArn);
    task = raw.tasks[0];
    return task;
  };
  const pollStopped = async (milliseconds, phase) => {
    const until = Date.now() + milliseconds;
    do {
      try { if (taskRead().lastStatus === 'STOPPED') return true; }
      catch (error) { recordFailure(phase, error, error?.name === 'AssertionError'); }
      if (Date.now() < until) await delay(5000);
    } while (Date.now() < until);
    return task?.lastStatus === 'STOPPED';
  };

  const assemble = (allEvents) => {
    const lines = allEvents.flatMap((event) => {
      assert.equal(typeof event.message, 'string');
      return event.message.split('\n');
    }).filter((line) => line.startsWith(PREFIX));
    const records = lines.map((line) => json(Buffer.from(line.slice(PREFIX.length), 'utf8'), 'FRAME'));
    logRecords.splice(0, logRecords.length, ...records);
    return verifyReceiptBytes(records, { mode, innerScriptSha256: local.innerScriptSha256, outputPath });
  };
  const collectLogs = async () => {
    const stream = `${logsContainer.logConfiguration.options['awslogs-stream-prefix']}/${logsContainer.name}/${taskArn.split('/').at(-1)}`;
    const started = Date.now();
    const deadline = started + 180000;
    let token;
    let totalBytes = 0;
    for (let attempt = 1; Date.now() < deadline && attempt <= 60; attempt++) {
      const name = String(++pageNo).padStart(3, '0');
      try {
        const args = ['logs', 'get-log-events', '--log-group-name', logsContainer.logConfiguration.options['awslogs-group'],
          '--log-stream-name', stream, '--start-from-head', '--limit', '10000'];
        if (token) args.push('--next-token', token);
        const page = aws(args);
        // Save every unmodified AWS page before parsing or assertions.
        save(root, `logs-page-${name}.json`, { at: new Date().toISOString(), inputToken: token ?? null, page });
        assert.ok(Array.isArray(page.events));
        assert.equal(typeof page.nextForwardToken, 'string');
        totalBytes += Buffer.byteLength(JSON.stringify(page));
        assert.ok(totalBytes <= 32 * 1024 * 1024);
        rawEvents.push(...page.events);
        const unchanged = page.nextForwardToken === token;
        token = page.nextForwardToken;
        try {
          const assembled = assemble(rawEvents);
          if (assembled.complete) {
            saveBytes(root, 'inner-owner-receipt.json', assembled.bytes);
            save(root, 'inner-owner-transport.json', { ...assembled.meta, pagesRead: attempt,
              collectionStartedAt: new Date(started).toISOString(), taskStopped: task?.lastStatus === 'STOPPED' });
            save(root, 'raw-log-events.json', { events: rawEvents });
            return assembled;
          }
        } catch (error) { recordFailure('LOG_RECEIPT_INVALID', error, true); }
        if (unchanged || page.events.length === 0) await delay(5000);
      } catch (error) {
        if (error?.code === 'EEXIST') evidencePersistenceFailed = true;
        recordFailure('LOG_READ_OR_PERSISTENCE', error, error?.name === 'AssertionError' || error?.code === 'EEXIST');
        if (evidencePersistenceFailed || totalBytes > 32 * 1024 * 1024) break;
        await delay(5000);
      }
    }
    save(root, 'raw-log-events.json', { events: rawEvents });
    save(root, 'log-collection-exhausted.json', { at: new Date().toISOString(), attempts: pageNo,
      totalBytes, terminalReceipt: false, taskStopped: task?.lastStatus === 'STOPPED' });
    return null;
  };

  // Wrapper stages the exact script/input/plan-owner bytes; no host-generated
  // multi-field plan envelope. The inner receipt remains the exact owner JSON.
  const wrapperSource = makeWrapper({ mode, innerBytes, inputBytes, ownerInput, priorPlan, local,
    outputPath, planOutputPath });
  const wrapperSha256 = hash(Buffer.from(wrapperSource));
  definitionInput.containerDefinitions[0].entryPoint=['/usr/bin/dumb-init','--','node','--input-type=module','-e'];
  definitionInput.containerDefinitions[0].command=[wrapperSource];
  const normalizedTaskInput = normalizeTaskEnvironment(definitionInput);
  const intent = {
    at: new Date().toISOString(), mode, sourceSha: SOURCE,
    candidateImage: release.services.api.image,
    packetSha256: release.packetSha256,
    approvalSha256: packetGate.approvalSha256,
    scriptHashes: { outer: local.outerScriptSha256, inner: local.innerScriptSha256,
      wrapper: wrapperSha256, sources: local.runtimeSources },
    inputSha256: local.inputSha256,
    checkpointSha256: local.checkpointBytesSha256,
    taskInputSha256: canonicalFingerprint(normalizedTaskInput),
    taskDefinitionRequestSha256: hash(Buffer.from(JSON.stringify(normalizedTaskInput))),
    setupOnly: true, liveAcceptance: 'NOT_RUN', budgets: 'NOT_INSTALLED',
    providerCalls: 0, sharedSourceCorpusWrites: 0,
    ownerWrites: mode === 'execute' ? ['controlled-read owner locator/binding/history/receipts only'] : [],
    taskNonce: startBy, runTaskClientToken: clientToken,
    automaticRetryAllowed: false,
  };
  save(root, 'intent.json', intent);
  // Private task definition request has only four approved secret reference names;
  // it contains no raw service task or service environment.
  save(root, 'task-definition-request.private.json', normalizedTaskInput);

  // Mutation A: registration. Unknown response means reconciliation, never retry.
  try {
  save(root, 'accounting-before-register.json', await recheckAccountingFiles(local.checkpoint));
  save(root, 'register-dispatch-intent.json', { at: new Date().toISOString(),
    taskInputSha256: canonicalFingerprint(normalizedTaskInput), automaticRetryAllowed: false });
  let registration;
  try { registration = await awsSingleAttempt(['ecs', 'register-task-definition', '--cli-input-json', `file://${root}/task-definition-request.private.json`]); }
  catch (error) { recordFailure('REGISTER_DISPATCH_OBSERVED_FAILURE', error); throw error; }
  taskDefinitionArn = registration.taskDefinition?.taskDefinitionArn ?? null;
  save(root, 'definition-register-response.json', registration);
  assert.match(taskDefinitionArn ?? '', new RegExp(`^arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/capiro-dev-meri-c2-case20-setup-20261003:[1-9][0-9]*$`, 'u'));
  const registered = await aws(['ecs', 'describe-task-definition', '--task-definition', taskDefinitionArn, '--include', 'TAGS']);
  save(root, 'definition-readback.private.json', registered);
  assert.equal(registered.taskDefinition.status, 'ACTIVE');
  const registeredInput = normalizeTaskEnvironment(policyTaskInput({ ...registered.taskDefinition, tags: registered.tags }));
  assert.deepEqual(registeredInput, normalizedTaskInput, 'Registered task input differs from approved minimal request');
  assert.equal(registeredInput.taskRoleArn ?? null, null);
  save(root, 'definition-readback.json', { taskDefinitionArn,
    taskInputSha256: canonicalFingerprint(registeredInput), sourceSha: SOURCE });

  request.taskDefinition = taskDefinitionArn;
  taskRequest = { ...request };
  save(root, 'run-task-input.private.json', taskRequest);
  save(root, 'accounting-before-run.json', await recheckAccountingFiles(local.checkpoint));
  save(root, 'run-task-dispatch-intent.json', { at: new Date().toISOString(),
    taskDefinitionArn, cluster: CLUSTER, startedBy: startBy, clientToken,
    taskInputSha256: hash(Buffer.from(JSON.stringify(taskRequest))), automaticRetryAllowed: false });
  runDispatched = true;
  let start;
  try { start = await awsSingleAttempt(['ecs', 'run-task', '--cli-input-json', `file://${root}/run-task-input.private.json`]); }
  catch (error) { recordFailure('RUN_TASK_DISPATCH_OBSERVED_FAILURE', error); throw error; }
  if (start.tasks?.length === 1) { taskArn = start.tasks[0].taskArn; task = start.tasks[0]; }
  save(root, 'task-start-response.json', start);
  assert.equal(start.failures?.length ?? 0, 0);
  assert.equal(start.tasks?.length, 1);
  assert.match(taskArn ?? '', new RegExp(`^arn:aws:ecs:${REGION}:${ACCOUNT}:task/${CLUSTER}/[a-f0-9]{32}$`, 'u'));
  exactTaskArn(start.tasks[0], taskDefinitionArn, request);
  save(root, 'task-start.json', { at: new Date().toISOString(), taskArn, taskDefinitionArn,
    startedBy: startBy, clientToken, scriptSha256: local.innerScriptSha256 });
  assert.equal(await pollStopped(8 * 60 * 1000, 'TASK_POLL'), true, 'Task did not stop within bounded deadline');
  } catch (error) { recordFailure('DISPATCH_OR_POLL', error); }

  // If RunTask acknowledgement is uncertain, bounded read-only exact nonce/family
  // discovery is solely for cleanup. It never retries RunTask.
  if (runDispatched && !taskArn && taskDefinitionArn && taskRequest) {
    try {
      for (let attempt = 1; attempt <= 6 && !taskArn; attempt++) {
        const matches = [];
        for (const status of ['RUNNING', 'STOPPED']) {
          const listing = await aws(['ecs', 'list-tasks', '--cluster', CLUSTER, '--family', 'capiro-dev-meri-c2-case20-setup-20261003',
            '--desired-status', status, '--max-results', '100']);
          save(root, `task-reconcile-${attempt}-${status}.json`, listing);
          assert.ok(Array.isArray(listing.taskArns));
          assert.ok(!listing.nextToken);
          if (listing.taskArns.length) {
            const described = await aws(['ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', ...listing.taskArns]);
            save(root, `task-reconcile-${attempt}-${status}-described.json`, described);
            assert.equal(described.failures?.length ?? 0, 0);
            assert.equal(described.tasks?.length,listing.taskArns.length);
            assert.deepEqual(described.tasks.map(t=>t.taskArn).sort(),[...listing.taskArns].sort());
            assert.equal(new Set(described.tasks.map(t=>t.taskArn)).size,described.tasks.length);
            matches.push(...described.tasks.filter((value) => value.startedBy === startBy && value.taskDefinitionArn === taskDefinitionArn));
          }
        }
        const unique = [...new Map(matches.map((value) => [value.taskArn, value])).values()];
        assert.ok(unique.length <= 1, 'Ambiguous exact-nonce task discovery');
        if (unique.length === 1) {
          taskArn = unique[0].taskArn;
          exactTaskArn(unique[0], taskDefinitionArn, request);
          task = unique[0];
          save(root, 'task-reconciled.json', { at: new Date().toISOString(), taskArn, taskDefinitionArn,
            originalDispatchFailureRetained: true, automaticRetryAllowed: false });
        } else if (attempt < 6) await delay(5000);
      }
    } catch (error) { recordFailure('READ_ONLY_TASK_RECONCILIATION', error); }
  }

  // Independent stop and deregister cleanup; regardless of these outcomes we
  // collect logs/evidence before final success classification.
  if (taskArn) {
    try {
      try { taskRead(); } catch (error) { recordFailure('PRE_CLEANUP_TASK_READ', error, error?.name === 'AssertionError'); }
      assert.ok(task);
      exactTaskArn(task, taskDefinitionArn, request, taskArn);
      if (task.lastStatus !== 'STOPPED') {
        save(root, 'stop-dispatch-intent.json', { at: new Date().toISOString(), taskArn, attempt: 1 });
        stopAttempted = true;
        try {
          const stopped = await awsSingleAttempt(['ecs', 'stop-task', '--cluster', CLUSTER, '--task', taskArn,
            '--reason', 'C2 Case20 bounded controlled-read setup task cleanup']);
          save(root, 'stop-dispatch-response.json', stopped);
        } catch (error) { recordFailure('STOP_TASK_DISPATCH_OBSERVED_FAILURE', error); }
        await pollStopped(60000, 'POST_STOP_TASK_READ');
      }
    } catch (error) { recordFailure('STOP_HANDLING', error); }
    try { receiptFrame = await collectLogs(); }
    catch (error) { recordFailure('POST_STOP_LOG_COLLECTION', error); }
    try { taskRead(); } catch (error) { recordFailure('POST_COLLECTION_TASK_READ', error, error?.name === 'AssertionError'); }
  }

  if (taskDefinitionArn) {
    try {
      assert.match(taskDefinitionArn,new RegExp(`^arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/capiro-dev-meri-c2-case20-setup-20261003:[1-9][0-9]*$`,'u'));
      save(root, 'deregister-dispatch-intent.json', { at: new Date().toISOString(), taskDefinitionArn, attempt: 1 });
      deregisterAttempted = true;
      try {
        const response = await awsSingleAttempt(['ecs', 'deregister-task-definition', '--task-definition', taskDefinitionArn]);
        save(root, 'deregister-response.json', response);
      } catch (error) { recordFailure('DEREGISTER_DISPATCH_OBSERVED_FAILURE', error); }
      for (let attempt = 1; attempt <= 3 && !cleanupInactive; attempt++) {
        try {
          const current = await aws(['ecs', 'describe-task-definition', '--task-definition', taskDefinitionArn]);
          save(root, `deregister-readback-${attempt}.json`, current);
          assert.equal(current.taskDefinition.taskDefinitionArn, taskDefinitionArn);
          if (current.taskDefinition.status === 'INACTIVE') cleanupInactive = true;
          else throw new Error('TASK_DEFINITION_STILL_ACTIVE');
        } catch (error) { recordFailure('DEREGISTER_READBACK', error, attempt === 3); if (attempt < 3) await delay(5000); }
      }
      assert.equal(cleanupInactive, true, 'Task definition must be INACTIVE');
    } catch (error) { recordFailure('DEREGISTER_CLEANUP', error); }
  }

  if (receiptFrame?.complete) {
    try { save(root, 'inner-owner-events.json', { meta: receiptFrame.meta,
      owner: receiptFrame.owner, ownerFailure: receiptFrame.ownerFailure }); } catch(error) { evidencePersistenceFailed=true; recordFailure('OWNER_EVIDENCE_PERSISTENCE',error); }
    try {
      validateOwnerReceipt(receiptFrame.owner);
      successfulReceipt = receiptFrame.successful === true;
    } catch(error) { recordFailure('CANONICAL_OWNER_RECEIPT_VALIDATION',error); }
  }
  let postSnapshot = null;
  try {
    postSnapshot = {};
    for (const service of SERVICES) {
      const snapshot = await operator.snapshot(service);
      validateLiveCandidate(service, snapshot, release.services[service]);
      postSnapshot[service] = { baseline: snapshot.baseline, serviceName: snapshot.service.serviceName,
        taskDefinition: snapshot.service.taskDefinition };
    }
    save(root, 'post-operation-snapshots.json', postSnapshot);
  } catch (error) {
    // A committed owner result remains saved above; post-check failure is separate.
    recordFailure('POST_OPERATION_LIVE_SNAPSHOT', error);
  }
  cleanupStopped = task?.lastStatus === 'STOPPED';
  try { if(logRecords.length) save(root,'raw-receipt-records.json',{records:logRecords}); } catch(error) { evidencePersistenceFailed=true; recordFailure('RAW_FRAME_PERSISTENCE',error); }
  let scriptStillBound=false;
  try { const currentScriptBytes=await read(path.join(ROOT,'case20-native-setup-inner.mjs')); scriptStillBound=hash(currentScriptBytes)===local.innerScriptSha256; } catch(error) { recordFailure('INNER_SCRIPT_FINAL_READ',error); }
  if (!scriptStillBound) recordFailure('INNER_SCRIPT_DRIFT_AFTER_TASK', new Error('INNER_SCRIPT_HASH_MISMATCH'));
  const noFatal = !fatal && !observations.some((o) => o.fatal);
  const success = successfulReceipt && task?.containers?.length === 1 &&
    task.containers[0].name === logsContainer.name && task.containers[0].image === release.services.api.image &&
    task.containers[0].imageDigest === release.services.api.image.split('@')[1] &&
    task.containers[0].exitCode === 0 && cleanupStopped && cleanupInactive &&
    !evidencePersistenceFailed && noFatal && postSnapshot !== null && scriptStillBound;
  const receiptPath = `${root}/inner-owner-receipt.json`;
  const result = {
    at: new Date().toISOString(), mode, status: success ? (mode === 'plan' ? 'PLAN_ONLY' : 'SETUP_ONLY_COMPLETE') :
      'BLOCKED_OR_UNCERTAIN_RECONCILE_BEFORE_ANOTHER_ACTION',
    exitCode: success ? 0 : 1, sourceSha: SOURCE, candidateImage: release.services.api.image,
    packetSha256: release.packetSha256, taskDefinitionArn, taskArn,
    inputSha256: local.inputSha256, innerScriptSha256: local.innerScriptSha256, outerScriptSha256:local.outerScriptSha256,
    wrapperSha256, ownerReceipt: receiptFrame?.complete ? { path: receiptPath,
      sha256: hash(receiptFrame.bytes), bytes: receiptFrame.bytes.length } : null,
    ownerPlan: mode === 'plan' && successfulReceipt && receiptFrame?.owner ? {
      path: receiptPath, sha256: hash(receiptFrame.bytes), bytes: receiptFrame.bytes.length,
      kind: receiptFrame.owner.kind, planSha256: receiptFrame.owner.planSha256,
      sourceSha: SOURCE, scriptSha256: local.innerScriptSha256, inputSha256: local.inputSha256,
      run: RUN, taskDefinitionArn, taskArn,
      cleanup: { taskStopped: cleanupStopped, taskDefinitionInactive: cleanupInactive },
    } : null,
    priorPlan: mode === 'execute' ? { resultPath: `${PRIOR_PLAN_ROOT}/result.json`,
      resultSha256: priorPlan?.resultSha256 ?? null, receiptPath: `${PRIOR_PLAN_ROOT}/inner-owner-receipt.json`,
      receiptSha256: priorPlan?.receiptSha256 ?? null, planSha256: priorPlan?.plan?.planSha256 ?? null } : null,
    innerObservedStatus:receiptFrame?.owner?.status??receiptFrame?.owner?.kind??null,
    priorBudgetQualification: mode === 'plan' ? 'UNCHANGED' : successfulReceipt ? 'CLEARED_BY_EXISTING_NATIVE_OWNER' : runDispatched ? 'NOT_PROVED' : 'UNCHANGED_BEFORE_DISPATCH',
    childExitCode: receiptFrame?.meta?.childExitCode ?? null,
    taskExitCode: task?.containers?.[0]?.exitCode ?? null,
    events, failures, rawFrameRecords: logRecords, observations, postOperationSnapshots: postSnapshot,
    cleanup: { taskStopped: cleanupStopped, stopAttempted, taskDefinitionInactive: cleanupInactive, deregisterAttempted },
    setupOnly: true, liveAcceptance: 'NOT_RUN', budgets: 'NOT_INSTALLED', providerCalls: 0,
    sharedSourceCorpusWrites: 0, automaticRetryAllowed: false, evidencePersistenceFailed,
  };
  save(root, 'cleanup.json', result.cleanup);
  save(root, 'result.json', result);
  return result;
}

function makeWrapper({ mode, innerBytes, inputBytes, ownerInput, priorPlan, local, outputPath, planOutputPath }) {
  const encodedInner = innerBytes.toString('base64');
  const encodedInput = inputBytes.toString('base64');
  const encodedOwnerInput = Buffer.from(JSON.stringify(ownerInput) + '\n', 'utf8').toString('base64');
  const priorB64 = priorPlan ? priorPlan.receiptBytes.toString('base64') : '';
  const priorSha = priorPlan?.receiptSha256 ?? '';
  const planPath = mode === 'execute' ? planOutputPath : '';
  return `import {writeFileSync} from 'node:fs';\n` +
`const write=(p,b)=>writeFileSync(p,Buffer.from(b,'base64'),{flag:'wx',mode:0o600});\n` +
`write('/dev/shm/case20-native-setup-inner.mjs',${JSON.stringify(encodedInner)});\n` +
`write(${JSON.stringify(`/dev/shm/case20-native-setup-${mode}-input.json`)},${JSON.stringify(encodedInput)});\n` +
`write(${JSON.stringify(`/dev/shm/case20-native-setup-${mode}-owner-input.json`)},${JSON.stringify(encodedOwnerInput)});\n` +
(mode === 'execute' ? `write(${JSON.stringify(planPath)},${JSON.stringify(priorB64)});\n` : '') +
`process.env.C2_CASE20_INNER_SHA256=${JSON.stringify(local.innerScriptSha256)};\n` +
`process.env.C2_CASE20_PRIOR_PLAN_RECEIPT_B64=${JSON.stringify(priorB64)};\n` +
`process.env.C2_CASE20_PRIOR_PLAN_RECEIPT_SHA256=${JSON.stringify(priorSha)};\n` +
`process.argv=[process.execPath,'/dev/shm/case20-native-setup-inner.mjs',${JSON.stringify(mode)},'--input',${JSON.stringify(`/dev/shm/case20-native-setup-${mode}-input.json`)},'--owner-input',${JSON.stringify(`/dev/shm/case20-native-setup-${mode}-owner-input.json`)},'--out',${JSON.stringify(outputPath)}];\n` +
`await import('file:///dev/shm/case20-native-setup-inner.mjs');\n`;
}

async function verifyPriorPlan(local, release) {
  const resultBytes = await read(`${PRIOR_PLAN_ROOT}/result.json`);
  const result = json(resultBytes, 'PRIOR_PLAN_RESULT');
  assert.equal(result.mode, 'plan');
  assert.equal(result.status, 'PLAN_ONLY');
  assert.equal(result.exitCode, 0);
  assert.equal(result.sourceSha, SOURCE);
  assert.equal(result.candidateImage,release.services.api.image);
  assert.equal(result.outerScriptSha256,local.outerScriptSha256);
  assert.equal(result.inputSha256, local.inputSha256);
  assert.equal(result.innerScriptSha256, local.innerScriptSha256);
  assert.equal(result.cleanup?.taskStopped, true);
  assert.equal(result.cleanup?.taskDefinitionInactive, true);
  assert.equal(result.ownerPlan?.kind, 'meri-controlled-read-setup-plan');
  assert.equal(result.ownerPlan?.run, RUN);
  assert.equal(result.ownerPlan.taskArn,result.taskArn);
  assert.equal(result.ownerPlan.taskDefinitionArn,result.taskDefinitionArn);
  assert.equal(result.ownerPlan.sourceSha,SOURCE);
  assert.equal(result.ownerPlan.scriptSha256,local.innerScriptSha256);
  assert.equal(result.ownerPlan.inputSha256,local.inputSha256);
  const receiptBytes = await read(`${PRIOR_PLAN_ROOT}/inner-owner-receipt.json`);
  assert.equal(hash(receiptBytes), result.ownerPlan.sha256);
  assert.equal(result.ownerPlan.bytes, receiptBytes.length);
  const plan = json(receiptBytes, 'PRIOR_OWNER_PLAN');
  assert.equal(plan.kind, 'meri-controlled-read-setup-plan');
  assert.equal(plan.liveAcceptance, 'NOT_RUN');
  assert.equal(plan.planSha256, result.ownerPlan.planSha256);
  const {controlledReadExecuteInput}=await import(pathToFileURL(`${REPO}/evals/meri/live-v1/controlled-read-operator-input.mjs`).href);
  controlledReadExecuteInput(local.input,plan);
  return { result, resultSha256: hash(resultBytes), receiptBytes, receiptSha256: hash(receiptBytes), plan };
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (!['plan', 'execute'].includes(mode) || args.length) fail('USAGE: run-case20-native-setup.mjs <plan|execute>');
  const root = mode === 'plan' ? PLAN_ROOT : EXECUTE_ROOT;
  // Discovery and all non-AWS authority gates happen before root creation/intent.
  const local = await localGates();
  const packetGate = await gateRelease();
  const priorPlan = mode === 'execute' ? await verifyPriorPlan(local,packetGate.release) : null;
  assert.equal(existsSync(root), false, 'Exclusive output root exists; reconcile, never retry');

  // Lazy-load helpers only after all immutable inputs, exact owner artifacts,
  // approval scope, checkpoint, and execute-plan bindings have passed.
  const { aws } = await import(pathToFileURL(`${OUTPUTS}/meri-fresh-20261003/auth-preflight.mjs`).href);
  const { awsSingleAttempt } = await import(pathToFileURL(`${PARENT}/aws-single-attempt.mjs`).href);
  const { releaseOperator } = await import(pathToFileURL(`${REPO}/scripts/meri-release.mjs`).href);
  const { fingerprint, taskInput } = await import(pathToFileURL(`${REPO}/scripts/lib/meri-release-policy.mjs`).href);
  const { controlledReadExecuteInput, inspectControlledReadSetupReceipt } = await import(pathToFileURL(`${REPO}/evals/meri/live-v1/controlled-read-operator-input.mjs`).href);
  const caller=aws(['sts','get-caller-identity']);
  assert.equal(caller.Account,ACCOUNT); assert.equal(caller.Arn,`arn:aws:iam::${ACCOUNT}:user/capirocli`);
  const operator = releaseOperator({ aws });
  const snapshots = {};
  for (const service of SERVICES) {
    const snapshot = await operator.snapshot(service);
    validateLiveCandidate(service, snapshot, packetGate.release.services[service]);
    snapshots[service] = snapshot;
  }
  const liveApi = snapshots.api;
  const definitionInput = buildTaskDefinition(liveApi, local, packetGate.release);
  // Confirm task normalization equals the mature policy's writable ECS projection.
  const projected = normalizeTaskEnvironment(taskInput(definitionInput));
  assert.deepEqual(projected, definitionInput);
  const innerBytes = await read(path.join(ROOT, 'case20-native-setup-inner.mjs'));
  const inputBytes = local.inputBytes;
  const ownerInput = mode === 'plan' ? local.input : controlledReadExecuteInput(local.input, priorPlan.plan);
  const wrapperPreview = makeWrapper({ mode, innerBytes, inputBytes, ownerInput, priorPlan, local,
    outputPath: `/dev/shm/case20-native-setup-${mode}-owner.json`,
    planOutputPath: '/dev/shm/case20-native-setup-plan-owner.json' });
  mkdirSync(root);
  save(root, 'pre-operation-snapshots.json', Object.fromEntries(SERVICES.map((service) => [service, {
    baseline: snapshots[service].baseline,
    taskDefinitionArn: snapshots[service].service.taskDefinition,
    serviceName: snapshots[service].service.serviceName,
  }])));
  save(root, 'release-gate.json', { packetSha256: packetGate.release.packetSha256,
    packetBytesSha256: packetGate.packetBytesSha256, approvalSha256: packetGate.approvalSha256,
    approvalScope: APPROVAL_SCOPE, callerArn:caller.Arn, qualificationSha256:packetGate.release.qualificationSha256, qualificationBytesSha256:packetGate.release.qualificationBytesSha256, services: Object.fromEntries(SERVICES.map((s) => [s, {
      sourceSha: packetGate.release.services[s].sourceSha, image: packetGate.release.services[s].image,
      receiptSha256: packetGate.release.services[s].receiptSha256,
      candidateTaskDefinition: packetGate.release.services[s].receipt.candidateTaskDefinition,
    }])) });
  save(root, 'source-bindings.json', { outerScriptSha256: local.outerScriptSha256,
    innerScriptSha256: local.innerScriptSha256, runtimeSources: local.runtimeSources,
    inputSha256: local.inputSha256, checkpointSha256: local.checkpointBytesSha256,
    journalSha256: local.checkpointProof.journalSha256,
    wrapperSha256: hash(Buffer.from(wrapperPreview)), sourceSha: SOURCE });
  const result = await runNativeTask({ aws, awsSingleAttempt, operator, mode, root, local,
    release: packetGate.release, packetGate, liveApi, definitionInput, wrapper: wrapperPreview,
    innerBytes, inputBytes, ownerInput, priorPlan, policyTaskInput:taskInput,
    validateOwnerReceipt:owner=>mode==='plan' ? controlledReadExecuteInput(local.input,owner) : inspectControlledReadSetupReceipt(local.input,owner) });
  if (result.exitCode !== 0) process.exitCode = 1;
  process.stdout.write(JSON.stringify({ status: result.status, mode, resultPath: `${root}/result.json`,
    taskStopped: result.cleanup.taskStopped, taskDefinitionInactive: result.cleanup.taskDefinitionInactive,
    setupOnly: true, liveAcceptance: 'NOT_RUN', budgets: 'NOT_INSTALLED', automaticRetryAllowed: false }) + '\n');
  void fingerprint;
}

main().catch((error) => {
  const message = /^[A-Z0-9_:-]{1,120}$/u.test(error?.message ?? '')
    ? error.message : 'CASE20_SETUP_FAILED_OR_UNCERTAIN_RECONCILE';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
