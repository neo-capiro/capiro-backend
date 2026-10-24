import { nativeObjectiveEnvelope } from './objective-native-envelope.fixture.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '../generated/prisma-client/index.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { applicationHash } from '../src/planner/objective-canonical-application.js';
import { canonicalGenerationAdmissionSha256, generationBindingKey,
  GENERATION_ADMISSION, GENERATION_ACCEPTANCE, GENERATION_REQUEST } from '../src/meri/objective-canonical-generation.js';
import { createCanonicalRequestPublication, candidateJcsSha256, privateRequestJcsSha256 } from '../src/meri/objective-canonical-request.js';
import { verifyRetainedCanonicalCompletion } from '../src/meri/objective-canonical-completion-receipt.js';
import { normalizeCanonicalDraft } from '../src/meri/objective-canonical-draft.js';
import { buildSnapshot } from '../src/strategy/versioning.js';
import { requestKey, type ObjectiveAdmission, type ObjectiveReceipt } from '../src/meri/objective-generation.types.js';
import { generationMarker, insertGenerationLedger, recordCanonicalNormalization,
  recordCanonicalGenerationProducer } from '../src/meri/objective-canonical-producer-ledger.js';
import { canonicalPublicationInputHash, canonicalPublicationSha256 } from '../src/meri/objective-canonical-request-ledger.js';
import { readCanonicalSavedGeneration } from '../src/meri/objective-canonical-saved-generation.js';
import { savedGenerationPlannerContinuation } from '../src/planner/objective-canonical-continuation.js';
import type { DraftJobInput } from '../src/meri/draft-job.types.js';
import { parseWorkCommand, workDigest } from '../../api/src/clients/objectives/work/objective-work-command.js';

const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const json = (v: unknown) => v as Prisma.InputJsonValue;

/** Synthetic original-owner observations for an owned native database. These
 * exercise actual backend codecs/SQL; they do not claim a real Meri SDK run,
 * issuer grant, protected key, provider result or production custody. */
