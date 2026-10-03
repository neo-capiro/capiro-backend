import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import {
  inspectCase01PresubmissionRecoveryEvidence,
  inspectCase01PresubmissionRecoveryReadback,
  consumeCase01PresubmissionRecoveryAuthority,
  inspectCase01PresubmissionRecoveryAuthority,
  recheckCase01PresubmissionRecoveryAuthority,
} from '../case01-presubmission-recovery-authority.mjs';
import { restoreCase01PresubmissionCaptureSpend } from '../capture-spend-aggregate.mjs';
import { inspectCase01Admission, inspectCase01Scope } from '../case01-live-capture.mjs';
import { sha256Stable } from '../artifact-collector.mjs';

const base = 'C:/dev/main/outputs/meri-c2-20261003';
const run = 'bd35c0f4-1604-4371-b7e9-a1338369e53f';
const old = `${base}/case01-native-${run}`;
const read = (name) => JSON.parse(fs.readFileSync(name, 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const authorityUrl = new URL('../case01-presubmission-recovery-authority.mjs', import.meta.url);
const authoritySource = fs.readFileSync(authorityUrl, 'utf8');
const aggregateUrl = new URL('../capture-spend-aggregate.mjs', import.meta.url);
const aggregateSource = fs.readFileSync(aggregateUrl, 'utf8');
const evidence = {
  execution: read(`${old}/execution.json`),
  history: fs
    .readFileSync(`${old}/execution-events.jsonl`, 'utf8')
    .trimEnd()
    .split('\n')
    .map(JSON.parse),
  scope: read(`${old}/actual-capture-scope.json`),
  checkpoint: read(`${old}/aggregate-reserved-checkpoint.json`),
  claim: read(`C:/dev/cap-meri-foundation-evidence/controlled-read-claims/01-${run}.json`),
  diagnostic: read(`${base}/case01-browser-readiness-diagnostic-v1.json`),
};
const liveJournal = 'C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl';
const liveAuthorization = 'C:/dev/main/outputs/meri-fresh-20261003/run-authorization.json';
const originalJournal = fs.readFileSync(liveJournal),
  originalAuthorization = fs.readFileSync(liveAuthorization);
const reservedJournal = Buffer.from(
  originalJournal.toString('utf8').split('\n').slice(0, 21).join('\n') + '\n',
);
assert.equal(
  hash(reservedJournal),
  '7ac5a5d06782d325e0d30327586968aa60233681b7dec2ed98f50285ed6daa60',
);
const recoveryClaim = `${base}/case01-presubmission-recovery-claim-${run}.json`;
const priorRecoveryClaim = fs.existsSync(recoveryClaim) ? fs.readFileSync(recoveryClaim) : null;
test.after(() => {
  assert.deepEqual(fs.readFileSync(liveJournal), originalJournal);
  assert.deepEqual(fs.readFileSync(liveAuthorization), originalAuthorization);
  assert.deepEqual(
    fs.existsSync(recoveryClaim) ? fs.readFileSync(recoveryClaim) : null,
    priorRecoveryClaim,
  );
});

function fixture() {
  const config = structuredClone(evidence.scope),
    scope = inspectCase01Scope(config, { MERI_LIVE_BEARER_TOKEN: 'unit-only' });
  const now = Date.now(),
    source = scope.source;
  const admission = {
    ...scope.expected,
    schemaVersion: 1,
    kind: 'meri-case01-authenticated-admission',
    status: 'READY',
    issuedAt: now,
    expiresAt: now + 60_000,
    apiReleaseSha: config.deployment.apiSha,
    toolAuthority: 'shared_static_registry_read_only',
    toolCatalogSha256: 'a'.repeat(64),
    dynamicMcpAllowed: false,
    incidentalWriters: 'suppressed',
    fixture: {
      fixtureNamespace: config.fixture.namespace,
      fixtureVersion: config.fixture.version,
      physicalMapSha256: config.fixture.mappingSha256,
      currentVerifySha256: evidence.execution.setupProof.currentVerifySha256,
      seedReceiptId: config.fixture.seedReceiptId,
      resetReceiptId: config.fixture.resetReceiptId,
      sources: [
        {
          logicalId: 'MA1-v2',
          physicalId: source.physicalId,
          tenantId: source.tenantPhysicalId,
          clientId: source.clientPhysicalId,
          sourceVersion: source.version,
          contentSha256: 'b'.repeat(64),
        },
      ],
    },
    providerBudget: {
      ready: true,
      coverage: 'case01_memory_turn',
      qualificationSha256: evidence.execution.setupProof.qualificationSha256,
      currentVerifySha256: evidence.execution.setupProof.currentVerifySha256,
      maxCostMicros: 15_000_000,
    },
  };
  return {
    config,
    now,
    me: {
      tenant: { id: scope.expected.tenantId, slug: scope.tenant.slug },
      user: { id: scope.expected.actorUserId, clerkUserId: scope.actor.clerkUserId },
      role: 'standard_user',
      features: { meriv3Chat: true },
    },
    status: { configured: true, healthy: true },
    messages: [],
    conversation: {
      id: config.conversationId,
      tenantId: scope.expected.tenantId,
      userId: scope.expected.actorUserId,
      clientId: scope.expected.clientId,
      archivedAt: null,
      title: `meri-foundation-20260928 case01 ${run}`,
      metadata: { brand: 'Meri', runtime: 'test', userEmail: 'synthetic@example.com' },
      captureAdmission: admission,
    },
  };
}

test('actual stopped pre-submission evidence and fresh READY readback validate without granting authority', () => {
  const inspected = inspectCase01PresubmissionRecoveryEvidence(evidence);
  assert.equal(inspected.captureAuthority, false);
  const readback = inspectCase01PresubmissionRecoveryReadback(fixture());
  assert.equal(readback.captureAuthority, false);
  for (const fake of [
    inspected,
    readback,
    { kind: 'case01-presubmission-recovery-authority' },
    null,
  ]) {
    assert.throws(() => consumeCase01PresubmissionRecoveryAuthority(fake));
    assert.throws(() => inspectCase01PresubmissionRecoveryAuthority(fake));
    assert.throws(() =>
      restoreCase01PresubmissionCaptureSpend(fake, {
        invocation: 'RESTORE_SAME_CASE01_UNSUBMITTED_RESERVATION_ONCE',
        pythonExecutable: 'unused',
      }),
    );
  }
});
for (const [name, mutate] of [
  ['execution intent', (x) => (x.history[0].summary.executionIntent = {})],
  ['execution attempted', (x) => (x.history[0].summary.executionAttempted = true)],
  ['completed preparation', (x) => (x.history[0].summary.capturePrepared = true)],
  ['native outcome', (x) => (x.history[0].summary.outcome = {})],
  ['browser application write', (x) => (x.history[0].summary.browserApplicationWrites = 1)],
  ['missing history', (x) => x.history.pop()],
  ['history gap', (x) => (x.history[0].sequence = 2)],
  ['different conversation', (x) => (x.scope.conversationId = x.scope.captureRunId)],
  ['different claim', (x) => (x.claim.captureRunId = 'bad')],
  ['different reservation', (x) => (x.checkpoint.snapshot.runs[`01:${run}`].reservationId = 'bad')],
  ['changed cost', (x) => (x.checkpoint.snapshot.committedCostMicros = 0)],
  ['additional journal event', (x) => x.checkpoint.snapshot.eventCount++],
  ['active reservation cleared', (x) => (x.checkpoint.snapshot.activeRun = null)],
  [
    'wrong journal hash',
    (x) => (x.checkpoint.state.files['fresh-spend.jsonl'].sha256 = 'f'.repeat(64)),
  ],
  ['diagnostic writes', (x) => (x.diagnostic.applicationWrites = 1)],
])
  test(`rejects local evidence: ${name}`, () => {
    const x = structuredClone(evidence);
    mutate(x);
    assert.throws(() => inspectCase01PresubmissionRecoveryEvidence(x));
  });

for (const [name, mutate] of [
  ['different actor', (x) => (x.me.user.id = x.config.captureRunId)],
  ['administrator', (x) => (x.me.role = 'tenant_admin')],
  ['wrong release', (x) => (x.conversation.captureAdmission.apiReleaseSha = 'f'.repeat(40))],
  ['archived conversation', (x) => (x.conversation.archivedAt = new Date().toISOString())],
  ['different owner', (x) => (x.conversation.userId = x.config.captureRunId)],
  ['different client', (x) => (x.conversation.clientId = x.config.captureRunId)],
  ['messages already present', (x) => x.messages.push({ role: 'user', body: 'anything' })],
  ['malformed messages', (x) => (x.messages = { messages: [] })],
  ['missing metadata', (x) => delete x.conversation.metadata],
  ['null metadata', (x) => (x.conversation.metadata = null)],
  [
    'wrong current fixture',
    (x) => (x.conversation.captureAdmission.fixture.currentVerifySha256 = 'f'.repeat(64)),
  ],
  [
    'wrong qualification',
    (x) => (x.conversation.captureAdmission.providerBudget.qualificationSha256 = 'f'.repeat(64)),
  ],
  ['expired admission', (x) => (x.conversation.captureAdmission.expiresAt = x.now)],
  ['stale admission', (x) => (x.conversation.captureAdmission.issuedAt = x.now - 40_000)],
])
  test(`rejects current readback: ${name}`, () => {
    const x = fixture();
    mutate(x);
    assert.throws(() => inspectCase01PresubmissionRecoveryReadback(x));
  });
for (const key of [
  'serverCaptureProviderBudget',
  'serverReadonlyCapturePolicy',
  'serverCaptureEvidenceReceipt',
  'syntheticReadBudgetQualification',
  'syntheticReadProviderBudget',
  'syntheticReadBudgetTerminal',
  'governedArtifactCapture',
  'governedArtifactCaptureBinding',
  'governedArtifactProviderBudget',
  'unknownScope',
]) {
  test(`present ${key}, even null, is not absence`, () => {
    const x = fixture();
    x.conversation.metadata[key] = null;
    assert.throws(() => inspectCase01PresubmissionRecoveryReadback(x));
  });
}

// Isolated source extraction can expose a test WeakMap but never the live map.
// No real HTTP object or acquisition function is exposed by this harness.
function privateHarness({
  guard = () => {},
  readback = async () => ({
    expected: { marker: 1 },
    observedAt: Date.now(),
    admissionExpiresAt: Date.now() + 60_000,
    observations: [],
  }),
} = {}) {
  const text = authoritySource
    .replace(/^import[\s\S]*?;\r?\n/gm, '')
    .replace(/^export /gm, '')
    .replace('function assertOwnedLocal(state)', 'function disabledAssertOwnedLocal(state)')
    .replace(
      'async function readCurrent(config, bearer)',
      'async function disabledReadCurrent(config, bearer)',
    );
  return vm.runInNewContext(
    `${text}\nconst assertOwnedLocal=__guard, readCurrent=__read;\n({authorities,consumeCase01PresubmissionRecoveryAuthority,recheckCase01PresubmissionRecoveryAuthority,inspectCase01PresubmissionRecoveryAuthority,writeExclusiveRecoveryClaim,readStableFile});`,
    {
      ...fs,
      ...path,
      createHash,
      isDeepStrictEqual,
      sha256Stable,
      inspectCase01Admission,
      inspectCase01Scope,
      Buffer,
      structuredClone,
      process,
      Date,
      __guard: guard,
      __read: readback,
    },
  );
}
function fakeState() {
  return {
    local: { checkpoint: {}, scope: {}, descriptors: {} },
    proof: { expected: { marker: 1 }, observations: [] },
    claimDescriptor: { sha256: 'a'.repeat(64) },
    restored: false,
    recheckStarted: false,
    rechecked: null,
    submissionConsumed: false,
    failed: false,
  };
}
test('restoration, HTTP recheck and immediate submission fence are independently one-use', async () => {
  const h = privateHarness(),
    cap = Object.freeze({}),
    state = fakeState();
  h.authorities.set(cap, state);
  const p = h.consumeCase01PresubmissionRecoveryAuthority(cap);
  assert.throws(() => h.consumeCase01PresubmissionRecoveryAuthority(cap));
  assert.throws(() => p.assertSubmission());
  await h.recheckCase01PresubmissionRecoveryAuthority({
    authority: cap,
    bearer: 'unit',
    invocation: 'RECHECK_SAME_CASE01_BEFORE_FIRST_SUBMISSION_ONCE',
  });
  await assert.rejects(
    h.recheckCase01PresubmissionRecoveryAuthority({
      authority: cap,
      bearer: 'unit',
      invocation: 'RECHECK_SAME_CASE01_BEFORE_FIRST_SUBMISSION_ONCE',
    }),
  );
  p.assertSubmission();
  assert.throws(() => p.assertSubmission());
  assert.equal(h.inspectCase01PresubmissionRecoveryAuthority(cap).submissionFenceConsumed, true);
});
test('failed recheck poisons authority and cannot be repaired by calling again', async () => {
  const h = privateHarness({
      readback: async () => {
        throw new Error('changed current metadata');
      },
    }),
    cap = {},
    state = fakeState();
  h.authorities.set(cap, state);
  const p = h.consumeCase01PresubmissionRecoveryAuthority(cap);
  await assert.rejects(
    h.recheckCase01PresubmissionRecoveryAuthority({
      authority: cap,
      bearer: 'unit',
      invocation: 'RECHECK_SAME_CASE01_BEFORE_FIRST_SUBMISSION_ONCE',
    }),
  );
  assert.throws(() => p.assertSubmission());
  assert.throws(() => p.assertOwned());
  assert.equal(h.inspectCase01PresubmissionRecoveryAuthority(cap).failed, true);
});
test('changed owned evidence rejects restoration and failed consume is not reusable', () => {
  const h = privateHarness({
      guard: () => {
        throw new Error('changed claim');
      },
    }),
    cap = {};
  h.authorities.set(cap, fakeState());
  assert.throws(() => h.consumeCase01PresubmissionRecoveryAuthority(cap));
  assert.throws(() => h.consumeCase01PresubmissionRecoveryAuthority(cap));
});
test('stale post-prepare HTTP proof refuses the native submission fence', () => {
  const h = privateHarness(),
    cap = {},
    state = fakeState();
  h.authorities.set(cap, state);
  const p = h.consumeCase01PresubmissionRecoveryAuthority(cap);
  state.rechecked = { observedAt: Date.now() - 31_000, admissionExpiresAt: Date.now() + 60_000 };
  assert.throws(() => p.assertSubmission());
});
test('live exported recheck rejects forged JSON before any endpoint call', async () => {
  await assert.rejects(
    recheckCase01PresubmissionRecoveryAuthority({
      authority: {},
      bearer: 'unit',
      invocation: 'RECHECK_SAME_CASE01_BEFORE_FIRST_SUBMISSION_ONCE',
    }),
  );
});

const temp = fs.mkdtempSync(path.join(tmpdir(), 'meri-case01-presubmission-unit-'));
test('exclusive fsynced claim preserves existing evidence and detects same-byte replacement', () => {
  const h = privateHarness(),
    p = path.join(temp, 'claim.json');
  const d = h.writeExclusiveRecoveryClaim(p, { unit: true });
  assert.equal(d.sha256, hash(fs.readFileSync(p)));
  assert.throws(() => h.writeExclusiveRecoveryClaim(p, { unit: false }));
  const bytes = fs.readFileSync(p);
  fs.renameSync(p, path.join(temp, 'retained-claim.json'));
  fs.writeFileSync(p, bytes, { flag: 'wx' });
  assert.notEqual(h.readStableFile(p).descriptor.identity, d.identity);
});
test('two real local processes cannot both acquire the same exclusive recovery claim', async () => {
  const p = path.join(temp, 'concurrent.json');
  const helper = authoritySource.slice(
    authoritySource.indexOf('function identity(stat)'),
    authoritySource.indexOf('/** Pure checks only.'),
  );
  const script = path.join(temp, 'claim-process.mjs');
  fs.writeFileSync(
    script,
    `import {closeSync,lstatSync,openSync,writeFileSync,fsyncSync,fstatSync,readFileSync,realpathSync} from 'node:fs';\nimport {resolve,dirname,parse} from 'node:path';\nimport {createHash} from 'node:crypto';\nimport {isDeepStrictEqual} from 'node:util';\nconst hash=x=>createHash('sha256').update(x).digest('hex'),need=(x)=>{if(!x)throw Error('refused')};\n${helper}\ntry {writeExclusiveRecoveryClaim(process.argv[2],{unit:true});process.exitCode=0;}catch{process.exitCode=1;}\n`,
  );
  const child = () =>
    new Promise((done, reject) => {
      const c = spawn(process.execPath, [script, p], { windowsHide: true, stdio: 'ignore' });
      c.on('error', reject);
      c.on('exit', done);
    });
  assert.deepEqual((await Promise.all([child(), child()])).sort(), [0, 1]);
});

// A test-only copied module cannot create live authority: its root/helper and
// opaque proof/outcome collaborators are replaced, never production exports.
async function nativeFixture() {
  const root = fs.mkdtempSync(path.join(temp, 'native-'));
  fs.writeFileSync(path.join(root, 'fresh-spend.jsonl'), reservedJournal);
  fs.writeFileSync(path.join(root, 'run-authorization.json'), originalAuthorization);
  const wrapper = path.join(root, 'unit-helper.py'),
    helper = fileURLToPath(new URL('../lib/windows-capture-spend.py', import.meta.url));
  fs.writeFileSync(
    wrapper,
    `import json,runpy,sys\nm=runpy.run_path(${JSON.stringify(helper)})\ng=m['execute'].__globals__\ng['FRESH_ROOT']=${JSON.stringify(path.resolve(root))}\nr=json.load(sys.stdin)\nif r.get('op')=='unit_checkpoint':\n r['op']='fresh_adopt'\n old=g['reduce_fresh']\n def initial(w):\n  s=old(w);s['eventCount']=20;s['activeRun']=None;return s\n g['reduce_fresh']=initial\n v=m['execute'](r);g['reduce_fresh']=old;v['snapshot']=old(open(r['root']+'/fresh-spend.jsonl','rb').read())\nelse:\n v=m['execute'](r)\nprint(json.dumps({'ok':True,**v}))\n`,
  );
  const python = 'C:/Users/neoma/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe';
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(python, ['-I', wrapper], {
    input: JSON.stringify({ op: 'unit_checkpoint', root: path.resolve(root) }),
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout),
    checkpoint = {
      kind: 'meri-fresh-capture-spend-checkpoint',
      version: 1,
      state: actual.state,
      snapshot: actual.snapshot,
    };
  const proof = {
    checkpoint,
    expected: inspectCase01Scope(evidence.scope, { MERI_LIVE_BEARER_TOKEN: 'unit' }).expected,
    reservation: {
      caseId: '01',
      captureRunId: run,
      reservationId: 'cf7ea1df-6996-4d29-a5d5-b98db9c85c61',
      ceilingMicros: 15_000_000,
    },
  };
  const fake = path.join(root, 'unit-authority.mjs');
  fs.writeFileSync(
    fake,
    `export const authority={};let used=false,ready=false,submitted=false;const proof=${JSON.stringify(proof)};export function consumeCase01PresubmissionRecoveryAuthority(x){if(x!==authority||used)throw Error('forged');used=true;return {...proof,assertOwned(){},assertSubmission(){if(!ready||submitted)throw Error('recheck required');submitted=true;}};}export function recheck(){ready=true;}\n`,
  );
  let source = aggregateSource
    .replace(/from '(\.\/[^']+)'/gu, (_m, ref) => `from '${new URL(ref, aggregateUrl).href}'`)
    .replace(
      `from '${new URL('../case01-presubmission-recovery-authority.mjs', import.meta.url).href}'`,
      `from '${pathToFileURL(fake).href}'`,
    )
    .replace(
      "const freshRoot = 'C:/dev/main/outputs/meri-fresh-20261003';",
      `const freshRoot = ${JSON.stringify(path.resolve(root))};`,
    )
    .replace(
      "const helper = fileURLToPath(new URL('./lib/windows-capture-spend.py', import.meta.url));",
      `const helper = ${JSON.stringify(wrapper)};`,
    )
    .replace(
      'currentCase01CaptureAuthority,',
      'currentCase01CaptureAuthority as unusedActualCase01Authority,',
    );
  source += '\nfunction currentCase01CaptureAuthority(outcome){return outcome.unitAuthority;}\n';
  const modulePath = path.join(root, 'unit-spend.mjs');
  fs.writeFileSync(modulePath, source);
  return {
    root,
    proof,
    python,
    module: await import(pathToFileURL(modulePath).href),
    control: await import(pathToFileURL(fake).href),
  };
}
test('actual native copy restores same reservation without append and existing settlement appends once', async () => {
  const f = await nativeFixture(),
    before = fs.readFileSync(path.join(f.root, 'fresh-spend.jsonl'));
  const { owner, reservation } = f.module.restoreCase01PresubmissionCaptureSpend(
    f.control.authority,
    { pythonExecutable: f.python, invocation: 'RESTORE_SAME_CASE01_UNSUBMITTED_RESERVATION_ONCE' },
  );
  assert.equal(reservation.reservationId, f.proof.reservation.reservationId);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'fresh-spend.jsonl')), before);
  assert.throws(() =>
    owner.reserve({ caseId: '01', captureRunId: run, ceilingMicros: 15_000_000 }),
  );
  assert.throws(() =>
    f.module.claimCaptureSpendReservation(reservation, {
      ...f.proof.expected,
      conversationId: run,
    }),
  );
  f.module.claimCaptureSpendReservation(reservation, f.proof.expected);
  assert.throws(() => f.module.claimCaptureSpendReservation(reservation, f.proof.expected));
  assert.throws(() => f.module.assertCaptureSpendReservation(reservation, f.proof.expected));
  f.control.recheck();
  f.module.assertCaptureSpendReservation(reservation, f.proof.expected);
  assert.throws(() => f.module.assertCaptureSpendReservation(reservation, f.proof.expected));
  const envelope = {
    receipt: {
      caseId: '01',
      captureRunId: run,
      providerBudget: {
        status: 'SETTLED',
        maxCostMicros: 15_000_000,
        unaccountedBoundaries: [],
        chargedCostMicros: 1234,
        ledgerSha256: 'c'.repeat(64),
      },
    },
  };
  const outcome = {
    unitAuthority: {
      evidence: {
        inputs: { expected: { ...f.proof.expected, assistantMessageId: 'unit' }, envelope },
      },
    },
  };
  owner.settleCaptured(reservation, outcome);
  const after = fs.readFileSync(path.join(f.root, 'fresh-spend.jsonl'));
  assert.deepEqual(after.subarray(0, before.length), before);
  assert.equal(after.toString().trimEnd().split('\n').length, 22);
  assert.equal(owner.checkpoint().snapshot.knownSettledCostMicros, 9_842_515);
  assert.equal(owner.checkpoint().snapshot.activeRun, null);
  assert.throws(() => owner.settleCaptured(reservation, outcome));
});
test('actual native checkpoint drift refuses restore and preserves full original ceiling', async () => {
  const f = await nativeFixture(),
    p = path.join(f.root, 'fresh-spend.jsonl');
  fs.appendFileSync(p, '\n');
  const changed = fs.readFileSync(p);
  assert.throws(() =>
    f.module.restoreCase01PresubmissionCaptureSpend(f.control.authority, {
      pythonExecutable: f.python,
      invocation: 'RESTORE_SAME_CASE01_UNSUBMITTED_RESERVATION_ONCE',
    }),
  );
  assert.throws(() =>
    f.module.restoreCase01PresubmissionCaptureSpend(f.control.authority, {
      pythonExecutable: f.python,
      invocation: 'RESTORE_SAME_CASE01_UNSUBMITTED_RESERVATION_ONCE',
    }),
  );
  assert.deepEqual(fs.readFileSync(p), changed);
  assert.equal(f.proof.checkpoint.snapshot.committedCostMicros, 24_841_281);
});
