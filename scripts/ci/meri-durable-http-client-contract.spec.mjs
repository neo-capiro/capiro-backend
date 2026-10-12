// Frozen original reachable HTTP closure is an oracle, never a frontend import.
// Candidate execution loads only the import-free API test client into a VM with fake fetch.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
const ORIGINAL_SOURCE = "export type MeriDurableRunStatus =\n  | 'running'\n  | 'cancel_requested'\n  | 'complete'\n  | 'failed'\n  | 'cancelled'\n  | 'interrupted'\n  | 'partial'\n  | 'awaiting_clarification';\n\nexport interface MeriDurableResearchRun {\n  id: string;\n  leaseEpoch: number;\n  eventSequence: number;\n  phase: 'plan' | 'research';\n  status: MeriDurableRunStatus;\n  stage: string;\n  startedAt: string;\n  heartbeatAt: string;\n  deadlineAt?: string;\n  finishedAt?: string;\n  failureReason?: string;\n  readyToStart?: boolean;\n}\n\nexport type MeriDurableStepOutcome =\n  | 'pending'\n  | 'reserved'\n  | 'completed'\n  | 'retryable_failure'\n  | 'waiting_for_approval'\n  | 'uncertain_effect'\n  | 'superseded'\n  | 'cancelled';\n\nexport interface MeriDurableResearchStep {\n  id: string;\n  objective: string;\n  dependsOn: string[];\n  goalRevision: number;\n  effect: 'safe_read' | 'approval_required';\n  attempt: number;\n  deadlineAt: string | null;\n  outcome: MeriDurableStepOutcome;\n  sourceRefs: string[];\n  operationRefs: string[];\n  leaseEpoch: number;\n  completedAt: string | null;\n  failureCode: string | null;\n}\n\nexport interface MeriDurableResearchEvent {\n  version: 1;\n  sequence: number;\n  type:\n    | 'plan_admitted'\n    | 'step_reserved'\n    | 'step_completed'\n    | 'step_failed'\n    | 'steering_accepted'\n    | 'steering_applied'\n    | 'cancel_requested'\n    | 'cancelled';\n  goalRevision: number;\n  planVersion: number;\n  stepId: string | null;\n  createdAt: string;\n  detail?: string;\n}\n\nexport interface MeriDurableResearchCoordinator {\n  version: 1;\n  planVersion: number;\n  goalRevision: number;\n  goal: { objective: string; constraints: string[]; deliverables: string[] };\n  deadlineAt: string | null;\n  leaseEpoch: number;\n  aggregateBudgetRef: 'researchToolBudget';\n  cancellation:\n    | { state: 'none' }\n    | {\n        state: 'requested' | 'observed';\n        requestId: string;\n        reason: string;\n        requestedAt: string;\n        observedAt: string | null;\n      };\n  steps: MeriDurableResearchStep[];\n}\n\nexport interface MeriDurableResearchSnapshot {\n  version: 1;\n  researchId: string;\n  // The API serializer returns null when terminal/legacy metadata no longer has\n  // a readable run. The coordinator remains the authoritative retained record.\n  run: MeriDurableResearchRun | null;\n  coordinator: MeriDurableResearchCoordinator;\n  events: MeriDurableResearchEvent[];\n  nextSequence: number;\n  cursorResetRequired?: true;\n}\n\nexport interface MeriDurableSteeringReceipt {\n  requestId: string;\n  sequence: number;\n  previousGoalRevision: number;\n  goalRevision: number;\n  message: string;\n  acceptedAt: string;\n  state: 'pending_safe_boundary' | 'applied';\n  appliedAt?: string | null;\n}\n\nexport interface MeriDurableSteeringResponse {\n  version: 1;\n  accepted: true;\n  idempotentReplay: boolean;\n  receipt: MeriDurableSteeringReceipt;\n}\n\nexport class MeriDurableResearchHttpError extends Error {\n  constructor(\n    readonly status: number,\n    readonly body: unknown,\n  ) {\n    super(`Durable research request failed (HTTP ${status}).`);\n    this.name = 'MeriDurableResearchHttpError';\n  }\n}\n\nconst EVENT_TYPES = new Set<MeriDurableResearchEvent['type']>([\n  'plan_admitted',\n  'step_reserved',\n  'step_completed',\n  'step_failed',\n  'steering_accepted',\n  'steering_applied',\n  'cancel_requested',\n  'cancelled',\n]);\nconst MAX_EVENT_HISTORY = 200;\nconst RUN_STATUSES = new Set<MeriDurableRunStatus>([\n  'running',\n  'cancel_requested',\n  'complete',\n  'failed',\n  'cancelled',\n  'interrupted',\n  'partial',\n  'awaiting_clarification',\n]);\nconst STEP_OUTCOMES = new Set<MeriDurableStepOutcome>([\n  'pending',\n  'reserved',\n  'completed',\n  'retryable_failure',\n  'waiting_for_approval',\n  'uncertain_effect',\n  'superseded',\n  'cancelled',\n]);\n\nconst record = (value: unknown): Record<string, unknown> | null =>\n  value && typeof value === 'object' && !Array.isArray(value)\n    ? (value as Record<string, unknown>)\n    : null;\nconst stringArray = (value: unknown): string[] | null =>\n  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;\nconst nonNegativeInteger = (value: unknown): value is number =>\n  Number.isSafeInteger(value) && Number(value) >= 0;\n\nfunction readRun(value: unknown): MeriDurableResearchRun | null {\n  const run = record(value);\n  if (\n    !run ||\n    typeof run.id !== 'string' ||\n    !nonNegativeInteger(run.leaseEpoch) ||\n    !nonNegativeInteger(run.eventSequence) ||\n    !['plan', 'research'].includes(String(run.phase)) ||\n    !RUN_STATUSES.has(run.status as MeriDurableRunStatus) ||\n    typeof run.stage !== 'string' ||\n    typeof run.startedAt !== 'string' ||\n    typeof run.heartbeatAt !== 'string'\n  )\n    return null;\n  return {\n    id: run.id,\n    leaseEpoch: run.leaseEpoch,\n    eventSequence: run.eventSequence,\n    phase: run.phase as 'plan' | 'research',\n    status: run.status as MeriDurableRunStatus,\n    stage: run.stage,\n    startedAt: run.startedAt,\n    heartbeatAt: run.heartbeatAt,\n    ...(typeof run.deadlineAt === 'string' ? { deadlineAt: run.deadlineAt } : {}),\n    ...(typeof run.finishedAt === 'string' ? { finishedAt: run.finishedAt } : {}),\n    ...(typeof run.failureReason === 'string' ? { failureReason: run.failureReason } : {}),\n    ...(run.readyToStart === true ? { readyToStart: true } : {}),\n  };\n}\n\nfunction readStep(value: unknown): MeriDurableResearchStep | null {\n  const step = record(value);\n  const dependsOn = stringArray(step?.dependsOn);\n  const sourceRefs = stringArray(step?.sourceRefs);\n  const operationRefs = stringArray(step?.operationRefs);\n  if (\n    !step ||\n    typeof step.id !== 'string' ||\n    typeof step.objective !== 'string' ||\n    !dependsOn ||\n    !nonNegativeInteger(step.goalRevision) ||\n    !['safe_read', 'approval_required'].includes(String(step.effect)) ||\n    !nonNegativeInteger(step.attempt) ||\n    !(step.deadlineAt === null || typeof step.deadlineAt === 'string') ||\n    !STEP_OUTCOMES.has(step.outcome as MeriDurableStepOutcome) ||\n    !sourceRefs ||\n    !operationRefs ||\n    !nonNegativeInteger(step.leaseEpoch) ||\n    !(step.completedAt === null || typeof step.completedAt === 'string') ||\n    !(step.failureCode === null || typeof step.failureCode === 'string')\n  )\n    return null;\n  return {\n    id: step.id,\n    objective: step.objective,\n    dependsOn,\n    goalRevision: step.goalRevision,\n    effect: step.effect as MeriDurableResearchStep['effect'],\n    attempt: step.attempt,\n    deadlineAt: step.deadlineAt as string | null,\n    outcome: step.outcome as MeriDurableStepOutcome,\n    sourceRefs,\n    operationRefs,\n    leaseEpoch: step.leaseEpoch,\n    completedAt: step.completedAt as string | null,\n    failureCode: step.failureCode as string | null,\n  };\n}\n\nfunction readEvent(value: unknown): MeriDurableResearchEvent | null {\n  const event = record(value);\n  if (\n    !event ||\n    event.version !== 1 ||\n    !nonNegativeInteger(event.sequence) ||\n    !EVENT_TYPES.has(event.type as MeriDurableResearchEvent['type']) ||\n    !nonNegativeInteger(event.goalRevision) ||\n    !nonNegativeInteger(event.planVersion) ||\n    !(event.stepId === null || typeof event.stepId === 'string') ||\n    typeof event.createdAt !== 'string'\n  )\n    return null;\n  return event as unknown as MeriDurableResearchEvent;\n}\n\nexport function readMeriDurableResearchSnapshot(\n  value: unknown,\n): MeriDurableResearchSnapshot | null {\n  const snapshot = record(value);\n  const run = snapshot?.run === null ? null : readRun(snapshot?.run);\n  const coordinator = record(snapshot?.coordinator);\n  const goal = record(coordinator?.goal);\n  const constraints = stringArray(goal?.constraints);\n  const deliverables = stringArray(goal?.deliverables);\n  const cancellation = record(coordinator?.cancellation);\n  const parsedCancellation = readCancellation(cancellation);\n  const rawSteps = coordinator?.steps;\n  const rawEvents = snapshot?.events;\n  const steps = Array.isArray(rawSteps)\n    ? rawSteps.map(readStep).filter((step): step is MeriDurableResearchStep => Boolean(step))\n    : null;\n  const events = Array.isArray(rawEvents)\n    ? rawEvents.map(readEvent).filter((event): event is MeriDurableResearchEvent => Boolean(event))\n    : null;\n  if (\n    !snapshot ||\n    snapshot.version !== 1 ||\n    typeof snapshot.researchId !== 'string' ||\n    !(snapshot.run === null || run) ||\n    !coordinator ||\n    coordinator.version !== 1 ||\n    !nonNegativeInteger(coordinator.planVersion) ||\n    !nonNegativeInteger(coordinator.goalRevision) ||\n    !goal ||\n    typeof goal.objective !== 'string' ||\n    !constraints ||\n    !deliverables ||\n    !(coordinator.deadlineAt === null || typeof coordinator.deadlineAt === 'string') ||\n    !nonNegativeInteger(coordinator.leaseEpoch) ||\n    coordinator.aggregateBudgetRef !== 'researchToolBudget' ||\n    !parsedCancellation ||\n    !steps ||\n    !Array.isArray(rawSteps) ||\n    steps.length !== rawSteps.length ||\n    !events ||\n    !Array.isArray(rawEvents) ||\n    events.length !== rawEvents.length ||\n    !nonNegativeInteger(snapshot.nextSequence)\n  )\n    return null;\n  return {\n    version: 1,\n    researchId: snapshot.researchId,\n    run,\n    coordinator: {\n      version: 1,\n      planVersion: coordinator.planVersion,\n      goalRevision: coordinator.goalRevision,\n      goal: { objective: goal.objective, constraints, deliverables },\n      deadlineAt: coordinator.deadlineAt as string | null,\n      leaseEpoch: coordinator.leaseEpoch,\n      aggregateBudgetRef: 'researchToolBudget',\n      cancellation: parsedCancellation,\n      steps,\n    },\n    events: events.sort((left, right) => left.sequence - right.sequence).slice(-MAX_EVENT_HISTORY),\n    nextSequence: snapshot.nextSequence,\n    ...(snapshot.cursorResetRequired === true ? { cursorResetRequired: true as const } : {}),\n  };\n}\n\nfunction readCancellation(\n  cancellation: Record<string, unknown> | null,\n): MeriDurableResearchCoordinator['cancellation'] | null {\n  if (!cancellation) return null;\n  if (cancellation.state === 'none') return { state: 'none' };\n  if (\n    !['requested', 'observed'].includes(String(cancellation.state)) ||\n    typeof cancellation.requestId !== 'string' ||\n    typeof cancellation.reason !== 'string' ||\n    typeof cancellation.requestedAt !== 'string' ||\n    !(cancellation.observedAt === null || typeof cancellation.observedAt === 'string')\n  )\n    return null;\n  return {\n    state: cancellation.state as 'requested' | 'observed',\n    requestId: cancellation.requestId,\n    reason: cancellation.reason,\n    requestedAt: cancellation.requestedAt,\n    observedAt: cancellation.observedAt as string | null,\n  };\n}\n\nasync function bodyOrNull(response: Response): Promise<unknown> {\n  try {\n    return await response.json();\n  } catch {\n    return null;\n  }\n}\n\nasync function checkedJson(response: Response): Promise<unknown> {\n  const body = await bodyOrNull(response);\n  if (!response.ok) throw new MeriDurableResearchHttpError(response.status, body);\n  return body;\n}\n\nexport async function fetchMeriDurableResearchSnapshot(input: {\n  apiBaseUrl: string;\n  researchId: string;\n  afterSequence: number;\n  headers: Record<string, string>;\n  signal?: AbortSignal;\n}): Promise<MeriDurableResearchSnapshot> {\n  const response = await fetch(\n    `${input.apiBaseUrl}/api/clio/research/${encodeURIComponent(input.researchId)}/coordinator?afterSequence=${input.afterSequence}`,\n    { headers: input.headers, signal: input.signal },\n  );\n  const snapshot = readMeriDurableResearchSnapshot(await checkedJson(response));\n  if (!snapshot || snapshot.researchId !== input.researchId)\n    throw new Error('The durable research coordinator returned an invalid snapshot.');\n  return snapshot;\n}\n\nexport async function steerMeriDurableResearch(input: {\n  apiBaseUrl: string;\n  researchId: string;\n  headers: Record<string, string>;\n  requestId: string;\n  expectedGoalRevision: number;\n  message: string;\n  signal?: AbortSignal;\n}): Promise<MeriDurableSteeringResponse> {\n  const response = await fetch(\n    `${input.apiBaseUrl}/api/clio/research/${encodeURIComponent(input.researchId)}/steer`,\n    {\n      method: 'POST',\n      headers: input.headers,\n      body: JSON.stringify({\n        version: 1,\n        requestId: input.requestId,\n        expectedGoalRevision: input.expectedGoalRevision,\n        message: input.message,\n      }),\n      signal: input.signal,\n    },\n  );\n  const value = record(await checkedJson(response));\n  const receipt = record(value?.receipt);\n  if (\n    !value ||\n    value.version !== 1 ||\n    value.accepted !== true ||\n    typeof value.idempotentReplay !== 'boolean' ||\n    !receipt ||\n    receipt.version !== 1 ||\n    typeof receipt.requestId !== 'string' ||\n    !nonNegativeInteger(receipt.goalRevision) ||\n    !nonNegativeInteger(receipt.previousGoalRevision) ||\n    !nonNegativeInteger(receipt.sequence) ||\n    typeof receipt.message !== 'string' ||\n    typeof receipt.acceptedAt !== 'string' ||\n    !['pending_safe_boundary', 'applied'].includes(String(receipt.state)) ||\n    !(receipt.appliedAt === null || typeof receipt.appliedAt === 'string')\n  )\n    throw new Error('The durable research steering response was invalid.');\n  return value as unknown as MeriDurableSteeringResponse;\n}\n\nexport async function cancelMeriDurableResearch(input: {\n  apiBaseUrl: string;\n  researchId: string;\n  headers: Record<string, string>;\n  requestId: string;\n  signal?: AbortSignal;\n}): Promise<{ run: MeriDurableResearchRun | null }> {\n  const response = await fetch(\n    `${input.apiBaseUrl}/api/clio/research/${encodeURIComponent(input.researchId)}/cancel`,\n    {\n      method: 'POST',\n      headers: input.headers,\n      body: JSON.stringify({ version: 1, requestId: input.requestId, reason: 'User pressed Stop' }),\n      signal: input.signal,\n    },\n  );\n  const value = record(await checkedJson(response));\n  return { run: readRun(value?.run) };\n}\n\n";
const ORIGINAL_CLOSURE_SHA256 = '476ace880c73c1f52558d3b08a7396a43f0b96a3e1bf8916ccc9ddc52ee8e50c';
const NORMALIZED_INTEGRATION_SHA256 = '2dddb1f1a60a4e9be2873e70c4b84eda6e996ed29c9ef9b287a671b3147df577';
const CLIENT_IMPORT = './lib/meri-durable-research-contract-client.js';
const CLIENT_URL = new URL('../../apps/api/scripts/lib/meri-durable-research-contract-client.ts', import.meta.url);
const INTEGRATION_URL = new URL('../../apps/api/scripts/meri-durable-controls.http.integration.spec.ts', import.meta.url);
const variants = ['original', 'candidate'];
const digest = (value) => createHash('sha256').update(value).digest('hex');
const plain = (value) => JSON.parse(JSON.stringify(value));
function load(source, fetchImpl) {
  // Type transform handles the old parameter-property Error constructor only.
  // Neither source has imports or an application bootstrap.
  const code = stripTypeScriptTypes(source.replace(/^export /gm, ''), { mode: 'transform' });
  return runInNewContext(code + '\n({fetchMeriDurableResearchSnapshot,steerMeriDurableResearch,cancelMeriDurableResearch})', { fetch: fetchImpl });
}
function snapshot() {
  return {
    version: 1, researchId: 'research /雪?#',
    run: { id: 'run-1', leaseEpoch: 1, eventSequence: 4, phase: 'research', status: 'running', stage: 'Reading', startedAt: 'not-required-to-be-a-date', heartbeatAt: 'also-a-string' },
    coordinator: {
      version: 1, planVersion: 1, goalRevision: 0,
      goal: { objective: 'Assess the record', constraints: [], deliverables: [] },
      deadlineAt: null, leaseEpoch: 1, aggregateBudgetRef: 'researchToolBudget', cancellation: { state: 'none' },
      steps: [{ id: 'step-1', objective: 'Read', dependsOn: [], goalRevision: 0, effect: 'safe_read', attempt: 1, deadlineAt: null, outcome: 'reserved', sourceRefs: ['source:test'], operationRefs: ['owner:test'], leaseEpoch: 1, completedAt: null, failureCode: null }],
    },
    events: [{ version: 1, sequence: 4, type: 'step_reserved', goalRevision: 0, planVersion: 1, stepId: 'step-1', createdAt: 'any-string' }], nextSequence: 4,
  };
}
function steering() {
  return { version: 1, accepted: true, idempotentReplay: false, receipt: { version: 1, requestId: 'receipt-can-differ', sequence: 5, previousGoalRevision: 0, goalRevision: 1, message: 'House only', acceptedAt: 'any-string', state: 'pending_safe_boundary', appliedAt: null } };
}
function inputs() {
  return { apiBaseUrl: 'https://contract.invalid/', researchId: 'research /雪?#', afterSequence: 0, headers: { Authorization: 'Bearer fake-test-value', 'Content-Type': 'application/json', 'x-capiro-impersonate-tenant': 'test-scope' }, requestId: 'request-1', expectedGoalRevision: 0, message: 'House only', signal: { fakeSignal: true } };
}
function setup(source, body, { ok = true, status = 200, jsonError, transportError } = {}) {
  const calls = []; let jsonCalls = 0;
  const client = load(source, async (...args) => {
    calls.push(args);
    if (transportError) throw transportError;
    return { ok, status, json: async () => { jsonCalls++; if (jsonError) throw jsonError; return body; } };
  });
  return { client, calls, jsonCalls: () => jsonCalls };
}
const METHODS = ['fetchMeriDurableResearchSnapshot', 'steerMeriDurableResearch', 'cancelMeriDurableResearch'];
for (const variant of variants) {
  const source = variant === 'original' ? ORIGINAL_SOURCE : readFileSync(CLIENT_URL, 'utf8');
  const check = (name, fn) => test(`${variant}: ${name}`, fn);
  check('snapshot uses encoded id, raw cursor, untouched headers/signal and no explicit method', async () => {
    const body = snapshot(), input = inputs(), fixture = setup(source, body);
    const value = await fixture.client.fetchMeriDurableResearchSnapshot(input);
    assert.equal(fixture.calls.length, 1); assert.equal(fixture.jsonCalls(), 1);
    assert.equal(fixture.calls[0][0], 'https://contract.invalid//api/clio/research/research%20%2F%E9%9B%AA%3F%23/coordinator?afterSequence=0');
    assert.equal(fixture.calls[0][1].headers, input.headers); assert.equal(fixture.calls[0][1].signal, input.signal);
    assert.deepEqual(Object.keys(fixture.calls[0][1]), ['headers', 'signal']);
    assert.deepEqual(plain(value), body);
  });
  check('steering posts the exact v1 body and returns the validated raw response', async () => {
    const body = steering(), input = inputs(), fixture = setup(source, body);
    body.extra = { retained: true };
    const value = await fixture.client.steerMeriDurableResearch(input);
    assert.equal(value, body); assert.equal(value.receipt, body.receipt);
    assert.equal(fixture.calls.length, 1); assert.equal(fixture.calls[0][0], 'https://contract.invalid//api/clio/research/research%20%2F%E9%9B%AA%3F%23/steer');
    assert.equal(fixture.calls[0][1].method, 'POST');
    assert.equal(fixture.calls[0][1].body, '{"version":1,"requestId":"request-1","expectedGoalRevision":0,"message":"House only"}');
    assert.equal(fixture.calls[0][1].headers, input.headers); assert.equal(fixture.calls[0][1].signal, input.signal);
  });
  check('cancel posts the exact Stop reason and maps a valid run without private fields', async () => {
    const run = { ...snapshot().run, privateField: 'opaque' }, input = inputs(), fixture = setup(source, { version: 999, run });
    const value = await fixture.client.cancelMeriDurableResearch(input);
    assert.equal(fixture.calls[0][0], 'https://contract.invalid//api/clio/research/research%20%2F%E9%9B%AA%3F%23/cancel');
    assert.equal(fixture.calls[0][1].method, 'POST');
    assert.equal(fixture.calls[0][1].body, '{"version":1,"requestId":"request-1","reason":"User pressed Stop"}');
    assert.equal(fixture.calls[0][1].headers, input.headers); assert.equal(fixture.calls[0][1].signal, input.signal);
    assert.deepEqual(plain(value.run), snapshot().run); assert.notEqual(value.run, run);
  });
  check('snapshot permits terminal null run and exact true cursor reset', async () => {
    const body = { ...snapshot(), run: null, cursorResetRequired: true };
    const value = await setup(source, body).client.fetchMeriDurableResearchSnapshot(inputs());
    assert.equal(value.run, null); assert.equal(value.cursorResetRequired, true);
    body.cursorResetRequired = false;
    assert.ok(!Object.hasOwn(await setup(source, body).client.fetchMeriDurableResearchSnapshot(inputs()), 'cursorResetRequired'));
  });
  check('snapshot events are stable sequence sorted, capped at 200, and retain references', async () => {
    const body = snapshot();
    body.events = Array.from({ length: 205 }, (_, index) => ({ ...body.events[0], sequence: 205 - index, opaque: { index } }));
    const first = body.events[0], before = body.events.map((value) => value.sequence);
    const result = await setup(source, body).client.fetchMeriDurableResearchSnapshot(inputs());
    assert.equal(result.events.length, 200); assert.equal(result.events[0].sequence, 6); assert.equal(result.events.at(-1), first);
    assert.deepEqual(body.events.map((value) => value.sequence), before);
    const repeated = snapshot(); repeated.events = [{ ...repeated.events[0], sequence: 1, detail: 'first' }, { ...repeated.events[0], sequence: 1, detail: 'second' }];
    assert.deepEqual(Array.from((await setup(source, repeated).client.fetchMeriDurableResearchSnapshot(inputs())).events, (value) => value.detail), ['first', 'second']);
  });
  check('snapshot projects public records while retaining array/event aliases', async () => {
    const body = snapshot(); body.extra = true; body.run.privateField = true; body.coordinator.privateField = true;
    body.coordinator.steps[0].privateField = true; body.events[0].opaque = { retained: true };
    const value = await setup(source, body).client.fetchMeriDurableResearchSnapshot(inputs());
    assert.ok(!Object.hasOwn(value, 'extra')); assert.ok(!Object.hasOwn(value.run, 'privateField'));
    assert.ok(!Object.hasOwn(value.coordinator, 'privateField')); assert.ok(!Object.hasOwn(value.coordinator.steps[0], 'privateField'));
    assert.equal(value.coordinator.goal.constraints, body.coordinator.goal.constraints);
    assert.equal(value.coordinator.steps[0].sourceRefs, body.coordinator.steps[0].sourceRefs);
    assert.equal(value.coordinator.steps[0].operationRefs, body.coordinator.steps[0].operationRefs);
    assert.equal(value.events[0], body.events[0]);
  });
  check('run optional fields include strings and exact true only', async () => {
    const body = snapshot(); Object.assign(body.run, { deadlineAt: 'deadline', finishedAt: 'finish', failureReason: 'reason', readyToStart: true });
    let value = await setup(source, body).client.fetchMeriDurableResearchSnapshot(inputs());
    assert.equal(value.run.deadlineAt, 'deadline'); assert.equal(value.run.finishedAt, 'finish'); assert.equal(value.run.failureReason, 'reason'); assert.equal(value.run.readyToStart, true);
    Object.assign(body.run, { deadlineAt: null, finishedAt: 3, failureReason: false, readyToStart: false });
    value = await setup(source, body).client.fetchMeriDurableResearchSnapshot(inputs());
    for (const key of ['deadlineAt', 'finishedAt', 'failureReason', 'readyToStart']) assert.ok(!Object.hasOwn(value.run, key));
  });
  check('all supported run statuses and phases are accepted without timestamp parsing', async () => {
    for (const status of ['running', 'cancel_requested', 'complete', 'failed', 'cancelled', 'interrupted', 'partial', 'awaiting_clarification']) {
      const body = snapshot(); body.run.status = status; body.run.phase = 'plan';
      assert.equal((await setup(source, body).client.fetchMeriDurableResearchSnapshot(inputs())).run.status, status);
    }
  });
  check('all supported step outcomes and approval-required effect remain accepted', async () => {
    for (const outcome of ['pending', 'reserved', 'completed', 'retryable_failure', 'waiting_for_approval', 'uncertain_effect', 'superseded', 'cancelled']) {
      const body = snapshot(); body.coordinator.steps[0].outcome = outcome; body.coordinator.steps[0].effect = 'approval_required';
      assert.equal((await setup(source, body).client.fetchMeriDurableResearchSnapshot(inputs())).coordinator.steps[0].outcome, outcome);
    }
  });
  check('cancellation strips extra fields and accepts requested/observed records', async () => {
    const body = snapshot(); body.coordinator.cancellation.extra = true;
    assert.deepEqual(plain((await setup(source, body).client.fetchMeriDurableResearchSnapshot(inputs())).coordinator.cancellation), { state: 'none' });
    for (const state of ['requested', 'observed']) {
      body.coordinator.cancellation = { state, requestId: 'stop-1', reason: 'Stop', requestedAt: 'any-string', observedAt: state === 'requested' ? null : 'any-string', privateField: true };
      const value = await setup(source, body).client.fetchMeriDurableResearchSnapshot(inputs());
      assert.equal(value.coordinator.cancellation.state, state); assert.ok(!Object.hasOwn(value.coordinator.cancellation, 'privateField'));
    }
  });
  check('malformed snapshot envelopes and mismatched research ids fail', async () => {
    for (const body of [null, [], 7, {}, { ...snapshot(), version: 2 }, { ...snapshot(), researchId: 'other' }, { ...snapshot(), run: {} }]) {
      await assert.rejects(setup(source, body).client.fetchMeriDurableResearchSnapshot(inputs()), { name: 'Error', message: 'The durable research coordinator returned an invalid snapshot.' });
    }
  });
  check('invalid nested coordinator, step and event fields fail the entire snapshot', async () => {
    const mutations = [
      (body) => { body.coordinator.goalRevision = 0.5; }, (body) => { body.coordinator.planVersion = '1'; },
      (body) => { body.coordinator.aggregateBudgetRef = 'other'; }, (body) => { body.coordinator.goal.constraints = [7]; },
      (body) => { body.coordinator.cancellation = { state: 'requested' }; }, (body) => { body.coordinator.steps[0].outcome = 'unknown'; },
      (body) => { body.coordinator.steps[0].sourceRefs = [7]; }, (body) => { body.coordinator.steps[0].failureCode = undefined; },
      (body) => { body.events[0].type = 'private_event'; }, (body) => { body.events[0].stepId = undefined; },
    ];
    for (const mutate of mutations) { const body = snapshot(); mutate(body); await assert.rejects(setup(source, body).client.fetchMeriDurableResearchSnapshot(inputs()), /invalid snapshot/); }
  });
  check('snapshot cursor requires a nonnegative safe integer', async () => {
    for (const cursor of [-1, 0.5, '4', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const body = snapshot(); body.nextSequence = cursor;
      await assert.rejects(setup(source, body).client.fetchMeriDurableResearchSnapshot(inputs()), /invalid snapshot/);
    }
  });
  check('cancel malformed or absent envelopes/runs map to null rather than an error', async () => {
    for (const body of [null, [], false, 7, {}, { run: null }, { run: {} }, { run: { ...snapshot().run, status: 'unknown' } }]) {
      assert.equal((await setup(source, body).client.cancelMeriDurableResearch(inputs())).run, null);
    }
  });
  check('steering accepts applied receipts and raw extra fields without echo-ID validation', async () => {
    const body = steering(); body.receipt.state = 'applied'; body.receipt.appliedAt = 'any-string'; body.receipt.extra = true;
    const value = await setup(source, body).client.steerMeriDurableResearch(inputs());
    assert.equal(value, body); assert.equal(value.receipt.requestId, 'receipt-can-differ'); assert.equal(value.receipt.extra, true);
  });
  check('malformed steering envelope or required receipt fields fail', async () => {
    const mutations = [(body) => { body.version = 2; }, (body) => { body.accepted = false; }, (body) => { body.idempotentReplay = 'false'; }, (body) => { body.receipt.version = 2; }, (body) => { body.receipt.goalRevision = -1; }, (body) => { body.receipt.sequence = 0.1; }, (body) => { body.receipt.state = 'unknown'; }, (body) => { delete body.receipt.appliedAt; }];
    for (const mutate of mutations) { const body = steering(); mutate(body); await assert.rejects(setup(source, body).client.steerMeriDurableResearch(inputs()), /steering response was invalid/); }
    for (const body of [null, [], 7, {}]) await assert.rejects(setup(source, body).client.steerMeriDurableResearch(inputs()), /steering response was invalid/);
  });
  check('every non-OK method preserves status, raw error body and Error identity fields', async () => {
    for (const method of METHODS) {
      const body = { error: 'conflict', extra: ['retained'] }, fixture = setup(source, body, { ok: false, status: 409 });
      await assert.rejects(fixture.client[method](inputs()), (error) => { assert.equal(error.name, 'MeriDurableResearchHttpError'); assert.equal(error.message, 'Durable research request failed (HTTP 409).'); assert.equal(error.status, 409); assert.equal(error.body, body); return true; });
      assert.equal(fixture.calls.length, 1); assert.equal(fixture.jsonCalls(), 1);
    }
  });
  check('non-JSON HTTP errors preserve status with null body', async () => {
    for (const method of METHODS) await assert.rejects(setup(source, null, { ok: false, status: 503, jsonError: new Error('bad JSON') }).client[method](inputs()), (error) => error.name === 'MeriDurableResearchHttpError' && error.status === 503 && error.body === null);
  });
  check('successful malformed JSON fails snapshot/steering but returns null cancel run', async () => {
    await assert.rejects(setup(source, null, { jsonError: new Error('bad JSON') }).client.fetchMeriDurableResearchSnapshot(inputs()), /invalid snapshot/);
    await assert.rejects(setup(source, null, { jsonError: new Error('bad JSON') }).client.steerMeriDurableResearch(inputs()), /steering response was invalid/);
    assert.equal((await setup(source, null, { jsonError: new Error('bad JSON') }).client.cancelMeriDurableResearch(inputs())).run, null);
  });
  check('transport and abort errors propagate unchanged with no retry/body read', async () => {
    for (const method of METHODS) for (const name of ['TypeError', 'AbortError']) {
      const error = new Error('fake transport failure'); error.name = name;
      const fixture = setup(source, null, { transportError: error });
      await assert.rejects(fixture.client[method](inputs()), (received) => received === error);
      assert.equal(fixture.calls.length, 1); assert.equal(fixture.jsonCalls(), 0);
    }
  });
  check('caller cursor and numeric body values retain legacy raw serialization', async () => {
    for (const afterSequence of [-1, 1.5, NaN, Infinity]) {
      const fixture = setup(source, snapshot()); await fixture.client.fetchMeriDurableResearchSnapshot({ ...inputs(), afterSequence });
      assert.ok(fixture.calls[0][0].endsWith(`?afterSequence=${afterSequence}`));
    }
    const fixture = setup(source, steering()); await fixture.client.steerMeriDurableResearch({ ...inputs(), expectedGoalRevision: NaN });
    assert.equal(JSON.parse(fixture.calls[0][1].body).expectedGoalRevision, null);
  });
}
function sourceFailures(integration, client) {
  const failures = [];
  if (!integration.includes(`from '${CLIENT_IMPORT}'`)) failures.push('Integration must use API-test contract client');
  if (digest(integration.replace(CLIENT_IMPORT, '<HTTP_CONTRACT_CLIENT>')) !== NORMALIZED_INTEGRATION_SHA256) failures.push('Existing integration identities/assertions changed');
  if (/^\s*import\b/m.test(client)) failures.push('Contract client must have no imports');
  if (/\b(?:process\s*\.\s*env|window|document|localStorage|sessionStorage)\b/.test(client)) failures.push('Contract client has ambient application/browser dependency');
  const exportedMethods = Array.from(client.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm), (match) => match[1]);
  if (JSON.stringify(exportedMethods) !== JSON.stringify(METHODS)) failures.push('Contract client must expose only the three used methods');
  return failures;
}
if (variants.includes('candidate')) {
  const integration = readFileSync(INTEGRATION_URL, 'utf8'), client = readFileSync(CLIENT_URL, 'utf8');
  test('frozen oracle closure identity and exact retained integration body', () => {
    assert.equal(digest(ORIGINAL_SOURCE), ORIGINAL_CLOSURE_SHA256);
    assert.deepEqual(sourceFailures(integration, client), []);
  });
  test('web-import reintroduction and dropped original assertion fail source boundary', () => {
    assert.ok(sourceFailures(integration.replace(CLIENT_IMPORT, '../../web/src/components/chat/meri-durable-research.js'), client).length);
    assert.ok(sourceFailures(integration.replace("expect(requested.run).toMatchObject({ status: 'cancel_requested' });", ''), client).includes('Existing integration identities/assertions changed'));
  });
  test('application/browser import and unused frontend utility fail client boundary', () => {
    assert.ok(sourceFailures(integration, "import './application.js';\n" + client).includes('Contract client must have no imports'));
    assert.ok(sourceFailures(integration, client + '\nexport function mergeMeriDurableResearchSnapshot() {}').includes('Contract client must expose only the three used methods'));
    assert.ok(sourceFailures(integration, client + '\nconst browserState = window.location;').includes('Contract client has ambient application/browser dependency'));
  });
  test('encoded-path removal mutation is detected by a positive transport expectation', async () => {
    const changed = client.replace(/encodeURIComponent\(input\.researchId\)/g, 'input.researchId');
    assert.notEqual(changed, client);
    const fixture = setup(changed, snapshot()); await fixture.client.fetchMeriDurableResearchSnapshot(inputs());
    assert.throws(() => assert.equal(fixture.calls[0][0], 'https://contract.invalid//api/clio/research/research%20%2F%E9%9B%AA%3F%23/coordinator?afterSequence=0'), { name: 'AssertionError' });
  });
  test('HTTP-error swallowing mutation is detected by adverse expectations', async () => {
    const changed = client.replace('if (!response.ok) throw new MeriDurableResearchHttpError(response.status, body);', 'if (!response.ok) return body;');
    assert.notEqual(changed, client);
    const fixture = setup(changed, { error: 'conflict' }, { ok: false, status: 409 });
    await assert.rejects(fixture.client.steerMeriDurableResearch(inputs()), (error) => { assert.notEqual(error.name, 'MeriDurableResearchHttpError'); return true; });
  });
  test('snapshot cursor validation removal mutation is detected by adverse expectations', async () => {
    const changed = client.replace('!nonNegativeInteger(snapshot.nextSequence)', 'false');
    assert.notEqual(changed, client);
    const body = snapshot(); body.nextSequence = -1;
    const value = await setup(changed, body).client.fetchMeriDurableResearchSnapshot(inputs());
    assert.throws(() => assert.ok(value.nextSequence >= 0), { name: 'AssertionError' });
  });
}
