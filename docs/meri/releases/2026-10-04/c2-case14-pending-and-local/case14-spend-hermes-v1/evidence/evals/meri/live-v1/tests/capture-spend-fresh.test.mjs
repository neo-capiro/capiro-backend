import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pythonExecutable = 'C:/Users/neoma/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe';
const liveRoot = 'C:/dev/main/outputs/meri-fresh-20261003';
const parent = 'C:/dev/main/outputs/meri-c2-20261003/fresh-journal-adapter-v1/local-tests';
const moduleUrl = new URL('../capture-spend-aggregate.mjs', import.meta.url);
const source = readFileSync(moduleUrl, 'utf8');
const original = Object.fromEntries(
  ['run-authorization.json', 'fresh-spend.jsonl'].map((name) => [
    name,
    readFileSync(join(liveRoot, name)),
  ]),
);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.equal(
  hash(original['fresh-spend.jsonl']),
  'abe458973e6998db20586c781ac5a3cbd4ca2fa565425e62722f0eb9c985210b',
);
assert.equal(
  hash(original['run-authorization.json']),
  'e07822e83a7c7b531606519ecd4fdf1027f2fa7cbaefd4bad92a2084590262fe',
);
mkdirSync(parent, { recursive: true });

async function fixture() {
  const root = mkdtempSync(join(parent, 'capability-'));
  for (const [name, bytes] of Object.entries(original)) writeFileSync(join(root, name), bytes);
  const wrapper = join(root, 'unit-helper.py');
  const helper = fileURLToPath(new URL('../lib/windows-capture-spend.py', import.meta.url));
  // Test-only copied source/isolated native process. No production root override exists.
  writeFileSync(
    wrapper,
    `import json,runpy,sys\nm=runpy.run_path(${JSON.stringify(helper)})\n` +
      `m['execute'].__globals__['FRESH_ROOT']=${JSON.stringify(resolve(root))}\n` +
      `try:\n r=m['execute'](json.load(sys.stdin));print(json.dumps({'ok':True,**r}))\n` +
      `except Exception:\n print(json.dumps({'ok':False}));sys.exit(1)\n`,
  );
  const copy = source
    .replace(/from '(\.\/[^']+)'/gu, (_all, ref) => `from '${new URL(ref, moduleUrl).href}'`)
    .replace(
      "const freshRoot = 'C:/dev/main/outputs/meri-fresh-20261003';",
      `const freshRoot = ${JSON.stringify(root)};`,
    )
    .replace(
      "const helper = fileURLToPath(new URL('./lib/windows-capture-spend.py', import.meta.url));",
      `const helper = ${JSON.stringify(wrapper)};`,
    );
  assert.notEqual(copy, source);
  const modulePath = join(root, 'unit-owner.mjs');
  writeFileSync(modulePath, copy);
  return { root, module: await import(pathToFileURL(modulePath).href) };
}
const reserve = () => ({ caseId: '01', captureRunId: randomUUID(), ceilingMicros: 15_000_000 });
const expected = (r) => ({
  caseId: r.caseId,
  captureRunId: r.captureRunId,
  maxSpendMicros: r.ceilingMicros,
  conversationId: randomUUID(),
  actorUserId: randomUUID(),
  clientId: randomUUID(),
  promptSha256: 'c'.repeat(64),
});
test.after(() => {
  for (const [name, bytes] of Object.entries(original))
    assert.deepEqual(readFileSync(join(liveRoot, name)), bytes, 'live evidence changed');
});

test('explicit fresh adoption does not append and returns exact cost/history state', async () => {
  const f = await fixture();
  const prior = f.module.adoptExistingFreshCaptureSpend({ pythonExecutable });
  assert.equal(prior.kind, 'meri-fresh-capture-spend-checkpoint');
  const owner = f.module.openCaptureSpendAggregate(prior, { pythonExecutable });
  assert.equal(owner.checkpoint().snapshot.knownSettledCostMicros, 9_841_281);
  assert.equal(owner.checkpoint().snapshot.remainingReservationMicros, 20_158_719);
  assert.equal(owner.checkpoint().snapshot.olderCosts, 'UNRESOLVED_SEPARATE_NOT_REPLACED');
  assert.deepEqual(readFileSync(join(f.root, 'fresh-spend.jsonl')), original['fresh-spend.jsonl']);
});

