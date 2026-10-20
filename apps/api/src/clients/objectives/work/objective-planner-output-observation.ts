import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { readObjectivePlanResource, plannerResourceCalendarDate,
  type TenantContext, type ObjectiveOperationalResource } from '@capiro/shared';
import { createPlannerApplicationCodec, createPlannerMaterializationCodec } from '@capiro/shared/objective-planner-owner-codec';
import type { Prisma } from '@prisma/client';
import type { ObjectivePlannerAppliedOperation, ObjectivePlannerAppliedPair } from './objective-planner-applied.js';
import type { WorkAuthority, WorkState } from './objective-work-command.js';
import { unavailableObjectiveWorkOutputs,
  type ObjectiveWorkOutputObservation, type ObjectiveWorkOutputRequest } from './objective-work-output.js';

const application = createPlannerApplicationCodec({ isProxy: nodeTypes.isProxy,
  sha256: value => createHash('sha256').update(value, 'utf8').digest('hex') });
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const materialization = createPlannerMaterializationCodec({ sha256,
  digest: value => sha256(JSON.stringify(JSON.parse(application.applicationJson(value)))),
  canonicalRegenerationHash: application.applicationHash, plannerCalendarDate: plannerResourceCalendarDate,
  materializationError: () => fail() });
const copy = <T>(value: T): T => JSON.parse(application.applicationJson(value)) as T;
const positive = (value: unknown): value is number => typeof value === 'number' &&
  Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const utc = (value: unknown): value is string => typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function fail(): never { throw Error('Unconfirmed Planner output observation'); }

/** Read-only pending observation: semantic inventory alone cannot rule out a
 * renamed/foreign-scoped receipt or head at an exact deterministic address. */
