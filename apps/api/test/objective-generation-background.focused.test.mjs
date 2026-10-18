import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// Native Node type stripping only. Map these exact source-local JS URLs; do not
// install a broad resolver, compiler, Nest graph, provider or database fixture.
const source = new URL('../src/', import.meta.url);
const aliases = new Map([
  'clients/client-profile-fill-completion-projection',
  'clients/client-profile-fill.helpers',
  'clients/client-profile-fill-completion-runtime.shared',
].map((path) => [new URL(`${path}.js`, source).href, new URL(`${path}.ts`, source).href]));
registerHooks({
  resolve(specifier, context, nextResolve) {
    let mapped;
    try {
      mapped = aliases.get(new URL(specifier, context.parentURL).href);
    } catch {
      // Built-in and bare specifiers retain Node's normal resolution.
    }
    return nextResolve(mapped ?? specifier, context);
  },
});
const {
  BackgroundSnapshotError,
  OBJECTIVE_EMPTY_STEERING,
  ObjectivePacketBudgetError,
  objectivePacketAddition,
  projectObjectiveBackground,
  readObjectiveBackground,
} = await import(new URL('context/objective-generation-background.ts', source).href);
const { projectFillRunState } = await import(
  new URL('clients/client-profile-fill-completion-projection.ts', source).href
);

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TENANT = uuid(1);
const CLIENT = uuid(2);
const OLDER = '2026-09-01T09:00:00.000Z';
const LATER = '2026-10-15T12:00:00.000Z';
const SECRET = 'PRIVATE_RAW_WORKER_REVIEWER_ERROR_SENTINEL';
const hash = (n) => n.toString(16).padStart(64, '0');
const scoped = (id) => ({ id: uuid(id), tenantId: TENANT, clientId: CLIENT });
const clone = (value) => structuredClone(value);
const project = (raw) => projectObjectiveBackground(raw, TENANT, CLIENT);

function run(id = 10, changes = {}) {
  return {
    ...scoped(id), status: 'completed', stage: 'review_ready', workflowVersion: 2,
    requestedSources: ['public_web', 'sam_gov'], startedAt: OLDER,
    reportedSources: [{ source: 'public_web', status: 'completed', error: SECRET }],
    completedAt: LATER, updatedAt: LATER,
    error: SECRET, summary: { private: SECRET }, sourceStates: { private: SECRET },
    ...changes,
  };
}
function task(id = 30, changes = {}) {
  return {
    ...scoped(id), runId: uuid(10), lane: 'core', taskType: 'public_web',
    status: 'completed', dependsOn: [], updatedAt: LATER,
    input: { private: SECRET }, errorMessage: SECRET, workerId: SECRET,
    ...changes,
  };
}
function finding(id = 40, status = 'accepted', changes = {}) {
  return {
    ...scoped(id), runId: uuid(10), status, factKind: 'fact',
    kind: 'profile_field', targetKey: 'description', source: 'public_web',
    currentValue: { text: 'Previously saved description' },
    proposedValue: { text: 'Historically reviewed description' },
    evidence: [{ label: 'Synthetic retained citation', url: 'https://example.invalid/fixture' }],
    confidence: 0.8, contentHash: hash(id),
    reviewedAt: status === 'accepted' || status === 'rejected' ? LATER : null,
    appliedAt: status === 'accepted' ? LATER : null,
    createdAt: OLDER, updatedAt: LATER,
    reviewedBy: SECRET, rejectionReason: SECRET, error: SECRET,
    ...changes,
  };
}
function fixture() {
  return {
    runs: [run(), run(20, { startedAt: LATER })],
    tasks: [task(), task(31, {
      runId: uuid(20), lane: 'extension', taskType: 'reconciliation', status: 'running',
      dependsOn: ['facility_resolution'],
    })],
    findings: [
      finding(40), finding(41, 'pending', { runId: uuid(20) }),
      finding(42, 'rejected'), finding(43, 'informational'),
      finding(44, 'accepted', { factKind: 'recommendation', kind: 'bill_recommendation' }),
    ],
  };
}
const summary = (result) => result.groups.profile_fill_corpus[0];
const byId = (rows, id) => {
  const row = rows.find((entry) => entry.id === uuid(id));
  assert.ok(row, `expected synthetic row ${id}`);
  return row;
};
const keys = (row) => Object.keys(row).sort();
const BASE_FINDING_KEYS = [
  'id', 'runId', 'status', 'factKind', 'contentHash', 'createdAt', 'updatedAt', 'disposition',
];
const PAYLOAD_FINDING_KEYS = [
  ...BASE_FINDING_KEYS, 'kind', 'targetKey', 'source', 'currentValue', 'proposedValue',
  'evidence', 'confidence', 'reviewedAt', 'appliedAt',
];

