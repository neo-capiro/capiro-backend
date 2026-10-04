import { buildFixtureManifest } from './manifest.mjs';
import {
  approvedMemoryDefinitions,
  createApprovedMemoryFixtureRuntime,
} from './approved-memory-runtime.mjs';
import { expectedMemoryCandidatePayload } from './memory-candidate-owner.mjs';
import { createCase12MemoryEligibilityOwner } from './case12-memory-eligibility-owner.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE, assertFixtureInstanceId } from './contract.mjs';
import { sha256Stable, stableJson } from '../lib/stable.mjs';

const fail = (code) => {
  throw new Error(`CASE12_SETUP_${code}`);
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[0-9a-f]{12}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const SLOT = 'case12MemorySetup';
const KEY_PATTERN =
  '^meri-foundation-20260928:([0-9a-f-]{36}:)?APPROVED-MA510(-DISTRACTOR-[0-9]{4})?$';
const MISSING = Object.freeze([
  'NATIVE_CASE12_SETUP_BUDGET_BINDING_OWNER_MISSING',
  'CASE12_PROJECTION_TERMINAL_PROOF_MISSING',
]);
const missing = () => [...MISSING];
const base = (status, extra = {}) => ({
  kind: 'meri-case12-memory-setup-result',
  schemaVersion: 1,
  caseId: '12',
  status,
  fixtureReady: false,
  captureAuthority: false,
  liveAcceptance: 'NOT_RUN',
  projectionStatus: 'CANONICAL_OUTBOX_RECORDED_NOT_QUALIFIED',
  missingPrerequisites: missing(),
  ...extra,
});
const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};
const keys = (value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort().join('|')
    : '';

/** Resolve only caller-supplied locators; source text, receipts, readiness, and code are forbidden. */
export async function resolveCase12SetupRecipe(input) {
  const value = structuredClone(input);
  if (
    !value ||
    keys(value) !==
      'actors|caseId|clerkUserId|clients|ctx|fixtureInstanceId|fixtureNamespace|reviewerUserId|schemaVersion|target' ||
    value.schemaVersion !== 1 ||
    value.target !== 'capiro-dev' ||
    value.caseId !== '12' ||
    value.fixtureNamespace !== FIXTURE_NAMESPACE ||
    process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== FIXTURE_NAMESPACE ||
    keys(value.ctx) !== 'role|tenantId|tenantSlug|userId' ||
    value.ctx.tenantId !== AUTHORIZED_TENANTS.T1.id ||
    value.ctx.tenantSlug !== AUTHORIZED_TENANTS.T1.slug ||
    value.ctx.role !== 'standard_user' ||
    !UUID.test(value.ctx.userId ?? '') ||
    !UUID.test(value.reviewerUserId ?? '') ||
    !UUID.test(value.fixtureInstanceId ?? '') ||
    value.ctx.userId === value.reviewerUserId ||
    typeof value.clerkUserId !== 'string' ||
    !/^user_[A-Za-z0-9_-]+$/u.test(value.clerkUserId) ||
    !value.actors ||
    !value.clients
  )
    fail('RECIPE_INVALID');
  // reviewerUserId is an explicit locator, never an authority token.
  // It is intentionally allowed in this recipe's exact top-level contract.
  if (
    keys(value) !==
    'actors|caseId|clerkUserId|clients|ctx|fixtureInstanceId|fixtureNamespace|reviewerUserId|schemaVersion|target'
  )
    fail('RECIPE_INVALID');
  assertFixtureInstanceId(value.fixtureInstanceId);
  const manifest = await buildFixtureManifest({
    fixtureInstanceId: value.fixtureInstanceId,
    actors: value.actors,
    clients: value.clients,
    uploaderActors: { T1: 'PAT' },
  });
  const pat = manifest.actors?.PAT,
    priya = manifest.actors?.PRIYA,
    client = manifest.clients?.ASTER;
  const patId = pat?.physicalId ?? pat?.userId,
    priyaId = priya?.physicalId ?? priya?.userId;
  if (
    !pat ||
    pat.tenantId !== 'T1' ||
    patId !== value.ctx.userId ||
    (pat.physicalId && pat.userId && pat.physicalId !== pat.userId) ||
    !priya ||
    priya.tenantId !== 'T1' ||
    priyaId !== value.reviewerUserId ||
    (priya.physicalId && priya.userId && priya.physicalId !== priya.userId) ||
    patId === priyaId ||
    !client ||
    client.tenantId !== 'T1' ||
    !UUID.test(client.physicalId ?? '') ||
    !manifest.clients?.BLUEHAVEN ||
    manifest.clients.BLUEHAVEN.tenantId !== 'T1' ||
    !UUID.test(manifest.clients.BLUEHAVEN.physicalId ?? '')
  )
    fail('ACTOR_CLIENT_LOCATOR_INVALID');
  const source = manifest.records.find((row) => row.logicalId === 'MA510');
  if (
    !source ||
    source.owner !== 'memory_item' ||
    source.clientPhysicalId !== client.physicalId ||
    source.tenantId !== AUTHORIZED_TENANTS.T1.id ||
    source.payload.facts.lifecycle !== 'approved'
  )
    fail('FIXED_SOURCE_INVALID');
  const definitions = approvedMemoryDefinitions(manifest, { distractorCount: 509 });
  const ids = definitions.map((row) => row.logicalId);
  if (
    definitions.length !== 510 ||
    ids[0] !== 'MA510' ||
    ids.slice(1).some((id, i) => id !== `MA510-DISTRACTOR-${String(i + 1).padStart(4, '0')}`) ||
    new Set(definitions.map((row) => row.candidate.physicalId)).size !== 510
  )
    fail('FIXED_510_DEFINITIONS_INVALID');
  return Object.freeze({
    input: deepFreeze(value),
    manifest: deepFreeze(manifest),
    definitions: deepFreeze(definitions),
  });
}

function runtimeFor(deps, spec) {
  return createApprovedMemoryFixtureRuntime({
    manifest: spec.manifest,
    distractorCount: 509,
    memoryCandidates: deps.memoryCandidates,
    memoryStore: deps.memoryStore,
    tenantContext: deps.tenantContext,
    prisma: deps.prisma,
    proposerForTenant: (tenantId) => {
      if (tenantId !== spec.input.ctx.tenantId) fail('FOREIGN_TENANT');
      return spec.input.ctx.userId;
    },
    reviewerForTenant: (tenantId) => {
      if (tenantId !== spec.input.ctx.tenantId) fail('FOREIGN_TENANT');
      return spec.input.reviewerUserId;
    },
    clientMemoryAllowed: deps.clientMemoryAllowed,
  });
}

async function currentScope(tx, deps, spec) {
  const { input, manifest } = spec,
    { ctx } = input;
  const tenants = await tx.$queryRawUnsafe(
    'SELECT id::text,slug,settings_jsonb AS settings,xmin::text AS version FROM tenants WHERE id=$1::uuid FOR UPDATE',
    ctx.tenantId,
  );
  const tenant = tenants[0],
    fixture = tenant?.settings?.meriFoundationFixture;
  if (
    tenants.length !== 1 ||
    tenant.slug !== ctx.tenantSlug ||
    fixture?.fixtureNamespace !== FIXTURE_NAMESPACE
  )
    fail('TENANT_INVALID');
  const users = await tx.$queryRawUnsafe(
    `SELECT u.id::text,u.clerk_user_id,u.email,u.first_name,u.last_name,tm.role
     FROM users u JOIN tenant_memberships tm ON tm.user_id=u.id
     WHERE tm.tenant_id=$1::uuid AND tm.user_id=ANY($2::uuid[]) AND tm.status='active'
     ORDER BY u.id FOR SHARE OF u,tm`,
    ctx.tenantId,
    [ctx.userId, input.reviewerUserId],
  );
  const reviewerClerk = manifest.actors.PRIYA.clerkUserId;
  const reviewerRow = users.find((row) => row.id === input.reviewerUserId);
  const validClerk = (id) => typeof id === 'string' && /^user_[A-Za-z0-9_-]+$/u.test(id);
  if (
    (reviewerClerk !== undefined &&
      (!validClerk(reviewerClerk) || reviewerRow?.clerk_user_id !== reviewerClerk)) ||
    users.some((row) => !validClerk(row.clerk_user_id))
  )
    fail('CLERK_BINDING_INVALID');
  if (
    users.length !== 2 ||
    users.some(
      (row) =>
        typeof row.email !== 'string' ||
        !row.email.toLowerCase().includes(FIXTURE_NAMESPACE) ||
        !row.email.toLowerCase().endsWith('@example.com') ||
        !/synthetic/iu.test(`${row.first_name ?? ''} ${row.last_name ?? ''}`),
    ) ||
    users.find((row) => row.id === ctx.userId)?.role !== 'standard_user' ||
    users.find((row) => row.id === input.reviewerUserId)?.role !== 'user_admin' ||
    users.find((row) => row.id === ctx.userId)?.clerk_user_id !== input.clerkUserId
  )
    fail('ACTORS_INVALID');
  const manifestPat = manifest.actors.PAT,
    manifestPriya = manifest.actors.PRIYA;
  if (
    (manifestPat.physicalId ?? manifestPat.userId) !== ctx.userId ||
    (manifestPriya.physicalId ?? manifestPriya.userId) !== input.reviewerUserId
  )
    fail('ACTOR_MANIFEST_MISMATCH');
  const clientId = manifest.clients.ASTER.physicalId;
  const clients = await tx.$queryRawUnsafe(
    'SELECT id::text,status,memory_wall FROM clients WHERE id=$1::uuid AND tenant_id=$2::uuid FOR SHARE',
    clientId,
    ctx.tenantId,
  );
  if (
    clients.length !== 1 ||
    clients[0].status === 'archived' ||
    !(await deps.clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId))
  )
    fail('CLIENT_SCOPE_INVALID');
  const reviewer = { tenantId: ctx.tenantId, userId: input.reviewerUserId, role: 'user_admin' };
  if (typeof deps.memoryAuthorization?.evaluateInTx !== 'function')
    fail('CANONICAL_AUTHORIZATION_REQUIRED');
  const first = spec.definitions[0].candidate;
  const subject = {
    id: first.physicalId,
    tenantId: ctx.tenantId,
    clientId,
    ownerUserId: ctx.userId,
    proposedByUserId: ctx.userId,
    memoryClass: 'client_steering',
    scope: 'client',
    status: 'pending_review',
    legalHold: false,
    clientStatus: clients[0].status,
  };
  for (const operation of ['approve']) {
    const decision = await deps.memoryAuthorization.evaluateInTx(
      tx,
      reviewer,
      { ...subject, status: operation === 'approve' ? 'pending_review' : 'active' },
      operation,
      { emitDenialMetrics: false },
    );
    if (decision?.allowed !== true) fail('REVIEWER_AUTHORITY_REQUIRED');
  }
  return { tenant, fixture, reviewer, clientId };
}