export function buildObjectivePlannerNativeFixture(nowMs: number, options: {
  seed?: string; plannerExpiresAtMs?: number; tenantEnabled?: boolean;
} = {}) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 60_000) throw Error('Invalid native fixture time');
  const seed = options.seed ?? randomUUID();
  const id = (name: string) => {
    const h = applicationHash(['objective-planner-native-fixture', seed, name]);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  const tenantId = id('tenant'), clerkUserId = `user_objective_planner_qa_${id('actor').replace(/-/g, '')}`;
  const source = { clientId: id('client'), objectiveId: id('objective'), objectiveVersion: 2,
    objectiveRevisionId: id('revision') };
  const intent = { outcome: 'Keep the synthetic government authority available', governmentProblem: 'Synthetic authority expires',
    askType: 'policy_authority', minimumWin: 'One synthetic extension', limits: 'Offline qualification fixture only' };
  const objectiveSnapshot = { id: source.objectiveId, clientId: source.clientId, version: source.objectiveVersion,
    status: 'ready', deletedAt: null, ...intent };
  const canonical = { canonicalPlanId: id('canonical'), tenantId, clientId: source.clientId,
    objectiveId: source.objectiveId, canonicalStrategyId: id('strategy'), canonicalProjectId: id('project'),
    bindingVersion: 1, epoch: 1, requestedIntentId: id('intent'), requestedObjectiveRevisionId: source.objectiveRevisionId,
    requestedObjectiveVersion: source.objectiveVersion, snapshotHash: applicationHash(objectiveSnapshot) };
  const admission = { schemaVersion: 1 as const, namespace: 'capiro.objective-strategy.admission:v1' as const,
    canonical, actorUserId: id('actor'), clerkUserId, consentId: id('generation-consent'), controlVersion: 1,
    generationJobId: id('job'), generationRequestId: id('request'), admittedAtMs: nowMs - 10_000,
    effectExpiresAtMs: nowMs + 600_000, expectedStrategyVersionId: null };
  const dto = { clientId: source.clientId, type: 'authorization' as const, goal: 'Synthetic authorization work',
    meriContext: null, ownerUserId: null, targetDate: null, attachmentIds: [] };
  const prompt = 'Synthetic preserved Objective and government relationship context for native qualification.\n';
  const sourceDigest = applicationHash({ source, intent }), coverageDigest = applicationHash([]);
  const publication = createCanonicalRequestPublication({ admission, dto,
    context: { schemaVersion: 1, tenantId, clerkUserId, requestId: admission.generationRequestId, source, intent,
      snapshotSha256: canonical.snapshotHash, sourceDigest, packetId: id('packet'),
      compiledAt: new Date(nowMs - 9_500).toISOString(), coverageDigest, promptSha256: sha(prompt), evidence: [] },
    prompt, owners: [{ ownerRef: 'owner:qa', clerkUserId }],
    requestedAtMs: nowMs - 9_000, effectExpiresAtMs: nowMs + 500_000 });
  const binding = { tenantId, actorId: admission.actorUserId, conversationId: id('conversation'), runId: id('generation-run'),
    attemptId: id('generation-attempt'), workerId: id('generation-worker'), writerFence: 1 };
  const sourceRequestSha256 = privateRequestJcsSha256({ requestId: admission.generationRequestId, prompt: publication.executionContext.prompt, skill: null, window: null, windowRequest: null });
  const acceptance = { schemaVersion: 1 as const, sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission),
    sourceBinding: binding, sourceRequestSha256, acceptedAtMs: nowMs - 8_000,
    effectExpiresAtMs: Math.min(admission.effectExpiresAtMs, publication.request.originalExpiresAtMs) };
  const payload = { type: 'authorization', rationale: 'Keep the synthetic authority current', summary: 'Prepare a synthetic request',
    nodes: [{ sourceNodeKey: 'prepare', kind: 'action', subject: 'deliverable', title: 'Prepare the synthetic authorization request',
      note: null, status: 'suggested', ownerRef: null, startsOn: '2027-02-01', endsOn: null, openEnded: false,
      sources: [], dependsOn: [] }],
    coverage: { complete: true, omitted: [], assumptions: [], sources: [], pendingSources: [] } };
  const normalized = normalizeCanonicalDraft(payload, { admission, queuedType: dto.type });
  const h = candidateJcsSha256({ binding, kind: 'completion' });
  const completionId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  const execution = { provider: 'synthetic-native-fixture', model: 'synthetic-native-fixture', receiptRef: completionId,
    receiptSha256: sha('synthetic owner receipt'), bindingSha256: candidateJcsSha256(binding) };
  const resultBody = { candidateVersion: publication.request.candidateVersion, operation: 'strategy.draft',
    requestId: admission.generationRequestId, jobId: admission.generationJobId, requestSha256: publication.requestSha256,
    inputSha256: publication.request.inputSha256, sourceSha256: candidateJcsSha256(publication.request.source),
    contextSha256: publication.request.context.contextSha256, basisSha256: null, binding, execution, resultRef: completionId,
    completedAtMs: nowMs - 7_000, state: 'succeeded', payload, payloadSha256: candidateJcsSha256(payload), issues: [] };
  const retained = nativeObjectiveEnvelope(admission, publication, binding, resultBody);
  const witness = verifyRetainedCanonicalCompletion(retained, { admission, acceptance, publication, nowMs: nowMs - 6_000 }).witness;
  const localDigest = sha('synthetic local context'), externalDigest = sha('synthetic external observation'), historyDigest = sha('synthetic history');
  const inputDigest = applicationHash({ sourceDigest, coverageDigest, packetId: id('packet'), requestId: admission.generationRequestId,
    type: dto.type, localDigest, externalDigest, historyDigest, promptDigest: applicationHash(prompt) });
  const context = { reobservedAt: null, state: 'complete' as const, packetId: id('packet'),
    compiledAt: new Date(nowMs - 9_500).toISOString(), sourceDigest, coverageDigest, inputDigest, issues: [] };
  const compiled: ObjectiveAdmission = { tenantId, clerkUserId, requestId: admission.generationRequestId, type: dto.type,
    source, intent, localDigest, externalDigest, historyDigest, historyObservedAt: new Date(nowMs - 9_500).toISOString(),
    contactIds: [], context, coverage: [] };
  const receipt: ObjectiveReceipt = { schemaVersion: 1, requestId: admission.generationRequestId, source,
    context: { ...context, reobservedAt: new Date(nowMs - 5_000).toISOString() }, result: {
      strategyId: canonical.canonicalStrategyId, strategyVersionId: id('version'), savedAt: new Date(nowMs - 6_000).toISOString(),
      sourceDigest, contextPacketId: id('packet'), coverageDigest, inputDigest }, failure: null };
  const request = { requestId: admission.generationRequestId, clientId: source.clientId,
    objective: { objectiveId: source.objectiveId, objectiveVersion: source.objectiveVersion }, type: dto.type };
  const input = { dto, bearer: null, canonicalGeneration: generationMarker(admission), canonicalCompletion: witness,
    objectiveGeneration: { request, fingerprint: applicationHash(request), receipt } } as unknown as DraftJobInput;
  const pendingInput: DraftJobInput = { ...input, objectiveGeneration: { ...input.objectiveGeneration!,
    receipt: { ...receipt, context, result: null } } };
  const storedRequest = { schemaVersion: 1, sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission),
    inputSha256: canonicalPublicationInputHash(input), publicationSha256: canonicalPublicationSha256(publication), compiled, publication };
  const savedAt = new Date(nowMs - 6_000).toISOString();
  const strategy = { id: canonical.canonicalStrategyId, clientId: source.clientId, title: 'Synthetic native qualification Strategy',
    type: dto.type, goal: dto.goal, meriContext: null, meriSummary: normalized.response.summary,
    targetDate: null, ownerUserId: clerkUserId, createdByUserId: clerkUserId, createdAt: savedAt };
  const nodes = normalized.response.nodes.map((n, index) => ({ ...n, id: normalized.nodeIds[index]!,
    note: n.note ?? null, ownerUserId: n.ownerUserId ?? null, status: n.status ?? 'suggested',
    endsOn: n.endsOn ?? null, openEnded: n.openEnded ?? false,
    dependsOnIds: n.dependsOn!.map(i => normalized.nodeIds[i]!), meriAuthored: true, createdByUserId: clerkUserId, createdAt: savedAt }));
  const snapshot = buildSnapshot(strategy, nodes);
  const plannerExpiresAtMs = options.plannerExpiresAtMs ?? nowMs + 600_000;
  return { seed, id, nowMs, tenantId, clerkUserId, source, canonical, admission, acceptance, publication, retained,
    normalized, objectiveSnapshot, compiled, receipt, input, pendingInput, storedRequest, strategy, nodes, snapshot,
    membershipId: id('membership'), actorUserId: admission.actorUserId,
    plannerControlId: id('planner-control'), plannerConsentId: id('planner-consent'),
    plannerExpiresAtMs, plannerConfirmedAtMs: plannerExpiresAtMs - 900_000,
    tenantEnabled: options.tenantEnabled ?? true,
    scope: { tenantId, clerkUserId, generationJobId: admission.generationJobId } };
}
export type ObjectivePlannerNativeFixture = ReturnType<typeof buildObjectivePlannerNativeFixture>;