test('only same-process native reservation can claim; arbitrary future settlement JSON cannot release cost', async () => {
  const f = await fixture();
  const prior = f.module.adoptExistingFreshCaptureSpend({ pythonExecutable });
  const owner = f.module.openCaptureSpendAggregate(prior, { pythonExecutable });
  const reservation = owner.reserve(reserve()),
    binding = expected(reservation);
  assert.throws(() => f.module.claimCaptureSpendReservation({ ...reservation }, binding));
  f.module.claimCaptureSpendReservation(reservation, binding);
  assert.throws(() => f.module.claimCaptureSpendReservation(reservation, binding));
  assert.throws(() =>
    f.module.assertCaptureSpendReservation(reservation, { ...binding, clientId: randomUUID() }),
  );
  f.module.assertCaptureSpendReservation(reservation, binding);
  const bytes = readFileSync(join(f.root, 'fresh-spend.jsonl'));
  assert.throws(() =>
    owner.settleCaptured(reservation, { chargedCostMicros: 0, status: 'CAPTURE_COMPLETE' }),
  );
  assert.throws(() =>
    owner.settleMemoryRead(reservation, { kind: 'authenticated_memory_read_usage' }),
  );
  assert.deepEqual(readFileSync(join(f.root, 'fresh-spend.jsonl')), bytes);
  assert.equal(owner.checkpoint().snapshot.remainingReservationMicros, 5_158_719);
  assert.throws(() => f.module.openCaptureSpendAggregate(owner.checkpoint(), { pythonExecutable }));
});

test('two opened owners cannot both reserve; failed stale owner remains poisoned', async () => {
  const f = await fixture();
  const prior = f.module.adoptExistingFreshCaptureSpend({ pythonExecutable });
  const first = f.module.openCaptureSpendAggregate(prior, { pythonExecutable });
  const second = f.module.openCaptureSpendAggregate(prior, { pythonExecutable });
  first.reserve(reserve());
  assert.throws(() => second.reserve(reserve()));
  assert.throws(() => second.reserve(reserve()));
  assert.throws(() => f.module.adoptExistingFreshCaptureSpend({ pythonExecutable }));
  assert.equal(
    readFileSync(join(f.root, 'fresh-spend.jsonl'), 'utf8').trim().split('\n').length,
    21,
  );
});

test('unsupported cases and kind/format confusion cannot acquire a fresh reservation', async () => {
  const f = await fixture();
  const prior = f.module.adoptExistingFreshCaptureSpend({ pythonExecutable });
  const owner = f.module.openCaptureSpendAggregate(prior, { pythonExecutable });
  for (const caseId of ['02', '14', '46', '72'])
    assert.throws(() => owner.reserve({ ...reserve(), caseId }));
  assert.throws(() =>
    f.module.openCaptureSpendAggregate(
      { ...prior, kind: 'meri-original-capture-spend-checkpoint' },
      { pythonExecutable },
    ),
  );
  assert.throws(() =>
    f.module.openCaptureSpendAggregate(
      { ...prior, state: { ...prior.state, freshVersion: 2 } },
      { pythonExecutable },
    ),
  );
  assert.deepEqual(readFileSync(join(f.root, 'fresh-spend.jsonl')), original['fresh-spend.jsonl']);
});

test('existing original owner still reserves with its original ceiling and rejects fresh substitution', async () => {
  const f = await fixture(),
    run = randomUUID();
  const prior = f.module.initializeCaptureSpendAggregate({
    root: join(f.root, 'legacy'),
    pythonExecutable,
    inventory: {
      sliceId: randomUUID(),
      priorRuns: [],
      boundary: {
        kind: 'original_file01_capture_slice',
        firstCaseId: '01',
        firstCaptureRunId: run,
        inventorySha256: 'd'.repeat(64),
      },
    },
  });
  const owner = f.module.openCaptureSpendAggregate(prior, { pythonExecutable });
  const reservation = owner.reserve({ caseId: '01', captureRunId: run, ceilingMicros: 3_000_000 });
  f.module.claimCaptureSpendReservation(reservation, expected(reservation));
  assert.equal(owner.checkpoint().snapshot.remainingReservationMicros, 27_000_000);
  assert.throws(() =>
    f.module.openCaptureSpendAggregate(
      { ...prior, kind: 'meri-fresh-capture-spend-checkpoint' },
      { pythonExecutable },
    ),
  );
  assert.deepEqual(readFileSync(join(f.root, 'fresh-spend.jsonl')), original['fresh-spend.jsonl']);
});