function candidateKeys(spec) {
  return spec.definitions.map(({ candidate }) =>
    expectedMemoryCandidatePayload(
      candidate,
      spec.input.ctx.userId,
      stableJson({ ownership: candidate.ownership, payload: candidate.payload }),
    ),
  );
}

async function assertFirstLiveCorpusEmpty(tx, spec) {
  const records = spec.definitions.map((row) => row.candidate),
    ids = records.map((r) => r.physicalId);
  const markers = records.map((r) => r.ownership.markerSha256),
    payloads = candidateKeys(spec),
    keys = payloads.map((p) => p.key);
  const candidates = await tx.$queryRawUnsafe(
    `SELECT id::text,source_id,payload_jsonb->>'key' AS key
     FROM memory_candidate WHERE tenant_id=$1::uuid AND
       (payload_jsonb->>'key' ~ $2 OR id=ANY($3::uuid[]) OR source_id=ANY($4::text[]) OR payload_jsonb->>'key'=ANY($5::text[]))
     ORDER BY id FOR UPDATE`,
    spec.input.ctx.tenantId,
    KEY_PATTERN,
    ids,
    markers,
    keys,
  );
  const legacy = await tx.$queryRawUnsafe(
    `SELECT id::text,key FROM clio_memory WHERE tenant_id=$1::uuid AND
       (key ~ $2 OR key=ANY($3::text[])) ORDER BY id FOR UPDATE`,
    spec.input.ctx.tenantId,
    KEY_PATTERN,
    keys,
  );
  const items = await tx.$queryRawUnsafe(
    `SELECT id::text,title,source_id FROM memory_items WHERE tenant_id=$1::uuid AND
       (title ~ $2 OR title=ANY($3::text[]) OR source_id=ANY($4::text[])) ORDER BY id FOR UPDATE`,
    spec.input.ctx.tenantId,
    KEY_PATTERN,
    keys,
    [...ids, ...markers],
  );
  if (candidates.length || legacy.length || items.length) fail('CURRENT_NAMESPACE_CORPUS_EXISTS');
}