async function insertConsent(tx: Prisma.TransactionClient, f: ObjectivePlannerNativeFixture,
  action: 'objective.strategy.draft' | 'objective.plan.prepare') {
  const planner = action === 'objective.plan.prepare', c = f.canonical;
  const controlId = planner ? f.plannerControlId : f.id('generation-control');
  const consentId = planner ? f.plannerConsentId : f.admission.consentId;
  const receiptId = f.id(`${action}:consent-receipt`), requestId = f.id(`${action}:consent-request`);
  const request = parseWorkCommand(c.clientId, c.objectiveId, { schemaVersion: 1, requestId, command: 'retry', workAction: action,
    expectedObjectiveVersion: c.requestedObjectiveVersion, expectedControlVersion: 0,
    expectedCanonicalBindingVersion: c.bindingVersion, targetAuthorizationRequestId: null });
  const digest = workDigest(request), command = JSON.stringify(request.command);
  const confirmedAt = new Date(planner ? f.plannerConfirmedAtMs : f.nowMs - 300_000).toISOString();
  const expiresAt = new Date(planner ? f.plannerExpiresAtMs : f.nowMs + 600_000).toISOString();
  // Reciprocal, deferred consent/receipt/control constraints remain enabled.
  await tx.$executeRaw`INSERT INTO client_objective_work_controls
    (id,tenant_id,client_id,objective_id,work_action,canonical_plan_id,canonical_epoch,canonical_strategy_id,canonical_project_id)
    VALUES(${controlId}::uuid,${f.tenantId}::uuid,${c.clientId}::uuid,${c.objectiveId}::uuid,${action},
      ${c.canonicalPlanId}::uuid,${c.epoch},${c.canonicalStrategyId}::uuid,${c.canonicalProjectId}::uuid)`;
  await tx.$executeRaw`INSERT INTO client_objective_work_consents
    (id,tenant_id,client_id,objective_id,work_action,control_id,canonical_plan_id,canonical_epoch,canonical_strategy_id,
     canonical_project_id,canonical_binding_version,root_intent_id,source_revision_id,source_objective_version,source_snapshot_hash,
     root_actor_user_id,consenting_actor_user_id,consenting_membership_id,consent_policy_id,consent_policy_revision,
     configured_duration_ms,effective_duration_ms,confirmed_at,expires_at,command_request_id,command_receipt_id,payload_digest)
    VALUES(${consentId}::uuid,${f.tenantId}::uuid,${c.clientId}::uuid,${c.objectiveId}::uuid,${action},${controlId}::uuid,
      ${c.canonicalPlanId}::uuid,${c.epoch},${c.canonicalStrategyId}::uuid,${c.canonicalProjectId}::uuid,${c.bindingVersion},
      ${c.requestedIntentId}::uuid,${c.requestedObjectiveRevisionId}::uuid,${c.requestedObjectiveVersion},${c.snapshotHash},
      ${f.actorUserId}::uuid,${f.actorUserId}::uuid,${f.membershipId}::uuid,'capiro.objective-generation-consent',1,
      900000,900000,${confirmedAt}::timestamptz,${expiresAt}::timestamptz,${requestId}::uuid,${receiptId}::uuid,${digest})`;
  await tx.$executeRaw`INSERT INTO client_objective_work_command_receipts
    (id,tenant_id,client_id,objective_id,work_action,control_id,canonical_plan_id,canonical_epoch,canonical_strategy_id,
     canonical_project_id,canonical_binding_version,root_intent_id,source_revision_id,source_objective_version,source_snapshot_hash,
     root_actor_user_id,actor_user_id,actor_membership_id,request_id,payload_digest,command,command_kind,command_revision_id,
     command_objective_version,control_version_before,control_version_after,created_consent_id,result_consent_id,outcome,committed_at)
    VALUES(${receiptId}::uuid,${f.tenantId}::uuid,${c.clientId}::uuid,${c.objectiveId}::uuid,${action},${controlId}::uuid,
      ${c.canonicalPlanId}::uuid,${c.epoch},${c.canonicalStrategyId}::uuid,${c.canonicalProjectId}::uuid,${c.bindingVersion},
      ${c.requestedIntentId}::uuid,${c.requestedObjectiveRevisionId}::uuid,${c.requestedObjectiveVersion},${c.snapshotHash},
      ${f.actorUserId}::uuid,${f.actorUserId}::uuid,${f.membershipId}::uuid,${requestId}::uuid,${digest},${command}::jsonb,'retry',
      ${c.requestedObjectiveRevisionId}::uuid,${c.requestedObjectiveVersion},0,1,${consentId}::uuid,${consentId}::uuid,
      'reconsent_recorded',${new Date(planner ? f.plannerConfirmedAtMs + 1 : f.nowMs - 299_999).toISOString()}::timestamptz)`;
  await tx.$executeRaw`UPDATE client_objective_work_controls SET version=1,current_consent_id=${consentId}::uuid
    WHERE tenant_id=${f.tenantId}::uuid AND id=${controlId}::uuid AND version=0`;
}

