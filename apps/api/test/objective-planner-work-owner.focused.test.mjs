// Actual Core binding + Planner operation/application codecs. Transaction SQL
// and rows below are synthetic; this is not native locking/RLS qualification.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { sharedUrl, appliedUrl, fullV2, fullV3, readySnapshot, nativeConsentProof } from './objective-planner-codec.fixtures.mjs';
const data = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const custody = [];
async function sourceModule(relative, replacements = []) {
  const path = new URL(relative, import.meta.url), raw = await readFile(path, 'utf8');
  let source = raw;
  for (const [from, to] of replacements) {
    assert.ok(source.split(from).length >= 2, `declared import rewrite: ${from}`);
    source = source.replaceAll(from, JSON.stringify(to));
  }
  const transformed = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: path.href });
  custody.push({ path: relative, sha256: createHash('sha256').update(raw).digest('hex'),
    transformedSha256: createHash('sha256').update(transformed).digest('hex'),
    replacementSpecifiers: replacements.map(([from]) => from) });
  return data(transformed);
}
const policyUrl = await sourceModule('../src/auth/workload-authority/objective-consent-policy.ts');
const kernelUrl = await sourceModule('../src/clients/objectives/work/objective-work-command.ts', [
  ["'../../../auth/workload-authority/objective-consent-policy.js'", policyUrl],
]);
const kernel = await import(kernelUrl);
const intentUrl = await sourceModule('../src/clients/objectives/objective-work-intent.ts');
const regenerationBindingUrl = await sourceModule('../src/clients/objectives/work/objective-planner-regeneration.ts');
const proofUrl = await sourceModule('../src/clients/objectives/work/objective-planner-consent-proof.ts', [
  ["'@capiro/shared/objective-planner-owner-codec'", sharedUrl],
  ["'../../../auth/workload-authority/objective-consent-policy.js'", policyUrl],
  ["'../objective-work-intent.js'", intentUrl],
  ["'./objective-work-command.js'", kernelUrl], ["'./objective-planner-applied.js'", appliedUrl],
]);
const ownerUrl = await sourceModule('../src/clients/objectives/work/objective-planner-work-owner.ts', [
  ["'./objective-work-command.js'", kernelUrl],
  ["'./objective-planner-applied.js'", appliedUrl],
  ["'./objective-planner-consent-proof.js'", proofUrl],
  ["'./objective-planner-regeneration.js'", regenerationBindingUrl],
]);
const { ObjectivePlannerWorkOwner } = await import(ownerUrl);
const appUrl = await sourceModule('../../api-strategy/src/planner/objective-canonical-application.ts', [
  ["'@capiro/shared/objective-planner-owner-codec'", sharedUrl],
]);
const app = await import(appUrl);
const genUrl = await sourceModule('../../api-strategy/src/meri/objective-canonical-generation.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl],
]);
const frameworkUrl = data('export class BadRequestException extends Error{}; export class ConflictException extends Error{}; export const STRATEGY_TYPES=[];');
const typesUrl = await sourceModule('../../api-strategy/src/meri/objective-generation.types.ts', [
  ["'@nestjs/common'", frameworkUrl], ["'../strategy/dto/create-strategy.dto.js'", frameworkUrl],
]);
const producerUrl = await sourceModule('../../api-strategy/src/meri/objective-canonical-producer.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl],
  ["'./objective-canonical-generation.js'", genUrl], ["'./objective-generation.types.js'", typesUrl],
]);
const storeUrl = await sourceModule('../../api-strategy/src/planner/objective-planner-continuation.store.ts', [
  ["'../meri/objective-canonical-producer.js'", producerUrl],
  ["'./objective-canonical-application.js'", appUrl],
]);
const store = await import(storeUrl);
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const iso = offset => new Date(NOW + offset).toISOString();
const copy = value => structuredClone(value);
const PLAN = 'objective.plan.prepare';
const env = { OBJECTIVE_PLANNER_CONTINUATION_ENABLED: 'true', OBJECTIVE_PLANNER_CONSENT_DURATION_MS: '600000' };
function fixture(options = {}) {
  const a = { tenantId: id(1), clientId: id(2), objectiveId: id(3), actorUserId: id(4), actorMembershipId: id(5),
    clerkUserId: 'user_current', objectiveRevisionId: id(6), objectiveVersion: 2, objectiveStatus: 'ready' };
  const source = { canonicalPlanId: id(7), canonicalEpoch: 1, canonicalStrategyId: id(8), canonicalProjectId: id(9),
    canonicalBindingVersion: 2, rootIntentId: id(10), sourceRevisionId: a.objectiveRevisionId,
    sourceObjectiveVersion: 2, sourceSnapshotHash: 'a'.repeat(64), rootActorUserId: id(11) };
  const canonical = { tenantId: a.tenantId, clientId: a.clientId, objectiveId: a.objectiveId,
    canonicalPlanId: source.canonicalPlanId, canonicalStrategyId: source.canonicalStrategyId,
    canonicalProjectId: source.canonicalProjectId, bindingVersion: source.canonicalBindingVersion, epoch: 1,
    requestedIntentId: source.rootIntentId, requestedObjectiveRevisionId: source.sourceRevisionId,
    requestedObjectiveVersion: source.sourceObjectiveVersion, snapshotHash: source.sourceSnapshotHash };
  const consent = { id: id(12), controlId: id(13), source: copy(source), previousConsentId: null,
    actorUserId: id(14), actorMembershipId: id(15), policyId: 'capiro.objective-generation-consent', policyRevision: 1,
    configuredDurationMs: 600000, effectiveDurationMs: 600000, stricterExpiresAt: null, stricterLimitRef: null,
    confirmedAt: iso(0), expiresAt: iso(600000), commandRequestId: id(16), commandReceiptId: id(17), payloadDigest: 'b'.repeat(64) };
  const state = { source, control: { id: consent.controlId, version: 2, currentConsentId: consent.id,
    cancelledAt: null, cancelledByUserId: null }, consent };
  const work = { canonical, applicationRequestId: app.canonicalApplicationRequestId(canonical, consent.actorUserId),
    generationJobId: id(18), generationRequestId: id(19), strategyId: source.canonicalStrategyId,
    strategyVersionId: id(20), objectiveReceiptSha256: 'c'.repeat(64), snapshotDigest: 'd'.repeat(64),
    actorUserId: consent.actorUserId, consentId: consent.id, controlVersion: 2 };
  const operation = store.newPlannerContinuationOperation({ work, clerkUserId: 'user_original',
    membershipId: consent.actorMembershipId, originalDeadlineAt: consent.expiresAt });
  const receipt = { id: consent.commandReceiptId, tenant_id: a.tenantId, client_id: a.clientId, objective_id: a.objectiveId,
    work_action: PLAN, control_id: consent.controlId, created_consent_id: consent.id, result_consent_id: consent.id,
    actor_user_id: consent.actorUserId, actor_membership_id: consent.actorMembershipId, request_id: consent.commandRequestId,
    payload_digest: consent.payloadDigest, command_kind: 'retry', outcome: 'reconsent_recorded', target_consent_id: null,
    control_version_after: 2, control_version_before: 1, canonical_plan_id: source.canonicalPlanId,
    canonical_epoch: source.canonicalEpoch, canonical_strategy_id: source.canonicalStrategyId,
    canonical_project_id: source.canonicalProjectId, canonical_binding_version: source.canonicalBindingVersion,
    root_intent_id: source.rootIntentId, source_revision_id: source.sourceRevisionId,
    source_objective_version: source.sourceObjectiveVersion, source_snapshot_hash: source.sourceSnapshotHash,
    root_actor_user_id: source.rootActorUserId };
  const originalCommand = kernel.parseWorkCommand(a.clientId, a.objectiveId, { schemaVersion: 1,
    requestId: consent.commandRequestId, command: 'retry', workAction: PLAN,
    expectedObjectiveVersion: source.sourceObjectiveVersion, expectedCanonicalBindingVersion: source.canonicalBindingVersion,
    expectedControlVersion: 1, targetAuthorizationRequestId: consent.previousConsentId });
  consent.payloadDigest = kernel.workDigest(originalCommand);
  Object.assign(receipt, { command: originalCommand.command, payload_digest: consent.payloadDigest,
    command_revision_id: source.sourceRevisionId, command_objective_version: source.sourceObjectiveVersion });
  const f = { a, state, work, operation, rows: [], receipts: [{ record: receipt, clerkUserId: 'user_original' }],
    settings: { clioFeatureFlags: { 'strategyPlanner.enabled': true }, objectivePlannerContinuation: { enabled: true } },
    calls: [], outputs: [{ present: false }], historical: [], nativeProofs: [], owner: new ObjectivePlannerWorkOwner(options.env ?? env) };
  f.tx = {
    async $executeRaw(parts, ...values) { f.calls.push({ kind: 'execute', sql: parts.join('?'), values }); return 1; },
    async $queryRaw(parts, ...values) {
      const sql = parts.join('?'); f.calls.push({ kind: 'query', sql, values });
      if (sql.includes('JOIN client_objective_work_intents'))
        return f.nativeProofs.filter(row => values.includes(row.consent.id));
      if (sql.includes('FROM client_objective_work_consents')) return f.historical;
      if (sql.includes('FROM client_objective_work_command_receipts')) return f.receipts;
      if (sql.includes('FROM sp_planner_resources')) return f.rows;
      if (sql.includes('FROM sp_planner_projects')) return f.outputs;
      if (sql.includes('FROM tenants')) return [{ settings: f.settings }];
      throw Error(`Unexpected query ${sql}`);
    },
  };
  f.row = (operation = f.operation) => ({ id: operation.original.operationId, tenantId: operation.tenantId,
    ownerId: operation.clerkUserId, projectId: null, kind: store.PLANNER_CONTINUATION_OPERATION,
    name: 'Objective Planner continuation operation', data: operation, version: operation.state === 'queued' ? 1 : operation.state === 'applied' ? 3 : 2,
    archived: false, shareTokenHash: null });
  f.lock = () => f.owner.lockWithinTx(f.tx, { tenantId: a.tenantId }, { command: { workAction: PLAN } });
  f.reconcile = () => f.owner.reconcileWithinTx(f.tx, f.a, PLAN, f.state);
  f.policy = () => f.owner.policyWithinTx(f.tx, f.a, PLAN, f.state);
  f.terminal = (outcome = 'cancelled') => {
    f.operation.state = outcome; f.operation.terminal = { receiptId: f.operation.original.operationId, recordedAtMs: NOW + 5 };
    if (outcome === 'cancelled') {
      f.state.control.version = 3; f.state.control.cancelledAt = iso(4); f.state.control.cancelledByUserId = f.a.actorUserId;
    }
    f.rows = [f.row()]; return f;
  };
  return f;
}
async function observed(f) { await f.lock(); return f.reconcile(); }
async function denyPolicy(f) {
  await observed(f); await assert.rejects(f.policy(), error => error.code === 'AUTHORITY_UNAVAILABLE');
}
function applied(f) {
  const hash = kernel.workDigest(readySnapshot(f.work.canonical));
  f.work.canonical.snapshotHash = hash; f.state.source.sourceSnapshotHash = hash;
  f.state.consent.source.sourceSnapshotHash = hash; f.receipts[0].record.source_snapshot_hash = hash;
  const full = fullV2({ canonical: f.work.canonical, actorUserId: f.work.actorUserId,
    consentId: f.work.consentId, controlVersion: f.work.controlVersion });
  f.work = full.work;
  f.operation = store.newPlannerContinuationOperation({ work: f.work, clerkUserId: 'user_original',
    membershipId: f.state.consent.actorMembershipId, originalDeadlineAt: f.state.consent.expiresAt });
  f.operation.state = 'applied'; f.operation.terminal = full.operation.terminal;
  f.rows = [f.row(), ...full.resources];
  const proof = nativeConsentProof({ stored: full.stored, owner: full.owner, ownerRowId: full.ownerId,
    receiptId: full.receiptId, ownerClerkUserId: full.clerkUserId }, f.state.control.id,
    { membershipId: f.state.consent.actorMembershipId, rootActorUserId: f.state.source.rootActorUserId,
      requestId: f.state.consent.commandRequestId, commandReceiptId: f.state.consent.commandReceiptId });
  f.nativeProofs = [proof];
  f.full = full;
  return f;
}
function sourceFrom(c, actor = id(11)) {
  return { canonicalPlanId: c.canonicalPlanId, canonicalEpoch: c.epoch, canonicalStrategyId: c.canonicalStrategyId,
    canonicalProjectId: c.canonicalProjectId, canonicalBindingVersion: c.bindingVersion, rootIntentId: c.requestedIntentId,
    sourceRevisionId: c.requestedObjectiveRevisionId, sourceObjectiveVersion: c.requestedObjectiveVersion,
    sourceSnapshotHash: c.snapshotHash, rootActorUserId: actor };
}
function appliedChain(f, chain) {
  const last = chain.at(-1), current = last.work.canonical;
  f.work = last.work; f.full = last;
  f.a.objectiveVersion = current.requestedObjectiveVersion; f.a.objectiveRevisionId = current.requestedObjectiveRevisionId;
  f.state.source = sourceFrom(current, id(11 + current.bindingVersion));
  f.state.consent.source = copy(f.state.source); f.state.consent.id = last.work.consentId;
  f.state.control.currentConsentId = last.work.consentId; f.state.control.version = last.work.controlVersion;
  f.nativeProofs = chain.map((full, i) => nativeConsentProof({ stored: full.stored, owner: full.owner,
    ownerRowId: full.ownerId, receiptId: full.receiptId, ownerClerkUserId: full.clerkUserId }, f.state.control.id,
    { rootActorUserId: id(11 + full.work.canonical.bindingVersion), previousConsentId: chain[i - 1]?.work.consentId ?? null }));
  const proof = f.nativeProofs.at(-1);
  Object.assign(f.state.consent, { previousConsentId: proof.consent.previous_consent_id,
    commandRequestId: proof.consent.command_request_id, commandReceiptId: proof.consent.command_receipt_id,
    payloadDigest: proof.consent.payload_digest });
  f.receipts = [{ record: proof.receipt, clerkUserId: proof.clerkUserId }];
  const ops = chain.map(full => {
    const operation = store.newPlannerContinuationOperation({ work: full.work, clerkUserId: full.clerkUserId,
      membershipId: f.state.consent.actorMembershipId, originalDeadlineAt: f.state.consent.expiresAt });
    operation.state = 'applied'; operation.terminal = full.operation.terminal; return operation;
  });
  f.operation = ops.at(-1); f.rows = [...ops.map(f.row), ...last.resources]; return f;
}
function advanceSource(f) {
  const next = fullV3(f.full).work.canonical;
  f.state.source = sourceFrom(next, id(99));
  f.a.objectiveVersion = next.requestedObjectiveVersion; f.a.objectiveRevisionId = next.requestedObjectiveRevisionId;
  return f;
}
test('source custody and cross-owner JSON digest convention', () => {
  assert.ok(custody.length >= 8); assert.equal(kernel.workDigest({ a: 1, b: ['x'] }), app.applicationHash({ b: ['x'], a: 1 }));
});
test('positive absence under the prior gate establishes not_started', async () => {
  const f = fixture(); assert.equal((await observed(f)).state, 'not_started');
  assert.match(f.calls[0].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(f.calls[0].values, [`planner:${f.a.tenantId}`]);
  assert.ok(f.calls.filter(c => c.kind === 'query').every(c => c.values.includes(f.a.tenantId)));
});
test('missing gate stays uncertain and performs no late lock or read', async () => {
  const f = fixture(); assert.equal((await f.reconcile()).state, 'outcome_unconfirmed'); assert.equal(f.calls.length, 0);
});
test('early read gate uses same Planner gate before any Core read', async () => {
  const f = fixture();
  await f.owner.lockReadWithinTx(f.tx, { tenantId: f.a.tenantId }, { workAction: PLAN });
  assert.equal((await f.reconcile()).state, 'not_started');
  assert.match(f.calls[0].sql, /pg_advisory_xact_lock/);
});
test('saved-generation ceiling may shorten immutable original operation deadline', async () => {
  const f = fixture();
  f.operation = store.newPlannerContinuationOperation({ work: f.work, clerkUserId: 'user_original',
    membershipId: f.state.consent.actorMembershipId, originalDeadlineAt: iso(300000) });
  f.terminal(); const evidence = await observed(f);
  assert.equal(evidence.state, 'accounted'); assert.equal(evidence.originalDeadlineAt, iso(300000));
});
test('Strategy action stays unavailable and acquires no Planner gate', async () => {
  const f = fixture(); await f.owner.lockWithinTx(f.tx, { tenantId: f.a.tenantId }, { command: { workAction: 'objective.strategy.draft' } });
  assert.equal((await f.owner.reconcileWithinTx(f.tx, f.a, 'objective.strategy.draft', f.state)).state, 'unavailable');
  assert.equal(f.calls.length, 0);
});
for (const invalid of [{}, { OBJECTIVE_PLANNER_CONTINUATION_ENABLED: 'TRUE' }, { ...env, OBJECTIVE_PLANNER_CONSENT_DURATION_MS: '0' },
  { ...env, OBJECTIVE_PLANNER_CONSENT_DURATION_MS: '1800001' }, { ...env, OBJECTIVE_PLANNER_CONSENT_DURATION_MS: '1e3' },
  { ...env, OBJECTIVE_PLANNER_CONSENT_DURATION_MS: ' 300' }]) {
  test(`operator policy denies ${JSON.stringify(invalid)}`, async () => {
    const f = fixture({ env: invalid }); assert.equal((await observed(f)).state, 'unavailable'); await assert.rejects(f.policy());
  });
}
for (const state of ['queued', 'leased']) test(`${state} operation is uncertain, including elapsed lease`, async () => {
  const f = fixture(); f.operation.state = state;
  if (state === 'leased') f.operation.lease = { token: id(30), expiresAtMs: NOW - 1 };
  f.rows = [f.row()]; assert.equal((await observed(f)).state, 'outcome_unconfirmed');
});
for (const state of ['cancelled', 'failed']) test(`${state} original record is accounted with immutable identities`, async () => {
  const f = fixture().terminal(state), evidence = await observed(f);
  assert.equal(evidence.state, 'accounted'); assert.equal(evidence.outcome, state);
  assert.equal(evidence.operationId, f.operation.original.operationId);
  assert.equal(evidence.terminalReceiptId, evidence.operationId);
  assert.equal(evidence.originalDeadlineAt, f.state.consent.expiresAt);
  const facts = await f.policy(); assert.equal(facts.originalDelegationExpiresAtMs, null);
  assert.equal(Object.hasOwn(facts, 'originalTokenExpiresAtMs'), false);
});
test('cancellation control advance retains original receipt version and actor', async () => {
  const f = fixture().terminal();
  const evidence = await observed(f); assert.equal(evidence.state, 'accounted');
  assert.notEqual(f.a.actorUserId, f.operation.work.actorUserId); assert.equal(f.operation.work.controlVersion, 2);
});
test('unexplained control version advance cannot establish original operation accounting', async () => {
  const f = fixture().terminal(); f.state.control.version = 5;
  assert.equal((await observed(f)).state, 'outcome_unconfirmed');
});
for (const mutate of [f => { f.receipts = []; }, f => { f.receipts[0].record.actor_membership_id = id(90); },
  f => { f.receipts[0].record.source_snapshot_hash = 'e'.repeat(64); }, f => { f.receipts[0].record.control_version_after = 3; },
  f => { f.receipts[0].clerkUserId = 'user_other'; }, f => { f.operation.terminal.receiptId = id(99); },
  f => { f.operation.original.runId = id(99); }, f => { f.operation.membershipId = id(98); },
  f => { f.rows[0].tenantId = id(99); }, f => { f.rows[0].archived = true; }]) {
  test(`malformed original accounting cannot permit retry: ${mutate.toString()}`, async () => {
    const f = fixture().terminal(); mutate(f); assert.equal((await observed(f)).state, 'outcome_unconfirmed');
  });
}
test('unknown operation kind and unscopable malformed rows do not prove absence', async () => {
  const f = fixture(); f.rows = [{ ...f.row(), kind: 'objective_planner_continuation_unknown' }];
  assert.equal((await observed(f)).state, 'outcome_unconfirmed');
  f.rows = [{ ...f.row(), data: {} }]; assert.equal((await f.reconcile()).state, 'outcome_unconfirmed');
});
test('enumeration overflow fails closed', async () => {
  const f = fixture(); f.rows = Array.from({ length: 257 }, () => f.row()); assert.equal((await observed(f)).state, 'outcome_unconfirmed');
});
test('orphan canonical project/tasks or missing output accounting remain uncertain', async () => {
  for (const outputs of [[{ present: true }], [], [{ present: null }]]) {
    const f = fixture(); f.outputs = outputs; assert.equal((await observed(f)).state, 'outcome_unconfirmed');
  }
});
test('application receipt without original operation is uncertainty', async () => {
  const f = applied(fixture()); f.rows.shift(); assert.equal((await observed(f)).state, 'outcome_unconfirmed');
});
test('applied original operation is positively reconstructed by full shared owner codec and denies policy', async () => {
  const f = applied(fixture()), evidence = await observed(f);
  assert.equal(evidence.state, 'accounted'); assert.equal(evidence.outcome, 'applied');
  await assert.rejects(f.policy(), e => e.code === 'AUTHORITY_UNAVAILABLE');
});
test('real v3 to v3 to v2 ancestry reconstructs every original native consent without using current actor', async () => {
  const first = fullV2(), second = fullV3(first), third = fullV3(second);
  const f = appliedChain(fixture(), [first, second, third]), evidence = await observed(f);
  assert.equal(evidence.state, 'accounted'); assert.equal(evidence.outcome, 'applied');
  assert.equal(f.calls.filter(c => c.sql.includes('JOIN client_objective_work_intents')).length, 3);
  assert.notEqual(f.a.actorUserId, third.work.actorUserId); assert.equal(evidence.regeneration, undefined);
});
test('advanced ready binding retains old applied identity and separately witnesses exact current-source absence', async () => {
  const first = fullV2(), second = fullV3(first), third = fullV3(second);
  const f = advanceSource(appliedChain(fixture(), [first, second, third])), evidence = await observed(f);
  assert.equal(evidence.state, 'accounted'); assert.equal(evidence.outcome, 'applied');
  assert.equal(evidence.operationId, f.operation.original.operationId);
  assert.equal(evidence.rootIntentId, third.work.canonical.requestedIntentId);
  assert.deepEqual(evidence.regeneration, { state: 'not_started', source: f.state.source });
  assert.notEqual(evidence.regeneration.source.rootIntentId, evidence.rootIntentId);
  assert.equal((await f.policy()).originalDelegationExpiresAtMs, null);
});
for (const corrupt of [
  f => { f.nativeProofs.shift(); },
  f => { f.nativeProofs[0].clerkUserId = 'foreign_clerk'; },
  f => { f.nativeProofs[0].intent.actor_user_id = id(98); },
  f => { f.nativeProofs[0].receipt.actor_membership_id = id(98); },
  f => { f.nativeProofs[0].revision.snapshot.title = 'changed'; },
  f => { f.rows.shift(); },
  f => { f.rows.push({ ...f.row(), id: id(991), kind: 'objective_planner_continuation_unknown' }); },
  f => { const next = fullV3(f.full); f.rows.push(...next.resources.filter(r => !f.rows.some(old => old.id === r.id))); },
]) test(`advanced-source witness denies incomplete/foreign/orphan ancestry: ${corrupt}`, async () => {
  const first = fullV2(), second = fullV3(first), third = fullV3(second);
  const f = advanceSource(appliedChain(fixture(), [first, second, third])); corrupt(f);
  assert.equal((await observed(f)).state, 'outcome_unconfirmed'); await assert.rejects(f.policy());
});
function priorTerminal(f) {
  const old = fixture().terminal('failed'), c = old.state.consent;
  const command = kernel.parseWorkCommand(old.a.clientId, old.a.objectiveId, { schemaVersion: 1,
    command: 'retry', requestId: c.commandRequestId, workAction: PLAN, expectedObjectiveVersion: old.a.objectiveVersion,
    expectedCanonicalBindingVersion: old.state.source.canonicalBindingVersion, expectedControlVersion: 1,
    targetAuthorizationRequestId: c.previousConsentId });
  const digest = kernel.workDigest(command), r = { ...copy(old.receipts[0].record), command: command.command,
    payload_digest: digest, command_revision_id: old.a.objectiveRevisionId, command_objective_version: old.a.objectiveVersion };
  const consent = { ...r, id: c.id, control_id: c.controlId, consenting_actor_user_id: c.actorUserId,
    consenting_membership_id: c.actorMembershipId, command_receipt_id: c.commandReceiptId, command_request_id: c.commandRequestId,
    previous_consent_id: c.previousConsentId, confirmed_at: c.confirmedAt, expires_at: c.expiresAt,
    consent_policy_id: c.policyId, consent_policy_revision: c.policyRevision, configured_duration_ms: c.configuredDurationMs,
    effective_duration_ms: c.effectiveDurationMs, stricter_expires_at: c.stricterExpiresAt, stricter_limit_ref: c.stricterLimitRef };
  f.state.consent.id = id(90); f.state.control.currentConsentId = id(90);
  f.state.consent.previousConsentId = c.id; f.state.control.version = 3;
  Object.assign(f.receipts[0].record, { created_consent_id: id(90), result_consent_id: id(90), target_consent_id: c.id,
    control_version_before: 2, control_version_after: 3 });
  const current = kernel.parseWorkCommand(f.a.clientId, f.a.objectiveId, { ...f.receipts[0].record.command,
    expectedControlVersion: 2, targetAuthorizationRequestId: c.id });
  f.state.consent.payloadDigest = kernel.workDigest(current);
  Object.assign(f.receipts[0].record, { command: current.command, payload_digest: f.state.consent.payloadDigest });
  f.historical = [{ consent, record: r, clerkUserId: old.operation.clerkUserId }]; f.rows = [old.row()];
  return f;
}
test('fully accounted earlier failed consent permits current same-binding operation absence', async () => {
  const f = priorTerminal(fixture()); assert.equal((await observed(f)).state, 'not_started');
  assert.ok(f.calls.some(c => c.sql.includes('FROM client_objective_work_consents')));
});
for (const mutate of [f => { f.historical = []; }, f => { f.historical[0].record.actor_membership_id = id(88); },
  f => { f.historical[0].consent.source_snapshot_hash = 'e'.repeat(64); },
  f => { f.historical[0].consent.expires_at = iso(1); }, f => { f.historical[0].record.payload_digest = 'a'.repeat(64); },
  f => { f.historical[0].clerkUserId = 'user_else'; }, f => { f.outputs = [{ present: true }]; },
  f => { f.rows[0].data.state = 'queued'; f.rows[0].data.terminal = null; f.rows[0].version = 1; }]) {
  test(`historical consent requires complete original proof and no effects: ${mutate.toString()}`, async () => {
    const f = priorTerminal(fixture()); mutate(f); assert.equal((await observed(f)).state, 'outcome_unconfirmed');
  });
}
test('changed ready source with old applied binding is refused without relabeling old work', async () => {
  const f = applied(fixture()), before = copy(f.operation);
  f.state.source.canonicalBindingVersion++; f.state.source.sourceObjectiveVersion++;
  f.state.source.sourceRevisionId = id(95); f.state.source.rootIntentId = id(96);
  assert.equal((await observed(f)).state, 'outcome_unconfirmed'); assert.deepEqual(f.operation, before);
});
test('older-binding queued work cannot be silently ignored as current operation absence', async () => {
  const f = fixture(), oldCanonical = { ...f.work.canonical, bindingVersion: 1, requestedObjectiveVersion: 1,
    requestedObjectiveRevisionId: id(97), requestedIntentId: id(98) };
  f.operation = store.newPlannerContinuationOperation({ work: { ...f.work, canonical: oldCanonical,
    applicationRequestId: app.canonicalApplicationRequestId(oldCanonical, f.work.actorUserId) },
  clerkUserId: 'user_original', membershipId: f.state.consent.actorMembershipId, originalDeadlineAt: f.state.consent.expiresAt });
  f.rows = [f.row()]; assert.equal((await observed(f)).state, 'outcome_unconfirmed');
});
test('applied owner observation prevents the actual Core retry kernel from writing a new consent', async () => {
  const f = applied(fixture()); let writes = 0;
  const request = kernel.parseWorkCommand(f.a.clientId, f.a.objectiveId, { schemaVersion: 1, requestId: id(750),
    command: 'retry', workAction: PLAN, expectedObjectiveVersion: f.a.objectiveVersion,
    expectedControlVersion: f.state.control.version, expectedCanonicalBindingVersion: f.state.source.canonicalBindingVersion,
    targetAuthorizationRequestId: f.state.consent.id });
  const port = { lockOwner: f.lock, currentAuthority: async () => f.a, receipt: async () => null, state: async () => f.state,
    reconcile: f.reconcile, policy: () => { throw Error('policy must not be reached'); },
    insertConsent: async () => { writes++; }, newId: () => { throw Error('no new identity'); } };
  await assert.rejects(kernel.executeWorkCommand(request, { transaction: async (_write, run) => run(port) }),
    error => error.code === 'OUTCOME_UNCONFIRMED');
  assert.equal(writes, 0);
});
test('policy requires exact tenant opt-in and existing feature owner flag', async () => {
  for (const settings of [{}, { objectivePlannerContinuation: { enabled: true } },
    { clioFeatureFlags: { 'strategyPlanner.enabled': true }, objectivePlannerContinuation: { enabled: 'true' } },
    { strategyPlanner: { enabled: true }, objectivePlannerContinuation: { enabled: true } }]) {
    const f = fixture(); f.settings = settings; await denyPolicy(f);
  }
});
test('duration policy is bounded, tenant override optional, and has no fabricated token proof', async () => {
  const f = fixture(); await observed(f);
  assert.deepEqual(await f.policy(), { configuredDurationMs: 600000, tenantDurationLimitMs: null,
    actionDurationLimitMs: 1800000, originalDelegationExpiresAtMs: null, limitReference: 'objective-planner-continuation:v1' });
  f.settings.objectivePlannerContinuation.durationLimitMs = 1000;
  assert.equal((await f.policy()).tenantDurationLimitMs, 1000);
});
for (const value of [null, 0, -1, 1800001, '300', 0.5]) test(`malformed tenant duration denies: ${JSON.stringify(value)}`, async () => {
  const f = fixture(); f.settings.objectivePlannerContinuation.durationLimitMs = value; await denyPolicy(f);
});
test('tenant settings accessor is rejected before reading', async () => {
  const f = fixture(); let read = false;
  Object.defineProperty(f.settings, 'objectivePlannerContinuation', { enumerable: true, get() { read = true; throw Error(); } });
  await denyPolicy(f); assert.equal(read, false);
});
test('policy cannot reuse different source/current consent reconciliation', async () => {
  const f = fixture(); await observed(f); f.state.source.sourceObjectiveVersion++;
  await assert.rejects(f.policy(), error => error.code === 'AUTHORITY_UNAVAILABLE');
});
test('tenant gate cannot be reused across tenants', async () => {
  const f = fixture(); await f.lock(); f.a.tenantId = id(70);
  assert.equal((await f.reconcile()).state, 'outcome_unconfirmed');
});
test('NEW explicit consent after accounted expiry creates distinct operation while original deadline stays immutable', async () => {
  const f = fixture().terminal('failed'), original = copy(f.operation);
  let serial = 800, savedConsent, savedControl;
  const request = kernel.parseWorkCommand(f.a.clientId, f.a.objectiveId, { schemaVersion: 1, requestId: id(700),
    command: 'retry', workAction: PLAN, expectedObjectiveVersion: f.a.objectiveVersion,
    expectedControlVersion: f.state.control.version, expectedCanonicalBindingVersion: f.state.source.canonicalBindingVersion,
    targetAuthorizationRequestId: f.state.consent.id });
  const port = {
    lockOwner: f.lock, currentAuthority: async () => f.a, receipt: async () => null, state: async () => copy(f.state),
    clock: async () => iso(700000), reconcile: () => f.reconcile(),
    policy: async () => ({ ...await f.policy(), originalTokenExpiresAtMs: NOW + 1000000 }),
    insertConsent: async (_a, _action, c) => { savedConsent = c; },
    casControl: async (_a, _action, _before, after) => { savedControl = after; return true; },
    insertReceipt: async () => {}, newId: () => id(serial++),
  };
  const receipt = await kernel.executeWorkCommand(request, { transaction: async (_write, run) => run(port) });
  assert.equal(receipt.outcome, 'reconsent_recorded'); assert.ok(Date.parse(savedConsent.confirmedAt) > Date.parse(original.original.originalDeadlineAt));
  assert.equal(Date.parse(savedConsent.expiresAt), NOW + 1000000, 'new consent clipped by current original native proof');
  assert.equal(savedConsent.actorUserId, f.a.actorUserId);
  const next = store.newPlannerContinuationOperation({ work: { ...copy(f.work), actorUserId: savedConsent.actorUserId,
    applicationRequestId: app.canonicalApplicationRequestId(f.work.canonical, savedConsent.actorUserId),
    consentId: savedConsent.id, controlVersion: savedControl.version }, clerkUserId: f.a.clerkUserId,
  membershipId: savedConsent.actorMembershipId, originalDeadlineAt: savedConsent.expiresAt });
  assert.notEqual(next.original.operationId, original.original.operationId);
  assert.notEqual(next.original.runId, original.original.runId);
  assert.equal(next.original.originalDeadlineAt, savedConsent.expiresAt);
  assert.deepEqual(f.operation, original, 'original prior work is never renewed or relabeled');
});