async function inspectCurrent(deps, spec) {
  return deps.prisma.withTenantUser(spec.input.ctx.tenantId, spec.input.ctx.userId, async (tx) => {
    const scope = await currentScope(tx, deps, spec);
    if (Object.hasOwn(scope.fixture, SLOT)) fail('EXISTING_CLAIM_REQUIRES_RECONCILIATION');
    await assertFirstLiveCorpusEmpty(tx, spec);
    const body = {
      kind: 'meri-case12-memory-setup-plan',
      schemaVersion: 1,
      recipeSha256: sha256Stable(spec.input),
      manifestContentSha256: spec.manifest.contentSha256,
      orderedDefinitionSha256: sha256Stable(spec.definitions.map((d) => d.candidate)),
      exactCanonicalDefinitionCount: 510,
      firstLogicalId: 'MA510',
      tenantId: spec.input.ctx.tenantId,
      tenantRowVersion: scope.tenant.version,
      priorSettingsSha256: sha256Stable(scope.tenant.settings),
      fixtureNamespace: FIXTURE_NAMESPACE,
      fixtureInstanceId: spec.input.fixtureInstanceId,
      actorScope: {
        proposerUserId: spec.input.ctx.userId,
        proposerRole: 'standard_user',
        clerkUserId: spec.input.clerkUserId,
        reviewerUserId: spec.input.reviewerUserId,
        reviewerRole: scope.reviewer.role,
        clientId: scope.clientId,
      },
      fixtureReady: false,
      captureAuthority: false,
      liveAcceptance: 'NOT_RUN',
    };
    return { ...body, planSha256: sha256Stable(body) };
  });
}

export async function inspectCase12Setup(deps, input) {
  const spec = await resolveCase12SetupRecipe(input);
  const plan = await inspectCurrent(deps, spec);
  return base('PLAN_ONLY', { plan, exactCanonicalDefinitionCount: 510 });
}