/** Identity and ready-source rows only, inside an already qualified native
 * tenant transaction. No consent, job, admission, acceptance or result is seeded. */
export async function seedObjectivePlannerNativeReadyWithinTx(tx: Prisma.TransactionClient, f: ObjectivePlannerNativeFixture) {
  const settings = JSON.stringify({ clioFeatureFlags: { 'strategyPlanner.enabled': true },
    objectivePlannerContinuation: { enabled: f.tenantEnabled } });
  await tx.$executeRaw`INSERT INTO tenants(id,slug,name,status,settings_jsonb,updated_at)
    VALUES(${f.tenantId}::uuid,${`objective-planner-qa-${f.tenantId}`},'Synthetic Objective Planner qualification','active',${settings}::jsonb,clock_timestamp())`;
  await tx.$executeRaw`INSERT INTO users(id,clerk_user_id,email,updated_at)
    VALUES(${f.actorUserId}::uuid,${f.clerkUserId},${`${f.actorUserId}@objective-planner.example.test`},clock_timestamp())`;
  await tx.$executeRaw`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,updated_at)
    VALUES(${f.membershipId}::uuid,${f.tenantId}::uuid,${f.actorUserId}::uuid,'standard_user','active',clock_timestamp())`;
  await tx.$executeRaw`INSERT INTO clients(id,tenant_id,name,memory_wall,updated_at)
    VALUES(${f.source.clientId}::uuid,${f.tenantId}::uuid,'Synthetic Objective Planner client',true,clock_timestamp())`;
  await tx.$executeRaw`INSERT INTO client_memory_access(id,tenant_id,client_id,user_id,granted_by)
    VALUES(${f.id('wall-grant')}::uuid,${f.tenantId}::uuid,${f.source.clientId}::uuid,${f.actorUserId}::uuid,${f.actorUserId}::uuid)`;
  await tx.$executeRaw`INSERT INTO client_objectives
    (id,tenant_id,client_id,client_request_id,create_request_hash,outcome,government_problem,ask_type,minimum_win,limits,
     created_by_user_id,status,version,ready_at)
    VALUES(${f.source.objectiveId}::uuid,${f.tenantId}::uuid,${f.source.clientId}::uuid,${f.id('objective-create')}::uuid,
      ${applicationHash(f.objectiveSnapshot)},${f.objectiveSnapshot.outcome},${f.objectiveSnapshot.governmentProblem},
      ${f.objectiveSnapshot.askType},${f.objectiveSnapshot.minimumWin},${f.objectiveSnapshot.limits},${f.actorUserId}::uuid,'ready',2,clock_timestamp())`;
  await tx.$executeRaw`INSERT INTO client_objective_revisions(id,tenant_id,client_id,objective_id,version,operation,actor_user_id,snapshot)
    VALUES(${f.source.objectiveRevisionId}::uuid,${f.tenantId}::uuid,${f.source.clientId}::uuid,${f.source.objectiveId}::uuid,
      2,'confirm_ready',${f.actorUserId}::uuid,${JSON.stringify(f.objectiveSnapshot)}::jsonb)`;
  await tx.$executeRaw`INSERT INTO client_objective_work_intents
    (id,tenant_id,client_id,objective_id,objective_revision_id,objective_version,actor_user_id,purpose,snapshot_hash)
    VALUES(${f.canonical.requestedIntentId}::uuid,${f.tenantId}::uuid,${f.source.clientId}::uuid,${f.source.objectiveId}::uuid,
      ${f.source.objectiveRevisionId}::uuid,2,${f.actorUserId}::uuid,'objective_strategy_plan',${f.canonical.snapshotHash})`;
  await tx.$executeRaw`INSERT INTO client_objective_canonical_plans
    (id,tenant_id,client_id,objective_id,canonical_strategy_id,canonical_project_id,binding_version,epoch,
     requested_intent_id,requested_objective_revision_id,requested_objective_version,requested_snapshot_hash)
    VALUES(${f.canonical.canonicalPlanId}::uuid,${f.tenantId}::uuid,${f.source.clientId}::uuid,${f.source.objectiveId}::uuid,
      ${f.canonical.canonicalStrategyId}::uuid,${f.canonical.canonicalProjectId}::uuid,1,1,${f.canonical.requestedIntentId}::uuid,
      ${f.source.objectiveRevisionId}::uuid,2,${f.canonical.snapshotHash})`;
}