test('retains older accepted findings alongside newer runs and labels historical evidence', () => {
  const raw = fixture();
  const result = project(raw);
  assert.equal(result.groups.profile_fill_runs.length, 2);
  const accepted = byId(result.groups.profile_fill_findings, 40);
  assert.equal(accepted.runId, uuid(10));
  assert.equal(accepted.disposition, 'historical_reviewed_applied');
  assert.deepEqual(accepted.proposedValue, raw.findings[0].proposedValue);
  assert.equal(summary(result).policy.accepted, 'historical_reviewed_applied_not_current_canonical_truth');
  assert.equal(summary(result).policy.currentCanonicalFacts, 'authoritative_over_historical_findings');
  assert.equal(summary(result).enumerationComplete, true);
  assert.deepEqual(summary(result).counts, {
    accepted: 2, pending: 1, rejected: 1, informational: 1,
    runs: 2, coreTasks: 1, extensionTasks: 1,
  });
});

test('keeps pending candidates and recommendations distinct from accepted facts', () => {
  const result = project(fixture());
  const pending = byId(result.groups.profile_fill_findings, 41);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.disposition, 'candidate_unverified');
  assert.equal(pending.reviewedAt, null);
  assert.equal(pending.appliedAt, null);
  const recommendation = byId(result.groups.profile_fill_findings, 44);
  assert.equal(recommendation.factKind, 'recommendation');
  assert.equal(recommendation.disposition, 'historical_reviewed_applied');
  assert.equal(summary(result).policy.factKind, 'recommendations_are_not_facts');
  assert.equal(summary(result).policy.pending, 'candidate_unverified_never_verified_fact');
  const raw = fixture();
  Object.assign(raw.findings[1], { factKind: 'recommendation', kind: 'bill_recommendation' });
  const pendingRecommendation = byId(project(raw).groups.profile_fill_findings, 41);
  assert.equal(pendingRecommendation.factKind, 'recommendation');
  assert.equal(pendingRecommendation.disposition, 'candidate_unverified');
});

test('extension reconciliation keeps the merged run pending and suppresses stale completion time', () => {
  const row = byId(project(fixture()).groups.profile_fill_runs, 20);
  assert.equal(row.status, 'running');
  assert.equal(row.stage, 'reconciliation');
  assert.equal(row.pending, true);
  assert.equal(row.completedAt, null);
  assert.deepEqual(row.progress, { total: 1, queued: 0, running: 1, completed: 0, failed: 0, cancelled: 0 });
});

test('retains a legal shared task UUID across core and extension lanes', () => {
  const raw = {
    runs: [run()],
    tasks: [
      task(30, { lane: 'extension', taskType: 'completion_audit', status: 'running' }),
      task(30),
    ],
    findings: [],
  };
  const result = project(raw);
  assert.deepEqual(result.groups.profile_fill_tasks.map(({ id, lane }) => ({ id, lane })), [
    { id: uuid(30), lane: 'core' }, { id: uuid(30), lane: 'extension' },
  ]);
  const projectedRun = byId(result.groups.profile_fill_runs, 10);
  assert.equal(projectedRun.status, 'running');
  assert.equal(projectedRun.stage, 'reconciliation');
  assert.equal(projectedRun.progress.total, 2);
  assert.equal(summary(result).counts.coreTasks, 1);
  assert.equal(summary(result).counts.extensionTasks, 1);
  const reordered = clone(raw);
  reordered.tasks.reverse();
  assert.deepEqual(project(reordered), result);
});