async function readClaim(deps, spec) {
  return deps.prisma.withTenantUser(spec.input.ctx.tenantId, spec.input.ctx.userId, async (tx) => {
    const scope = await currentScope(tx, deps, spec);
    return { ...scope, operation: scope.fixture?.[SLOT] ?? null };
  });
}

async function persistOperation(deps, spec, oldOperation, nextOperation) {
  return deps.prisma.withTenantUser(spec.input.ctx.tenantId, spec.input.ctx.userId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      'SELECT settings_jsonb AS settings,xmin::text AS version FROM tenants WHERE id=$1::uuid FOR UPDATE',
      spec.input.ctx.tenantId,
    );
    if (rows.length !== 1) fail('TENANT_MISSING');
    const settings = rows[0].settings,
      fixture = settings?.meriFoundationFixture;
    if (!fixture || sha256Stable(fixture[SLOT] ?? null) !== sha256Stable(oldOperation))
      fail('CLAIM_CAS_MISMATCH');
    const changed = await tx.$queryRawUnsafe(
      `UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,case12MemorySetup}',$1::jsonb,true)
       WHERE id=$2::uuid
         AND settings_jsonb#>'{meriFoundationFixture,case12MemorySetup}'=$3::jsonb RETURNING xmin::text AS version`,
      stableJson(nextOperation),
      spec.input.ctx.tenantId,
      stableJson(oldOperation),
    );
    if (changed.length !== 1) fail('CLAIM_CAS_FAILED');
    return changed[0].version;
  });
}

function safeFailure(stage, error) {
  const known = new Set([
    'FixtureProvisioningError',
    'PrismaClientKnownRequestError',
    'PrismaClientUnknownRequestError',
    'PrismaClientInitializationError',
    'PrismaClientValidationError',
    'ForbiddenException',
    'ConflictException',
    'Error',
  ]);
  return {
    stage,
    errorClass: known.has(error?.constructor?.name) ? error.constructor.name : 'UnknownError',
    code: /^CASE12_SETUP_[A-Z0-9_]+$/u.test(error?.message ?? '') ? error.message : null,
  };
}