/** Called only after target, postmaster and connected catalog qualification.
 * All rows belong to a newly randomized synthetic tenant. No reset, upsert,
 * trigger disablement, permission expansion or historical audit purge occurs. */
export async function seedObjectivePlannerNativeFixture(prisma: PrismaService, f: ObjectivePlannerNativeFixture) {
  return prisma.withTenant(f.tenantId, async tx => {
    await seedObjectivePlannerNativeReadyWithinTx(tx, f);
    await insertConsent(tx, f, 'objective.strategy.draft');
    await insertConsent(tx, f, 'objective.plan.prepare');
    await tx.spStrategy.create({ data: { ...f.strategy, createdAt: new Date(f.strategy.createdAt), tenantId: f.tenantId, draftedByMeri: true } });
    for (const n of f.nodes) await tx.spNode.create({ data: { id: n.id, tenantId: f.tenantId,
      strategyId: f.strategy.id, kind: n.kind as 'action', subject: n.subject as 'deliverable', title: n.title,
      note: n.note, ownerUserId: n.ownerUserId, status: n.status as 'suggested', startsOn: new Date(n.startsOn),
      endsOn: n.endsOn ? new Date(n.endsOn) : null, openEnded: n.openEnded, dependsOnIds: n.dependsOnIds,
      meriAuthored: true, createdByUserId: f.clerkUserId, createdAt: new Date(n.createdAt) } });
    await tx.spVersion.create({ data: { id: f.id('version'), tenantId: f.tenantId, strategyId: f.strategy.id,
      snapshot: json(f.snapshot), authorKind: 'meri', authorUserId: f.clerkUserId, note: 'Synthetic original generation', coalescible: false } });
    await tx.spDraftJob.create({ data: { id: f.admission.generationJobId, tenantId: f.tenantId, clientId: f.source.clientId,
      ownerUserId: f.clerkUserId, requestKey: requestKey(f.tenantId, f.clerkUserId, f.admission.generationRequestId),
      input: json(f.pendingInput), status: 'running', attempt: 2, claimedBy: `canonical:${generationBindingKey(f.acceptance.sourceBinding)}`,
      claimedAt: new Date(f.acceptance.acceptedAtMs), deadlineAt: new Date(f.admission.effectExpiresAtMs) } });
    await insertGenerationLedger(tx, GENERATION_ADMISSION, f.tenantId, f.clerkUserId, f.admission.generationJobId, f.admission);
    await insertGenerationLedger(tx, GENERATION_ACCEPTANCE, f.tenantId, f.clerkUserId, f.admission.generationJobId, f.acceptance);
    await insertGenerationLedger(tx, GENERATION_REQUEST, f.tenantId, f.clerkUserId, f.admission.generationJobId, f.storedRequest);
    await recordCanonicalNormalization(tx, f.tenantId, f.clerkUserId, f.admission.generationJobId,
      { strategyId: f.strategy.id, strategyVersionId: f.id('version') }, f.normalized);
    await tx.spDraftJob.update({ where: { id: f.admission.generationJobId },
      data: { status: 'completed', strategyId: f.strategy.id, input: json(f.input), stage: 'completed' } });
    await recordCanonicalGenerationProducer(tx, f.tenantId, f.clerkUserId, f.admission.generationJobId);
    const saved = await readCanonicalSavedGeneration(tx, f.scope);
    const work = savedGenerationPlannerContinuation(saved, { workAction: 'objective.plan.prepare', tenantId: f.tenantId,
      actorUserId: f.actorUserId, clerkUserId: f.clerkUserId, canonical: f.canonical, consentId: f.plannerConsentId, controlVersion: 1 });
    return { fixture: f, work };
  }, { timeoutMs: 15_000 });
}