for (const [status, stage] of [['running', 'preparing'], ['partial', 'research']]) {
  for (const withCoreTask of [false, true]) {
    test(`preserves stored ${status}/${stage} without extension tasks (${withCoreTask ? 'core task' : 'no tasks'})`, () => {
      const raw = {
        runs: [run(10, { status, stage, completedAt: LATER })],
        tasks: withCoreTask ? [task()] : [],
        findings: [],
      };
      const row = byId(project(raw).groups.profile_fill_runs, 10);
      assert.equal(row.projection, 'stored_core');
      assert.equal(row.status, status);
      assert.equal(row.stage, stage);
      assert.equal(row.pending, status === 'running');
      assert.equal(row.completedAt, LATER);
      assert.equal(row.recordedStatus, status);
      assert.equal(row.recordedStage, stage);
      assert.equal(row.recordedCompletedAt, LATER);
      assert.equal(row.progress.total, withCoreTask ? 1 : 0);
    });
  }
}

test('sorts reported source states and retains only source/status, including an absent status', () => {
  const raw = fixture();
  raw.runs[0].reportedSources = [
    { source: 'sam_gov', status: 'running', error: SECRET, count: 999 },
    { source: 'advocacy_history', status: null, errorMessage: SECRET },
    { source: 'public_web', status: 'completed', raw: { private: SECRET } },
  ];
  const before = clone(raw);
  const result = project(raw);
  const reported = byId(result.groups.profile_fill_runs, 10).reportedSources;
  assert.deepEqual(reported, [
    { source: 'advocacy_history', status: null },
    { source: 'public_web', status: 'completed' },
    { source: 'sam_gov', status: 'running' },
  ]);
  for (const entry of reported) assert.deepEqual(keys(entry), ['source', 'status']);
  assert.equal(JSON.stringify(reported).includes(SECRET), false);
  assert.deepEqual(raw, before);
  const reordered = clone(raw);
  reordered.runs[0].reportedSources.reverse();
  assert.deepEqual(project(reordered), result);
});

test('digest binds reported source status while excluding its discarded private diagnostics', () => {
  const raw = fixture();
  const initial = project(raw).digest;
  const privateChange = clone(raw);
  privateChange.runs[0].reportedSources[0].error = 'A different private diagnostic';
  assert.equal(project(privateChange).digest, initial);
  const stateChange = clone(raw);
  stateChange.runs[0].reportedSources[0].status = 'failed';
  assert.notEqual(project(stateChange).digest, initial);
});

test('accepts nullable optional completion dates and normalizes valid ISO offset timestamps', () => {
  const raw = fixture();
  raw.runs[0].completedAt = null;
  raw.findings[0].updatedAt = '2026-10-15T14:00:00+02:00';
  const result = project(raw);
  assert.equal(byId(result.groups.profile_fill_runs, 10).completedAt, null);
  assert.equal(byId(result.groups.profile_fill_findings, 40).updatedAt, LATER);
});

test('whitelists accepted/pending payload and fully withholds rejected/informational payload', () => {
  const raw = fixture();
  for (const row of raw.findings.filter((entry) => ['rejected', 'informational'].includes(entry.status))) {
    Object.assign(row, {
      targetKey: SECRET, source: SECRET, kind: SECRET,
      currentValue: { private: SECRET }, proposedValue: { private: SECRET },
      evidence: [{ excerpt: SECRET }], reviewedBy: SECRET,
    });
  }
  const result = project(raw);
  for (const row of result.groups.profile_fill_findings) {
    if (row.status === 'rejected' || row.status === 'informational') {
      assert.deepEqual(keys(row), [...BASE_FINDING_KEYS].sort());
      assert.equal(row.disposition, 'withheld_not_supporting');
    } else {
      assert.deepEqual(keys(row), [...PAYLOAD_FINDING_KEYS].sort());
    }
  }
  for (const row of result.groups.profile_fill_tasks) {
    assert.deepEqual(keys(row), ['id', 'runId', 'lane', 'taskType', 'status', 'updatedAt'].sort());
    assert.equal(Object.hasOwn(row, 'dependsOn'), false);
  }
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(summary(result).policy.rawSourceAuthority, 'not_granted_by_retained_artifact_read');
});

