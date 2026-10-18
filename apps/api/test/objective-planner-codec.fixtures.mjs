// Source-only support for real full owner/application codec fixtures. No DB,
// native authority, worker admission or effect execution is represented here.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { stripTypeScriptTypes } from 'node:module';
const data = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
export async function sourceModule(relative, replacements = []) {
  const url = new URL(relative, import.meta.url); let raw = await readFile(url, 'utf8');
  for (const [specifier, replacement] of replacements) {
    if (!raw.includes(specifier)) throw Error(`Missing declared source import ${specifier}`);
    raw = raw.replaceAll(specifier, JSON.stringify(replacement));
  }
  return data(stripTypeScriptTypes(raw, { mode: 'strip', sourceUrl: url.href }));
}
const materialUrl = await sourceModule('../../../packages/shared/src/objective-planner-materialization.ts');
const applicationUrl = await sourceModule('../../../packages/shared/src/objective-planner-application.ts');
export const sharedUrl = data(`export * from ${JSON.stringify(materialUrl)}; export * from ${JSON.stringify(applicationUrl)};`);
export const shared = await import(sharedUrl);
export const calendarUrl = await sourceModule('../../../packages/shared/src/planner-resource-schedule.ts');
const calendar = await import(calendarUrl);
export const app = shared.createPlannerApplicationCodec({ isProxy: nodeTypes.isProxy,
  sha256: value => createHash('sha256').update(value, 'utf8').digest('hex') });
export const objectiveDigest = value => createHash('sha256')
  .update(JSON.stringify(JSON.parse(app.applicationJson(value))), 'utf8').digest('hex');
export const m = shared.createPlannerMaterializationCodec({
  sha256: value => createHash('sha256').update(value, 'utf8').digest('hex'),
  digest: objectiveDigest,
  canonicalRegenerationHash: app.applicationHash,
  plannerCalendarDate: calendar.plannerResourceCalendarDate,
  materializationError: code => { throw Error(code); },
});
export const regenerationUrl = await sourceModule('../../api-strategy/src/planner/canonical-regeneration-plan.ts');
export const regeneration = await import(regenerationUrl);
export const appliedUrl = await sourceModule('../src/clients/objectives/work/objective-planner-applied.ts', [
  ["'@capiro/shared/objective-planner-owner-codec'", sharedUrl], ["'@capiro/shared'", calendarUrl],
]);
export const applied = await import(appliedUrl);
export const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export const NOW = Date.parse('2026-10-16T12:00:00.000Z');
export const at = offset => new Date(NOW + offset).toISOString();
export const readySnapshot = c => ({ id: c.objectiveId, clientId: c.clientId,
  version: c.requestedObjectiveVersion, status: 'ready', deletedAt: null });
const node = (n, title) => ({ id: id(n), kind: 'action', subject: 'deliverable', title, note: 'Saved note', ownerUserId: null,
  status: 'draft', startsOn: '2026-10-16', endsOn: '2026-10-17', openEnded: false, dependsOnIds: [], meriAuthored: true,
  createdByUserId: 'user_original', createdAt: at(0) });
const row = (tenantId, ownerId, id, kind, name, data, version = 1) => ({ tenantId, ownerId, id, kind, name, data, version,
  projectId: null, archived: false, shareTokenHash: null });