/** A real reciprocal cancellation of this fixture's Planner consent. Immutable
 * consent/receipt rows and all constraint triggers retain their native owners. */
export async function cancelObjectivePlannerNativeFixtureConsent(prisma: PrismaService, f: ObjectivePlannerNativeFixture) {
  return prisma.withTenant(f.tenantId, async tx => {
    const c = f.canonical, requestId = f.id('planner-cancel-request'), receiptId = f.id('planner-cancel-receipt');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`planner:${f.tenantId}`},0))`;
    const times = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const at = times[0]!.now.toISOString();
    const request = parseWorkCommand(c.clientId, c.objectiveId, { schemaVersion: 1, requestId, command: 'cancel',
      workAction: 'objective.plan.prepare', expectedObjectiveVersion: c.requestedObjectiveVersion,
      expectedControlVersion: 1, expectedCanonicalBindingVersion: c.bindingVersion, targetAuthorizationRequestId: f.plannerConsentId });
    await tx.$executeRaw`INSERT INTO client_objective_work_command_receipts
      (id,tenant_id,client_id,objective_id,work_action,control_id,canonical_plan_id,canonical_epoch,canonical_strategy_id,
       canonical_project_id,canonical_binding_version,root_intent_id,source_revision_id,source_objective_version,source_snapshot_hash,
       root_actor_user_id,actor_user_id,actor_membership_id,request_id,payload_digest,command,command_kind,command_revision_id,
       command_objective_version,control_version_before,control_version_after,target_consent_id,result_consent_id,outcome,committed_at)
      VALUES(${receiptId}::uuid,${f.tenantId}::uuid,${c.clientId}::uuid,${c.objectiveId}::uuid,'objective.plan.prepare',${f.plannerControlId}::uuid,
        ${c.canonicalPlanId}::uuid,${c.epoch},${c.canonicalStrategyId}::uuid,${c.canonicalProjectId}::uuid,${c.bindingVersion},
        ${c.requestedIntentId}::uuid,${c.requestedObjectiveRevisionId}::uuid,${c.requestedObjectiveVersion},${c.snapshotHash},
        ${f.actorUserId}::uuid,${f.actorUserId}::uuid,${f.membershipId}::uuid,${requestId}::uuid,${workDigest(request)},
        ${JSON.stringify(request.command)}::jsonb,'cancel',${c.requestedObjectiveRevisionId}::uuid,${c.requestedObjectiveVersion},
        1,2,${f.plannerConsentId}::uuid,${f.plannerConsentId}::uuid,'cancellation_recorded',${at}::timestamptz)`;
    const changed = await tx.$executeRaw`UPDATE client_objective_work_controls SET version=2,cancelled_at=${at}::timestamptz,
      cancelled_by_user_id=${f.actorUserId}::uuid,updated_at=clock_timestamp()
      WHERE tenant_id=${f.tenantId}::uuid AND id=${f.plannerControlId}::uuid AND version=1
        AND current_consent_id=${f.plannerConsentId}::uuid AND cancelled_at IS NULL`;
    if (changed !== 1) throw Error('Synthetic Planner cancellation did not change exactly its own control');
  }, { timeoutMs: 15_000 });
}
