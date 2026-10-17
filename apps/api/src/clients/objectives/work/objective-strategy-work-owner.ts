import { types as nodeTypes } from 'node:util';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { ObjectiveStrategySelectionMode, ObjectiveWorkOwnerPort } from './objective-work.service.js';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import { lockObjectiveStrategyOutputWithinTx } from '@capiro/shared/objective-strategy-intake';
import { lockObjectiveStrategyIntakeWithinTx, type ObjectiveStrategyJobInventory } from './objective-strategy-job-reservation.js';
import { insertObjectiveStrategySelectionWithinTx } from './objective-strategy-selection-prisma.js';
import { objectiveStrategyRequestCodec, objectiveStrategySelectionBody, parseObjectiveStrategySelection,
  type ObjectiveStrategySelectionRequest } from './objective-strategy-selection.js';
import { workDigest, workFailure, workUuid, type StoredWorkReceipt, type WorkAction, type WorkAuthority, type WorkPolicyFacts,
  type WorkReadRequest, type WorkReconciliation, type WorkRequest, type WorkState } from './objective-work-command.js';

type Tx = Prisma.TransactionClient;
const ACTION = 'objective.strategy.draft';
const MAX_DURATION = 1_800_000;
type Gate = { tenantId: string; actorUserId: string; actorRole: string; strategyId: string; inventory: ObjectiveStrategyJobInventory };
const positive = (v: unknown, max = MAX_DURATION): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= max;
function json(v: unknown): void {
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return;
  if (!v || typeof v !== 'object' || nodeTypes.isProxy(v)) throw Error('Invalid stored JSON');
  if (Array.isArray(v)) {
    if (Reflect.ownKeys(v).length !== v.length + 1) throw Error('Invalid stored array');
    for (let n = 0; n < v.length; n++) {
      const d = Object.getOwnPropertyDescriptor(v, String(n));
      if (!d || !d.enumerable || !('value' in d)) throw Error('Invalid stored array'); json(d.value);
    }
    return;
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(v))) throw Error('Invalid stored object');
  for (const key of Reflect.ownKeys(v)) {
    if (typeof key !== 'string') throw Error('Invalid stored key');
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (!d || !d.enumerable || !('value' in d)) throw Error('Invalid stored property'); json(d.value);
  }
}