const LEGACY_RUN_EDGES = [
  ['completed core with running reconciliation', 'completed', ['completed'], [['running', 'reconciliation']]],
  ['completed core with queued extension', 'completed', ['completed'], [['queued', 'federal_market']]],
  ['mixed terminal success and failure', 'completed', ['completed'], [['failed', 'completion_audit']]],
  ['all failed tasks', 'running', ['failed'], [['failed', 'completion_audit']]],
  ['skipped extension is terminal success', 'running', [], [['skipped', 'completion_audit']]],
  ['cancelled run retains cancellation despite queued tasks', 'cancelled', ['queued'], [['running', 'reconciliation']]],
  ['legacy completed run without tasks', 'completed', [], []],
  ['legacy failed run without tasks', 'failed', [], []],
  ['legacy running run without tasks', 'running', [], []],
];
for (const [label, coreStatus, coreStatuses, extensionStates] of LEGACY_RUN_EDGES) {
  test(`uses actual Fill projection helper: ${label}`, () => {
    const core = coreStatuses.map((status, index) => task(100 + index, { status }));
    const extension = extensionStates.map(([status, taskType], index) => task(200 + index, {
      lane: 'extension', status, taskType,
    }));
    const merged = projectFillRunState(coreStatus, core, extension);
    const stage = coreStatus === 'running' ? 'research' : coreStatus === 'failed' ? 'failed' : 'review_ready';
    const expected = extension.length ? merged : { status: coreStatus, stage,
      pending: coreStatus === 'running', progress: merged.progress };
    const result = project({ runs: [run(10, { status: coreStatus, stage })], tasks: [...core, ...extension], findings: [] });
    const actual = byId(result.groups.profile_fill_runs, 10);
    assert.deepEqual({
      status: actual.status, stage: actual.stage, pending: actual.pending, progress: actual.progress,
    }, expected);
    assert.equal(actual.completedAt, extension.length && expected.pending ? null : LATER);
  });
}

test('an empty retained Fill corpus is complete zero evidence, with no fabricated run or finding', () => {
  const result = project({ runs: [], tasks: [], findings: [] });
  assert.deepEqual(result.groups.profile_fill_runs, []);
  assert.deepEqual(result.groups.profile_fill_tasks, []);
  assert.deepEqual(result.groups.profile_fill_findings, []);
  assert.deepEqual(summary(result).counts, {
    accepted: 0, pending: 0, rejected: 0, informational: 0, runs: 0, coreTasks: 0, extensionTasks: 0,
  });
  assert.equal(summary(result).enumerationComplete, true);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
});

test('digest is stable under enumeration/source ordering and excludes discarded raw fields', () => {
  const raw = fixture();
  const before = clone(raw);
  const initial = project(raw);
  assert.deepEqual(raw, before, 'projection must not mutate the retained snapshot');
  const reordered = clone(raw);
  for (const name of ['runs', 'tasks', 'findings']) reordered[name].reverse();
  for (const row of reordered.runs) row.requestedSources.reverse();
  reordered.runs[0].error = 'a different private error';
  reordered.tasks[0].workerId = 'a different worker';
  reordered.freshObservationClock = '2099-01-01T00:00:00.000Z';
  assert.deepEqual(project(reordered), initial);
  assert.deepEqual(project(raw), initial);
});

test('digest binds actual retained payload, finding disposition and merged task state', () => {
  const raw = fixture();
  const initial = project(raw).digest;
  for (const change of [
    (next) => { next.findings[0].proposedValue.text = 'A materially different retained value'; },
    (next) => { next.findings[1].status = 'rejected'; next.findings[1].reviewedAt = LATER; },
    (next) => { next.tasks[1].status = 'failed'; },
    (next) => { next.runs[0].workflowVersion = 3; },
  ]) {
    const next = clone(raw);
    change(next);
    assert.notEqual(project(next).digest, initial);
  }
});

