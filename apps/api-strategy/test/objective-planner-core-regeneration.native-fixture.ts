import { createHash } from 'node:crypto';
import type { Prisma } from '../generated/prisma-client/index.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { WorkReceipt } from '../../api/src/clients/objectives/work/objective-work-command.js';
import { parseWorkCommand, workDigest } from '../../api/src/clients/objectives/work/objective-work-command.js';
import { objectiveRevisionSnapshotHash, OBJECTIVE_WORK_BLOCKER, OBJECTIVE_WORK_PURPOSE } from '../../api/src/clients/objectives/objective-work-intent.js';
import { applicationHash, applicationJson } from '../src/planner/objective-canonical-application.js';
import { savedGenerationPlannerContinuation } from '../src/planner/objective-canonical-continuation.js';
import { requestKey, type ObjectiveAdmission, type ObjectiveIntent, type ObjectiveReceipt } from '../src/meri/objective-generation.types.js';
import { canonicalGenerationAdmissionSha256, generationBindingKey, generationLedgerId,
  GENERATION_ADMISSION, GENERATION_ACCEPTANCE, GENERATION_REQUEST, GENERATION_NORMALIZATION,
  type CanonicalGenerationAdmission } from '../src/meri/objective-canonical-generation.js';
import { generationMarker, insertGenerationLedger, recordCanonicalGenerationProducer } from '../src/meri/objective-canonical-producer-ledger.js';
import { canonicalPublicationInputHash, canonicalPublicationSha256 } from '../src/meri/objective-canonical-request-ledger.js';
import { captureCanonicalStrategyBasis } from '../src/meri/objective-canonical-basis.js';
import { normalizeCanonicalRegenerationDraft } from '../src/meri/objective-canonical-draft.js';
import { createCanonicalRegenerationRequestPublication } from '../src/meri/objective-canonical-regeneration-request.js';
import { privateRequestJcsSha256 } from '../src/meri/objective-canonical-request.js';
import { CORE_CANONICAL_REGENERATION_RESULT_VERSION,
  verifyRetainedCanonicalRegenerationCompletion } from '../src/meri/objective-canonical-regeneration-completion-receipt.js';
import { planCanonicalStrategyRegeneration } from '../src/meri/objective-canonical-regeneration.js';
import { recordCanonicalRegenerationNormalization } from '../src/meri/objective-canonical-regeneration-ledger.js';
import { readCanonicalSavedGeneration, requireCanonicalBasisCustody } from '../src/meri/objective-canonical-saved-generation.js';
import type { DraftJobInput } from '../src/meri/draft-job.types.js';
import type { ObjectivePlannerNativeFixture } from './objective-planner-native-fixture.js';
import type { ObjectivePlannerNativeReadySource } from './objective-planner-core-retry.native-fixture.js';

type Tx = Prisma.TransactionClient;
type Row = Record<string, any>;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => value as Prisma.InputJsonValue;
const copy = <T>(value: T): T => JSON.parse(applicationJson(value)) as T;
const iso = (value: unknown) => new Date(value as string).toISOString();
const fail = (): never => { throw Error('Native regeneration fixture requires its actual current Core Planner receipt and source'); };

/** Read the actual reciprocal command/consent/control and saved ready source.
 * This helper never mints, patches or replaces the Planner consent supplied by
 * the real Core WorkService command. The enclosing suite owns DB qualification. */