function finish({ work, owner, prior = [], recordedAt = at(1) }) {
  const clerkUserId = 'user_original', tenantId = work.canonical.tenantId;
  const { actorUserId, consentId, controlVersion, ...fields } = work, request = { schemaVersion: 1, ...fields };
  const ownerId = m.canonicalMaterializationReceiptId(tenantId, clerkUserId, request.applicationRequestId);
  const ack = app.creationAck(request, { tenantId, actorUserId, consentId, controlVersion,
    requestSha256: app.applicationHash(request), canonicalSha256: app.applicationHash(work.canonical) }, owner, ownerId, recordedAt);
  const stored = { receiptVersion: 1, request, ack, ackSha256: app.applicationHash(ack) };
  const receiptId = app.applicationReceiptId(tenantId, clerkUserId, request.applicationRequestId);
  const headId = app.applicationHeadId(work.canonical), head = { schemaVersion: 1, canonical: work.canonical,
    applicationRequestId: work.applicationRequestId, ackSha256: stored.ackSha256, source: ack.source,
    strategyId: ack.source.strategyId, projectId: work.canonical.canonicalProjectId };
  const resources = [...prior.filter(r => r.kind !== 'objective_canonical_application_head'),
    row(tenantId, clerkUserId, ownerId, 'objective_canonical_materialization_receipt',
      owner.receiptVersion === 2 ? 'Strategy plan preparation receipt' : 'Strategy plan reconciliation receipt', owner),
    row(tenantId, clerkUserId, receiptId, 'objective_canonical_application_receipt', 'Objective canonical application receipt', stored),
    row(tenantId, clerkUserId, headId, 'objective_canonical_application_head', 'Objective canonical application head', head, work.canonical.bindingVersion)];
  const operation = { tenantId, clerkUserId, work, original: { originalDeadlineAt: at(600000), workSha256: app.applicationHash(work) },
    state: 'applied', terminal: { receiptId, recordedAtMs: Date.parse(recordedAt) + 1 } };
  return { tenantId, clerkUserId, work, owner, stored, ownerId, receiptId, resources, operation };
}
export function fullV2(options = {}) {
  const canonical = options.canonical ?? { tenantId: id(1), clientId: id(2), objectiveId: id(3), canonicalPlanId: id(7),
    canonicalStrategyId: id(8), canonicalProjectId: id(9), bindingVersion: 1, epoch: 1, requestedIntentId: id(10),
    requestedObjectiveRevisionId: id(6), requestedObjectiveVersion: 1, snapshotHash: 'a'.repeat(64) };
  if (!options.canonical) canonical.snapshotHash = app.applicationHash(readySnapshot(canonical));
  const actorUserId = options.actorUserId ?? id(14), snapshot = { meta: { id: canonical.canonicalStrategyId, clientId: canonical.clientId,
    title: 'Saved project', type: 'legislative', goal: null, meriContext: null, meriSummary: null, targetDate: null,
    ownerUserId: 'user_original', createdByUserId: 'user_original', createdAt: at(0) }, nodes: [node(101, 'Original work'), node(102, 'Prior work')] };
  if (options.numericKeys) snapshot.nodes[0].targetRef = { '2': 'second', '10': { '3': 'third', '11': 'eleventh' } };
  const work = { canonical, applicationRequestId: app.canonicalApplicationRequestId(canonical, actorUserId),
    generationJobId: id(18), generationRequestId: id(19), strategyId: canonical.canonicalStrategyId, strategyVersionId: id(20),
    objectiveReceiptSha256: 'c'.repeat(64), snapshotDigest: objectiveDigest(snapshot), actorUserId,
    consentId: options.consentId ?? id(12), controlVersion: options.controlVersion ?? 2 };
  const input = { requestId: work.applicationRequestId, generationJobId: work.generationJobId,
    expected: { strategyId: work.strategyId, strategyVersionId: work.strategyVersionId, objectiveRevisionId: canonical.requestedObjectiveRevisionId } };
  const source = { generationJobId: work.generationJobId, generationRequestId: work.generationRequestId,
    clientId: canonical.clientId, objectiveId: canonical.objectiveId, objectiveVersion: canonical.requestedObjectiveVersion,
    objectiveRevisionId: canonical.requestedObjectiveRevisionId, strategyId: work.strategyId, strategyVersionId: work.strategyVersionId,
    snapshotDigest: work.snapshotDigest };
  const binding = { canonical, generationRequestId: work.generationRequestId,
    objectiveReceiptSha256: work.objectiveReceiptSha256, snapshotDigest: work.snapshotDigest };
  const plan = m.materializationPlan(snapshot, snapshot.nodes.map(n => ({ id: n.id, archivedAt: null })), input);
  const owner = { receiptVersion: 2, input, binding, fingerprint: m.canonicalMaterializationFingerprint(input, binding), snapshot,
    archivedSourceNodeIds: [], result: m.materializationResult(plan, input, source, canonical.tenantId, 'user_original', at(0),
      m.materializationOutputResolver(canonical.tenantId, 'user_original', input.requestId, binding)) };
  m.checkedCanonicalMaterialization(owner, binding, canonical.tenantId, 'user_original');
  return finish({ work, owner });
}
export function fullV3(previous = fullV2(), options = {}) {
  const v = previous.work.canonical.bindingVersion + 1;
  const canonical = { ...previous.work.canonical, bindingVersion: v, requestedIntentId: id(200 + v),
    requestedObjectiveRevisionId: id(300 + v), requestedObjectiveVersion: previous.work.canonical.requestedObjectiveVersion + 1,
    snapshotHash: String(v).repeat(64).slice(0, 64) };
  canonical.snapshotHash = app.applicationHash(readySnapshot(canonical));
  const actorUserId = previous.work.actorUserId, snapshot = { meta: { ...previous.owner.snapshot.meta, title: `Saved revision ${v}` },
    nodes: [node(101, `Proposed work ${v}`), { ...node(103, `New work ${v}`), dependsOnIds: [id(101)] }] };
  if (options.numericKeys) snapshot.nodes[0].provenance = { '2': { '4': 'fourth', '14': 'fourteenth' }, '10': 'tenth' };
  const work = { ...previous.work, canonical, applicationRequestId: app.canonicalApplicationRequestId(canonical, actorUserId),
    generationJobId: id(400 + v), generationRequestId: id(500 + v), strategyVersionId: id(600 + v),
    snapshotDigest: objectiveDigest(snapshot), consentId: id(700 + v), controlVersion: v + 2 };
  const input = { requestId: work.applicationRequestId, generationJobId: work.generationJobId,
    expected: { strategyId: work.strategyId, strategyVersionId: work.strategyVersionId, objectiveRevisionId: canonical.requestedObjectiveRevisionId } };
  const source = { ...previous.owner.result.source, generationJobId: work.generationJobId, generationRequestId: work.generationRequestId,
    objectiveVersion: canonical.requestedObjectiveVersion, objectiveRevisionId: canonical.requestedObjectiveRevisionId,
    strategyVersionId: work.strategyVersionId, snapshotDigest: work.snapshotDigest };
  const binding = { canonical, generationRequestId: work.generationRequestId,
    objectiveReceiptSha256: work.objectiveReceiptSha256, snapshotDigest: work.snapshotDigest };
  const predecessor = { owner: previous.owner, applicationRequestId: previous.work.applicationRequestId,
    applicationAckSha256: previous.stored.ackSha256, ownerReceiptId: previous.ownerId, ownerReceiptSha256: app.applicationHash(previous.owner) };
  const baseline = m.canonicalRegenerationPrevious(predecessor), plan = m.materializationPlan(snapshot,
    snapshot.nodes.map(n => ({ id: n.id, archivedAt: null })), input);
  const tasks = baseline.taskIndex.map((entry, index) => ({ id: entry.taskId, version: entry.appliedVersion + 2, archived: false,
    data: { clientId: canonical.clientId, name: index === 0 ? 'PRIVATE_HUMAN_TITLE' : entry.baseline.name,
      description: entry.baseline.description, ...entry.baseline.schedule, dependencies: entry.baseline.dependencies,
      memberships: [], status: 'done', approval: 'approved', assigneeId: 'PRIVATE_HUMAN_ASSIGNEE', recurrence: null,
      startTime: null, dueTime: null, timeZone: null } }));
  const resolved = m.materializationOutputResolver(canonical.tenantId, 'user_original', input.requestId, binding);
  const prepared = regeneration.planCanonicalRegeneration({ canonical,
    ownerReceiptId: m.canonicalMaterializationReceiptId(canonical.tenantId, 'user_original', input.requestId), previous: baseline,
    project: { id: canonical.canonicalProjectId, version: baseline.project.appliedVersion + 3, archived: false,
      data: { clientId: canonical.clientId, name: 'PRIVATE_HUMAN_PROJECT', description: baseline.project.baseline.description } },
    currentTasks: tasks, proposed: { project: { name: plan.groups[0].name, description: m.materializationProjectDescription(source, input.requestId) },
      tasks: plan.actionable.map(n => ({ sourceNodeId: n.id, newTaskId: baseline.taskIndex.some(t => t.sourceNodeId === n.id) ? null : resolved('task', n.id),
        fields: { name: n.title, description: n.note ?? '', schedule: { subtype: 'task', startOn: n.startsOn, dueOn: n.endsOn ?? n.startsOn } } })),
      sourceNodeIds: snapshot.nodes.map(n => n.id), edges: plan.edges }, allTasks: tasks.map(t => ({ id: t.id, dependencies: t.data.dependencies })) });
  const witness = m.canonicalRegenerationWitness(prepared), owner = { receiptVersion: 3, input, binding,
    fingerprint: m.canonicalMaterializationFingerprint(input, binding), snapshot, archivedSourceNodeIds: [], reconciliation: witness,
    result: m.canonicalRegenerationResult(plan, input, source, witness, at(v)) };
  m.checkedCanonicalMaterialization(owner, binding, canonical.tenantId, 'user_original', predecessor);
  return finish({ work, owner, prior: previous.resources, recordedAt: at(v + 1) });
}
export function nativeConsentProof(pair, controlId, options = {}) {
  const c = pair.stored.request.canonical, ack = pair.stored.ack, membershipId = options.membershipId ?? id(15);
  const rootActorUserId = options.rootActorUserId ?? id(11), requestId = options.requestId ?? id(800 + c.bindingVersion);
  const commandReceiptId = options.commandReceiptId ?? id(900 + c.bindingVersion), previousConsentId = options.previousConsentId ?? null;
  const command = { schemaVersion: 1, requestId, command: 'retry', workAction: 'objective.plan.prepare',
    expectedObjectiveVersion: c.requestedObjectiveVersion, expectedControlVersion: ack.controlVersion - 1,
    expectedCanonicalBindingVersion: c.bindingVersion, targetAuthorizationRequestId: previousConsentId };
  const payloadDigest = app.applicationHash({ clientId: c.clientId, objectiveId: c.objectiveId, command });
  const scope = { tenant_id: c.tenantId, client_id: c.clientId, objective_id: c.objectiveId,
    work_action: 'objective.plan.prepare', control_id: controlId, canonical_plan_id: c.canonicalPlanId,
    canonical_epoch: c.epoch, canonical_strategy_id: c.canonicalStrategyId, canonical_project_id: c.canonicalProjectId,
    canonical_binding_version: c.bindingVersion, root_intent_id: c.requestedIntentId,
    source_revision_id: c.requestedObjectiveRevisionId, source_objective_version: c.requestedObjectiveVersion,
    source_snapshot_hash: c.snapshotHash, root_actor_user_id: rootActorUserId };
  const consent = { ...scope, id: ack.consentId, previous_consent_id: previousConsentId,
    consenting_actor_user_id: ack.actorUserId, consenting_membership_id: membershipId,
    consent_policy_id: 'capiro.objective-generation-consent', consent_policy_revision: 1,
    configured_duration_ms: 600000, effective_duration_ms: 600000, stricter_expires_at: at(600000),
    stricter_limit_ref: 'objective-planner-continuation:v1', confirmed_at: at(0), expires_at: at(600000),
    command_request_id: requestId, command_receipt_id: commandReceiptId, payload_digest: payloadDigest };
  const receipt = { ...scope, id: commandReceiptId, actor_user_id: ack.actorUserId, actor_membership_id: membershipId,
    request_id: requestId, payload_digest: payloadDigest, command, command_kind: 'retry', command_revision_id: c.requestedObjectiveRevisionId,
    command_objective_version: c.requestedObjectiveVersion, control_version_before: ack.controlVersion - 1,
    control_version_after: ack.controlVersion, target_consent_id: previousConsentId, created_consent_id: ack.consentId,
    result_consent_id: ack.consentId, outcome: 'reconsent_recorded', committed_at: at(0) };
  const intent = { id: c.requestedIntentId, tenant_id: c.tenantId, client_id: c.clientId, objective_id: c.objectiveId,
    objective_revision_id: c.requestedObjectiveRevisionId, objective_version: c.requestedObjectiveVersion,
    actor_user_id: rootActorUserId, purpose: 'objective_strategy_plan', snapshot_hash: c.snapshotHash,
    state: 'pending', blocked_reason: 'runtime_authority_unconnected', created_at: at(0) };
  const revision = { id: c.requestedObjectiveRevisionId, tenant_id: c.tenantId, client_id: c.clientId, objective_id: c.objectiveId,
    version: c.requestedObjectiveVersion, operation: 'confirm_ready', actor_user_id: rootActorUserId,
    snapshot: readySnapshot(c), created_at: at(0) };
  return { consent, receipt, intent, revision, clerkUserId: pair.ownerClerkUserId };
}