const MALFORMED = [
  ['missing runs enumeration', (raw) => { delete raw.runs; }],
  ['non-array tasks enumeration', (raw) => { raw.tasks = {}; }],
  ['missing findings enumeration', (raw) => { delete raw.findings; }],
  ['foreign run tenant', (raw) => { raw.runs[0].tenantId = uuid(999); }],
  ['foreign task client', (raw) => { raw.tasks[0].clientId = uuid(999); }],
  ['foreign finding tenant', (raw) => { raw.findings[0].tenantId = uuid(999); }],
  ['invalid row UUID', (raw) => { raw.findings[0].id = 'not-a-uuid'; }],
  ['unknown run status', (raw) => { raw.runs[0].status = 'invented'; }],
  ['unknown stored run stage', (raw) => { raw.runs[0].stage = 'invented'; }],
  ['missing reported source enumeration', (raw) => { delete raw.runs[0].reportedSources; }],
  ['non-array reported source enumeration', (raw) => { raw.runs[0].reportedSources = {}; }],
  ['non-array accepted evidence', (raw) => { raw.findings[0].evidence = { private: SECRET }; }],
  ['non-array pending evidence', (raw) => { raw.findings[1].evidence = { private: SECRET }; }],
  ['unknown task status', (raw) => { raw.tasks[0].status = 'invented'; }],
  ['unknown finding status', (raw) => { raw.findings[0].status = 'invented'; }],
  ['unknown finding fact kind', (raw) => { raw.findings[0].factKind = 'verified_truth'; }],
  ['unknown task lane', (raw) => { raw.tasks[0].lane = 'private'; }],
  ['missing task run', (raw) => { raw.tasks[0].runId = uuid(999); }],
  ['missing finding run', (raw) => { raw.findings[0].runId = uuid(999); }],
  ['duplicate run ID', (raw) => { raw.runs.push(clone(raw.runs[0])); }],
  ['duplicate task ID within lane', (raw) => { raw.tasks.push(clone(raw.tasks[0])); }],
  ['duplicate task ID within extension lane', (raw) => { raw.tasks.push(clone(raw.tasks[1])); }],
  ['duplicate finding ID', (raw) => { raw.findings.push(clone(raw.findings[0])); }],
  ['short content hash', (raw) => { raw.findings[0].contentHash = 'a'.repeat(63); }],
  ['non-hex content hash', (raw) => { raw.findings[0].contentHash = 'g'.repeat(64); }],
  ['invalid run date', (raw) => { raw.runs[0].startedAt = 'not-a-date'; }],
  ['invalid task date', (raw) => { raw.tasks[0].updatedAt = '2026-99-01T00:00:00.000Z'; }],
  ['invalid finding date', (raw) => { raw.findings[0].createdAt = '2026-10-15'; }],
  ['impossible ISO calendar date', (raw) => { raw.findings[0].updatedAt = '2026-02-30T00:00:00.000Z'; }],
  ['accepted finding without applied date', (raw) => { raw.findings[0].appliedAt = null; }],
  ['pending finding with applied date', (raw) => { raw.findings[1].appliedAt = LATER; }],
  ['non-positive workflow version', (raw) => { raw.runs[0].workflowVersion = 0; }],
  ['non-finite confidence', (raw) => { raw.findings[0].confidence = NaN; }],
  ['unserializable accepted payload', (raw) => { raw.findings[0].proposedValue = undefined; }],
];
for (const [label, mutate] of MALFORMED) {
  test(`rejects incomplete or malformed background: ${label}`, () => {
    const raw = fixture();
    mutate(raw);
    assert.throws(() => project(raw), BackgroundSnapshotError);
  });
}

test('reader uses one parameterized, scoped, read-only SQL snapshot with conditional payload selection', async () => {
  const raw = fixture();
  const calls = [];
  const tx = {
    async $queryRaw(strings, ...values) {
      assert.ok(Array.isArray(strings.raw), 'must call the actual tagged-SQL interface');
      calls.push({ sql: strings.reduce((sql, part, index) => sql + (index ? `$${index}` : '') + part, ''), values });
      return [{ background: raw }];
    },
  };
  assert.deepEqual(await readObjectiveBackground(tx, TENANT, CLIENT), project(raw));
  assert.equal(calls.length, 1);
  const { sql, values } = calls[0];
  assert.deepEqual(values, Array.from({ length: 4 }, () => [TENANT, CLIENT]).flat());
  assert.match(sql, /FROM\s+client_profile_fill_run\s+r\s+WHERE\s+r\.tenant_id=\$1::uuid\s+AND\s+r\.client_id=\$2::uuid/i);
  assert.match(sql, /FROM\s+client_profile_fill_task\s+t\s+WHERE\s+t\.tenant_id=\$3::uuid\s+AND\s+t\.client_id=\$4::uuid/i);
  assert.match(sql, /FROM\s+client_profile_fill_extension_task\s+t\s+WHERE\s+t\.tenant_id=\$5::uuid\s+AND\s+t\.client_id=\$6::uuid/i);
  assert.match(sql, /FROM\s+client_profile_fill_finding\s+f\s+WHERE\s+f\.tenant_id=\$7::uuid\s+AND\s+f\.client_id=\$8::uuid/i);
  assert.match(sql, /CASE\s+WHEN\s+f\.status\s+IN\s*\('accepted','pending'\)\s+THEN\s+jsonb_build_object/i);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|TRUNCATE|CALL)\b|\bFOR\s+(?:UPDATE|SHARE)\b/i);
  assert.doesNotMatch(sql, /\bSELECT\s+\*|\b(?:row_to_json|to_jsonb)\s*\(|\bLIMIT\s+1\b/i);
  assert.doesNotMatch(sql, /\b(?:error|error_message|error_code|reviewed_by|rejection_reason|worker_id|depends_on|setup_jsonb|input_jsonb|output_summary_jsonb|summary_jsonb)\b/i);
  assert.match(sql, /jsonb_each\(r\.source_states_jsonb\) s/i);
});