async function requireNativePlannerReceipt(tx: Tx, f: ObjectivePlannerNativeFixture,
  advanced: ObjectivePlannerNativeReadySource, receipt: WorkReceipt) {
  const c = advanced.canonical;
  const rows = await tx.$queryRaw<Array<{ consent: Row; receipt: Row; control: Row; intent: Row; revision: Row; canonical: Row }>>`
    SELECT to_jsonb(cs) AS consent,to_jsonb(r) AS receipt,to_jsonb(ctl) AS control,
      to_jsonb(i) AS intent,to_jsonb(v) AS revision,to_jsonb(p) AS canonical
    FROM client_objective_work_controls ctl JOIN client_objective_work_consents cs
      ON cs.tenant_id=ctl.tenant_id AND cs.client_id=ctl.client_id AND cs.objective_id=ctl.objective_id
      AND cs.work_action=ctl.work_action AND cs.control_id=ctl.id AND cs.id=ctl.current_consent_id
    JOIN client_objective_work_command_receipts r ON r.tenant_id=cs.tenant_id AND r.client_id=cs.client_id
      AND r.objective_id=cs.objective_id AND r.work_action=cs.work_action AND r.control_id=cs.control_id
      AND r.id=cs.command_receipt_id AND r.created_consent_id=cs.id
    JOIN client_objective_work_intents i ON i.tenant_id=cs.tenant_id AND i.client_id=cs.client_id
      AND i.objective_id=cs.objective_id AND i.id=cs.root_intent_id
    JOIN client_objective_revisions v ON v.tenant_id=i.tenant_id AND v.client_id=i.client_id
      AND v.objective_id=i.objective_id AND v.id=i.objective_revision_id AND v.version=i.objective_version
    JOIN client_objective_canonical_plans p ON p.tenant_id=cs.tenant_id AND p.client_id=cs.client_id
      AND p.objective_id=cs.objective_id AND p.id=cs.canonical_plan_id
    WHERE ctl.tenant_id=${f.tenantId}::uuid AND ctl.client_id=${c.clientId}::uuid
      AND ctl.objective_id=${c.objectiveId}::uuid AND ctl.work_action='objective.plan.prepare'
      AND cs.id=${receipt.authorizationRequestId}::uuid AND r.id=${receipt.receiptId}::uuid
    FOR UPDATE OF ctl,p FOR SHARE OF cs,r,i,v`;
  if (rows.length !== 1) return fail();
  const { consent: s, receipt: r, control, intent, revision, canonical } = rows[0]!;
  applicationJson(rows[0]);
  const source = { canonical_plan_id: c.canonicalPlanId, canonical_epoch: c.epoch,
    canonical_strategy_id: c.canonicalStrategyId, canonical_project_id: c.canonicalProjectId,
    canonical_binding_version: c.bindingVersion, root_intent_id: c.requestedIntentId,
    source_revision_id: c.requestedObjectiveRevisionId, source_objective_version: c.requestedObjectiveVersion,
    source_snapshot_hash: c.snapshotHash, root_actor_user_id: advanced.actorUserId };
  for (const row of [s, r]) {
    if (row.tenant_id !== f.tenantId || row.client_id !== c.clientId || row.objective_id !== c.objectiveId ||
        row.work_action !== 'objective.plan.prepare' || row.control_id !== f.plannerControlId ||
        Object.entries(source).some(([key, value]) => row[key] !== value)) return fail();
  }
  const command = parseWorkCommand(c.clientId, c.objectiveId, r.command);
  const publicSource = { id: c.requestedObjectiveRevisionId, version: c.requestedObjectiveVersion };
  if (control.id !== f.plannerControlId || control.current_consent_id !== s.id || control.cancelled_at !== null ||
      control.version !== receipt.controlVersionAfter || control.version !== r.control_version_after ||
      control.canonical_plan_id !== c.canonicalPlanId || control.canonical_epoch !== c.epoch ||
      control.canonical_strategy_id !== c.canonicalStrategyId || control.canonical_project_id !== c.canonicalProjectId ||
      canonical.id !== c.canonicalPlanId || canonical.binding_version !== c.bindingVersion ||
      canonical.requested_intent_id !== c.requestedIntentId || canonical.requested_objective_revision_id !== c.requestedObjectiveRevisionId ||
      canonical.requested_objective_version !== c.requestedObjectiveVersion || canonical.requested_snapshot_hash !== c.snapshotHash ||
      s.id !== receipt.authorizationRequestId || s.id === f.plannerConsentId || s.previous_consent_id !== f.plannerConsentId ||
      s.command_receipt_id !== r.id || s.command_request_id !== r.request_id || s.payload_digest !== r.payload_digest ||
      s.consenting_actor_user_id !== advanced.actorUserId || s.consenting_membership_id !== advanced.membershipId ||
      r.id !== receipt.receiptId || r.request_id !== receipt.requestId || r.payload_digest !== receipt.payloadDigest ||
      r.payload_digest !== workDigest(command) || r.actor_user_id !== advanced.actorUserId || r.actor_membership_id !== advanced.membershipId ||
      r.command_kind !== 'retry' || r.outcome !== 'reconsent_recorded' || r.target_consent_id !== f.plannerConsentId ||
      r.created_consent_id !== s.id || r.result_consent_id !== s.id || r.command_revision_id !== c.requestedObjectiveRevisionId ||
      r.command_objective_version !== c.requestedObjectiveVersion || r.control_version_before + 1 !== r.control_version_after ||
      command.command.workAction !== 'objective.plan.prepare' || command.command.expectedObjectiveVersion !== c.requestedObjectiveVersion ||
      command.command.expectedCanonicalBindingVersion !== c.bindingVersion || command.command.expectedControlVersion !== r.control_version_before ||
      command.command.targetAuthorizationRequestId !== f.plannerConsentId ||
      receipt.schemaVersion !== 1 || receipt.clientId !== c.clientId || receipt.objectiveId !== c.objectiveId ||
      receipt.command !== 'retry' || receipt.workAction !== 'objective.plan.prepare' || receipt.outcome !== 'reconsent_recorded' ||
      receipt.rootIntentId !== c.requestedIntentId || receipt.targetAuthorizationRequestId !== f.plannerConsentId ||
      receipt.controlVersionBefore !== r.control_version_before || applicationHash(receipt.sourceRevision) !== applicationHash(publicSource) ||
      applicationHash(receipt.commandRevision) !== applicationHash(publicSource) || iso(r.committed_at) !== receipt.committedAt ||
      !receipt.consent || receipt.consent.id !== s.id || iso(s.confirmed_at) !== receipt.consent.confirmedAt ||
      iso(s.expires_at) !== receipt.consent.expiresAt || Date.parse(s.confirmed_at) > Date.parse(r.committed_at) ||
      Date.parse(r.committed_at) >= Date.parse(s.expires_at) || s.consent_policy_id !== 'capiro.objective-generation-consent' ||
      s.consent_policy_revision !== 1 || intent.id !== c.requestedIntentId || intent.actor_user_id !== advanced.actorUserId ||
      intent.purpose !== OBJECTIVE_WORK_PURPOSE || intent.state !== 'pending' || intent.blocked_reason !== OBJECTIVE_WORK_BLOCKER ||
      intent.objective_revision_id !== c.requestedObjectiveRevisionId || intent.objective_version !== c.requestedObjectiveVersion ||
      intent.snapshot_hash !== c.snapshotHash || revision.id !== c.requestedObjectiveRevisionId ||
      revision.version !== c.requestedObjectiveVersion || revision.operation !== 'confirm_ready' ||
      revision.actor_user_id !== advanced.actorUserId || objectiveRevisionSnapshotHash(revision.snapshot) !== c.snapshotHash ||
      applicationHash(revision.snapshot) !== applicationHash(advanced.objectiveSnapshot)) return fail();
  return { plannerConsentId: s.id as string, plannerControlId: control.id as string,
    controlVersion: control.version as number, plannerExpiresAtMs: Date.parse(s.expires_at) };
}

