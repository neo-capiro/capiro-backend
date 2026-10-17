// Actual Core binding + Planner operation/application codecs. Transaction SQL
// and rows below are synthetic; this is not native locking/RLS qualification.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { sharedUrl, calendarUrl, appliedUrl, fullV2, fullV3, readySnapshot, nativeConsentProof, m as materialization } from './objective-planner-codec.fixtures.mjs';
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
const regenerationBindingUrl = await sourceModule('../src/clients/objectives/work/objective-planner-regeneration.ts');
const kernelUrl = await sourceModule('../src/clients/objectives/work/objective-work-command.ts', [
  ["'../../../auth/workload-authority/objective-consent-policy.js'", policyUrl],
  ["'./objective-planner-regeneration.js'", regenerationBindingUrl],
]);
const kernel = await import(kernelUrl);
const intentUrl = await sourceModule('../src/clients/objectives/objective-work-intent.ts');
const proofUrl = await sourceModule('../src/clients/objectives/work/objective-planner-consent-proof.ts', [
  ["'@capiro/shared/objective-planner-owner-codec'", sharedUrl],
  ["'../../../auth/workload-authority/objective-consent-policy.js'", policyUrl],
  ["'../objective-work-intent.js'", intentUrl],
  ["'./objective-work-command.js'", kernelUrl], ["'./objective-planner-applied.js'", appliedUrl],
]);
const historicalUrl = await sourceModule('../src/clients/objectives/work/objective-planner-historical-proof.ts', [
  ["'@capiro/shared'", calendarUrl],
  ["'@capiro/shared/objective-planner-owner-codec'", sharedUrl],
  ["'../../../auth/workload-authority/objective-consent-policy.js'", policyUrl],
  ["'../objective-work-intent.js'", intentUrl], ["'./objective-work-command.js'", kernelUrl],
]);
const historicalCodec = await import(historicalUrl);
const currentConsentUrl = await sourceModule('../src/clients/objectives/work/objective-planner-current-consent-proof.ts', [
  ["'@capiro/shared/objective-planner-owner-codec'", sharedUrl],
  ["'../../../auth/workload-authority/objective-consent-policy.js'", policyUrl],
  ["'../objective-work-intent.js'", intentUrl], ["'./objective-work-command.js'", kernelUrl],
]);
const unusedConsentUrl = await sourceModule('../src/clients/objectives/work/objective-planner-unused-consent-proof.ts', [
  ["'@capiro/shared'", calendarUrl],
  ["'@capiro/shared/objective-planner-owner-codec'", sharedUrl],
  ["'./objective-planner-current-consent-proof.js'", currentConsentUrl],
  ["'./objective-work-command.js'", kernelUrl],
]);
const retainedAnchorUrl = await sourceModule('../src/clients/objectives/work/objective-planner-retained-anchor.ts', [
  ["'@capiro/shared'", calendarUrl], ["'@capiro/shared/objective-planner-owner-codec'", sharedUrl],
  ["'./objective-planner-applied.js'", appliedUrl], ["'./objective-planner-consent-proof.js'", proofUrl],
  ["'./objective-work-command.js'", kernelUrl],
  ["'./objective-planner-unused-consent-proof.js'", unusedConsentUrl],
]);
const ownerUrl = await sourceModule('../src/clients/objectives/work/objective-planner-work-owner.ts', [
  ["'./objective-work-command.js'", kernelUrl],
  ["'./objective-planner-applied.js'", appliedUrl],
  ["'./objective-planner-consent-proof.js'", proofUrl],
  ["'./objective-planner-historical-proof.js'", historicalUrl],
  ["'./objective-planner-regeneration.js'", regenerationBindingUrl],
  ["'./objective-planner-current-consent-proof.js'", currentConsentUrl],
  ["'./objective-planner-retained-anchor.js'", retainedAnchorUrl],
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
    calls: [], outputs: [{ present: false }], outputRows: [], historical: [], nativeProofs: [], hiddenResources: [],
    expiryRows: [{ expired: false }], owner: new ObjectivePlannerWorkOwner(options.env ?? env) };
  f.tx = {
    async $executeRaw(parts, ...values) { f.calls.push({ kind: 'execute', sql: parts.join('?'), values }); return 1; },
    async $queryRaw(parts, ...values) {
      const sql = parts.join('?'); f.calls.push({ kind: 'query', sql, values });
      if (sql.includes('AS expired')) return f.expiryRows;
      if (sql.includes('JOIN client_objective_work_intents'))
        return [...f.nativeProofs, ...f.historical].filter(row => values.includes(row.consent.id));
      if (sql.includes('FROM client_objective_work_consents')) return f.historical;
      if (sql.includes('FROM client_objective_work_command_receipts')) return f.receipts;
      if (sql.includes('FROM sp_planner_resources') && sql.includes('consentId') && sql.includes('ANY'))
        return [...f.rows, ...f.hiddenResources].filter(row => values.flat().includes(row.data?.work?.consentId));
      if (sql.includes('FROM sp_planner_resources') && /\b(?:AND|WHERE)\s+(?:\w+\.)?id\s*(?:=|IN\b)/.test(sql))
        return [...f.rows, ...f.hiddenResources].filter(row => values.includes(row.id));
      if (sql.includes('FROM sp_planner_resources')) return f.rows;
      if (sql.includes('FROM sp_planner_projects') && sql.includes('UNION ALL')) return f.outputRows;
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
async function observedRead(f) {
  await f.owner.lockReadWithinTx(f.tx, { tenantId: f.a.tenantId }, { workAction: PLAN }); return f.reconcile();
}
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
function retainedHead(chain = [fullV2()], current = 'absent') {
  const f = advanceSource(appliedChain(fixture(), chain)), anchor = f.operation;
  const next = fullV3(chain.at(-1)), canonical = next.work.canonical, controlVersion = anchor.work.controlVersion + 1;
  const consentId = id(9500), source = copy(f.state.source), currentClerk = 'user_current_issuance';
  const proof = nativeConsentProof({ stored: { request: { canonical }, ack: { consentId,
    actorUserId: f.a.actorUserId, controlVersion } }, ownerClerkUserId: currentClerk }, f.state.control.id,
  { rootActorUserId: source.rootActorUserId, membershipId: f.a.actorMembershipId,
    previousConsentId: anchor.work.consentId, requestId: id(9501), commandReceiptId: id(9502) });
  Object.assign(proof.consent, { confirmed_at: iso(100), expires_at: iso(600100), stricter_expires_at: iso(600100) });
  proof.receipt.committed_at = iso(100);
  f.state.consent = { ...f.state.consent, id: consentId, source, previousConsentId: anchor.work.consentId,
    actorUserId: f.a.actorUserId, actorMembershipId: f.a.actorMembershipId,
    confirmedAt: iso(100), expiresAt: iso(600100), stricterExpiresAt: iso(600100),
    stricterLimitRef: proof.consent.stricter_limit_ref, commandRequestId: proof.consent.command_request_id,
    commandReceiptId: proof.consent.command_receipt_id, payloadDigest: proof.consent.payload_digest };
  f.state.control = { ...f.state.control, version: controlVersion, currentConsentId: consentId,
    cancelledAt: null, cancelledByUserId: null };
  f.receipts = [{ record: proof.receipt, clerkUserId: currentClerk }];
  f.currentProof = proof; f.nativeProofs.push(proof); f.anchor = anchor; f.anchorChain = chain;
  f.work = { ...copy(next.work), actorUserId: f.state.consent.actorUserId, consentId, controlVersion,
    applicationRequestId: app.canonicalApplicationRequestId(canonical, f.state.consent.actorUserId) };
  f.operation = store.newPlannerContinuationOperation({ work: f.work, clerkUserId: currentClerk,
    membershipId: f.state.consent.actorMembershipId, originalDeadlineAt: f.state.consent.expiresAt });
  const outputs = new Map();
  for (const full of chain) for (const kind of ['project', 'task']) {
    for (const item of full.owner.result[`${kind}s`]) if (item.output.id)
      outputs.set(item.output.id, { id: item.output.id, tenantId: f.a.tenantId, kind });
  }
  f.outputRows = [...outputs.values()]; f.outputs = [{ present: true }];
  if (current !== 'absent') {
    f.operation.state = current;
    if (current === 'leased') f.operation.lease = { token: id(9503), expiresAtMs: NOW + 200000 };
    else if (current !== 'queued') f.operation.terminal = { receiptId: f.operation.original.operationId, recordedAtMs: NOW + 200 };
    if (current === 'cancelled') {
      f.state.control.version++; f.state.control.cancelledAt = iso(150); f.state.control.cancelledByUserId = f.a.actorUserId;
    }
    f.rows.push(f.row());
  }
  return f;
}
function retainedCurrentReceiptIds(f) {
  return { applicationId: app.applicationReceiptId(f.a.tenantId, f.operation.clerkUserId, f.work.applicationRequestId),
    ownerId: materialization.canonicalMaterializationReceiptId(f.a.tenantId, f.operation.clerkUserId, f.work.applicationRequestId) };
}
function captureUnusedConsent(f, proof) {
  const c = proof.consent, r = proof.receipt;
  f.currentProof = proof;
  f.state.consent = { id: c.id, controlId: c.control_id, source: copy(f.state.source),
    previousConsentId: c.previous_consent_id, actorUserId: c.consenting_actor_user_id,
    actorMembershipId: c.consenting_membership_id, policyId: c.consent_policy_id, policyRevision: c.consent_policy_revision,
    configuredDurationMs: c.configured_duration_ms, effectiveDurationMs: c.effective_duration_ms,
    stricterExpiresAt: c.stricter_expires_at, stricterLimitRef: c.stricter_limit_ref,
    confirmedAt: c.confirmed_at, expiresAt: c.expires_at, commandRequestId: c.command_request_id,
    commandReceiptId: c.command_receipt_id, payloadDigest: c.payload_digest };
  f.state.control = { ...f.state.control, version: r.control_version_after, currentConsentId: c.id,
    cancelledAt: null, cancelledByUserId: null };
  f.receipts = [{ record: r, clerkUserId: proof.clerkUserId }];
  f.work = { ...f.work, actorUserId: c.consenting_actor_user_id, consentId: c.id,
    controlVersion: r.control_version_after,
    applicationRequestId: app.canonicalApplicationRequestId(f.work.canonical, c.consenting_actor_user_id) };
  f.operation = store.newPlannerContinuationOperation({ work: f.work, clerkUserId: proof.clerkUserId,
    membershipId: c.consenting_membership_id, originalDeadlineAt: c.expires_at });
}
function unusedRenewals(f, count = 1) {
  f.unusedProofs ??= [];
  for (let i = 0; i < count; i++) {
    const previous = f.currentProof, serial = f.unusedProofs.length;
    f.unusedProofs.push(previous);
    const controlVersion = previous.receipt.control_version_after + 1;
    const proof = nativeConsentProof({ stored: { request: { canonical: f.work.canonical }, ack: {
      consentId: id(10000 + serial), actorUserId: f.a.actorUserId, controlVersion } },
    ownerClerkUserId: `user_unused_successor_${serial}` }, f.state.control.id,
    { rootActorUserId: f.state.source.rootActorUserId, membershipId: f.a.actorMembershipId,
      previousConsentId: previous.consent.id, requestId: id(11000 + serial), commandReceiptId: id(12000 + serial) });
    const confirmedAt = Date.parse(previous.consent.expires_at) + 1;
    Object.assign(proof.consent, { confirmed_at: new Date(confirmedAt).toISOString(),
      expires_at: new Date(confirmedAt + 600000).toISOString(),
      stricter_expires_at: new Date(confirmedAt + 600000).toISOString() });
    proof.receipt.committed_at = proof.consent.confirmed_at;
    f.nativeProofs.push(proof); captureUnusedConsent(f, proof);
  }
  return f;
}
function retryRequest(f, requestId = id(13000)) {
  return kernel.parseWorkCommand(f.a.clientId, f.a.objectiveId, { schemaVersion: 1, requestId, command: 'retry',
    workAction: PLAN, expectedObjectiveVersion: f.a.objectiveVersion,
    expectedCanonicalBindingVersion: f.state.source.canonicalBindingVersion,
    expectedControlVersion: f.state.control.version, targetAuthorizationRequestId: f.state.consent.id });
}
async function observedRetry(f, request = retryRequest(f)) {
  await f.owner.lockWithinTx(f.tx, { tenantId: f.a.tenantId }, request); return f.reconcile();
}
function nativeUnusedReceiptIds(f, proof) {
  const requestId = app.canonicalApplicationRequestId(f.work.canonical, proof.consent.consenting_actor_user_id);
  return { applicationId: app.applicationReceiptId(f.a.tenantId, proof.clerkUserId, requestId),
    ownerId: materialization.canonicalMaterializationReceiptId(f.a.tenantId, proof.clerkUserId, requestId) };
}
function addHistoricalTerminal(f, full, options = {}) {
  const actorUserId = options.sameAction ? full.work.actorUserId : id(1999);
  const work = { ...copy(full.work), actorUserId, consentId: options.consentId ?? id(1900),
    controlVersion: options.controlVersion ?? 1,
    applicationRequestId: app.canonicalApplicationRequestId(full.work.canonical, actorUserId) };
  if (options.work) Object.assign(work, options.work);
  const clerkUserId = options.sameAction ? full.clerkUserId : 'user_failed_original';
  const operation = store.newPlannerContinuationOperation({ work, clerkUserId,
    membershipId: id(15), originalDeadlineAt: iso(300000) });
  operation.state = options.state ?? 'failed';
  operation.terminal = { receiptId: operation.original.operationId, recordedAtMs: NOW + (options.terminalOffset ?? -1) };
  const proof = nativeConsentProof({ stored: { request: { canonical: work.canonical },
    ack: { consentId: work.consentId, actorUserId, controlVersion: work.controlVersion } }, ownerClerkUserId: clerkUserId },
  f.state.control.id, { rootActorUserId: id(11 + full.work.canonical.bindingVersion),
    requestId: id(1800 + work.controlVersion), commandReceiptId: id(1700 + work.controlVersion),
    previousConsentId: options.previousConsentId ?? null });
  const confirmed = options.confirmedOffset ?? -1000;
  Object.assign(proof.consent, { confirmed_at: iso(confirmed), expires_at: iso(confirmed + 600000),
    stricter_expires_at: iso(confirmed + 600000) });
  proof.receipt.committed_at = iso(confirmed);
  proof.intent.created_at = proof.revision.created_at = iso(confirmed - 1000);
  f.historical.push(proof); f.rows.unshift(f.row(operation));
  return { operation, proof };
}
function linkAppliedConsent(f, full, previousConsentId) {
  const proof = f.nativeProofs.find(p => p.consent.id === full.work.consentId);
  proof.consent.previous_consent_id = proof.receipt.target_consent_id = previousConsentId;
  proof.receipt.command.targetAuthorizationRequestId = previousConsentId;
  const request = kernel.parseWorkCommand(f.a.clientId, f.a.objectiveId, proof.receipt.command);
  proof.consent.payload_digest = proof.receipt.payload_digest = kernel.workDigest(request);
  if (f.state.consent.id === full.work.consentId) {
    f.state.consent.previousConsentId = previousConsentId; f.state.consent.payloadDigest = proof.consent.payload_digest;
    f.receipts[0].record = proof.receipt;
  }
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
test('actual owner advanced-source accounting and cached policy feed actual kernel new consent and exact replay', async () => {
  const first = fullV2(), second = fullV3(first), third = fullV3(second);
  const f = advanceSource(appliedChain(fixture(), [first, second, third]));
  const original = copy({ operation: f.operation, rows: f.rows, nativeProofs: f.nativeProofs, consent: f.state.consent });
  // Only persistence, current human authority and the request proof's expiry are
  // synthetic. Reconciliation, full owner/native lineage codecs, cached policy,
  // source witness verification, command kernel and receipt recovery are real.
  let saved = { state: copy(f.state), consents: {}, receipts: {}, nextId: 8000 };
  const events = [];
  const owner = { transaction: async (write, run) => {
    const draft = copy(saved), writable = () => assert.equal(write, true);
    const result = await run({
      lockOwner: async () => { writable();events.push('lock-owner');await f.lock(); },
      currentAuthority: async () => { events.push('current-authority');return copy(f.a); },
      receipt: async (a, action, requestId) => {
        events.push('receipt');return copy(draft.receipts[`${a.actorUserId}:${action}:${requestId}`] ?? null);
      },
      state: async () => { events.push('state');return copy(draft.state); },
      reconcile: async (a, action, state) => {
        events.push('reconcile');return f.owner.reconcileWithinTx(f.tx, a, action, state);
      },
      policy: async (a, action, state) => {
        events.push('policy');return { ...await f.owner.policyWithinTx(f.tx, a, action, state),
          originalTokenExpiresAtMs: NOW + 20000 };
      },
      clock: async () => { events.push('clock');return iso(1000); },
      insertConsent: async (_a, _action, consent) => {
        writable();events.push('insert-consent');assert.equal(draft.consents[consent.id], undefined);
        draft.consents[consent.id] = copy(consent);
      },
      casControl: async (_a, _action, before, after) => {
        writable();events.push('cas-control');assert.deepEqual(draft.state.control, before);
        draft.state.control = copy(after);draft.state.consent = copy(draft.consents[after.currentConsentId]);return true;
      },
      insertReceipt: async (a, stored) => {
        writable();events.push('insert-receipt');
        const key = `${a.actorUserId}:${stored.command.workAction}:${stored.command.requestId}`;
        assert.equal(draft.receipts[key], undefined);draft.receipts[key] = copy(stored);
      },
      newId: () => { writable();events.push('new-id');return id(draft.nextId++); },
    });
    if (write) saved = draft;return result;
  } };
  await f.lock();
  const status = await kernel.readWorkGeneration({ clientId: f.a.clientId, objectiveId: f.a.objectiveId, workAction: PLAN }, owner);
  assert.equal(status.reconciliation, 'accounted');assert.equal(status.consent.id, original.consent.id);
  assert.equal(Object.hasOwn(status, 'regeneration'), false);
  const request = kernel.parseWorkCommand(f.a.clientId, f.a.objectiveId, { schemaVersion: 1, requestId: id(7999),
    command: 'retry', workAction: PLAN, expectedObjectiveVersion: f.a.objectiveVersion,
    expectedControlVersion: saved.state.control.version, expectedCanonicalBindingVersion: saved.state.source.canonicalBindingVersion,
    targetAuthorizationRequestId: original.consent.id });
  events.length = 0;
  const receipt = await kernel.executeWorkCommand(request, owner);
  assert.equal(receipt.outcome, 'reconsent_recorded');assert.equal(receipt.workAction, PLAN);
  assert.equal(receipt.payloadDigest, kernel.workDigest(request));assert.equal(receipt.targetAuthorizationRequestId, original.consent.id);
  assert.equal(receipt.rootIntentId, f.state.source.rootIntentId);
  assert.notEqual(receipt.rootIntentId, original.consent.source.rootIntentId);
  const consent = saved.consents[receipt.authorizationRequestId];
  assert.deepEqual(consent.source, f.state.source);assert.equal(consent.previousConsentId, original.consent.id);
  assert.equal(consent.actorUserId, f.a.actorUserId);assert.notEqual(consent.actorUserId, original.consent.actorUserId);
  assert.equal(consent.expiresAt, iso(20000));assert.equal(consent.confirmedAt, iso(1000));
  assert.equal(saved.state.control.version, f.state.control.version + 1);
  assert.ok(events.indexOf('lock-owner') < events.lastIndexOf('current-authority'));
  assert.ok(events.indexOf('reconcile') < events.indexOf('policy'));
  assert.ok(events.indexOf('policy') < events.indexOf('clock'));
  assert.equal(f.calls.filter(c => c.sql.includes('JOIN client_objective_work_intents')).length, 6,
    'status and retry each revalidate every real applied ancestor');
  assert.equal(f.calls.filter(c => c.sql.includes('FROM tenants')).length, 1, 'actual cached owner policy was consumed');
  const committed = copy(saved);events.length = 0;
  assert.deepEqual(await kernel.executeWorkCommand(request, owner), receipt);
  assert.deepEqual(saved, committed);assert.deepEqual(events, ['current-authority', 'receipt']);
  await assert.rejects(kernel.executeWorkCommand({ ...request,
    command: { ...request.command, expectedControlVersion: 99 } }, owner), error => error.code === 'REQUEST_ID_CONFLICT');
  assert.deepEqual(saved, committed);
  assert.deepEqual({ operation: f.operation, rows: f.rows, nativeProofs: f.nativeProofs, consent: f.state.consent }, original,
    'retained operation, applied receipts, native lineage and original consent remain unchanged');
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
for (const state of ['failed', 'cancelled']) test(`earlier-binding ${state} keeps original root identity with no own receipt despite verified predecessor outputs`, async () => {
  const first = fullV2(), second = fullV3(first), f = appliedChain(fixture(), [first, second]);
  const historical = addHistoricalTerminal(f, first, { state }), before = copy(historical.operation);
  f.outputs = [{ present: true }];
  const evidence = await observed(f);
  assert.equal(evidence.state, 'accounted'); assert.equal(evidence.outcome, 'applied');
  assert.equal(evidence.operationId, f.operation.original.operationId);
  assert.notEqual(historical.proof.intent.actor_user_id, f.state.source.rootActorUserId);
  assert.deepEqual(historical.operation, before);
  assert.equal(f.calls.some(c => c.sql.includes('FROM sp_planner_projects')), false);
});
test('no-own-receipt history permits equal native terminal/current-consent millisecond timestamps', async () => {
  const first = fullV2(), second = fullV3(first), f = appliedChain(fixture(), [first, second]);
  addHistoricalTerminal(f, first, { terminalOffset: 0 });
  assert.equal((await observed(f)).state, 'accounted');
});
test('coherently terminal-accounted old failure after current consent cannot borrow receipt absence', async () => {
  const first = fullV2(), second = fullV3(first), f = appliedChain(fixture(), [first, second]);
  const h = addHistoricalTerminal(f, first, { terminalOffset: 1 });
  assert.ok(h.operation.terminal.recordedAtMs >= Date.parse(h.proof.receipt.committed_at));
  assert.ok(h.operation.terminal.recordedAtMs < Date.parse(h.operation.original.originalDeadlineAt));
  assert.equal((await observed(f)).state, 'outcome_unconfirmed');
});
for (const confirmedAt of ['invalid', '2026-02-30T12:00:00.000Z', iso(0) + '\n'])
test(`historical receipt absence fails closed on invalid current confirmation clock: ${JSON.stringify(confirmedAt)}`, async () => {
  const f = olderNoEffect(fixture()); f.state.consent.confirmedAt = confirmedAt;
  assert.equal((await observed(f)).state, 'outcome_unconfirmed');
});
test('earlier failed action can be owned by a distinct later explicit consent with exact full paired predecessor request', async () => {
  const first = fullV2(), second = fullV3(first), f = appliedChain(fixture(), [first, second]);
  const historical = addHistoricalTerminal(f, first, { sameAction: true });
  linkAppliedConsent(f, first, historical.operation.work.consentId);
  assert.equal((await observed(f)).state, 'accounted');
  assert.equal(historical.operation.terminal.receiptId, historical.operation.original.operationId);
});
test('a same-action paired success allows equality at its own verified successor confirmation timestamp', async () => {
  const first = fullV2(), second = fullV3(first), f = appliedChain(fixture(), [first, second]);
  const h = addHistoricalTerminal(f, first, { sameAction: true, terminalOffset: 0 });
  linkAppliedConsent(f, first, h.operation.work.consentId);
  assert.equal((await observed(f)).state, 'accounted');
});
test('a later current consent cannot cover terminal accounting after the exact paired successor consent', async () => {
  const first = fullV2(), second = fullV3(first), f = appliedChain(fixture(), [first, second]);
  const h = addHistoricalTerminal(f, first, { sameAction: true, terminalOffset: 1 });
  linkAppliedConsent(f, first, h.operation.work.consentId);
  const current = f.nativeProofs.at(-1);
  current.consent.confirmed_at = current.receipt.committed_at = f.state.consent.confirmedAt = iso(2);
  current.consent.expires_at = current.consent.stricter_expires_at = f.state.consent.expiresAt = iso(600002);
  assert.ok(h.operation.terminal.recordedAtMs < Date.parse(f.state.consent.confirmedAt));
  assert.equal((await observed(f)).state, 'outcome_unconfirmed');
});
test('full explicit native succession can account two earlier terminal consents before one paired success', async () => {
  const first = fullV2({ controlVersion: 4 }), second = fullV3(first), f = appliedChain(fixture(), [first, second]);
  const older = addHistoricalTerminal(f, first, { sameAction: true, consentId: id(1901), terminalOffset: -100 });
  const newer = addHistoricalTerminal(f, first, { sameAction: true, consentId: id(1902), state: 'cancelled',
    controlVersion: 2, confirmedOffset: -80, terminalOffset: -50, previousConsentId: older.operation.work.consentId });
  linkAppliedConsent(f, first, newer.operation.work.consentId);
  assert.equal((await observed(f)).state, 'accounted');
});
for (const corrupt of [
  (f, h) => { h.proof.intent.actor_user_id = f.state.source.rootActorUserId; },
  (_f, h) => { h.proof.revision.snapshot.title = 'original snapshot changed'; },
  (_f, h) => { h.proof.receipt.actor_membership_id = id(991); },
  (_f, h) => { h.proof.clerkUserId = 'foreign_clerk'; },
  (_f, h) => { h.proof.receipt.command.expectedControlVersion++; },
  (_f, h) => { h.proof.consent.expires_at = iso(1); },
  (_f, h) => { h.operation.terminal.receiptId = id(992); },
  (_f, h) => { h.operation.original.originalDeadlineAt = iso(900000); },
  (_f, h) => { h.operation.state = 'queued'; h.operation.terminal = null; },
  (_f, h) => { h.operation.state = 'leased'; h.operation.terminal = null; h.operation.lease = { token: id(993), expiresAtMs: NOW + 1 }; },
]) test(`earlier-binding terminal original proof refuses corruption: ${corrupt}`, async () => {
  const first = fullV2(), second = fullV3(first), f = appliedChain(fixture(), [first, second]);
  const historical = addHistoricalTerminal(f, first); corrupt(f, historical);
  assert.equal((await observed(f)).state, 'outcome_unconfirmed');
});
for (const corrupt of [
  (f, _h, first) => { linkAppliedConsent(f, first, id(998)); },
  (_f, h) => { h.operation.terminal.recordedAtMs = NOW + 1; },
  (f, _h, first) => { f.nativeProofs.find(p => p.consent.id === first.work.consentId).consent.confirmed_at = iso(-2); },
]) test(`same-action paired success cannot bypass later explicit native succession: ${corrupt}`, async () => {
  const first = fullV2(), second = fullV3(first), f = appliedChain(fixture(), [first, second]);
  const historical = addHistoricalTerminal(f, first, { sameAction: true });
  linkAppliedConsent(f, first, historical.operation.work.consentId); corrupt(f, historical, first);
  assert.equal((await observed(f)).state, 'outcome_unconfirmed');
});
for (const work of [{ generationJobId: id(990) }, { generationRequestId: id(990) }, { strategyVersionId: id(990) },
  { objectiveReceiptSha256: 'e'.repeat(64) }, { snapshotDigest: 'e'.repeat(64) }])
test(`same stable action with different complete generation work cannot borrow a later paired success: ${JSON.stringify(work)}`, async () => {
  const first = fullV2(), second = fullV3(first), f = appliedChain(fixture(), [first, second]);
  const historical = addHistoricalTerminal(f, first, { sameAction: true, work });
  linkAppliedConsent(f, first, historical.operation.work.consentId);
  assert.equal((await observed(f)).state, 'outcome_unconfirmed');
});
function olderNoEffect(f, overrides = {}) {
  const c = { ...f.work.canonical, bindingVersion: 1, requestedObjectiveVersion: 1,
    requestedIntentId: id(1601), requestedObjectiveRevisionId: id(1602), ...overrides };
  c.snapshotHash = kernel.workDigest(readySnapshot(c));
  addHistoricalTerminal(f, fullV2({ canonical: c })); return f;
}
test('fully proved earlier-binding terminal history permits genuinely empty current work only with direct no-output proof', async () => {
  const f = olderNoEffect(fixture()); assert.equal((await observed(f)).state, 'not_started');
  assert.equal(f.calls.filter(c => c.sql.includes('FROM sp_planner_projects')).length, 1);
  f.outputs = [{ present: true }]; assert.equal((await f.reconcile()).state, 'outcome_unconfirmed');
});
test('earlier terminal history preserves genuinely no-output current failed operation identity and deadline', async () => {
  const f = olderNoEffect(fixture().terminal('failed')), before = copy(f.operation);
  const evidence = await observed(f); assert.equal(evidence.state, 'accounted'); assert.equal(evidence.outcome, 'failed');
  assert.equal(evidence.operationId, before.original.operationId); assert.equal(evidence.originalDeadlineAt, before.original.originalDeadlineAt);
  assert.equal(evidence.terminalReceiptId, before.original.operationId); assert.deepEqual(f.operation, before);
});
for (const overrides of [{ requestedObjectiveVersion: 2 }, { requestedObjectiveVersion: 3 },
  { requestedIntentId: id(10) }, { requestedObjectiveRevisionId: id(6) }])
test(`lower binding label cannot establish earlier history with nonadvancing native source: ${JSON.stringify(overrides)}`, async () => {
  const f = olderNoEffect(fixture(), overrides);
  assert.equal((await observed(f)).state, 'outcome_unconfirmed');
});
test('current failed operation with older applied head remains uncertain outside retained no-operation status', async () => {
  const first = fullV2(), second = fullV3(first), f = appliedChain(fixture(), [first, second]);
  const older = f.rows.find(row => row.kind === store.PLANNER_CONTINUATION_OPERATION && row.data.work.consentId === first.work.consentId);
  f.rows = [older, ...first.resources];
  f.operation.state = 'failed'; f.operation.terminal = { receiptId: f.operation.original.operationId, recordedAtMs: NOW + 5 };
  f.rows.push(f.row());
  assert.equal((await observed(f)).state, 'outcome_unconfirmed');
});
for (const length of [1, 2, 3]) test(`current operation absence retains a fully checked ${length}-application older head for status only`, async () => {
  const chain = [fullV2()]; while (chain.length < length) chain.push(fullV3(chain.at(-1)));
  const f = retainedHead(chain), before = copy({ rows: f.rows, state: f.state, proofs: f.nativeProofs });
  const evidence = await observedRead(f);
  assert.equal(evidence.state, 'not_started'); assert.equal(evidence.authorizationRequestId, f.state.consent.id);
  assert.equal(evidence.rootIntentId, f.state.consent.source.rootIntentId);
  assert.equal(evidence.operationId, undefined); assert.equal(evidence.regeneration, undefined);
  assert.equal(evidence.originalDeadlineAt, undefined, 'the old deadline is not the new consent subject');
  assert.equal(f.calls.filter(c => c.sql.includes('JOIN client_objective_work_intents')).length, length + 1);
  await assert.rejects(f.policy(), error => error.code === 'AUTHORITY_UNAVAILABLE');
  assert.equal(f.calls.filter(c => c.sql.includes('FROM tenants')).length, 0, 'status cannot reach issuance settings');
  assert.deepEqual({ rows: f.rows, state: f.state, proofs: f.nativeProofs }, before);
});
test('retained-head status uses the current consent actor and issuance Clerk rather than the current viewer', async () => {
  const f = retainedHead(); f.a.actorUserId = id(9600); f.a.actorMembershipId = id(9601); f.a.clerkUserId = 'user_current_viewer';
  assert.notEqual(f.a.actorUserId, f.state.consent.actorUserId);
  assert.notEqual(f.state.consent.actorUserId, f.anchor.work.actorUserId);
  assert.equal((await observedRead(f)).state, 'not_started');
  const probes = f.calls.filter(c => c.sql.includes('FROM sp_planner_resources') && c.sql.includes('AND id IN'));
  const exact = retainedCurrentReceiptIds(f);
  assert.ok(probes.some(c => c.values.includes(exact.applicationId) && c.values.includes(exact.ownerId)));
});
test('retained-head qualification requires an early read gate and cannot survive a subsequent writer lock', async () => {
  const f = retainedHead();
  assert.equal((await observed(f)).state, 'outcome_unconfirmed');
  assert.equal((await observedRead(f)).state, 'not_started');
  await assert.rejects(f.policy(), error => error.code === 'AUTHORITY_UNAVAILABLE');
  assert.equal((await observed(f)).state, 'outcome_unconfirmed');
  await assert.rejects(f.policy(), error => error.code === 'AUTHORITY_UNAVAILABLE');
});
for (const current of ['queued', 'leased', 'failed', 'cancelled']) test(`retained head does not relabel current ${current} operation as no operation`, async () => {
  const f = retainedHead(undefined, current);
  assert.equal((await observedRead(f)).state, 'outcome_unconfirmed'); await assert.rejects(f.policy());
});
const retainedCorruptions = [
  ['missing head', f => { f.rows = f.rows.filter(r => r.kind !== 'objective_canonical_application_head'); }],
  ['wrong head kind', f => { f.rows.find(r => r.kind === 'objective_canonical_application_head').kind = 'unrelated_private'; }],
  ['foreign head owner', f => { f.rows.find(r => r.kind === 'objective_canonical_application_head').ownerId = 'foreign_clerk'; }],
  ['changed head acknowledgement', f => { f.rows.find(r => r.kind === 'objective_canonical_application_head').data.ackSha256 = '0'.repeat(64); }],
  ['unconsumed old operation', f => { f.rows.push({ ...f.row(f.anchor), id: id(9602) }); }],
  ['missing original applied operation', f => { f.rows = f.rows.filter(r => r.id !== f.anchor.original.operationId); }],
  ['missing oldest ancestor operation', f => {
    f.rows = f.rows.filter(r => r.kind !== store.PLANNER_CONTINUATION_OPERATION ||
      r.data.work.consentId !== f.anchorChain[0].work.consentId);
  }],
  ['orphan full application outside selected ancestry', f => {
    const orphan = fullV2({ actorUserId: id(9620) });
    f.rows.push(...orphan.resources.filter(r => r.kind !== 'objective_canonical_application_head'));
  }],
  ['missing oldest native proof', f => { f.nativeProofs.shift(); }],
  ['foreign original Clerk mapping', f => { f.nativeProofs[0].clerkUserId = 'foreign_clerk'; }],
  ['corrupt oldest original root', f => { f.nativeProofs[0].intent.actor_user_id = id(9603); }],
  ['unknown direct previous consent', f => {
    f.state.consent.previousConsentId = id(9604); f.currentProof.consent.previous_consent_id = id(9604);
    f.currentProof.receipt.target_consent_id = id(9604); f.currentProof.receipt.command.targetAuthorizationRequestId = id(9604);
    const digest = kernel.workDigest(kernel.parseWorkCommand(f.a.clientId, f.a.objectiveId, f.currentProof.receipt.command));
    f.state.consent.payloadDigest = f.currentProof.consent.payload_digest = f.currentProof.receipt.payload_digest = digest;
  }],
  ['new consent before old application terminal', f => {
    f.state.consent.confirmedAt = f.currentProof.consent.confirmed_at = iso(0);
    f.state.consent.expiresAt = f.state.consent.stricterExpiresAt = f.currentProof.consent.expires_at =
      f.currentProof.consent.stricter_expires_at = iso(600000); f.currentProof.receipt.committed_at = iso(0);
  }],
  ['mismatched current native membership', f => { f.currentProof.consent.consenting_membership_id = id(9605); }],
  ['mismatched current native Clerk', f => { f.currentProof.clerkUserId = 'foreign_current_clerk'; }],
  ['mismatched current native snapshot', f => { f.currentProof.revision.snapshot.version++; }],
  ['stale current Objective status', f => { f.a.objectiveStatus = 'draft'; }],
  ['new ready source beyond consent source', f => { f.state.source.sourceObjectiveVersion++; f.a.objectiveVersion++; }],
  ['orphan canonical output', f => { f.outputRows.push({ id: id(9606), tenantId: f.a.tenantId, kind: 'task' }); }],
  ['foreign output tenant', f => { f.outputRows[0].tenantId = id(9607); }],
  ['missing owned output identity', f => { f.outputRows.pop(); }],
  ['duplicate owned output identity', f => { f.outputRows[1] = copy(f.outputRows[0]); }],
  ['output inventory overflow', f => { f.outputRows = Array.from({ length: 257 }, (_, n) => ({ id: id(10000 + n), tenantId: f.a.tenantId, kind: 'task' })); }],
  ['resource inventory overflow', f => { f.rows = Array.from({ length: 257 }, () => copy(f.rows[0])); }],
];
for (const [label, corrupt] of retainedCorruptions) test(`retained-head status refuses ${label}`, async () => {
  const first = fullV2(), second = fullV3(first), f = retainedHead([first, second]); corrupt(f);
  assert.equal((await observedRead(f)).state, 'outcome_unconfirmed'); await assert.rejects(f.policy());
});
test('an older ancestor control cannot run ahead of the current native consent despite a coherent complete receipt chain', async () => {
  const first = fullV2({ controlVersion: 99 }), f = retainedHead([first, fullV3(first)]);
  assert.equal((await observedRead(f)).state, 'outcome_unconfirmed');
});
test('every ancestor terminal must precede the new native confirmation, not only the selected head operation', async () => {
  const first = fullV2(), f = retainedHead([first, fullV3(first)]);
  f.rows.find(r => r.kind === store.PLANNER_CONTINUATION_OPERATION && r.data.work.consentId === first.work.consentId)
    .data.terminal.recordedAtMs = NOW + 101;
  assert.ok(f.anchor.terminal.recordedAtMs < NOW + 100);
  assert.equal((await observedRead(f)).state, 'outcome_unconfirmed');
});
test('adjacent older applied controls must advance even when both precede the new current consent', async () => {
  const first = fullV2({ controlVersion: 4 }), second = fullV3(first), f = retainedHead([first, second]);
  assert.equal(first.work.controlVersion, second.work.controlVersion);
  assert.ok(second.work.controlVersion < f.state.control.version);
  assert.equal((await observedRead(f)).state, 'outcome_unconfirmed');
});
test('adjacent older applied terminal chronology must hold even when both precede the new confirmation', async () => {
  const first = fullV2(), f = retainedHead([first, fullV3(first)]);
  f.rows.find(r => r.kind === store.PLANNER_CONTINUATION_OPERATION && r.data.work.consentId === first.work.consentId)
    .data.terminal.recordedAtMs = NOW + 10;
  assert.ok(f.anchor.terminal.recordedAtMs < NOW + 10 && NOW + 10 < Date.parse(f.state.consent.confirmedAt));
  assert.equal((await observedRead(f)).state, 'outcome_unconfirmed');
});
test('adjacent older applied terminal equality remains valid at millisecond precision', async () => {
  const first = fullV2(), f = retainedHead([first, fullV3(first)]);
  f.rows.find(r => r.kind === store.PLANNER_CONTINUATION_OPERATION && r.data.work.consentId === first.work.consentId)
    .data.terminal.recordedAtMs = f.anchor.terminal.recordedAtMs;
  assert.equal((await observedRead(f)).state, 'not_started');
});
test('a fully proved failed consent bridge does not require adjacent applied consents to be direct predecessors', async () => {
  const first = fullV2(), second = fullV3(first);
  second.stored.ack.recordedAt = iso(30); second.stored.ackSha256 = app.applicationHash(second.stored.ack);
  second.resources.find(r => r.kind === 'objective_canonical_application_head').data.ackSha256 = second.stored.ackSha256;
  second.operation.terminal.recordedAtMs = NOW + 31;
  const f = retainedHead([first, second]), proof = f.nativeProofs.find(p => p.consent.id === second.work.consentId);
  Object.assign(proof.consent, { confirmed_at: iso(20), expires_at: iso(600020), stricter_expires_at: iso(600020) });
  proof.receipt.committed_at = iso(20);
  const bridge = addHistoricalTerminal(f, second, { sameAction: true, controlVersion: 3,
    consentId: id(9630), confirmedOffset: 5, terminalOffset: 10, previousConsentId: first.work.consentId });
  linkAppliedConsent(f, second, bridge.operation.work.consentId);
  assert.notEqual(proof.consent.previous_consent_id, first.work.consentId);
  const before = copy({ rows: f.rows, proofs: f.nativeProofs, historical: f.historical });
  assert.equal((await observedRead(f)).state, 'not_started');
  await assert.rejects(f.policy(), error => error.code === 'AUTHORITY_UNAVAILABLE');
  assert.deepEqual({ rows: f.rows, proofs: f.nativeProofs, historical: f.historical }, before);
});
test('anchor terminal equality with the new confirmation remains valid at millisecond precision', async () => {
  const f = retainedHead(); f.anchor.terminal.recordedAtMs = NOW + 100;
  assert.equal((await observedRead(f)).state, 'not_started');
});
for (const kind of ['applicationId', 'ownerId']) for (const hidden of ['different kind', 'foreign embedded source', 'foreign owner', 'shared'])
test(`exact current retained-head ${kind} cannot hide with ${hidden}`, async () => {
  const f = retainedHead(), ids = retainedCurrentReceiptIds(f);
  const sourceKind = kind === 'applicationId' ? 'objective_canonical_application_receipt' : 'objective_canonical_materialization_receipt';
  const row = copy(f.anchorChain[0].resources.find(r => r.kind === sourceKind)); row.id = ids[kind];
  row.ownerId = f.operation.clerkUserId;
  if (hidden === 'different kind') row.kind = 'unrelated_private';
  if (hidden === 'foreign embedded source') {
    const c = kind === 'applicationId' ? row.data.request.canonical : row.data.binding.canonical;
    c.objectiveId = id(9610); c.canonicalPlanId = id(9611);
  }
  if (hidden === 'foreign owner') row.ownerId = 'foreign_clerk';
  if (hidden === 'shared') row.shareTokenHash = 'f'.repeat(64);
  f.hiddenResources.push(row);
  assert.equal((await observedRead(f)).state, 'outcome_unconfirmed');
});
test('actual kernel exposes retained-head status but cannot create any new consent or operation from it', async () => {
  const first = fullV2(), f = retainedHead([first, fullV3(first)]), before = copy({ rows: f.rows, state: f.state });
  const writes = [];
  const owner = { transaction: async (write, run) => {
    if (!write) await f.owner.lockReadWithinTx(f.tx, { tenantId: f.a.tenantId }, { workAction: PLAN });
    return run({ lockOwner: f.lock, currentAuthority: async () => copy(f.a), receipt: async () => null,
      state: async () => copy(f.state), clock: async () => iso(300),
      reconcile: (a, kind, state) => f.owner.reconcileWithinTx(f.tx, a, kind, state),
      policy: async (a, kind, state) => ({ ...await f.owner.policyWithinTx(f.tx, a, kind, state), originalTokenExpiresAtMs: NOW + 500000 }),
      insertConsent: async () => { writes.push('consent'); }, casControl: async () => { writes.push('control'); return true; },
      insertReceipt: async () => { writes.push('receipt'); }, newId: () => { writes.push('id'); return id(9700); } });
  } };
  const status = await kernel.readWorkGeneration({ clientId: f.a.clientId, objectiveId: f.a.objectiveId, workAction: PLAN }, owner);
  assert.equal(status.reconciliation, 'not_started'); assert.equal(status.consent.id, f.state.consent.id);
  assert.equal(status.control.currentAuthorizationRequestId, f.state.consent.id);
  const request = kernel.parseWorkCommand(f.a.clientId, f.a.objectiveId, { schemaVersion: 1, requestId: id(9701),
    command: 'retry', workAction: PLAN, expectedObjectiveVersion: f.a.objectiveVersion,
    expectedCanonicalBindingVersion: f.state.source.canonicalBindingVersion, expectedControlVersion: f.state.control.version,
    targetAuthorizationRequestId: f.state.consent.id });
  await assert.rejects(kernel.executeWorkCommand(request, owner), error => error.code === 'OUTCOME_UNCONFIRMED');
  assert.deepEqual(writes, []); assert.deepEqual({ rows: f.rows, state: f.state }, before);
});
for (const kind of ['applicationId', 'ownerId']) for (const concealment of ['different kind', 'foreign embedded scope'])
test(`exact earlier terminal ${kind} cannot hide behind ${concealment}`, async () => {
  const first = fullV2(), second = fullV3(first), f = appliedChain(fixture(), [first, second]);
  const h = addHistoricalTerminal(f, first), ids = historicalCodec.objectivePlannerHistoricalReceiptIds(h.operation);
  const receiptKind = kind === 'applicationId' ? 'objective_canonical_application_receipt' : 'objective_canonical_materialization_receipt';
  const row = copy(first.resources.find(resource => resource.kind === receiptKind));
  row.id = ids[kind]; row.ownerId = h.operation.clerkUserId;
  if (concealment === 'different kind') row.kind = 'unrelated_private_receipt';
  else {
    const c = kind === 'applicationId' ? row.data.request.canonical : row.data.binding.canonical;
    c.objectiveId = id(9901); c.canonicalPlanId = id(9902);
  }
  f.hiddenResources = [row];
  assert.equal((await observed(f)).state, 'outcome_unconfirmed');
  const probes = f.calls.filter(c => c.sql.includes('AND id IN'));
  assert.equal(probes.length, 1); assert.deepEqual(probes[0].values, [f.a.tenantId, ids.applicationId, ids.ownerId]);
  assert.doesNotMatch(probes[0].sql, /AND\s+(?:kind|owner_id|data)/);
});
function priorTerminal(f) {
  const old = applied(fixture()).terminal('failed'), c = old.state.consent;
  f.state.source = copy(old.state.source); f.state.consent.source = copy(old.state.source);
  f.receipts[0].record.source_snapshot_hash = old.state.source.sourceSnapshotHash;
  f.state.consent.id = id(90); f.state.control.currentConsentId = id(90);
  f.state.consent.previousConsentId = c.id; f.state.control.version = 3;
  f.state.consent.confirmedAt = iso(10); f.state.consent.expiresAt = iso(600010);
  Object.assign(f.receipts[0].record, { created_consent_id: id(90), result_consent_id: id(90), target_consent_id: c.id,
    control_version_before: 2, control_version_after: 3 });
  const current = kernel.parseWorkCommand(f.a.clientId, f.a.objectiveId, { ...f.receipts[0].record.command,
    expectedControlVersion: 2, targetAuthorizationRequestId: c.id });
  f.state.consent.payloadDigest = kernel.workDigest(current);
  Object.assign(f.receipts[0].record, { command: current.command, payload_digest: f.state.consent.payloadDigest });
  f.historical = old.nativeProofs; f.rows = [old.row()];
  return f;
}
test('fully accounted earlier failed consent permits current same-binding operation absence', async () => {
  const f = priorTerminal(fixture()); assert.equal((await observed(f)).state, 'not_started');
  assert.ok(f.calls.some(c => c.sql.includes('FROM client_objective_work_consents')));
});
test('same-binding terminal/current consent equality is valid at database millisecond precision', async () => {
  const f = priorTerminal(fixture()); f.state.consent.confirmedAt = iso(5); f.state.consent.expiresAt = iso(600005);
  assert.equal((await observed(f)).state, 'not_started');
});
test('same-binding coherent terminal from after current consent is uncertain despite exact receipt absence', async () => {
  const f = priorTerminal(fixture()); f.rows[0].data.terminal.recordedAtMs = NOW + 11;
  assert.ok(f.rows[0].data.terminal.recordedAtMs < Date.parse(f.rows[0].data.original.originalDeadlineAt));
  assert.equal((await observed(f)).state, 'outcome_unconfirmed');
});
for (const mutate of [f => { f.historical = []; }, f => { f.historical[0].receipt.actor_membership_id = id(88); },
  f => { f.historical[0].consent.source_snapshot_hash = 'e'.repeat(64); },
  f => { f.historical[0].consent.expires_at = iso(1); }, f => { f.historical[0].receipt.payload_digest = 'a'.repeat(64); },
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

test('expired unused current consent beside a full applied anchor enables only an explicit retry', async () => {
  const f = retainedHead(), before = copy({ rows: f.rows, state: f.state, proofs: f.nativeProofs });
  f.expiryRows = [{ expired: true }];
  assert.equal((await observedRetry(f)).state, 'not_started');
  const facts = await f.policy(); assert.equal(facts.originalDelegationExpiresAtMs, null);
  const expiry = f.calls.find(c => c.sql.includes('AS expired'));
  assert.match(expiry.sql, /clock_timestamp\(\) >= c\.expires_at/);
  assert.deepEqual(expiry.values, [f.a.tenantId, f.a.clientId, f.a.objectiveId, PLAN, f.state.control.id, f.state.consent.id]);
  assert.deepEqual({ rows: f.rows, state: f.state, proofs: f.nativeProofs }, before);
  await observedRead(f); await assert.rejects(f.policy(), error => error.code === 'AUTHORITY_UNAVAILABLE');
});

for (const count of [1, 3]) test(`complete ${count}-unused-consent bridge retains read and expired-retry accounting`, async () => {
  const f = unusedRenewals(retainedHead(), count), before = copy({ rows: f.rows, state: f.state, proofs: f.nativeProofs });
  assert.equal((await observedRead(f)).state, 'not_started');
  assert.equal(f.calls.filter(c => c.sql.includes('AS expired')).length, 0, 'a read cannot evaluate issuance expiry');
  await assert.rejects(f.policy(), error => error.code === 'AUTHORITY_UNAVAILABLE');
  f.expiryRows = [{ expired: true }]; assert.equal((await observedRetry(f)).state, 'not_started');
  assert.equal((await f.policy()).originalDelegationExpiresAtMs, null);
  for (const proof of f.unusedProofs) {
    const read = f.calls.find(c => c.sql.includes('JOIN client_objective_work_intents') && c.values.includes(proof.consent.id));
    assert.ok(read, 'each unused consent has its own actual native proof');
    assert.deepEqual(read.values, [f.a.tenantId, f.a.clientId, f.a.objectiveId, PLAN, proof.consent.id, f.state.control.id]);
    assert.match(read.sql, /FOR SHARE OF m,u/);
    const ids = nativeUnusedReceiptIds(f, proof);
    assert.ok(f.calls.some(c => c.sql.includes('FROM sp_planner_resources') && c.values.includes(ids.applicationId) &&
      c.values.includes(ids.ownerId) && !c.sql.includes('kind') && !c.sql.includes('owner_id')));
  }
  assert.deepEqual({ rows: f.rows, state: f.state, proofs: f.nativeProofs }, before);
});

test('unused original actor and Clerk remain exact when another current human renews', async () => {
  const f = retainedHead(), prior = copy(f.currentProof);
  f.a.actorUserId = id(14000); f.a.actorMembershipId = id(14001); f.a.clerkUserId = 'user_fresh_human';
  unusedRenewals(f); f.expiryRows = [{ expired: true }];
  assert.equal((await observedRetry(f)).state, 'not_started');
  assert.notEqual(f.currentProof.clerkUserId, prior.clerkUserId);
  const ids = nativeUnusedReceiptIds(f, prior);
  assert.ok(f.calls.some(c => c.sql.includes('FROM sp_planner_resources') && c.values.includes(ids.applicationId)));
});

test('unused renewal accepts expiry equal to successor confirmation at millisecond precision', async () => {
  const f = unusedRenewals(retainedHead()), confirmedAt = f.unusedProofs[0].consent.expires_at;
  f.currentProof.consent.confirmed_at = f.currentProof.receipt.committed_at = confirmedAt;
  f.currentProof.consent.expires_at = f.currentProof.consent.stricter_expires_at =
    new Date(Date.parse(confirmedAt) + 600000).toISOString();
  captureUnusedConsent(f, f.currentProof);
  assert.equal((await observedRead(f)).state, 'not_started');
});

test('a coherent native consent from the old ready source cannot bridge current-source unused consent', async () => {
  const f = unusedRenewals(retainedHead()), bridge = f.unusedProofs[0], c = bridge.consent, r = bridge.receipt;
  const old = nativeConsentProof({ stored: { request: { canonical: f.anchorChain[0].work.canonical },
    ack: { consentId: c.id, actorUserId: c.consenting_actor_user_id, controlVersion: r.control_version_after } },
  ownerClerkUserId: bridge.clerkUserId }, c.control_id, { rootActorUserId: f.nativeProofs[0].intent.actor_user_id,
    membershipId: c.consenting_membership_id, previousConsentId: c.previous_consent_id,
    requestId: c.command_request_id, commandReceiptId: c.command_receipt_id });
  Object.assign(old.consent, { confirmed_at: c.confirmed_at, expires_at: c.expires_at,
    stricter_expires_at: c.stricter_expires_at }); old.receipt.committed_at = r.committed_at;
  Object.assign(bridge, old); f.expiryRows = [{ expired: true }];
  assert.equal((await observedRetry(f)).state, 'outcome_unconfirmed');
});

test('coherent unused bridge command with a noncontiguous native control remains uncertain', async () => {
  const f = unusedRenewals(retainedHead()), bridge = f.unusedProofs[0];
  bridge.receipt.control_version_before++; bridge.receipt.control_version_after++;
  bridge.receipt.command.expectedControlVersion++;
  const digest = kernel.workDigest(kernel.parseWorkCommand(f.a.clientId, f.a.objectiveId, bridge.receipt.command));
  bridge.consent.payload_digest = bridge.receipt.payload_digest = digest;
  f.expiryRows = [{ expired: true }]; assert.equal((await observedRetry(f)).state, 'outcome_unconfirmed');
});

for (const expiryRows of [[], [{ expired: false }], [{ expired: true }, { expired: true }],
  [{ expired: 'true' }], [{ expired: null }], [{}]])
test(`expired retry refuses native expiry evidence ${JSON.stringify(expiryRows)}`, async () => {
  const f = retainedHead(); f.expiryRows = expiryRows;
  assert.equal((await observedRetry(f)).state, 'outcome_unconfirmed');
  await assert.rejects(f.policy(), error => error.code === 'AUTHORITY_UNAVAILABLE');
});

test('expired retained retry authority cannot survive a later cancel lock or foreign command scope', async () => {
  const f = retainedHead(); f.expiryRows = [{ expired: true }]; await observedRetry(f); await f.policy();
  const cancel = retryRequest(f); cancel.command.command = 'cancel';
  await f.owner.lockWithinTx(f.tx, { tenantId: f.a.tenantId }, cancel);
  await assert.rejects(f.policy(), error => error.code === 'AUTHORITY_UNAVAILABLE');
  assert.equal((await f.reconcile()).state, 'outcome_unconfirmed');
  const foreign = retryRequest(f); foreign.objectiveId = id(14002);
  await f.owner.lockWithinTx(f.tx, { tenantId: f.a.tenantId }, foreign);
  assert.equal((await f.reconcile()).state, 'outcome_unconfirmed');
});

test('direct historical control gap remains readable but cannot issue an unprovable unused successor', async () => {
  const f = retainedHead(), c = f.currentProof.consent, r = f.currentProof.receipt;
  r.control_version_before += 2; r.control_version_after += 2; r.command.expectedControlVersion += 2;
  const digest = kernel.workDigest(kernel.parseWorkCommand(f.a.clientId, f.a.objectiveId, r.command));
  c.payload_digest = r.payload_digest = f.state.consent.payloadDigest = digest;
  f.state.control.version = r.control_version_after;
  assert.equal((await observedRead(f)).state, 'not_started');
  f.expiryRows = [{ expired: true }]; assert.equal((await observedRetry(f)).state, 'outcome_unconfirmed');
});

const unusedCorruptions = [
  ['missing native bridge', f => { f.nativeProofs = f.nativeProofs.filter(p => p !== f.unusedProofs[0]); }],
  ['duplicate native bridge', f => { f.nativeProofs.push(copy(f.unusedProofs[0])); }],
  ['bridge source revision', f => { f.unusedProofs[0].consent.source_revision_id = id(14003); }],
  ['bridge root actor', f => { f.unusedProofs[0].intent.actor_user_id = id(14004); }],
  ['bridge original Clerk missing', f => { f.unusedProofs[0].clerkUserId = ''; }],
  ['bridge original membership', f => { f.unusedProofs[0].receipt.actor_membership_id = id(14005); }],
  ['bridge command digest', f => { f.unusedProofs[0].receipt.payload_digest = 'f'.repeat(64); }],
  ['bridge future expiry', f => {
    const c = f.unusedProofs[0].consent; c.expires_at = c.stricter_expires_at = f.currentProof.consent.expires_at;
  }],
  ['bridge missing anchor predecessor', f => { f.unusedProofs[0].consent.previous_consent_id = null; }],
  ['bridge cycle', f => { f.unusedProofs[0].consent.previous_consent_id = f.state.consent.id; }],
  ['current cancelled', f => { f.state.control.cancelledAt = iso(1); f.state.control.cancelledByUserId = f.a.actorUserId; }],
  ['current source no longer ready', f => { f.a.objectiveStatus = 'draft'; }],
  ['orphan current output', f => { f.outputRows.push({ id: id(14006), tenantId: f.a.tenantId, kind: 'task' }); }],
];
for (const [label, corrupt] of unusedCorruptions) test(`unused-consent recovery refuses ${label}`, async () => {
  const f = unusedRenewals(retainedHead()); corrupt(f); f.expiryRows = [{ expired: true }];
  assert.equal((await observedRetry(f)).state, 'outcome_unconfirmed');
  await assert.rejects(f.policy(), error => error.code === 'AUTHORITY_UNAVAILABLE');
});

for (const state of ['queued', 'leased', 'failed', 'cancelled', 'applied', 'unknown'])
test(`unused bridge cannot own a ${state} operation`, async () => {
  const f = unusedRenewals(retainedHead()), bridge = f.unusedProofs[0];
  const operation = store.newPlannerContinuationOperation({ work: { ...copy(f.work),
    consentId: bridge.consent.id, controlVersion: bridge.receipt.control_version_after,
    actorUserId: bridge.consent.consenting_actor_user_id,
    applicationRequestId: app.canonicalApplicationRequestId(f.work.canonical, bridge.consent.consenting_actor_user_id) },
  clerkUserId: bridge.clerkUserId, membershipId: bridge.consent.consenting_membership_id,
  originalDeadlineAt: bridge.consent.expires_at });
  operation.state = state;
  if (state === 'leased') operation.lease = { token: id(14007), expiresAtMs: NOW + 1 };
  if (['failed', 'cancelled', 'applied'].includes(state)) operation.terminal = { receiptId: operation.original.operationId, recordedAtMs: NOW + 1 };
  f.rows.push(f.row(operation)); f.expiryRows = [{ expired: true }];
  assert.equal((await observedRetry(f)).state, 'outcome_unconfirmed');
});

for (const kind of ['applicationId', 'ownerId']) for (const concealed of ['kind', 'scope'])
test(`unused bridge exact ${kind} cannot hide through changed ${concealed}`, async () => {
  const f = unusedRenewals(retainedHead()), bridge = f.unusedProofs[0], ids = nativeUnusedReceiptIds(f, bridge);
  const row = copy(f.anchorChain[0].resources.find(r => r.kind ===
    (kind === 'applicationId' ? 'objective_canonical_application_receipt' : 'objective_canonical_materialization_receipt')));
  row.id = ids[kind]; row.ownerId = bridge.clerkUserId;
  if (concealed === 'kind') row.kind = 'private_unknown_kind';
  else {
    const canonical = kind === 'applicationId' ? row.data.request.canonical : row.data.binding.canonical;
    canonical.objectiveId = id(14008); canonical.canonicalPlanId = id(14009);
  }
  f.hiddenResources.push(row); f.expiryRows = [{ expired: true }];
  assert.equal((await observedRetry(f)).state, 'outcome_unconfirmed');
});

for (const subject of ['current', 'bridge']) for (const concealment of ['kind', 'scope', 'owner', 'archived'])
test(`${subject} consent operation cannot evade tenant-wide inventory through changed ${concealment}`, async () => {
  const f = unusedRenewals(retainedHead()), proof = subject === 'current' ? f.currentProof : f.unusedProofs[0];
  const row = f.row(); row.id = id(14100); row.data.work.consentId = proof.consent.id;
  if (concealment === 'kind') row.kind = 'unrelated_private_row';
  if (concealment === 'scope') {
    row.data.work.canonical.objectiveId = id(14101); row.data.work.canonical.canonicalPlanId = id(14102);
  }
  if (concealment === 'owner') row.ownerId = row.data.clerkUserId = 'foreign_clerk';
  if (concealment === 'archived') row.archived = true;
  f.hiddenResources.push(row); f.expiryRows = [{ expired: true }];
  assert.equal((await observedRetry(f)).state, 'outcome_unconfirmed');
});

test('actual owner and kernel renew an expired unused consent once, then read the complete C2 C1 applied-anchor chain', async () => {
  const f = retainedHead(), original = copy({ rows: f.rows, proofs: f.nativeProofs, consent: f.state.consent });
  const now = Date.parse(f.state.consent.expiresAt) + 1, proofExpiry = now + 20000;
  f.expiryRows = [{ expired: true }];
  const request = retryRequest(f, id(15000));
  let saved = { state: copy(f.state), receipts: {}, consents: {}, serial: 15001 };
  let writeCount = 0;
  const owner = { transaction: async (write, run) => {
    if (!write) await f.owner.lockReadWithinTx(f.tx, { tenantId: f.a.tenantId }, { workAction: PLAN });
    const draft = copy(saved), writable = () => assert.equal(write, true);
    const result = await run({
      lockOwner: async () => { writable(); await f.owner.lockWithinTx(f.tx, { tenantId: f.a.tenantId }, request); },
      currentAuthority: async () => copy(f.a),
      receipt: async (a, action, requestId) => copy(draft.receipts[`${a.actorUserId}:${action}:${requestId}`] ?? null),
      state: async () => copy(draft.state), clock: async () => new Date(now).toISOString(),
      reconcile: (a, action, state) => f.owner.reconcileWithinTx(f.tx, a, action, state),
      policy: async (a, action, state) => ({ ...await f.owner.policyWithinTx(f.tx, a, action, state),
        originalTokenExpiresAtMs: proofExpiry }),
      insertConsent: async (_a, _action, consent) => {
        writable(); assert.equal(draft.consents[consent.id], undefined); draft.consents[consent.id] = copy(consent); writeCount++;
      },
      casControl: async (_a, _action, before, after) => {
        writable(); assert.deepEqual(before, draft.state.control); draft.state.control = copy(after);
        draft.state.consent = copy(draft.consents[after.currentConsentId]); writeCount++; return true;
      },
      insertReceipt: async (a, stored) => {
        writable(); const key = `${a.actorUserId}:${stored.command.workAction}:${stored.command.requestId}`;
        assert.equal(draft.receipts[key], undefined); draft.receipts[key] = copy(stored); writeCount++;
      }, newId: () => { writable(); return id(draft.serial++); },
    });
    if (write) {
      const newConsent = draft.state.consent;
      if (newConsent.id !== saved.state.consent.id) {
        // Only the persistence adapter is synthetic. These bytes come from the
        // ACTUAL kernel-issued consent/command, then pass the real native codec
        // on the following read. No operation or regeneration witness is made.
        const stored = Object.values(draft.receipts).find(r => r.receipt.authorizationRequestId === newConsent.id);
        const proof = nativeConsentProof({ stored: { request: { canonical: f.work.canonical },
          ack: { consentId: newConsent.id, actorUserId: newConsent.actorUserId,
            controlVersion: draft.state.control.version } }, ownerClerkUserId: f.a.clerkUserId },
        newConsent.controlId, { rootActorUserId: newConsent.source.rootActorUserId, membershipId: newConsent.actorMembershipId,
          previousConsentId: newConsent.previousConsentId, requestId: newConsent.commandRequestId,
          commandReceiptId: newConsent.commandReceiptId });
        Object.assign(proof.consent, { configured_duration_ms: newConsent.configuredDurationMs,
          effective_duration_ms: newConsent.effectiveDurationMs, stricter_expires_at: newConsent.stricterExpiresAt,
          stricter_limit_ref: newConsent.stricterLimitRef, confirmed_at: newConsent.confirmedAt,
          expires_at: newConsent.expiresAt, payload_digest: newConsent.payloadDigest });
        proof.receipt.committed_at = stored.receipt.committedAt;
        proof.receipt.payload_digest = newConsent.payloadDigest; proof.receipt.command = copy(stored.command);
        f.nativeProofs.push(proof); captureUnusedConsent(f, proof);
        assert.deepEqual(f.state, draft.state);
      }
      saved = draft;
    }
    return result;
  } };
  const receipt = await kernel.executeWorkCommand(request, owner);
  assert.equal(receipt.outcome, 'reconsent_recorded'); assert.equal(receipt.targetAuthorizationRequestId, original.consent.id);
  assert.equal(receipt.controlVersionAfter, request.command.expectedControlVersion + 1);
  assert.equal(Date.parse(receipt.consent.expiresAt), proofExpiry, 'fresh request proof bounds the NEW consent');
  assert.equal(writeCount, 3); assert.deepEqual(f.rows, original.rows);
  assert.deepEqual(f.nativeProofs.slice(0, original.proofs.length), original.proofs, 'every original immutable ledger remains unchanged');
  const status = await kernel.readWorkGeneration({ clientId: f.a.clientId, objectiveId: f.a.objectiveId,
    workAction: PLAN, requestId: request.command.requestId }, owner);
  assert.equal(status.reconciliation, 'not_started'); assert.equal(status.consent.id, receipt.authorizationRequestId);
  assert.deepEqual(status.commandReceipt, receipt); assert.deepEqual(f.rows, original.rows);
  assert.ok(f.calls.some(c => c.sql.includes('JOIN client_objective_work_intents') && c.values.includes(original.consent.id)),
    'the real read reconstructs unused C1 in addition to C2 and A');
  const committed = copy(saved);
  assert.deepEqual(await kernel.executeWorkCommand(request, owner), receipt);
  assert.deepEqual(saved, committed); assert.equal(writeCount, 3);
  await assert.rejects(kernel.executeWorkCommand({ ...request,
    command: { ...request.command, expectedControlVersion: receipt.controlVersionAfter } }, owner),
  error => error.code === 'REQUEST_ID_CONFLICT');
  assert.deepEqual(saved, committed); assert.equal(writeCount, 3);
  await assert.rejects(f.policy(), error => error.code === 'AUTHORITY_UNAVAILABLE', 'read status cannot grant another consent');
});