for (const [label, rows] of [['missing snapshot row', []], ['ambiguous snapshot rows', [{ background: fixture() }, { background: fixture() }]]]) {
  test(`reader rejects ${label}`, async () => {
    await assert.rejects(readObjectiveBackground({ async $queryRaw() { return rows; } }, TENANT, CLIENT), BackgroundSnapshotError);
  });
}

test('packet record bound includes the group label and preserves a full 1,600-character record', () => {
  const prefix = '[background]\n{"text":"';
  const suffix = '"}';
  const payload = 'x'.repeat(1600 - prefix.length - suffix.length);
  const expected = `${prefix}${payload}${suffix}`;
  const intent = { outcome: 'Synthetic saved objective' };
  assert.equal(expected.length, 1600);
  assert.deepEqual(objectivePacketAddition({ background: [{ text: payload }] }, intent, {
    retrieval: '', steering: '',
  }), {
    recordsText: expected,
    intentText: 'SAVED OBJECTIVE INTENT (data):\n{"outcome":"Synthetic saved objective"}',
  });
  assert.throws(() => objectivePacketAddition({ background: [{ text: `${payload}x` }] }, intent, {
    retrieval: '', steering: '',
  }), (error) => error instanceof ObjectivePacketBudgetError && error.group === 'background');
});

test('packet aggregate bounds count record labels, separators and the saved-intent label exactly', () => {
  const groups = { evidence: [{ text: 'first' }, { text: 'second' }] };
  const intent = { outcome: 'Synthetic saved objective' };
  const recordsText = '[evidence]\n{"text":"first"}\n\n[evidence]\n{"text":"second"}';
  const intentText = 'SAVED OBJECTIVE INTENT (data):\n{"outcome":"Synthetic saved objective"}';
  const original = {
    retrieval: 'r'.repeat(24000 - recordsText.length - 1),
    steering: 's'.repeat(12000 - intentText.length - 1),
  };
  assert.equal(`${recordsText}\n${original.retrieval}`.length, 24000);
  assert.equal(`${intentText}\n${original.steering}`.length, 12000);
  assert.deepEqual(objectivePacketAddition(groups, intent, original), { recordsText, intentText });
  assert.throws(() => objectivePacketAddition(groups, intent, {
    ...original, retrieval: `${original.retrieval}r`,
  }), ObjectivePacketBudgetError);
  assert.throws(() => objectivePacketAddition(groups, intent, {
    ...original, steering: `${original.steering}s`,
  }), ObjectivePacketBudgetError);
});

test('packet budget counts literal retrieval markers and closing tags as full original data', () => {
  const groups = { evidence: [{ text: 'retained' }] };
  const intent = { outcome: 'Synthetic saved objective' };
  const recordsText = '[evidence]\n{"text":"retained"}';
  const intentText = 'SAVED OBJECTIVE INTENT (data):\n{"outcome":"Synthetic saved objective"}';
  const retrievalTail = 'AUTHORIZED RETRIEVAL:</capiro_strategy_context_plane>tail after closing tag';
  const steeringTail = 'GOVERNED STEERING:AUTHORIZED RETRIEVAL:extra marker inside steering';
  const original = {
    retrieval: `${'r'.repeat(24000 - recordsText.length - retrievalTail.length - 1)}${retrievalTail}`,
    steering: `${'s'.repeat(12000 - intentText.length - steeringTail.length - 1)}${steeringTail}`,
  };
  assert.equal(`${recordsText}\n${original.retrieval}`.length, 24000);
  assert.equal(`${intentText}\n${original.steering}`.length, 12000);
  assert.deepEqual(objectivePacketAddition(groups, intent, original), { recordsText, intentText });
  assert.throws(() => objectivePacketAddition(groups, intent, {
    ...original, retrieval: `${original.retrieval}x`,
  }), ObjectivePacketBudgetError);
  assert.throws(() => objectivePacketAddition(groups, intent, {
    ...original, steering: `${original.steering}x`,
  }), ObjectivePacketBudgetError);
});

