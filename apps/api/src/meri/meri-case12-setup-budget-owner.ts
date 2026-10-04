import { createHash } from 'node:crypto';
import {
  CASE12_SETUP_ROWS,
  case12SetupHash,
  completeCase12SetupBudgetRow,
  createCase12SetupBudget,
  readCase12SetupBudget,
  reserveCase12SetupWire,
  settleCase12SetupWire,
  validateCase12SetupBudgetPlan,
  type Case12SetupBudgetPlan,
  type Case12SetupBudgetState,
  type Case12SetupOutcome,
  type Case12SetupWireInput,
  type Case12SetupWireKind,
} from './meri-case12-setup-budget.js';
import { withCase12SetupProviderScope } from './meri-case12-setup-provider-scope.js';

const BUDGET_SLOT = 'case12SetupProviderBudget';
const CLAIM_SLOT = 'case12MemorySetup';
const FIXTURE_NAMESPACE = 'meri-foundation-20260928';
const TENANT_ID = 'f2d6cf8f-057c-479a-8110-62fe5086d43f';
const HASH = /^[a-f0-9]{64}$/u;
const UUID4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const UUID5 = /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const uuid4=(v:unknown)=>typeof v==='string'&&UUID4.test(v);
const uuid5=(v:unknown)=>typeof v==='string'&&UUID5.test(v);
const hash=(v:unknown)=>typeof v==='string'&&HASH.test(v);
const logical=(i:number)=>i===0?'MA510':`MA510-DISTRACTOR-${String(i).padStart(4,'0')}`;