export async function requireObjectivePlannerPendingReceiptAbsenceWithinTx(tx: Prisma.TransactionClient,
  rawOperation: ObjectivePlannerAppliedOperation, rawOperationId: string): Promise<void> {
  const { operation, operationId } = copy({ operation: rawOperation, operationId: rawOperationId });
  const { tenantId, clerkUserId, work } = operation;
  application.applicationUuid(operationId);
  // A second started claim can be hidden from the semantic inventory by a
  // changed kind/owner/archive/scope. Exactly the already-validated current
  // operation may bear this consent identity; all other rows are uncertainty.
  const started = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM sp_planner_resources
    WHERE tenant_id=${tenantId}::uuid AND data#>>'{work,consentId}'=ANY(${[work.consentId]}::text[]) LIMIT 2`;
  if (started.length !== 1 || started[0]!.id !== operationId) fail();
  const applicationId = application.applicationReceiptId(tenantId, clerkUserId, work.applicationRequestId);
  const ownerId = materialization.canonicalMaterializationReceiptId(tenantId, clerkUserId, work.applicationRequestId);
  const headId = application.applicationHeadId(work.canonical);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM sp_planner_resources
    WHERE tenant_id=${tenantId}::uuid AND id IN (${applicationId}::uuid,${ownerId}::uuid,${headId}::uuid)`;
  if (rows.length !== 0) fail();
}

/** Projection of ALREADY owner/native-verified Planner pairs only. The caller
 * retains its early Planner gate and current Core authority. This is neither a
 * Strategy producer/completion reader nor a policy, operation or effect grant.
 * Original private receipts/snapshots remain inputs, never public output.
 */
export async function readObjectivePlannerOutputObservationWithinTx(tx: Prisma.TransactionClient,
  rawContext: TenantContext, rawAuthority: WorkAuthority, rawState: WorkState,
  rawRequest: ObjectiveWorkOutputRequest, rawApplications: readonly ObjectivePlannerAppliedPair[],
  observedAt: string): Promise<ObjectiveWorkOutputObservation> {
  try {
    // Pin all local owner/caller data before the first await. The shared JSON
    // checker rejects accessors/proxies before property reflection or getters.
    const { ctx, a, state, request, applications } = copy({ ctx: rawContext, a: rawAuthority,
      state: rawState, request: rawRequest, applications: rawApplications });
    if (!utc(observedAt) || request.workAction !== 'objective.plan.prepare' ||
        ctx.tenantId !== a.tenantId || ctx.userId !== a.actorUserId || ctx.clerkUserId !== a.clerkUserId ||
        !['standard_user', 'user_admin', 'capiro_admin'].includes(ctx.role) ||
        request.clientId !== a.clientId || request.objectiveId !== a.objectiveId ||
        !Array.isArray(applications) || applications.length === 0 || applications.length > 128) fail();
    const matches = applications.filter(pair => {
      const c = pair.stored.request.canonical;
      return c.tenantId === a.tenantId && c.clientId === a.clientId && c.objectiveId === a.objectiveId &&
        c.requestedObjectiveRevisionId === request.source.revision.id &&
        c.requestedObjectiveVersion === request.source.revision.version &&
        c.bindingVersion === request.source.canonicalBindingVersion;
    });
    if (matches.length !== 1) fail();
    const selected = matches[0]!, canonical = selected.stored.request.canonical, result = selected.owner.result;
    if (canonical.canonicalPlanId !== state.source.canonicalPlanId || canonical.epoch !== state.source.canonicalEpoch ||
        canonical.canonicalProjectId !== state.source.canonicalProjectId ||
        canonical.canonicalStrategyId !== state.source.canonicalStrategyId || result.projects.length !== 1 ||
        !utc(result.recordedAt) || Date.parse(result.recordedAt) > Date.parse(observedAt) ||
        ![2, 3].includes(selected.owner.receiptVersion)) fail();
    const project = result.projects[0]!;
    if (project.output.id !== canonical.canonicalProjectId || !positive(project.output.createdVersion) ||
        !positive(project.output.currentVersion)) fail();
    // A v3 application reconciles an existing project. Its selected application
    // time/version must never be described as the original project creation.
    const creators = applications.filter(pair => pair.owner.receiptVersion === 2 &&
      ['tenantId', 'clientId', 'objectiveId', 'canonicalPlanId', 'epoch', 'canonicalProjectId', 'canonicalStrategyId']
        .every(key => pair.stored.request.canonical[key as keyof typeof canonical] === canonical[key as keyof typeof canonical]) &&
      pair.owner.result.projects.length === 1 &&
      pair.owner.result.projects[0]!.output.id === project.output.id);
    if (creators.length !== 1) fail();
    const creator = creators[0]!, original = creator.owner.result.projects[0]!;
    if (!utc(creator.owner.result.recordedAt) ||
        Date.parse(creator.owner.result.recordedAt) > Date.parse(result.recordedAt) ||
        original.output.createdVersion !== project.output.createdVersion) fail();
    const current = await readObjectivePlanResource(tx, ctx, { clientId: a.clientId, objectiveId: a.objectiveId,
      objectiveVersion: a.objectiveVersion, objectiveRevisionId: a.objectiveRevisionId },
    { kind: 'planner_project', id: canonical.canonicalProjectId }, observedAt, observedAt);
    if (!current) return { state: 'applied', strategy: { availability: 'unavailable' }, planner: {
      availability: 'unavailable', projects: [{ availability: 'unavailable', creation: null, application: null, current: null }] } };
    // Return only the existing current-resource public contract. Task metadata,
    // stored project titles, owner IDs and any private input stay behind this
    // projection even if the owner reader returns additional fields.
    application.applicationJson(current);
    const resource = current.resource;
    const ownerVersion = resource.ownerVersion;
    if (ownerVersion.kind !== 'counter') return fail();
    const currentVersion = ownerVersion.value;
    if (resource.selection.kind !== 'planner_project' || resource.selection.id !== canonical.canonicalProjectId ||
        resource.observedAt !== observedAt || (resource.title !== null && typeof resource.title !== 'string') ||
        !positive(currentVersion) || currentVersion < project.output.currentVersion) fail();
    const publicResource: ObjectiveOperationalResource = { selection: { kind: 'planner_project', id: resource.selection.id },
      title: resource.title, ownerVersion: { kind: 'counter', value: currentVersion }, observedAt };
    return copy({ state: 'applied', strategy: { availability: 'unavailable' }, planner: {
      availability: 'available', projects: [{ availability: 'available',
        creation: { receiptVersion: creator.owner.receiptVersion, recordedAt: creator.owner.result.recordedAt,
          version: original.output.createdVersion },
        application: { receiptVersion: selected.owner.receiptVersion, recordedAt: result.recordedAt },
        current: publicResource }] } });
  } catch { return unavailableObjectiveWorkOutputs('outcome_unconfirmed'); }
}