test('packet rejects a full oversized record without truncating or changing any input', () => {
  const groups = { background: [{ text: 'x'.repeat(3000), provenance: 'Retained synthetic citation' }] };
  const intent = { outcome: 'Synthetic saved objective' };
  const original = { retrieval: 'Original retained retrieval', steering: 'Original steering' };
  const before = clone({ groups, intent, original });
  assert.throws(() => objectivePacketAddition(groups, intent, original),
    (error) => error instanceof ObjectivePacketBudgetError && error.group === 'background');
  assert.deepEqual({ groups, intent, original }, before);
});

test('packet does not duplicate relationship history already counted in the original retrieval', () => {
  const history = { text: 'h'.repeat(4000) };
  const groups = { relationship_history: [history], evidence: [{ text: 'new' }] };
  const intent = { outcome: 'Synthetic saved objective' };
  const recordsText = '[evidence]\n{"text":"new"}';
  const historyText = `[relationship_history]\n${JSON.stringify(history)}`;
  const original = {
    retrieval: `${historyText}${'r'.repeat(24000 - recordsText.length - historyText.length - 1)}`,
    steering: '',
  };
  const before = clone({ groups, intent, original });
  const actual = objectivePacketAddition(groups, intent, original);
  assert.equal(actual.recordsText, recordsText);
  assert.equal(actual.recordsText.includes('relationship_history'), false);
  assert.equal(`${actual.recordsText}\n${original.retrieval}`.length, 24000);
  assert.deepEqual({ groups, intent, original }, before);
  assert.throws(() => objectivePacketAddition(groups, intent, {
    ...original, retrieval: `${original.retrieval}x`,
  }), ObjectivePacketBudgetError);
});

test('packet steering bound counts the literal empty-steering fallback and its separator', () => {
  const fallback = '(no approved steering items selected)';
  assert.equal(OBJECTIVE_EMPTY_STEERING, fallback);
  const prefix = 'SAVED OBJECTIVE INTENT (data):\n{"outcome":"';
  const suffix = '"}';
  const payload = 'x'.repeat(12000 - prefix.length - suffix.length - fallback.length - 1);
  const intent = { outcome: payload };
  const intentText = `${prefix}${payload}${suffix}`;
  assert.equal(`${intentText}\n${fallback}`.length, 12000);
  assert.deepEqual(objectivePacketAddition({}, intent, { retrieval: '', steering: '' }), {
    recordsText: '', intentText,
  });
  assert.throws(() => objectivePacketAddition({}, { outcome: `${payload}x` }, {
    retrieval: '', steering: '',
  }), ObjectivePacketBudgetError);
});

test('packet retrieval bound adds no separator when either retrieval part is empty', () => {
  const intent = { outcome: 'Synthetic saved objective' };
  const original = { retrieval: 'r'.repeat(24000), steering: '' };
  assert.equal(objectivePacketAddition({}, intent, original).recordsText, '');
  assert.throws(() => objectivePacketAddition({}, intent, {
    ...original, retrieval: `${original.retrieval}r`,
  }), ObjectivePacketBudgetError);

  const prefix = '[background]\n{"text":"';
  const suffix = '"}';
  const fullPayload = 'x'.repeat(1600 - prefix.length - suffix.length);
  const lastPayload = 'y'.repeat(1572 - prefix.length - suffix.length);
  const fullRecord = `${prefix}${fullPayload}${suffix}`;
  const lastRecord = `${prefix}${lastPayload}${suffix}`;
  const groups = { background: [
    ...Array.from({ length: 14 }, () => ({ text: fullPayload })),
    { text: lastPayload },
  ] };
  const recordsText = [...Array(14).fill(fullRecord), lastRecord].join('\n\n');
  assert.equal(fullRecord.length, 1600);
  assert.equal(lastRecord.length, 1572);
  assert.equal(recordsText.length, 24000);
  assert.equal(objectivePacketAddition(groups, intent, {
    retrieval: '', steering: '',
  }).recordsText, recordsText);
  const oversized = clone(groups);
  oversized.background[14].text += 'y';
  assert.throws(() => objectivePacketAddition(oversized, intent, {
    retrieval: '', steering: '',
  }), ObjectivePacketBudgetError);
});