function fail(code: string): never {
  throw new Error(`meri_case12_setup_owner_${code}`);
}
const isRecord = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/* Matches evals/meri/live-v1/lib/stable.mjs for setup recipe/manifest hashes. */
function stableValue(value: any): any {
  if (typeof value === 'string') {
    return value.normalize('NFC').replace(/\r\n?/g, '\n').split('\n')
      .map((line) => line.replace(/[\t ]+$/u, '')).join('\n').replace(/\n+$/u, '');
  }
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}
function setupStableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value)), 'utf8').digest('hex');
}
function reducerEqual(a: unknown, b: unknown): boolean {
  return case12SetupHash(a) === case12SetupHash(b);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

type Candidate = {
  physicalId: string;
  logicalId: string;
  tenantId: string;
  clientPhysicalId: string;
  payloadSha256: string;
  ownership: { markerSha256: string };
  payload: Record<string,any>;
};
type FrozenBindings = {
  recipe: Record<string, any>;
  plan: Record<string, any>;
  ordered510Candidates: Candidate[];
};
type Tx = { $queryRawUnsafe(query: string, ...values: unknown[]): Promise<any[]> };
type TerminalProof = Record<string,unknown> & {kind:'meri-case12-setup-terminal-row'; proofSha256:string};
type Deps = {
  prisma: {
    withTenantUser<T>(tenantId: string, userId: string, work: (tx: Tx) => Promise<T>): Promise<T>;
  };
  /** Native T1 actor/membership/Clerk/client-wall check in the supplied transaction. */
  assertCurrentCase12ScopeInTx(
    tx: Tx,
    bindings: FrozenBindings,
  ): Promise<{ tenantId: string; userId: string; clientId: string }>;
  /** Mandatory private native admission; must consume the exact live reservation in this tx. */
  consumeNativeSetupAdmissionInTx(
    tx: Tx,
    opaqueNativeAdmission: unknown,
    frozenBindings: FrozenBindings,
  ): Promise<Case12SetupBudgetPlan>;
  /** Mandatory private proof from actual current native rows, called in the locked tx. */
  inspectTerminalRowInTx(
    tx: Tx,
    ctx: unknown,
    admittedRow: unknown,
    returnedBinding: unknown,
  ): Promise<TerminalProof>;
};
type StoredBudget = {
  version: 1;
  plan: Case12SetupBudgetPlan;
  state: Case12SetupBudgetState;
  terminalProofs: Array<{ row: number; proofSha256: string; metadata: Record<string, unknown> }>;
};
type Handle = {
  tenantId: string;
  userId: string;
  bindings: FrozenBindings;
  plan: Case12SetupBudgetPlan;
  poisoned: boolean;
  busy: boolean;
};

function requireDeps(deps: Deps): void {
  if (typeof deps?.prisma?.withTenantUser !== 'function') fail('PRISMA_REQUIRED');
  if (typeof deps?.assertCurrentCase12ScopeInTx !== 'function') fail('NATIVE_SCOPE_AUTH_REQUIRED');
  // Deliberately before all database activity: never supply either missing native capability.
  if (typeof deps?.consumeNativeSetupAdmissionInTx !== 'function') fail('NATIVE_ADMISSION_REQUIRED');
  if (typeof deps?.inspectTerminalRowInTx !== 'function') fail('NATIVE_TERMINAL_INSPECTOR_REQUIRED');
}
function snapshotBindings(input: unknown): FrozenBindings {
  if (!isRecord(input) || !isRecord(input.recipe) || !isRecord(input.plan) ||
      !Array.isArray(input.ordered510Candidates) || input.ordered510Candidates.length !== CASE12_SETUP_ROWS) fail('BINDINGS_INVALID');
  const bindings = structuredClone(input) as FrozenBindings;
  const { recipe, plan, ordered510Candidates: candidates } = bindings;
  const recipeKeys = 'actors|caseId|clerkUserId|clients|ctx|fixtureInstanceId|fixtureNamespace|reviewerUserId|schemaVersion|target';
  if (Object.keys(recipe).sort().join('|') !== recipeKeys ||
      !isRecord(recipe.ctx) || Object.keys(recipe.ctx).sort().join('|') !== 'role|tenantId|tenantSlug|userId' ||
      recipe.caseId !== '12' || recipe.schemaVersion !== 1 || recipe.fixtureNamespace !== FIXTURE_NAMESPACE || recipe.target !== 'capiro-dev' ||
      recipe.ctx?.tenantId !== TENANT_ID || recipe.ctx.tenantSlug !== FIXTURE_NAMESPACE+'-t1' || recipe.ctx?.role !== 'standard_user' ||
      !uuid4(recipe.fixtureInstanceId ?? '') || !uuid4(recipe.ctx.userId ?? '') ||
      !uuid4(recipe.reviewerUserId ?? '') || recipe.ctx.userId === recipe.reviewerUserId ||
      (typeof recipe.clerkUserId!=='string'||!/^user_[A-Za-z0-9_-]+$/u.test(recipe.clerkUserId))) fail('RECIPE_INVALID');
  const expectedDefinitionHash = setupStableHash(candidates);
  for (const [index, candidate] of candidates.entries()) {
    const logicalId = index === 0 ? 'MA510' : `MA510-DISTRACTOR-${String(index).padStart(4, '0')}`;
    if (!isRecord(candidate) || candidate.logicalId !== `APPROVED-${logicalId}` || !uuid5(candidate.physicalId ?? '') ||
        candidate.tenantId !== TENANT_ID || !uuid4(candidate.clientPhysicalId ?? '') ||
        !hash(candidate.payloadSha256 ?? '') || setupStableHash(candidate.payload) !== candidate.payloadSha256 ||
        !hash(candidate.ownership?.markerSha256 ?? '')) fail('CANDIDATE_BINDING_INVALID');
  }
  if (new Set(candidates.map((candidate) => candidate.physicalId)).size !== CASE12_SETUP_ROWS ||
      candidates.some((candidate) => candidate.clientPhysicalId !== candidates[0]?.clientPhysicalId ||
        candidate.payload?.facts?.lifecycle !== 'approved') ||
      recipe.actors?.PAT?.tenantId !== 'T1' ||
      (recipe.actors?.PAT?.physicalId ?? recipe.actors?.PAT?.userId) !== recipe.ctx.userId ||
      recipe.actors?.PRIYA?.tenantId !== 'T1' ||
      (recipe.actors?.PRIYA?.physicalId ?? recipe.actors?.PRIYA?.userId) !== recipe.reviewerUserId ||
      recipe.clients?.ASTER?.tenantId !== 'T1' || recipe.clients?.ASTER?.physicalId !== candidates[0]?.clientPhysicalId ||
      plan.kind !== 'meri-case12-memory-setup-plan' || plan.schemaVersion !== 1 ||
      plan.exactCanonicalDefinitionCount !== CASE12_SETUP_ROWS || plan.firstLogicalId !== 'MA510' ||
      plan.fixtureNamespace !== FIXTURE_NAMESPACE || plan.fixtureInstanceId !== recipe.fixtureInstanceId ||
      plan.tenantId !== TENANT_ID || plan.actorScope?.proposerUserId !== recipe.ctx.userId ||
      plan.actorScope?.proposerRole !== 'standard_user' || plan.actorScope?.clerkUserId !== recipe.clerkUserId ||
      plan.actorScope?.reviewerUserId !== recipe.reviewerUserId || plan.actorScope?.reviewerRole !== 'user_admin' ||
      plan.actorScope?.clientId !== candidates[0]?.clientPhysicalId ||
      !hash(plan.planSha256 ?? '') || !hash(plan.recipeSha256 ?? '') ||
      !hash(plan.orderedDefinitionSha256 ?? '') || !hash(plan.manifestContentSha256 ?? '') ||
      plan.recipeSha256 !== setupStableHash(recipe) || plan.orderedDefinitionSha256 !== expectedDefinitionHash ||
      plan.planSha256 !== setupStableHash(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planSha256')))) fail('FROZEN_PLAN_BINDING_MISMATCH');
  return deepFreeze(bindings);
}
function validateAdmittedPlan(value: unknown, bindings: FrozenBindings): Case12SetupBudgetPlan {
  const plan = validateCase12SetupBudgetPlan(value);
  const { recipe, plan: setupPlan, ordered510Candidates: candidates } = bindings;
  if (plan.setupPlanSha256 !== setupPlan.planSha256 || plan.recipeSha256 !== setupPlan.recipeSha256 ||
      plan.orderedDefinitionSha256 !== setupPlan.orderedDefinitionSha256 || plan.rows.length !== CASE12_SETUP_ROWS ||
      plan.rows[0]?.logicalId !== 'MA510' || plan.tenantId !== TENANT_ID ||
      plan.fixtureNamespace !== FIXTURE_NAMESPACE || plan.fixtureInstanceId !== recipe.fixtureInstanceId ||
      plan.proposerUserId !== recipe.ctx.userId || plan.reviewerUserId !== recipe.reviewerUserId ||
      plan.clientId !== setupPlan.actorScope.clientId ||
      plan.rows.some((row, index) => row.candidateId !== candidates[index]?.physicalId ||
        row.logicalId !== logical(index) || row.candidatePayloadSha256 !== candidates[index]?.payloadSha256)) fail('ADMITTED_PLAN_BINDING_MISMATCH');
  return deepFreeze(plan);
}
function parseStored(value: unknown, bindings?: FrozenBindings): StoredBudget {
  if (!isRecord(value) || Object.keys(value).sort().join('|') !== 'plan|state|terminalProofs|version' ||
      value.version !== 1 || !Array.isArray(value.terminalProofs)) fail('BUDGET_SLOT_INVALID');
  const plan = bindings ? validateAdmittedPlan(value.plan, bindings) : validateCase12SetupBudgetPlan(value.plan);
  if (value.state?.planSha256 !== case12SetupHash(plan)) fail('BUDGET_PLAN_CHANGED');
  const state = readCase12SetupBudget(value.state, plan);
  const terminalProofs = value.terminalProofs.map((proof: any, index: number) => {
    if (!isRecord(proof) || Object.keys(proof).sort().join('|') !== 'metadata|proofSha256|row' ||
        proof.row !== index || !hash(proof.proofSha256 ?? '') || !isRecord(proof.metadata) ||
        Buffer.byteLength(JSON.stringify(proof), 'utf8') > 4096 || case12SetupHash(proof.metadata)!==proof.proofSha256) fail('TERMINAL_PROOF_LEDGER_INVALID');
    return { row: proof.row as number, proofSha256: proof.proofSha256 as string, metadata: proof.metadata as Record<string,unknown> };
  });
  if (terminalProofs.length !== state.nextRow) fail('TERMINAL_PROOF_PROGRESS_MISMATCH');
  return { version: 1, plan, state, terminalProofs };
}
function assertClaim(claim: any, index: number, bindings: FrozenBindings, plan: Case12SetupBudgetPlan): void {
  const progress = claim?.progress;
  if (!claim || claim.kind !== 'meri-case12-memory-setup-claim' || claim.schemaVersion !== 1 || claim.status !== 'STARTED' ||
      claim.recipeSha256 !== bindings.plan.recipeSha256 || claim.planSha256 !== bindings.plan.planSha256 ||
      claim.orderedDefinitionSha256 !== bindings.plan.orderedDefinitionSha256 ||
      claim.manifestContentSha256 !== bindings.plan.manifestContentSha256 ||
      claim.fixtureInstanceId !== bindings.recipe.fixtureInstanceId || claim.locator == null ||
      setupStableHash(claim.locator) !== setupStableHash(bindings.recipe) ||
      claim.plan?.planSha256 !== claim.planSha256 || claim.plan?.recipeSha256 !== claim.recipeSha256 ||
      claim.plan?.orderedDefinitionSha256 !== claim.orderedDefinitionSha256 ||
      claim.planSha256 !== setupStableHash(Object.fromEntries(Object.entries(claim.plan ?? {}).filter(([key]) => key !== 'planSha256'))) ||
      !reducerEqual(claim.plan, bindings.plan) ||
      claim.claimIdentitySha256 !== setupStableHash({ planSha256: claim.planSha256, recipeSha256: claim.recipeSha256 }) ||
      !Array.isArray(progress) || progress.length !== index + 1 ||
      progress.slice(0, index).some((step: any, priorIndex: number) =>
        step?.phase !== 'VERIFIED' || step.index !== priorIndex ||
        step.logicalId !== plan.rows[priorIndex]?.logicalId || step.candidateId !== plan.rows[priorIndex]?.candidateId ||
        !isRecord(step.binding) || step.binding.candidateId!==step.candidateId || step.binding.logicalId!==step.logicalId ||
        step.bindingSha256!==setupStableHash(step.binding)) ||
      progress[index]?.phase !== 'INTENT' || progress[index]?.index !== index ||
      progress[index]?.logicalId !== plan.rows[index]?.logicalId || progress[index]?.candidateId !== plan.rows[index]?.candidateId) fail('CLAIM_OR_PROGRESS_MISMATCH');
}

/**
 * Draft private composition owner. The mandatory native admission and terminal-row ports are
 * intentionally not implemented here; this factory is unqualified until real ports are composed.
 */
export function createCase12SetupBudgetOwner(suppliedDeps: Deps) {
  requireDeps(suppliedDeps);
  const deps:Deps={prisma:{withTenantUser:suppliedDeps.prisma.withTenantUser.bind(suppliedDeps.prisma)},assertCurrentCase12ScopeInTx:suppliedDeps.assertCurrentCase12ScopeInTx.bind(suppliedDeps),consumeNativeSetupAdmissionInTx:suppliedDeps.consumeNativeSetupAdmissionInTx.bind(suppliedDeps),inspectTerminalRowInTx:suppliedDeps.inspectTerminalRowInTx.bind(suppliedDeps)};
  const handles = new WeakMap<object, Handle>();

  async function withLockedBudget<T>(handle: Handle, work: (tx: Tx, fixture: Record<string, any>, stored: StoredBudget) => Promise<T>, expectedSlot?: unknown): Promise<T> {
    return deps.prisma.withTenantUser(handle.tenantId, handle.userId, async (tx) => {
      const rows = await tx.$queryRawUnsafe('SELECT settings_jsonb AS settings FROM tenants WHERE id=$1::uuid FOR UPDATE', handle.tenantId);
      const fixture = rows[0]?.settings?.meriFoundationFixture;
      if (rows.length !== 1 || !isRecord(fixture) || fixture.fixtureNamespace !== FIXTURE_NAMESPACE) fail('TENANT_FIXTURE_INVALID');
      const scope = await deps.assertCurrentCase12ScopeInTx(tx, handle.bindings);
      if (scope.tenantId !== handle.tenantId || scope.userId !== handle.userId || scope.clientId !== handle.plan.clientId) fail('CURRENT_SCOPE_CHANGED');
      const stored = parseStored(fixture[BUDGET_SLOT], handle.bindings);
      if (expectedSlot !== undefined && !reducerEqual(stored, expectedSlot)) fail('BUDGET_SLOT_CHANGED');
      if (!reducerEqual(stored.plan, handle.plan)) fail('DURABLE_PLAN_CHANGED');
      return work(tx, fixture, stored);
    });
  }
  async function updateBudgetSlot(tx: Tx, tenantId: string, nextStored: StoredBudget): Promise<void> {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,${BUDGET_SLOT}}',$1::jsonb,true)
       WHERE id=$2::uuid RETURNING id`,
      JSON.stringify(nextStored), tenantId);
    if (rows.length !== 1) fail('BUDGET_SLOT_WRITE_FAILED');
  }
  function getHandle(value: unknown): Handle {
    if (!value || typeof value !== 'object') fail('OPAQUE_HANDLE_REQUIRED');
    const handle = handles.get(value as object);
    if (!handle || handle.poisoned) fail('HANDLE_POISONED_OR_FOREIGN');
    return handle;
  }
  async function poison(handle: Handle): Promise<void> {
    handle.poisoned = true;
    try {
      await withLockedBudget(handle, async (tx, _fixture, stored) => {
        if(stored.state.reconciliationRequired)return;
        const state=readCase12SetupBudget(stored.state,stored.plan);state.reconciliationRequired=true;
        await updateBudgetSlot(tx,handle.tenantId,{...stored,state});
      });
    } catch { /* Best effort only; retain all acknowledged accounting and never expose raw errors. */ }
  }

  async function consumeCase12SetupSpendAuthority(
    tx: Tx,
    opaqueNativeAdmission: unknown,
    frozenBindingsInput: unknown,
  ): Promise<object> {
    const bindings = snapshotBindings(frozenBindingsInput);
    const rows = await tx.$queryRawUnsafe('SELECT settings_jsonb AS settings FROM tenants WHERE id=$1::uuid FOR UPDATE', TENANT_ID);
    const fixture = rows[0]?.settings?.meriFoundationFixture;
    if (rows.length !== 1 || !isRecord(fixture) || fixture.fixtureNamespace !== FIXTURE_NAMESPACE ||
        Object.hasOwn(fixture, BUDGET_SLOT)) fail('BUDGET_SLOT_ALREADY_PRESENT');
    const scope = await deps.assertCurrentCase12ScopeInTx(tx, bindings);
    if (scope.tenantId !== TENANT_ID || scope.userId !== bindings.recipe.ctx.userId ||
        scope.clientId !== bindings.plan.actorScope.clientId) fail('CURRENT_SCOPE_INVALID');
    const plan = validateAdmittedPlan(await deps.consumeNativeSetupAdmissionInTx(tx, opaqueNativeAdmission, bindings), bindings);
    const state = createCase12SetupBudget(plan);
    const initial: StoredBudget = { version: 1, plan, state, terminalProofs: [] };
    const changed = await tx.$queryRawUnsafe(
      `UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,${BUDGET_SLOT}}',$1::jsonb,true)
       WHERE id=$2::uuid AND NOT ((settings_jsonb->'meriFoundationFixture') ? '${BUDGET_SLOT}') RETURNING id`,
      JSON.stringify(initial), TENANT_ID);
    if (changed.length !== 1) fail('BUDGET_INITIAL_CAS_FAILED');
    const handle: Handle = { tenantId: TENANT_ID, userId: scope.userId, bindings, plan, poisoned: false, busy: false };
    const opaque = Object.freeze({});
    handles.set(opaque, handle);
    return opaque;
  }

  async function withCase12SetupRow<T>(opaque: unknown, descriptor: unknown, callback: () => Promise<T>): Promise<T> {
    const handle = getHandle(opaque);
    if (!isRecord(descriptor) || typeof callback !== 'function') fail('ROW_ARGUMENTS_INVALID');
    const index = descriptor.index;
    if (!Number.isSafeInteger(index) || index < 0 || index >= CASE12_SETUP_ROWS || handle.busy) fail('ROW_BUSY_OR_INVALID');
    const candidate = handle.bindings.ordered510Candidates[index]!;
    if (descriptor.logicalId !== logical(index) || !reducerEqual(descriptor.candidate, candidate)) fail('ROW_DESCRIPTOR_MISMATCH');
    handle.busy = true;
    try {
      const admittedRow = await withLockedBudget(handle, async (tx, fixture, stored) => {
        assertClaim(fixture[CLAIM_SLOT], index, handle.bindings, stored.plan);
        if (stored.state.nextRow !== index || stored.state.reconciliationRequired || stored.terminalProofs.length !== index) fail('ROW_ORDER_OR_RECONCILIATION');
        const clocks=await tx.$queryRawUnsafe('SELECT clock_timestamp() AS now');
        const current=clocks.length===1?new Date(clocks[0].now).getTime():NaN;
        if(!Number.isFinite(current)||current<Date.parse(handle.plan.admittedAt)||current>=Date.parse(handle.plan.deadlineAt))fail('ROW_WINDOW_CLOSED');
        return deepFreeze({ index, logicalId:logical(index), candidate, planRow:stored.plan.rows[index], admission:{fixtureInstanceId:handle.plan.fixtureInstanceId,proposerUserId:handle.plan.proposerUserId,reviewerUserId:handle.plan.reviewerUserId,clientId:handle.plan.clientId,admittedAt:handle.plan.admittedAt,deadlineAt:handle.plan.deadlineAt} });
      });
      const reservations = new Map<string, Case12SetupWireKind>();
      let uncertain = false;
      const providerOwner = {
        reserve: async (input: Case12SetupWireInput): Promise<{ reservationId: string }> => {
          if (uncertain || handle.poisoned) fail('RESERVATION_UNCERTAIN');
          let reservationId = '';
          try {
            await withLockedBudget(handle, async (tx, fixture, stored) => {
              assertClaim(fixture[CLAIM_SLOT], index, handle.bindings, stored.plan);
              if (uncertain || handle.poisoned || stored.state.nextRow !== index || stored.state.reconciliationRequired) fail('ROW_NOT_DISPATCHABLE');
              const clocks=await tx.$queryRawUnsafe('SELECT clock_timestamp() AS now');
              const now=clocks.length===1?new Date(clocks[0].now):new Date(NaN);
              if(!Number.isFinite(now.getTime()))fail('RESERVATION_DATABASE_CLOCK_INVALID');
              const result = reserveCase12SetupWire(stored.state, stored.plan, index, input, now);
              reservationId = result.reservationId;
              await updateBudgetSlot(tx, handle.tenantId, { ...stored, state: result.state });
            });
          } catch { await poison(handle); fail('RESERVATION_UNKNOWN'); }
          const acknowledgedAt=Date.now();
          if(acknowledgedAt<Date.parse(handle.plan.admittedAt)||acknowledgedAt>=Date.parse(handle.plan.deadlineAt)){
            await poison(handle);fail('RESERVATION_ACK_WINDOW_CLOSED');
          }
          reservations.set(reservationId, input.kind);
          return { reservationId };
        },
        settle: async (reservationId: string, outcome: Case12SetupOutcome): Promise<void> => {
          const kind = reservations.get(reservationId);
          if (!kind) fail('RESERVATION_NOT_OWNED');
          reservations.delete(reservationId); // Consume before awaiting durable settlement; no duplicate settle.
          if (outcome.kind === 'uncertain') uncertain = true;
          try {
            await withLockedBudget(handle, async (tx, fixture, stored) => {
              assertClaim(fixture[CLAIM_SLOT], index, handle.bindings, stored.plan);
              if (stored.state.nextRow !== index) fail('ROW_NO_LONGER_CURRENT');
              const attempt = stored.state.rows[index]?.attempts.find((entry) => entry.reservationId === reservationId);
              if (!attempt || attempt.kind !== kind) fail('RESERVATION_BINDING_MISMATCH');
              const state = settleCase12SetupWire(stored.state, stored.plan, index, kind, reservationId, outcome);
              await updateBudgetSlot(tx, handle.tenantId, { ...stored, state });
            });
          } catch { await poison(handle); fail('SETTLEMENT_UNKNOWN'); }
          if (outcome.kind === 'uncertain') {
            const next = readCase12SetupBudget((await withLockedBudget(handle, async (_tx, _fixture, stored) => stored)).state,
              handle.plan);
            if (next.nextRow !== index) await poison(handle);
          }
        },
      };
      const callbackResult = await withCase12SetupProviderScope(providerOwner, callback);
      if (handle.poisoned) fail('HANDLE_POISONED');
      const completionSnapshot = await withLockedBudget(handle, async (_tx, fixture, stored) => {
        assertClaim(fixture[CLAIM_SLOT], index, handle.bindings, stored.plan);
        if (stored.state.nextRow !== index || stored.state.reconciliationRequired) fail('ROW_COMPLETION_STALE');
        return structuredClone(stored);
      });
      await withLockedBudget(handle, async (tx, fixture, stored) => {
        if (!reducerEqual(stored, completionSnapshot)) fail('ROW_COMPLETION_CAS_CHANGED');
        assertClaim(fixture[CLAIM_SLOT], index, handle.bindings, stored.plan);
        if (reservations.size !== 0) fail('WIRE_ATTEMPTS_UNSETTLED');
        const returned = callbackResult;
        if (!isRecord(returned) || returned.candidateId !== candidate.physicalId || returned.tenantId !== candidate.tenantId ||
            returned.clientId !== candidate.clientPhysicalId || returned.candidatePayloadSha256 !== candidate.payloadSha256 ||
            returned.ownershipMarkerSha256 !== candidate.ownership.markerSha256 || returned.lifecycle !== 'approved') fail('RETURNED_BINDING_INVALID');
        const proof = await deps.inspectTerminalRowInTx(tx,
          { ...handle.bindings.recipe.ctx, clerkUserId: handle.bindings.recipe.clerkUserId }, admittedRow, returned);
        const childAttempts = stored.state.rows[index]?.attempts ?? [];
        if (childAttempts.length !== 2 || childAttempts.some((attempt) => attempt.status !== 'settled') ||
            new Set(childAttempts.map((attempt) => attempt.kind)).size !== 2 ||
            !isRecord(proof) || proof.kind!=='meri-case12-setup-terminal-row' || !hash(proof.proofSha256) ||
            proof.fixtureInstanceId!==handle.plan.fixtureInstanceId || proof.logicalId!==logical(index) || proof.candidateId!==candidate.physicalId || proof.itemId!==returned.physicalId ||
            proof.tenantId!==handle.tenantId || proof.clientId!==handle.plan.clientId || proof.proposerUserId!==handle.userId || proof.reviewerUserId!==handle.plan.reviewerUserId ||
            proof.captureAuthority!==false || proof.liveAcceptance!=='NOT_RUN' ||
            case12SetupHash(Object.fromEntries(Object.entries(proof).filter(([key])=>key!=='proofSha256')))!==proof.proofSha256 ||
            Buffer.byteLength(JSON.stringify(proof), 'utf8') > 4096) fail('TERMINAL_PROOF_INVALID');
        const completed = completeCase12SetupBudgetRow(stored.state, stored.plan, index);
        if (completed.nextRow !== index + 1) fail('ROW_COMPLETION_INVALID');
        const terminalProof = { row: index, proofSha256: proof.proofSha256, metadata: Object.fromEntries(Object.entries(proof).filter(([key])=>key!=='proofSha256')) };
        await updateBudgetSlot(tx, handle.tenantId, {
          ...stored, state: completed, terminalProofs: [...stored.terminalProofs, terminalProof],
        });
      });
      return callbackResult;
    } catch {
      await poison(handle);
      fail('ROW_RECONCILIATION_REQUIRED');
    } finally {
      handle.busy = false;
    }
  }

  return Object.freeze({ consumeCase12SetupSpendAuthority, withCase12SetupRow });
}

export type { Deps as Case12SetupBudgetOwnerDeps, TerminalProof as Case12SetupTerminalProof };
export const CASE12_SETUP_BUDGET_OWNER_QUALIFIED = false as const;