export async function executeCase12Setup(
  deps,
  input,
  { expectedPlanSha256, journal, setupSpendAuthority } = {},
) {
  // Hard stop before any metadata or canonical write. A JSON receipt or ready flag is never a substitute.
  if (typeof deps?.consumeCase12SetupSpendAuthority !== 'function')
    fail('NATIVE_BUDGET_AUTHORITY_MISSING');
  if (typeof deps?.withCase12SetupRow !== 'function') fail('NATIVE_ROW_BUDGET_SCOPE_MISSING');
  if (typeof journal !== 'function' || !HASH.test(expectedPlanSha256 ?? ''))
    fail('PLAN_AND_JOURNAL_REQUIRED');
  const spec = await resolveCase12SetupRecipe(input),
    definitions = spec.definitions.map((row) => row.candidate);
  const runtime = runtimeFor(deps, spec);
  const plan = await inspectCurrent(deps, spec);
  if (plan.planSha256 !== expectedPlanSha256) fail('STALE_PLAN');
  let operation = {
    kind: 'meri-case12-memory-setup-claim',
    schemaVersion: 1,
    status: 'STARTED',
    recipeSha256: plan.recipeSha256,
    manifestContentSha256: plan.manifestContentSha256,
    orderedDefinitionSha256: plan.orderedDefinitionSha256,
    planSha256: plan.planSha256,
    plan,
    fixtureInstanceId: spec.input.fixtureInstanceId,
    locator: spec.input,
    claimIdentitySha256: sha256Stable({
      planSha256: plan.planSha256,
      recipeSha256: plan.recipeSha256,
    }),
    progress: [],
    liveAcceptance: 'NOT_RUN',
  };
  let admitted,
    setupRunAuthority,
    claimDispatched = false,
    claimAcknowledged = false;
  try {
    await journal({ stage: 'CLAIM', phase: 'INTENT', planSha256: plan.planSha256 });
    claimDispatched = true;
    admitted = await deps.prisma.withTenantUser(
      spec.input.ctx.tenantId,
      spec.input.ctx.userId,
      async (tx) => {
        const scope = await currentScope(tx, deps, spec);
        await assertFirstLiveCorpusEmpty(tx, spec);
        // Re-read plan pins, including xmin/settings, under the transaction immediately before claim.
        if (
          scope.tenant.version !== plan.tenantRowVersion ||
          sha256Stable(scope.tenant.settings) !== plan.priorSettingsSha256
        )
          fail('STALE_PLAN');
        if (Object.hasOwn(scope.fixture, SLOT)) fail('EXISTING_CLAIM_REQUIRES_RECONCILIATION');
        const budgetBinding = deepFreeze({
          recipe: spec.input,
          plan,
          ordered510Candidates: definitions,
        });
        // This future source-owned dependency must validate and consume the opaque authority.
        // Opaque native handle remains only in this closure. It is never hashed or persisted.
        setupRunAuthority = await deps.consumeCase12SetupSpendAuthority(
          tx,
          setupSpendAuthority,
          budgetBinding,
        );
        // The row lock protected fresh-plan validation before consumption. Native
        // admission may update its own budget slot in this same transaction. Preserve
        // that current settings value; CAS only this still-absent Case12 claim slot.
        const changed = await tx.$queryRawUnsafe(
          `UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,case12MemorySetup}',$1::jsonb,true)
       WHERE id=$2::uuid
         AND NOT (settings_jsonb->'meriFoundationFixture' ? 'case12MemorySetup') RETURNING xmin::text AS version`,
          stableJson(operation),
          spec.input.ctx.tenantId,
        );
        if (changed.length !== 1) fail('CLAIM_CAS_FAILED');
        return changed[0].version;
      },
    );
    claimAcknowledged = true;
    await journal({
      stage: 'CLAIM',
      phase: 'VERIFIED',
      planSha256: plan.planSha256,
      claimRowVersion: admitted,
    });
    for (let index = 0; index < definitions.length; index++) {
      const candidate = definitions[index];
      const intent = {
        index,
        logicalId: index === 0 ? 'MA510' : `MA510-DISTRACTOR-${String(index).padStart(4, '0')}`,
        candidateId: candidate.physicalId,
        phase: 'INTENT',
      };
      const next = { ...operation, progress: [...operation.progress, intent] };
      await persistOperation(deps, spec, operation, next);
      operation = next;
      await journal({ stage: 'CREATE', ...intent });
      const binding = await deps.withCase12SetupRow(
        setupRunAuthority,
        Object.freeze({ index, logicalId: intent.logicalId, candidate }),
        () => runtime.create(intent.logicalId),
      );
      if (
        !binding ||
        binding.candidateId !== candidate.physicalId ||
        binding.ownershipMarkerSha256 !== candidate.ownership.markerSha256 ||
        binding.candidatePayloadSha256 !== candidate.payloadSha256 ||
        binding.tenantId !== candidate.tenantId ||
        binding.clientId !== candidate.clientPhysicalId ||
        binding.lifecycle !== 'approved'
      )
        fail('CANONICAL_BINDING_MISMATCH');
      const verified = {
        ...intent,
        phase: 'VERIFIED',
        bindingSha256: sha256Stable(binding),
        binding,
      };
      const nextVerified = {
        ...operation,
        progress: [...operation.progress.slice(0, -1), verified],
      };
      await persistOperation(deps, spec, operation, nextVerified);
      operation = nextVerified;
      await journal({ stage: 'CREATE', ...verified, binding: undefined });
    }
    const complete = {
      ...operation,
      status: 'SETUP_COMPLETE',
      progressSha256: sha256Stable(operation.progress),
    };
    await persistOperation(deps, spec, operation, complete);
    operation = complete;
    return base('SETUP_COMPLETE', {
      exactCanonicalDefinitionCount: 510,
      planSha256: plan.planSha256,
      claimSha256: sha256Stable(operation),
      boundedProgress: operation.progress.map(({ index, logicalId, phase }) => ({
        index,
        logicalId,
        phase,
      })),
      reconciliationRequired: false,
    });
  } catch (error) {
    const failure = safeFailure(
      claimAcknowledged ? 'CANONICAL_CREATE_OR_PROGRESS' : 'CLAIM_OR_BUDGET_CONSUMPTION',
      error,
    );
    if (claimAcknowledged)
      try {
        const marked = { ...operation, status: 'RECONCILIATION_REQUIRED', failure };
        await persistOperation(deps, spec, operation, marked);
        operation = marked;
      } catch {
        /* The last durable INTENT/claim remains non-replayable. */
      }
    try {
      await journal({ stage: failure.stage, phase: 'RECONCILIATION_REQUIRED', failure });
    } catch {
      /* claim remains durable */
    }
    return base('RECONCILIATION_REQUIRED', {
      planSha256: plan.planSha256,
      lastAcknowledgedClaimSha256: claimAcknowledged ? sha256Stable(operation) : null,
      claimPersistence: claimAcknowledged
        ? 'ACKNOWLEDGED_CLAIM_RETAINED'
        : claimDispatched
          ? 'UNKNOWN_MAY_HAVE_COMMITTED'
          : 'NOT_DISPATCHED',
      returnedProgressIsLastAcknowledged: true,
      reconciliationRequired: true,
      boundedProgress: operation.progress.map(({ index, logicalId, phase }) => ({
        index,
        logicalId,
        phase,
      })),
      failure,
    });
  }
}