/** Synthetic Strategy generation consent only. Core's real Plan-only retry is
 * left untouched, and this test helper makes no claim that Strategy retry is
 * enabled or that an external SDK/issuer produced these observations. Native
 * reciprocal constraints stay enabled; all prior records remain immutable. */
async function appendGenerationConsent(tx: Tx, f: ObjectivePlannerNativeFixture,
  advanced: ObjectivePlannerNativeReadySource, id: (name: string) => string, nowMs: number) {
  const c = advanced.canonical;
  const rows = await tx.$queryRaw<Array<{ id: string; version: number; currentConsentId: string }>>`
    SELECT id::text AS id,version,current_consent_id::text AS "currentConsentId"
    FROM client_objective_work_controls WHERE tenant_id=${f.tenantId}::uuid
      AND client_id=${c.clientId}::uuid AND objective_id=${c.objectiveId}::uuid
      AND work_action='objective.strategy.draft' AND cancelled_at IS NULL FOR UPDATE`;
  const old = rows[0];
  if (rows.length !== 1 || !old || old.id !== f.id('generation-control') || old.version !== 1 ||
      old.currentConsentId !== f.admission.consentId) return fail();
  const requestId = id('generation-consent-request'), receiptId = id('generation-consent-receipt'), consentId = id('generation-consent');
  const request = parseWorkCommand(c.clientId, c.objectiveId, { schemaVersion: 1, requestId, command: 'retry',
    workAction: 'objective.strategy.draft', expectedObjectiveVersion: c.requestedObjectiveVersion,
    expectedControlVersion: old.version, expectedCanonicalBindingVersion: c.bindingVersion,
    targetAuthorizationRequestId: old.currentConsentId });
  const digest = workDigest(request), at = new Date(nowMs).toISOString(), expires = new Date(nowMs + 600_000).toISOString();
  await tx.$executeRaw`INSERT INTO client_objective_work_consents
    (id,tenant_id,client_id,objective_id,work_action,control_id,canonical_plan_id,canonical_epoch,canonical_strategy_id,
     canonical_project_id,canonical_binding_version,root_intent_id,source_revision_id,source_objective_version,source_snapshot_hash,
     root_actor_user_id,previous_consent_id,consenting_actor_user_id,consenting_membership_id,consent_policy_id,consent_policy_revision,
     configured_duration_ms,effective_duration_ms,confirmed_at,expires_at,command_request_id,command_receipt_id,payload_digest)
    VALUES(${consentId}::uuid,${f.tenantId}::uuid,${c.clientId}::uuid,${c.objectiveId}::uuid,'objective.strategy.draft',${old.id}::uuid,
      ${c.canonicalPlanId}::uuid,${c.epoch},${c.canonicalStrategyId}::uuid,${c.canonicalProjectId}::uuid,${c.bindingVersion},
      ${c.requestedIntentId}::uuid,${c.requestedObjectiveRevisionId}::uuid,${c.requestedObjectiveVersion},${c.snapshotHash},
      ${advanced.actorUserId}::uuid,${old.currentConsentId}::uuid,${advanced.actorUserId}::uuid,${advanced.membershipId}::uuid,
      'capiro.objective-generation-consent',1,600000,600000,${at}::timestamptz,${expires}::timestamptz,
      ${requestId}::uuid,${receiptId}::uuid,${digest})`;
  await tx.$executeRaw`INSERT INTO client_objective_work_command_receipts
    (id,tenant_id,client_id,objective_id,work_action,control_id,canonical_plan_id,canonical_epoch,canonical_strategy_id,
     canonical_project_id,canonical_binding_version,root_intent_id,source_revision_id,source_objective_version,source_snapshot_hash,
     root_actor_user_id,actor_user_id,actor_membership_id,request_id,payload_digest,command,command_kind,command_revision_id,
     command_objective_version,control_version_before,control_version_after,target_consent_id,created_consent_id,result_consent_id,outcome,committed_at)
    VALUES(${receiptId}::uuid,${f.tenantId}::uuid,${c.clientId}::uuid,${c.objectiveId}::uuid,'objective.strategy.draft',${old.id}::uuid,
      ${c.canonicalPlanId}::uuid,${c.epoch},${c.canonicalStrategyId}::uuid,${c.canonicalProjectId}::uuid,${c.bindingVersion},
      ${c.requestedIntentId}::uuid,${c.requestedObjectiveRevisionId}::uuid,${c.requestedObjectiveVersion},${c.snapshotHash},
      ${advanced.actorUserId}::uuid,${advanced.actorUserId}::uuid,${advanced.membershipId}::uuid,${requestId}::uuid,${digest},
      ${JSON.stringify(request.command)}::jsonb,'retry',${c.requestedObjectiveRevisionId}::uuid,${c.requestedObjectiveVersion},
      ${old.version},${old.version + 1},${old.currentConsentId}::uuid,${consentId}::uuid,${consentId}::uuid,'reconsent_recorded',${at}::timestamptz)`;
  const changed = await tx.$executeRaw`UPDATE client_objective_work_controls
    SET version=${old.version + 1},current_consent_id=${consentId}::uuid,updated_at=clock_timestamp()
    WHERE tenant_id=${f.tenantId}::uuid AND id=${old.id}::uuid AND version=${old.version}
      AND current_consent_id=${old.currentConsentId}::uuid AND cancelled_at IS NULL`;
  if (changed !== 1) return fail();
  return { consentId, controlVersion: old.version + 1 };
}