/** Initial selected Strategy intake only. No terminal or regeneration outcome is inferred. */
export class ObjectiveStrategyWorkOwner implements ObjectiveWorkOwnerPort {
  private readonly selected = new WeakMap<Tx, ObjectiveStrategySelectionRequest>();
  private readonly gates = new WeakMap<Tx, Gate>();
  private readonly eligible = new WeakMap<Tx, string>();
  private readonly lockedState = new WeakMap<Tx, string>();
  private readonly enabled: boolean;
  private readonly duration: number | null;
  constructor(env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly prisma?: Pick<PrismaService, 'withSystem'>) {
    this.enabled = env.OBJECTIVE_STRATEGY_INTAKE_ENABLED === 'true';
    const d = env.OBJECTIVE_STRATEGY_CONSENT_DURATION_MS;
    this.duration = typeof d === 'string' && /^[1-9][0-9]*$/.exec(d)?.[0] === d && positive(Number(d)) ? Number(d) : null;
  }
  bindStrategySelectionWithinTx(tx: Tx, ctx: TenantContext, request: ObjectiveStrategySelectionRequest,
    mode: ObjectiveStrategySelectionMode = 'write'): void {
    if (mode !== 'write' && mode !== 'recovery-read') workFailure('AUTHORITY_UNAVAILABLE', request.work.command.requestId);
    // An exact historical receipt is recovered before fresh-write policy checks.
    // This trusted mode only captures selection for the read transaction; the
    // same method still gates the later writer before state or consent writes.
    if (mode === 'write' && (!this.enabled || this.duration === null || !this.prisma))
      workFailure('AUTHORITY_UNAVAILABLE', request.work.command.requestId);
    this.selected.set(tx, parseObjectiveStrategySelection(request.work.clientId, request.work.objectiveId,
      objectiveStrategySelectionBody(request)));
    this.eligible.delete(tx);
  }
  private async lock(tx: Tx, ctx: TenantContext, clientId: string, objectiveId: string) {
    this.eligible.delete(tx);
    this.lockedState.delete(tx);
    const { tenantId, userId: actorUserId, role: actorRole } = ctx;
    if (!this.prisma) workFailure('AUTHORITY_UNAVAILABLE');
    const inventory = await lockObjectiveStrategyIntakeWithinTx(tx, tenantId);
    // Routing hint only. Current native source is locked and compared later.
    const rows = await tx.$queryRaw<Array<{ strategyId: string }>>`SELECT canonical_strategy_id::text AS "strategyId"
      FROM client_objective_canonical_plans WHERE tenant_id=${tenantId}::uuid
        AND client_id=${clientId}::uuid AND objective_id=${objectiveId}::uuid`;
    if (rows.length !== 1 || workUuid(rows[0]!.strategyId) !== rows[0]!.strategyId) workFailure('AUTHORITY_UNAVAILABLE');
    const strategyId = rows[0]!.strategyId;
    await lockObjectiveStrategyOutputWithinTx(tx, strategyId);
    this.gates.set(tx, { tenantId, actorUserId, actorRole, strategyId, inventory });
  }
  async lockWithinTx(tx: Tx, ctx: TenantContext, request: WorkRequest): Promise<void> {
    if (request.command.workAction !== ACTION || !this.enabled || this.duration === null) return;
    await this.lock(tx, ctx, request.clientId, request.objectiveId);
  }
  async lockReadWithinTx(tx: Tx, ctx: TenantContext, request: WorkReadRequest): Promise<void> {
    if (request.workAction !== ACTION || !this.enabled || this.duration === null) return;
    this.selected.delete(tx);
    await this.lock(tx, ctx, request.clientId, request.objectiveId);
  }
  private key(a: WorkAuthority, state: WorkState) { return workDigest({ a, state }); }
  /** Called by WorkService only after its actual canonical/control write locks. */
  observeLockedStrategyStateWithinTx(tx: Tx, a: WorkAuthority, action: WorkAction, state: WorkState): void {
    if (action === ACTION && this.gates.get(tx)?.tenantId === a.tenantId && this.selected.has(tx))
      this.lockedState.set(tx, this.key(a, state));
  }
  async reconcileWithinTx(tx: Tx, a: WorkAuthority, action: WorkAction, state: WorkState): Promise<WorkReconciliation> {
    const base: WorkReconciliation = { state: 'outcome_unconfirmed', tenantId: a.tenantId, clientId: a.clientId,
      objectiveId: a.objectiveId, workAction: action, authorizationRequestId: state.control?.currentConsentId ?? null,
      rootIntentId: state.consent?.source.rootIntentId ?? state.source.rootIntentId,
      canonicalPlanId: state.source.canonicalPlanId, canonicalEpoch: state.source.canonicalEpoch };
    this.eligible.delete(tx);
    if (action !== ACTION || !this.enabled || this.duration === null) return { ...base, state: 'unavailable' };
    if (this.gates.get(tx)?.tenantId !== a.tenantId) return base;
    // The reserved-output parent fence is exclusive only on the real command
    // write path. An ordinary FOR SHARE status read cannot prove absence.
    if (!this.selected.has(tx) || this.lockedState.get(tx) !== this.key(a, state)) return base;
    try {
      const c = state.control, s = state.source;
      const gate = this.gates.get(tx)!;
      if (gate.strategyId !== s.canonicalStrategyId || gate.actorUserId !== a.actorUserId ||
          !['standard_user', 'user_admin', 'capiro_admin'].includes(gate.actorRole)) return base;
      if (state.consent || c && (c.version !== 0 || c.currentConsentId !== null || c.cancelledAt !== null || c.cancelledByUserId !== null) ||
          a.objectiveStatus !== 'ready' || a.objectiveRevisionId !== s.sourceRevisionId || a.objectiveVersion !== s.sourceObjectiveVersion)
        return base;
      const present = await tx.$queryRaw<Array<{ present: boolean }>>`SELECT
        EXISTS(SELECT 1 FROM client_objective_strategy_intakes WHERE tenant_id=${a.tenantId}::uuid
          AND (objective_id=${a.objectiveId}::uuid OR canonical_plan_id=${s.canonicalPlanId}::uuid
            OR canonical_strategy_id=${s.canonicalStrategyId}::uuid OR canonical_project_id=${s.canonicalProjectId}::uuid)) OR
        EXISTS(SELECT 1 FROM sp_strategy WHERE tenant_id=${a.tenantId}::uuid AND id=${s.canonicalStrategyId}::uuid) OR
        EXISTS(SELECT 1 FROM sp_version WHERE tenant_id=${a.tenantId}::uuid AND strategy_id=${s.canonicalStrategyId}::uuid) AS present`;
      if (present.length !== 1 || present[0]!.present !== false) return base;
      const roles = await tx.$queryRaw<Array<{ role: string }>>`SELECT role::text AS role FROM tenant_memberships
        WHERE tenant_id=${a.tenantId}::uuid AND id=${a.actorMembershipId}::uuid
          AND user_id=${a.actorUserId}::uuid AND status::text='active'`;
      if (roles.length !== 1 || !['standard_user', 'user_admin', 'capiro_admin'].includes(roles[0]!.role)) return base;
      // Global IDs can already belong to a foreign RLS scope. Under the held
      // global writer gate, the approved system owner observes only occupancy
      // and audits this actual native viewer. No foreign metadata is returned.
      const occupied = await this.prisma!.withSystem(async system => {
        const observations = await system.$queryRaw<Array<{ occupied: boolean }>>`SELECT
          EXISTS(SELECT 1 FROM public.sp_strategy WHERE id=${gate.strategyId}::uuid) OR
          EXISTS(SELECT 1 FROM public.sp_version WHERE strategy_id=${gate.strategyId}::uuid) AS occupied`;
        if (observations.length !== 1 || typeof observations[0]!.occupied !== 'boolean') throw Error('Unknown global occupancy');
        await system.auditLog.create({ data: { tenantId: a.tenantId, actorUserId: a.actorUserId,
          actorRole: roles[0]!.role, action: 'objective_strategy_intake_output_presence_observed',
          entityType: 'canonical_strategy', entityId: gate.strategyId,
          requestId: this.selected.get(tx)!.work.command.requestId, after: { occupied: observations[0]!.occupied } } });
        return observations[0]!.occupied;
      }, { timeoutMs: 3000 });
      if (occupied) return base;
      const jobs = await tx.$queryRaw<Array<{ id: string; clientId: string; strategyId: string | null; input: any }>>`
        SELECT id::text AS id,client_id::text AS "clientId",strategy_id::text AS "strategyId",input FROM sp_draft_job
        WHERE tenant_id=${a.tenantId}::uuid ORDER BY id LIMIT 129`;
      if (jobs.length > 128) return base;
      for (const job of jobs) {
        json(job.input);
        if (!job.input || typeof job.input !== 'object' || Array.isArray(job.input)) return base;
        if (job.strategyId === s.canonicalStrategyId) return base;
        const hasObjective = Object.hasOwn(job.input, 'objectiveGeneration'),
          hasCanonical = Object.hasOwn(job.input, 'canonicalGeneration'),
          hasReservation = Object.hasOwn(job.input, 'objectiveCanonicalReservation');
        if (hasCanonical && hasReservation) return base;
        if (hasCanonical) {
          const marker = job.input.canonicalGeneration;
          if (!marker || typeof marker !== 'object' || Array.isArray(marker) ||
              Object.keys(marker).sort().join(',') !== 'admissionId' || workUuid(marker.admissionId) !== marker.admissionId) return base;
        }
        if (hasReservation) objectiveStrategyRequestCodec.parseReservation(job.input.objectiveCanonicalReservation);
        if (hasObjective) {
          const envelope = job.input.objectiveGeneration;
          if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return base;
          if (Object.keys(envelope).some(key => !['request', 'fingerprint', 'receipt', 'localDigest', 'externalDigest',
            'historyDigest', 'historyObservedAt', 'historyCheckedAt', 'coverage', 'contactIds'].includes(key))) return base;
          const request = objectiveStrategyRequestCodec.parseObjectiveDraft(envelope.request);
          const receipt = envelope.receipt, source = receipt?.source;
          if (request.clientId !== job.clientId || envelope.fingerprint !== objectiveStrategyRequestCodec.digest(request) ||
              !receipt || receipt.schemaVersion !== 1 || receipt.requestId !== request.requestId || !source ||
              Object.keys(source).sort().join(',') !== 'clientId,objectiveId,objectiveRevisionId,objectiveVersion' ||
              source.clientId !== request.clientId || source.objectiveId !== request.objective.objectiveId ||
              source.objectiveVersion !== request.objective.objectiveVersion ||
              workUuid(source.objectiveRevisionId) !== source.objectiveRevisionId || request.objective.objectiveId === a.objectiveId) return base;
        } else if (hasCanonical || hasReservation) return base;
      }
      // Inspect complete bounded tenant resource inventory, including renamed
      // kinds and foreign owner/archive metadata. Existing same-canonical
      // Planner evidence is conservatively uncertain, never Strategy-applied.
      // No kind filter proves absence.
      const resources = await tx.$queryRaw<Array<{ kind: string; data: any }>>`SELECT kind,data FROM sp_planner_resources
        WHERE tenant_id=${a.tenantId}::uuid ORDER BY id LIMIT 257`;
      if (resources.length > 256) return base;
      for (const row of resources) {
        json(row.data);
        const d = row.data, candidates = [d?.canonical, d?.sourceAdmission?.canonical, d?.request?.canonical,
          d?.binding?.canonical, d?.work?.canonical];
        if (candidates.some(canonical => canonical && (canonical.canonicalPlanId === s.canonicalPlanId ||
            canonical.objectiveId === a.objectiveId || canonical.canonicalStrategyId === s.canonicalStrategyId ||
            canonical.canonicalProjectId === s.canonicalProjectId))) return base;
        if (row.kind.startsWith('objective_') && !candidates.some(canonical => canonical &&
            typeof canonical.canonicalPlanId === 'string' && typeof canonical.objectiveId === 'string')) return base;
      }
      const selected = this.selected.get(tx);
      if (selected && selected.work.clientId === a.clientId && selected.work.objectiveId === a.objectiveId &&
          selected.work.command.expectedObjectiveVersion === a.objectiveVersion &&
          selected.work.command.expectedCanonicalBindingVersion === s.canonicalBindingVersion &&
          selected.work.command.expectedControlVersion === 0 && selected.work.command.targetAuthorizationRequestId === null)
        this.eligible.set(tx, this.key(a, state));
      return { ...base, state: 'not_started' };
    } catch { return base; }
  }
  async policyWithinTx(tx: Tx, a: WorkAuthority, action: WorkAction, state: WorkState): Promise<Omit<WorkPolicyFacts, 'originalTokenExpiresAtMs'>> {
    if (action !== ACTION || !this.enabled || this.duration === null || this.gates.get(tx)?.tenantId !== a.tenantId ||
        this.eligible.get(tx) !== this.key(a, state)) return workFailure('AUTHORITY_UNAVAILABLE');
    try {
      const rows = await tx.$queryRaw<Array<{ settings: any }>>`SELECT settings_jsonb AS settings FROM tenants
        WHERE id=${a.tenantId}::uuid AND status::text='active' FOR SHARE`;
      if (rows.length !== 1) throw Error('Missing tenant policy');
      const s = rows[0]!.settings; json(s);
      const p = s?.objectiveStrategyIntake;
      if (s?.clioFeatureFlags?.['strategyPlanner.enabled'] !== true || !p || Array.isArray(p) || p.enabled !== true)
        throw Error('Disabled tenant policy');
      const limit = Object.hasOwn(p, 'durationLimitMs') ? p.durationLimitMs : null;
      if (Object.hasOwn(p, 'durationLimitMs') && !positive(limit)) throw Error('Invalid tenant duration');
      return { configuredDurationMs: this.duration, tenantDurationLimitMs: limit, actionDurationLimitMs: MAX_DURATION,
        originalDelegationExpiresAtMs: null, limitReference: 'objective-strategy-intake:v1' };
    } catch { return workFailure('AUTHORITY_UNAVAILABLE'); }
  }
  async reserveStrategyWithinTx(tx: Tx, a: WorkAuthority, stored: StoredWorkReceipt,
    request: ObjectiveStrategySelectionRequest): Promise<void> {
    const selected = this.selected.get(tx), gate = this.gates.get(tx);
    if (!selected || !gate || gate.tenantId !== a.tenantId || workDigest(selected) !== workDigest(request))
      return workFailure('AUTHORITY_UNAVAILABLE');
    await insertObjectiveStrategySelectionWithinTx(tx, a, stored, selected, gate.inventory);
    this.eligible.delete(tx);
  }
}