/** Current-only hydration: saved locator/progress is metadata, never seed authority. */
export async function readCase12Setup(deps, input) {
  const spec = await resolveCase12SetupRecipe(input),
    row = await readClaim(deps, spec),
    operation = row.operation;
  const definitionHash = sha256Stable(spec.definitions.map((d) => d.candidate));
  const savedPlan = operation?.plan;
  const { planSha256: savedPlanHash, ...savedPlanBody } = savedPlan ?? {};
  const identityOk =
    operation &&
    operation.kind === 'meri-case12-memory-setup-claim' &&
    operation.schemaVersion === 1 &&
    ['STARTED', 'SETUP_COMPLETE', 'RECONCILIATION_REQUIRED'].includes(operation.status) &&
    operation.liveAcceptance === 'NOT_RUN' &&
    operation.recipeSha256 === sha256Stable(spec.input) &&
    operation.manifestContentSha256 === spec.manifest.contentSha256 &&
    operation.orderedDefinitionSha256 === definitionHash &&
    savedPlanHash === operation.planSha256 &&
    sha256Stable(savedPlanBody) === savedPlanHash &&
    savedPlanBody.recipeSha256 === operation.recipeSha256 &&
    savedPlanBody.manifestContentSha256 === spec.manifest.contentSha256 &&
    savedPlanBody.orderedDefinitionSha256 === definitionHash &&
    savedPlanBody.exactCanonicalDefinitionCount === 510 &&
    savedPlanBody.fixtureInstanceId === spec.input.fixtureInstanceId &&
    operation.fixtureInstanceId === spec.input.fixtureInstanceId &&
    operation.locator &&
    sha256Stable(operation.locator) === sha256Stable(spec.input) &&
    operation.planSha256 &&
    HASH.test(operation.planSha256) &&
    operation.claimIdentitySha256 ===
      sha256Stable({ planSha256: operation.planSha256, recipeSha256: operation.recipeSha256 }) &&
    Array.isArray(operation.progress) &&
    operation.progress.length <= 510 &&
    operation.progress.every((step, index) => {
      const definition = spec.definitions[index],
        candidate = definition?.candidate;
      const logicalId =
        index === 0 ? 'MA510' : `MA510-DISTRACTOR-${String(index).padStart(4, '0')}`;
      return (
        step?.index === index &&
        step.logicalId === logicalId &&
        step.candidateId === candidate?.physicalId &&
        ['INTENT', 'VERIFIED'].includes(step.phase) &&
        (step.phase !== 'INTENT' || index === operation.progress.length - 1) &&
        (step.phase !== 'VERIFIED' ||
          (step.binding?.candidateId === candidate.physicalId &&
            step.binding?.ownershipMarkerSha256 === candidate.ownership.markerSha256 &&
            step.binding?.candidatePayloadSha256 === candidate.payloadSha256 &&
            step.binding?.logicalId === logicalId &&
            step.binding?.supporting === definition.supporting &&
            step.binding?.owner === 'memory_item' &&
            step.binding?.tenantId === candidate.tenantId &&
            step.binding?.clientId === candidate.clientPhysicalId &&
            step.binding?.proposedItemId === definition.proposedItemId &&
            step.binding?.lifecycle === 'approved' &&
            UUID.test(step.binding?.physicalId ?? '') &&
            step.bindingSha256 === sha256Stable(step.binding)))
      );
    }) &&
    (operation.status !== 'SETUP_COMPLETE' ||
      (operation.progress.length === 510 &&
        operation.progress.every((step) => step.phase === 'VERIFIED') &&
        operation.progressSha256 === sha256Stable(operation.progress)));
  if (!identityOk)
    return base('RECONCILIATION_REQUIRED', {
      reconciliationRequired: true,
      boundedProgress: [],
      blocker: 'STORED_LOCATOR_OR_PROGRESS_INVALID',
    });
  const runtime = runtimeFor(deps, spec),
    bindings = [],
    observed = [];
  let reconciliationRequired =
    operation.status !== 'SETUP_COMPLETE' ||
    operation.progress.length !== 510 ||
    operation.progress.some((step) => step.phase !== 'VERIFIED');
  try {
    for (let index = 0; index < spec.definitions.length; index++) {
      const definition = spec.definitions[index],
        candidate = definition.candidate;
      const actual = await runtime.inspect(definition.logicalId);
      if (
        !actual ||
        actual.candidateId !== candidate.physicalId ||
        actual.ownershipMarkerSha256 !== candidate.ownership.markerSha256 ||
        actual.candidatePayloadSha256 !== candidate.payloadSha256 ||
        actual.tenantId !== spec.input.ctx.tenantId ||
        actual.clientId !== candidate.clientPhysicalId ||
        actual.lifecycle !== 'approved' ||
        !UUID.test(actual.physicalId ?? '')
      ) {
        reconciliationRequired = true;
        break;
      }
      observed.push({
        logicalId: definition.logicalId,
        candidateId: candidate.physicalId,
        itemId: actual.physicalId,
        runtimeBindingSha256: sha256Stable(actual),
      });
      const saved = operation.progress[index];
      if (saved?.phase === 'VERIFIED' && saved.binding.physicalId !== actual.physicalId)
        fail('SAVED_BINDING_ID_CHANGED');
    }
    if (observed.length !== 510)
      return base('RECONCILIATION_REQUIRED', {
        reconciliationRequired: true,
        boundedProgress: observed.slice(0, 510).map(({ logicalId }) => logicalId),
        blocker: 'CURRENT_CANONICAL_RUNTIME_READBACK_INCOMPLETE',
      });
    await deps.prisma
      .withTenantUser(spec.input.ctx.tenantId, spec.input.ctx.userId, async (tx) => {
        const scope = await currentScope(tx, deps, spec),
          byCandidate = new Map(observed.map((row) => [row.candidateId, row]));
        if (sha256Stable(scope.fixture[SLOT] ?? null) !== sha256Stable(operation))
          fail('CLAIM_CHANGED_DURING_HYDRATION');
        let bulkCanonical = null;
        if (typeof deps.assertSyntheticApprovedMemorySetInTx === 'function') {
          if (typeof deps.memoryAuthorization.readCase12ItemsWithDecisionsInTx !== 'function') fail('NATIVE_SET_PORTS_INCOMPLETE');
          const rows = await tx.$queryRawUnsafe(`SELECT c.id::text AS candidate_id,c.source_id,c.payload_jsonb->>'key' AS key,c.proposed_by::text AS proposer,
             c.client_id::text AS client_id,c.status,c.approved_by_user_id::text AS reviewer,
             c.committed_memory_item_id::text AS item_id,c.xmin::text AS candidate_version,
             m.id::text AS actual_item_id,m.tenant_id::text AS tenant_id,m.client_id::text AS item_client_id,
             m.xmin::text AS item_version,m.status AS item_status,m.source_version,m.source_content_hash
           FROM memory_candidate c JOIN memory_items m ON m.tenant_id=c.tenant_id AND m.id=c.committed_memory_item_id
           WHERE c.tenant_id=$1::uuid AND c.id=ANY($2::uuid[]) FOR UPDATE OF c,m`,
            spec.input.ctx.tenantId,spec.definitions.map(x=>x.candidate.physicalId));
          bulkCanonical = new Map(rows.map(row=>[row.candidate_id,row]));
          if (rows.length !== 510 || bulkCanonical.size !== 510 ||
              spec.definitions.some(x=>!bulkCanonical.has(x.candidate.physicalId))) fail('CURRENT_SOURCE_ROW_MISSING');
        }
        for (const definition of spec.definitions) {
          const candidate = definition.candidate,
            proof = byCandidate.get(candidate.physicalId);
          const rows = bulkCanonical ? [bulkCanonical.get(candidate.physicalId)] : await tx.$queryRawUnsafe(
            `SELECT c.id::text AS candidate_id,c.source_id,c.payload_jsonb->>'key' AS key,c.proposed_by::text AS proposer,
             c.client_id::text AS client_id,c.status,c.approved_by_user_id::text AS reviewer,
             c.committed_memory_item_id::text AS item_id,c.xmin::text AS candidate_version,
             m.id::text AS actual_item_id,m.tenant_id::text AS tenant_id,m.client_id::text AS item_client_id,
             m.xmin::text AS item_version,m.status AS item_status,m.source_version,m.source_content_hash
           FROM memory_candidate c JOIN memory_items m ON m.tenant_id=c.tenant_id AND m.id=c.committed_memory_item_id
           WHERE c.tenant_id=$1::uuid AND c.id=$2::uuid FOR UPDATE OF c,m`,
            spec.input.ctx.tenantId,
            candidate.physicalId,
          );
          if (rows.length !== 1) fail('CURRENT_SOURCE_ROW_MISSING');
          const current = rows[0],
            payload = expectedMemoryCandidatePayload(
              candidate,
              spec.input.ctx.userId,
              stableJson({ ownership: candidate.ownership, payload: candidate.payload }),
            );
          if (
            current.candidate_id !== candidate.physicalId ||
            current.source_id !== candidate.ownership.markerSha256 ||
            current.key !== payload.key ||
            current.proposer !== spec.input.ctx.userId ||
            current.client_id !== scope.clientId ||
            current.status !== 'approved' ||
            current.reviewer !== spec.input.reviewerUserId ||
            current.item_id !== proof.itemId ||
            current.actual_item_id !== proof.itemId ||
            current.tenant_id !== spec.input.ctx.tenantId ||
            current.item_client_id !== scope.clientId ||
            current.item_status !== 'active' ||
            current.source_version !== `candidate:${candidate.physicalId}` ||
            !HASH.test(current.source_content_hash ?? '') ||
            !/^[0-9]{1,10}$/u.test(current.candidate_version) ||
            !/^[0-9]{1,10}$/u.test(current.item_version)
          )
            fail('CURRENT_BINDING_INVALID');
          const binding = {
            logicalId: definition.logicalId,
            supporting: definition.supporting,
            owner: 'memory_item',
            tenantId: candidate.tenantId,
            clientId: candidate.clientPhysicalId,
            physicalId: current.item_id,
            proposedItemId: definition.proposedItemId,
            candidateId: candidate.physicalId,
            ownershipMarkerSha256: candidate.ownership.markerSha256,
            candidatePayloadSha256: candidate.payloadSha256,
            candidateRowVersion: current.candidate_version,
            itemRowVersion: current.item_version,
            lifecycle: 'approved',
          };
          bindings.push(binding);
        }
        if (bindings.length !== 510 || bindings[0].logicalId !== 'MA510')
          fail('CURRENT_510_BINDINGS_INVALID');
        const seedInventory = {
          kind: 'meri-approved-memory-local-bindings',
          fixtureMapSha256: spec.manifest.contentSha256,
          bindings,
          bindingsSha256: sha256Stable(bindings),
          liveAcceptance: 'NOT_RUN',
        };
        const eligibility = createCase12MemoryEligibilityOwner({
          manifest: spec.manifest,
          seedInventory,
          proposerForTenant: (id) =>
            id === spec.input.ctx.tenantId ? spec.input.ctx.userId : fail('FOREIGN_TENANT'),
          assertSyntheticApprovedMemoryInTx: deps.assertSyntheticApprovedMemoryInTx,
          assertSyntheticApprovedMemorySetInTx: deps.assertSyntheticApprovedMemorySetInTx,
          memoryAuthorization: deps.memoryAuthorization,
          readCase12CanonicalEligibilityInTx: deps.readCase12CanonicalEligibilityInTx,
        });
        const currentInventory = await eligibility.inspectInTx(tx, spec.input.ctx, {
          caseId: '12',
          clientId: scope.clientId,
        });
        if (
          currentInventory.inventoryVerified !== true ||
          currentInventory.observations?.length !== 510
        )
          fail('CURRENT_INVENTORY_NOT_VERIFIED');
        return currentInventory;
      })
      .then((currentInventory) => {
        observed.currentInventory = currentInventory;
      });
  } catch (error) {
    return base('RECONCILIATION_REQUIRED', {
      reconciliationRequired: true,
      boundedProgress: observed.slice(0, 510).map(({ logicalId }) => logicalId),
      failure: safeFailure('READ_ONLY_HYDRATION', error),
    });
  }
  const inventory = observed.currentInventory;
  return base(reconciliationRequired ? 'RECONCILIATION_REQUIRED' : 'CURRENT_HYDRATED', {
    reconciliationRequired,
    exactCanonicalDefinitionCount: 510,
    boundedProgress: operation.progress
      .slice(0, 510)
      .map(({ index, logicalId, phase }) => ({ index, logicalId, phase })),
    currentInventory: inventory,
    currentInventorySha256: sha256Stable(inventory),
  });
}