/** Called ONLY by the separately approved, target-qualified native suite.
 * This is an actual withTenant DB transaction: real owner reads/locks, complete
 * retained basis custody, preserving node updates, a new immutable version and
 * schema-2 generation normalization. No in-memory ORM, injected authority,
 * current Planner consent fabrication, SQL execution on import or external IO.
 * Generation/provider observations are explicitly synthetic qualification data. */
export async function seedObjectivePlannerCoreNativeRegeneration(prisma: PrismaService,
  initial: ObjectivePlannerNativeFixture, advancedActualSource: ObjectivePlannerNativeReadySource,
  actualNewPlannerReceipt: WorkReceipt) {
  // Pin all JSON supplied by the suite before the transaction's first await.
  const advanced = copy(advancedActualSource), plannerReceipt = copy(actualNewPlannerReceipt), c = advanced.canonical;
  if (advanced.tenantId !== initial.tenantId || advanced.actorUserId !== initial.actorUserId ||
      advanced.clerkUserId !== initial.clerkUserId || advanced.membershipId !== initial.membershipId ||
      ['canonicalPlanId', 'tenantId', 'clientId', 'objectiveId', 'canonicalStrategyId', 'canonicalProjectId', 'epoch']
        .some(key => c[key as keyof typeof c] !== initial.canonical[key as keyof typeof c]) ||
      c.bindingVersion !== initial.canonical.bindingVersion + 1 || c.requestedObjectiveVersion !== initial.source.objectiveVersion + 2 ||
      c.requestedIntentId === initial.canonical.requestedIntentId || c.requestedObjectiveRevisionId === initial.source.objectiveRevisionId ||
      c.requestedObjectiveRevisionId !== advanced.source.objectiveRevisionId || c.requestedObjectiveVersion !== advanced.source.objectiveVersion ||
      c.clientId !== advanced.source.clientId || c.objectiveId !== advanced.source.objectiveId ||
      objectiveRevisionSnapshotHash(advanced.objectiveSnapshot) !== c.snapshotHash) return fail();
  const id = (name: string) => initial.id(`core-regeneration-${c.requestedIntentId}-${name}`);
  return prisma.withTenant(initial.tenantId, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`planner:${initial.tenantId}`},0))`;
    const strategies = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM sp_strategy
      WHERE tenant_id=${initial.tenantId}::uuid AND id=${c.canonicalStrategyId}::uuid FOR UPDATE`;
    if (strategies.length !== 1 || strategies[0]!.id !== c.canonicalStrategyId) return fail();
    const heads = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM sp_version
      WHERE tenant_id=${initial.tenantId}::uuid AND strategy_id=${c.canonicalStrategyId}::uuid
      ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`;
    if (heads.length !== 1) return fail();
    const clocks = await tx.$queryRaw<Array<{ ms: string }>>`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS ms`;
    const nowMs = Number(clocks[0]?.ms);
    if (clocks.length !== 1 || !Number.isSafeInteger(nowMs) || nowMs < 0) return fail();
    // Capture before writing this generation. Its canonical token comes only
    // from the ACTUAL new Core ready source, never deterministic fixture IDs.
    const admission: CanonicalGenerationAdmission = { ...copy(initial.admission), canonical: c,
      consentId: id('generation-consent'), controlVersion: 2, generationJobId: id('job'), generationRequestId: id('request'),
      admittedAtMs: nowMs, effectExpiresAtMs: nowMs + 600_000, expectedStrategyVersionId: heads[0]!.id };
    const basis = await captureCanonicalStrategyBasis(tx, admission);
    if (!basis) return fail();
    await requireCanonicalBasisCustody(tx, basis);
    const planner = await requireNativePlannerReceipt(tx, initial, advanced, plannerReceipt);
    if (planner.plannerExpiresAtMs <= nowMs) return fail();
    const generationConsent = await appendGenerationConsent(tx, initial, advanced, id, nowMs);
    if (generationConsent.consentId !== admission.consentId || generationConsent.controlVersion !== admission.controlVersion) return fail();
    const intent: ObjectiveIntent = { outcome: advanced.objectiveSnapshot.outcome, governmentProblem: advanced.objectiveSnapshot.governmentProblem,
      askType: advanced.objectiveSnapshot.askType, minimumWin: advanced.objectiveSnapshot.minimumWin, limits: advanced.objectiveSnapshot.limits };
    const source = copy(advanced.source), dto = { ...copy(initial.input.dto), goal: 'Synthetic revised native authorization work' };
    const prompt = 'Synthetic revised Objective and preserved government relationship context for native Core retry qualification.\n';
    const sourceDigest = applicationHash({ source, intent }), coverageDigest = applicationHash([]), packetId = id('packet');
    const localDigest = sha('synthetic native regeneration local context'), externalDigest = sha('synthetic native regeneration external observation'),
      historyDigest = sha('synthetic native regeneration history'), at = new Date(nowMs).toISOString();
    const inputDigest = applicationHash({ sourceDigest, coverageDigest, packetId, requestId: admission.generationRequestId,
      type: dto.type, localDigest, externalDigest, historyDigest, promptDigest: applicationHash(prompt) });
    const context = { reobservedAt: null, state: 'complete' as const, packetId, compiledAt: at,
      sourceDigest, coverageDigest, inputDigest, issues: [] };
    const compiled: ObjectiveAdmission = { tenantId: initial.tenantId, clerkUserId: initial.clerkUserId,
      requestId: admission.generationRequestId, type: dto.type, source, intent, localDigest, externalDigest, historyDigest,
      historyObservedAt: at, contactIds: [], context, coverage: [] };
    const publication = createCanonicalRegenerationRequestPublication({ admission, dto, context: { schemaVersion: 1,
      tenantId: initial.tenantId, clerkUserId: initial.clerkUserId, requestId: admission.generationRequestId, source, intent,
      snapshotSha256: c.snapshotHash, sourceDigest, packetId, compiledAt: at, coverageDigest, promptSha256: sha(prompt), evidence: [] },
      prompt, owners: [{ ownerRef: 'owner:qa', clerkUserId: initial.clerkUserId }],
      delegation: { ref: id('synthetic-delegation'), revision: 'synthetic-native-core-regeneration:1',
        issuedAtMs: nowMs, absoluteExpiresAtMs: nowMs + 700_000 }, requestedAtMs: nowMs, effectExpiresAtMs: nowMs + 500_000, basis });
    const binding = { tenantId: initial.tenantId, actorId: initial.clerkUserId, conversationId: id('conversation'),
      runId: id('run'), attemptId: id('attempt'), workerId: id('worker'), writerFence: 1 };
    const sourceRequestSha256 = applicationHash(['synthetic-native-core-regeneration-original-request', initial.seed, c.requestedIntentId]);
    const acceptance = { schemaVersion: 1 as const, sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission),
      sourceBinding: binding, sourceRequestSha256, acceptedAtMs: nowMs, issuance: { issuanceKey: generationBindingKey(binding), binding,
        requestSha256: sourceRequestSha256, expiresAtMs: nowMs + 400_000, grantId: id('synthetic-grant'),
        capabilitySha256: sha('synthetic native regeneration capability'), factsSha256: sha('synthetic native regeneration protected facts') } };
    const sourceKeys = basis.sourceIndex.filter(entry => !entry.archived).map(entry => entry.sourceNodeKey);
    if (sourceKeys.includes('native-submit')) return fail();
    sourceKeys.push('native-submit');
    const payload = { type: dto.type, rationale: 'Synthetic revised authority work', summary: 'Prepare the revised synthetic native request',
      nodes: sourceKeys.map((sourceNodeKey, index) => ({ sourceNodeKey, kind: 'action', subject: index === 0 ? 'deliverable' : 'submission',
        title: sourceNodeKey === 'prepare' ? 'Updated machine native authorization request' : `Complete synthetic ${sourceNodeKey}`,
        note: sourceNodeKey === 'prepare' ? 'Machine revised native request note' : null, status: 'suggested', ownerRef: null,
        startsOn: new Date(Date.parse('2027-02-01') + index * 86_400_000).toISOString().slice(0, 10), endsOn: null,
        openEnded: false, sources: [], dependsOn: index ? [sourceKeys[index - 1]!] : [] })),
      coverage: { complete: true, omitted: [], assumptions: [], sources: [], pendingSources: [] } };
    const normalized = normalizeCanonicalRegenerationDraft(payload, { admission, queuedType: dto.type, basis });
    const h = privateRequestJcsSha256({ binding, kind: 'completion' });
    const completionId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    const execution = { provider: 'synthetic-native-core-regeneration-fixture', model: 'synthetic-native-core-regeneration-fixture',
      receiptRef: completionId, receiptSha256: sha('synthetic native regeneration original-owner receipt'), bindingSha256: privateRequestJcsSha256(binding) };
    const resultBody = { resultVersion: CORE_CANONICAL_REGENERATION_RESULT_VERSION, operation: 'strategy.draft',
      requestId: admission.generationRequestId, jobId: admission.generationJobId, requestSha256: publication.requestSha256,
      inputSha256: publication.request.inputSha256, sourceSha256: privateRequestJcsSha256(publication.request.source),
      contextSha256: publication.request.context.contextSha256, basisSha256: applicationHash(basis), binding, execution,
      resultRef: completionId, completedAtMs: nowMs, state: 'succeeded', payload, payloadSha256: privateRequestJcsSha256(payload), issues: [] };
    const result = { ...resultBody, resultSha256: privateRequestJcsSha256(resultBody) }, bytes = Buffer.from(JSON.stringify(result), 'utf8');
    const rawFileSha256 = sha(bytes);
    const retained = { schemaVersion: 1, generationJobId: admission.generationJobId, binding,
      sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission), sourceRequestSha256, typedRequestSha256: publication.requestSha256,
      completionId, checkpointId: id('checkpoint'), checkpointSha256: sha('synthetic native regeneration checkpoint'), resultRef: completionId,
      resultSha256: result.resultSha256, file: { path: 'meri-objective-strategy-regeneration.result.json', object: {
        objectId: 'synthetic-native-regeneration-object', versionId: 'synthetic-native-regeneration-immutable-version',
        sha256: rawFileSha256, bytes: bytes.length, scopes: ['synthetic-native-core-regeneration-fixture'] } },
      rawFileSha256, execution, result, checkedAtMs: nowMs, expiresAtMs: nowMs + 1_000 };
    const witness = verifyRetainedCanonicalRegenerationCompletion(retained, { admission, acceptance, publication, nowMs }).witness;
    const request = { requestId: admission.generationRequestId, clientId: source.clientId,
      objective: { objectiveId: source.objectiveId, objectiveVersion: source.objectiveVersion }, type: dto.type };
    const strategyVersionId = id('version');
    const receipt: ObjectiveReceipt = { schemaVersion: 1, requestId: admission.generationRequestId, source,
      context: { ...context, reobservedAt: at }, result: { strategyId: c.canonicalStrategyId, strategyVersionId, savedAt: at,
        sourceDigest, contextPacketId: packetId, coverageDigest, inputDigest }, failure: null };
    const pendingInput = { dto, bearer: null, canonicalGeneration: generationMarker(admission), objectiveGeneration: {
      request, fingerprint: applicationHash(request), receipt: { ...receipt, context, result: null } } } as DraftJobInput;
    const input = { ...pendingInput, canonicalCompletion: witness,
      objectiveGeneration: { ...pendingInput.objectiveGeneration!, receipt } } as DraftJobInput;
    const storedRequest = { schemaVersion: 1, sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission),
      inputSha256: canonicalPublicationInputHash(pendingInput), publicationSha256: canonicalPublicationSha256(publication), compiled, publication };
    await tx.spDraftJob.create({ data: { id: admission.generationJobId, tenantId: initial.tenantId, clientId: source.clientId,
      ownerUserId: initial.clerkUserId, requestKey: requestKey(initial.tenantId, initial.clerkUserId, admission.generationRequestId),
      status: 'running', attempt: 2, input: json(pendingInput), claimedBy: `canonical:${acceptance.issuance.issuanceKey}`,
      claimedAt: new Date(nowMs), deadlineAt: new Date(admission.effectExpiresAtMs) } });
    for (const [kind, data] of [[GENERATION_ADMISSION, admission], [GENERATION_ACCEPTANCE, acceptance], [GENERATION_REQUEST, storedRequest]] as const)
      await insertGenerationLedger(tx, kind, initial.tenantId, initial.clerkUserId, admission.generationJobId, data);
    const plan = planCanonicalStrategyRegeneration({ basis, normalized, current: basis.snapshot,
      archivedNodeIds: basis.archiveIndex.map(entry => entry.nodeId), createdByUserId: initial.clerkUserId, createdAt: at,
      normalizationId: generationLedgerId(GENERATION_NORMALIZATION, initial.tenantId, initial.clerkUserId, admission.generationJobId) });
    if (Object.keys(plan.metaPatch).length) await tx.spStrategy.update({ where: { id: c.canonicalStrategyId }, data: plan.metaPatch });
    for (const { nodeId, patch } of plan.nodePatches) await tx.spNode.update({ where: { id: nodeId },
      data: { ...patch, kind: patch.kind as Prisma.SpNodeUpdateInput['kind'], subject: patch.subject as Prisma.SpNodeUpdateInput['subject'],
        startsOn: patch.startsOn ? new Date(patch.startsOn) : undefined,
        endsOn: patch.endsOn === null ? null : patch.endsOn ? new Date(patch.endsOn) : undefined } });
    for (const node of plan.newNodes) await tx.spNode.create({ data: { id: node.id, tenantId: initial.tenantId,
      strategyId: c.canonicalStrategyId, kind: node.kind as 'action', subject: node.subject as 'submission', title: node.title,
      note: node.note, ownerUserId: node.ownerUserId, status: node.status as 'suggested', startsOn: new Date(node.startsOn),
      endsOn: node.endsOn ? new Date(node.endsOn) : null, openEnded: node.openEnded, dependsOnIds: node.dependsOnIds,
      targetRef: node.targetRef == null ? undefined : json(node.targetRef), provenance: node.provenance == null ? undefined : json(node.provenance),
      meriAuthored: node.meriAuthored, createdByUserId: node.createdByUserId, createdAt: new Date(node.createdAt) } });
    await tx.spVersion.create({ data: { id: strategyVersionId, tenantId: initial.tenantId, strategyId: c.canonicalStrategyId,
      snapshot: json(plan.snapshot), authorKind: 'meri', authorUserId: initial.clerkUserId,
      note: 'Synthetic native Core regeneration', coalescible: false } });
    const normalization = await recordCanonicalRegenerationNormalization(tx, initial.tenantId, initial.clerkUserId,
      admission.generationJobId, { strategyId: c.canonicalStrategyId, strategyVersionId }, { basis, normalized, plan });
    await tx.spDraftJob.update({ where: { id: admission.generationJobId },
      data: { status: 'completed', strategyId: c.canonicalStrategyId, input: json(input), stage: 'completed' } });
    const producer = await recordCanonicalGenerationProducer(tx, initial.tenantId, initial.clerkUserId, admission.generationJobId);
    const scope = { tenantId: initial.tenantId, clerkUserId: initial.clerkUserId, generationJobId: admission.generationJobId };
    const saved = await readCanonicalSavedGeneration(tx, scope);
    const work = savedGenerationPlannerContinuation(saved, { workAction: 'objective.plan.prepare', tenantId: initial.tenantId,
      actorUserId: advanced.actorUserId, clerkUserId: initial.clerkUserId, canonical: c,
      consentId: planner.plannerConsentId, controlVersion: planner.controlVersion });
    return { id, nowMs, tenantId: initial.tenantId, actorUserId: advanced.actorUserId, clerkUserId: initial.clerkUserId,
      membershipId: advanced.membershipId, source, canonical: c, objectiveSnapshot: copy(advanced.objectiveSnapshot),
      admission, acceptance, publication, retained, normalized, compiled, receipt, pendingInput, input, storedRequest,
      basis, plan, snapshot: plan.snapshot, normalization, producer, saved, scope, work, ...planner,
      originalDeadlineAt: new Date(Math.min(planner.plannerExpiresAtMs, admission.effectExpiresAtMs,
        acceptance.issuance.expiresAtMs, publication.request.originalExpiresAtMs)).toISOString() };
  }, { timeoutMs: 30_000 });
}

export type ObjectivePlannerCoreNativeRegeneration = Awaited<ReturnType<typeof seedObjectivePlannerCoreNativeRegeneration>>;