// This proposal contains no factory, route, CLI, budget owner, projection worker, or live authority.
// Any injected/mock spend callback only tests sequencing; it is not native budget authorization.
// Approved-memory creation can invoke embeddings; no provider-free claim is made here.

/** Private current-scope composition. Resolves fixed source once; no capture or
 * spend capability is produced. Dependencies are captured before any callback. */
export async function createCase12SetupCurrentScopeInspector(deps, recipe) {
  if (typeof deps?.clientMemoryAllowed !== 'function' ||
      typeof deps?.memoryAuthorization?.evaluateInTx !== 'function')
    fail('SCOPE_INSPECTOR_NATIVE_DEPENDENCIES_REQUIRED');
  const boundDeps = Object.freeze({
    clientMemoryAllowed: deps.clientMemoryAllowed.bind(deps),
    memoryAuthorization: Object.freeze({
      evaluateInTx: deps.memoryAuthorization.evaluateInTx.bind(deps.memoryAuthorization),
    }),
  });
  const spec = await resolveCase12SetupRecipe(recipe);
  const recipeSha256 = sha256Stable(spec.input);
  const definitionsSha256 = sha256Stable(spec.definitions.map(({candidate}) => candidate));
  return Object.freeze({
    async assertInTx(tx, frozenBindings) {
      if (typeof tx?.$queryRawUnsafe !== 'function' ||
          keys(frozenBindings) !== 'ordered510Candidates|plan|recipe' ||
          keys(frozenBindings.recipe) !== keys(spec.input) ||
          sha256Stable(frozenBindings.recipe) !== recipeSha256 ||
          !Array.isArray(frozenBindings.ordered510Candidates) ||
          frozenBindings.ordered510Candidates.length !== 510 ||
          sha256Stable(frozenBindings.ordered510Candidates) !== definitionsSha256)
        fail('SCOPE_INSPECTOR_BINDINGS_INVALID');
      const plan = frozenBindings.plan;
      if (plan?.kind !== 'meri-case12-memory-setup-plan' || plan.schemaVersion !== 1 ||
          plan.recipeSha256 !== recipeSha256 ||
          plan.manifestContentSha256 !== spec.manifest.contentSha256 ||
          plan.orderedDefinitionSha256 !== definitionsSha256 ||
          plan.fixtureInstanceId !== spec.input.fixtureInstanceId ||
          typeof plan.planSha256 !== 'string' ||
          plan.planSha256 !== sha256Stable(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planSha256'))))
        fail('SCOPE_INSPECTOR_PLAN_INVALID');
      const scope = await currentScope(tx, boundDeps, spec);
      return Object.freeze({tenantId:spec.input.ctx.tenantId,userId:spec.input.ctx.userId,clientId:scope.clientId});
    },
  });
}
