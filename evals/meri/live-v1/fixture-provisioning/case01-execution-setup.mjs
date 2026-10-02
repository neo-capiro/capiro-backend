import { lifecycleSeedMemoryDefinitions, selectedApprovedMemoryDefinitions } from './approved-memory-runtime.mjs';
import { expectedMemoryCandidatePayload } from './memory-candidate-owner.mjs';
import { buildFixtureManifest } from './manifest.mjs';
import { createCase01MemoryFixtureRuntime } from './case01-memory-runtime.mjs';
import { createCaptureBindingOwner } from './capture-binding-owner.mjs';
import {
  createHydratedCase01MemoryOwner,
  case01MemoryOwnerLocator,
} from './case01-memory-owner.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE, assertFixtureInstanceId } from './contract.mjs';
import { sha256Stable, stableJson } from '../artifact-collector.mjs';

const fail = (code) => {
  throw new Error(`CASE01_SETUP_${code}`);
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

async function recipe(input) {
  const value = structuredClone(input);
  const tenant = AUTHORIZED_TENANTS.T1;
  if (
    value?.schemaVersion !== 1 ||
    value.target !== 'capiro-dev' ||
    value.fixtureNamespace !== FIXTURE_NAMESPACE ||
    process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== FIXTURE_NAMESPACE ||
    value.ctx?.tenantId !== tenant.id ||
    value.ctx.tenantSlug !== tenant.slug ||
    value.ctx.role !== 'standard_user' ||
    !uuid.test(value.ctx.userId ?? '') ||
    !uuid.test(value.reviewerUserId ?? '') ||
    value.ctx.userId === value.reviewerUserId ||
    !uuid.test(value.captureRunId ?? '') ||
    typeof value.clerkUserId !== 'string' ||
    !value.clerkUserId ||
    !value.previousFixtureInstanceId ||
    !value.currentFixtureInstanceId ||
    value.previousFixtureInstanceId === value.currentFixtureInstanceId
  )
    fail('SCOPE_INVALID');
  assertFixtureInstanceId(value.previousFixtureInstanceId);
  assertFixtureInstanceId(value.currentFixtureInstanceId);
  // Callers provide locators, never source text, receipts, readiness, or executable modules.
  if (
    Object.keys(value).some(
      (key) =>
        ![
          'schemaVersion',
          'target',
          'fixtureNamespace',
          'ctx',
          'clerkUserId',
          'reviewerUserId',
          'captureRunId',
          'previousFixtureInstanceId',
          'currentFixtureInstanceId',
          'clients',
          'actors',
        ].includes(key),
    )
  )
    fail('RECIPE_FIELD_INVALID');
  if (Object.keys(value.ctx).sort().join('|') !== 'role|tenantId|tenantSlug|userId')
    fail('ACTOR_FIELDS_INVALID');
  const config = { clients: value.clients, actors: value.actors, uploaderActors: { T1: 'PAT' } };
  const previous = await buildFixtureManifest({
    ...config,
    fixtureInstanceId: value.previousFixtureInstanceId,
  });
  const current = await buildFixtureManifest({
    ...config,
    fixtureInstanceId: value.currentFixtureInstanceId,
  });
  if (
    current.actors?.PAT?.physicalId !== value.ctx.userId ||
    current.actors?.PRIYA?.physicalId !== value.reviewerUserId ||
    ['ASTER', 'BLUEHAVEN'].some(
      (key) =>
        current.clients?.[key]?.tenantId !== 'T1' || !uuid.test(current.clients[key].physicalId),
    )
  )
    fail('MAPPING_INVALID');
  return { input: value, previous, current };
}

async function inspectInTx(tx, spec, memoryAuthorization) {
  const { input, current } = spec;
  const { ctx } = input;
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
  const rows = await tx.$queryRawUnsafe(
    `SELECT u.id::text,u.clerk_user_id,u.email,u.first_name,u.last_name,tm.role
    FROM users u JOIN tenant_memberships tm ON tm.user_id=u.id
    WHERE tm.tenant_id=$1::uuid AND tm.status='active' AND u.id=ANY($2::uuid[]) FOR SHARE OF u,tm`,
    ctx.tenantId,
    [ctx.userId, input.reviewerUserId],
  );
  if (
    rows.length !== 2 ||
    rows.some(
      (row) =>
        (row.id === ctx.userId
          ? row.role !== 'standard_user'
          : !['standard_user', 'user_admin'].includes(row.role)) ||
        typeof row.email !== 'string' ||
        !row.email.toLowerCase().includes(FIXTURE_NAMESPACE) ||
        !row.email.toLowerCase().endsWith('@example.com') ||
        !/synthetic/iu.test(`${row.first_name ?? ''} ${row.last_name ?? ''}`),
    ) ||
    rows.find((row) => row.id === ctx.userId)?.clerk_user_id !== input.clerkUserId
  )
    fail('ACTORS_INVALID');
  if (typeof memoryAuthorization?.evaluateInTx !== 'function')
    fail('CANONICAL_AUTHORIZATION_REQUIRED');
  const reviewer = {
    tenantId: ctx.tenantId,
    userId: input.reviewerUserId,
    role: rows.find((row) => row.id === input.reviewerUserId).role,
  };
  for (const key of ['ASTER', 'BLUEHAVEN']) {
    const clientId = current.clients[key].physicalId;
    const clients = await tx.$queryRawUnsafe(
      'SELECT id::text,memory_wall,status FROM clients WHERE tenant_id=$1::uuid AND id=$2::uuid FOR SHARE',
      ctx.tenantId,
      clientId,
    );
    if (clients.length !== 1 || clients[0].status === 'archived') fail('CLIENT_INVALID');
    if (clients[0].memory_wall) {
      const grants = await tx.$queryRawUnsafe(
        'SELECT user_id::text FROM client_memory_access WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND user_id=ANY($3::uuid[]) FOR SHARE',
        ctx.tenantId,
        clientId,
        [ctx.userId, input.reviewerUserId],
      );
      if (new Set(grants.map((row) => row.user_id)).size !== 2) fail('CLIENT_WALL');
    }
    // Visibility alone is not approval or retirement authority. Read the real
    // current policy before the durable operation claim or first candidate write.
    // The subject is a fixed prospective fixture; this is only a preflight, not
    // an authorization capability. Canonical lifecycle commands recheck later.
    const subject = {
      id: current.records.find((record) => record.logicalId === (key === 'ASTER' ? 'MA3' : 'MB1')).physicalId,
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
    for (const operation of ['approve', 'revoke']) {
      const decision = await memoryAuthorization.evaluateInTx(
        tx,
        reviewer,
        { ...subject, status: operation === 'revoke' ? 'active' : 'pending_review' },
        operation,
        { emitDenialMetrics: false },
      );
      if (decision?.allowed !== true) fail('REVIEWER_AUTHORITY_REQUIRED');
    }
  }
  return { version: tenant.version, settings: tenant.settings, fixture, reviewer };
}

function planFor(spec, row) {
  const body = {
    kind: 'meri-case01-execution-setup-plan',
    schemaVersion: 1,
    recipeSha256: sha256Stable(spec.input),
    previousManifestSha256: spec.previous.contentSha256,
    currentManifestSha256: spec.current.contentSha256,
    tenantRowVersion: row.version,
    priorSettingsSha256: sha256Stable(row.settings),
    captureRunId: spec.input.captureRunId,
    sourceIds: ['MA1-v1', 'MA1-v2', 'MA2', 'MA3', 'MB1'],
    liveAcceptance: 'NOT_RUN',
  };
  return { ...body, planSha256: sha256Stable(body) };
}

function assertFresh(row) {
  if (row.fixture.case01ExecutionSetup || row.fixture.case01ExecutionSetupRecovery) fail('EXISTING_OPERATION_REQUIRES_RECONCILIATION');
  if (row.fixture.case01MemoryOwner || row.fixture.captureEvidence) fail('EXISTING_OWNER_REQUIRES_RECONCILIATION');
  return row;
}

export async function inspectCase01ExecutionSetup(deps, input) {
  const spec = await recipe(input);
  return deps.prisma.withTenantUser(spec.input.ctx.tenantId, spec.input.ctx.userId, async (tx) =>
    planFor(spec, assertFresh(await inspectInTx(tx, spec, deps.memoryAuthorization))),
  );
}

/** Explicit one-shot operator composition. Canonical owners retain all policies,
 * audit/outbox writes and real projection behavior. The durable operation claim
 * prevents retries after partial/unknown commits; there is no resume-by-JSON API.
 */
export async function executeCase01ExecutionSetup(
  deps,
  input,
  { expectedPlanSha256, createConversation, journal },
) {
  if (typeof createConversation !== 'function' || typeof journal !== 'function')
    fail('PORTS_REQUIRED');
  const spec = await recipe(input),
    { ctx } = spec.input;
  input = spec.input;
  const stage = 'CLAIM';
  const operation = {
    kind: 'meri-case01-execution-setup',
    captureRunId: input.captureRunId,
    recipeSha256: sha256Stable(spec.input),
    status: 'STARTED',
    liveAcceptance: 'NOT_RUN',
  };
  await journal({ stage, phase: 'INTENT', ...operation });
  await deps.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
    const row = assertFresh(await inspectInTx(tx, spec, deps.memoryAuthorization));
    if (planFor(spec, row).planSha256 !== expectedPlanSha256) fail('STALE_PLAN');
    const changed = await tx.$queryRawUnsafe(
      `UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,case01ExecutionSetup}',$1::jsonb,true)
      WHERE id=$2::uuid AND xmin::text=$3 AND settings_jsonb=$4::jsonb RETURNING id::text`,
      stableJson(operation),
      ctx.tenantId,
      row.version,
      stableJson(row.settings),
    );
    if (changed.length !== 1) fail('CLAIM_CAS_FAILED');
  });
  return continueClaimedSetup(deps, spec, { createConversation, journal, operation, claimKey: 'case01ExecutionSetup', originalOperation: operation });
}

async function continueClaimedSetup(deps, spec, { createConversation, journal, operation, claimKey, originalOperation, originalRecoveryOperation = null, originalContinuationOperation = null }) {
  const input = spec.input, { ctx } = input;
  let stage = 'CLAIMED';
  if (!['case01ExecutionSetup', 'case01ExecutionSetupRecovery', 'case01ExecutionSetupContinuation', 'case01ExecutionSetupPostApproval'].includes(claimKey) ||
    (claimKey === 'case01ExecutionSetupContinuation' && !originalRecoveryOperation) ||
    (claimKey === 'case01ExecutionSetupPostApproval' && (!originalRecoveryOperation || !originalContinuationOperation))) fail('CLAIM_KEY_INVALID');
  try {
    const runtimeDeps = {
      ...deps,
      proposerForTenant: (id) => {
        if (id !== ctx.tenantId) fail('FOREIGN_TENANT');
        return ctx.userId;
      },
      reviewerForTenant: (id) => {
        if (id !== ctx.tenantId) fail('FOREIGN_TENANT');
        return input.reviewerUserId;
      },
    };
    const previous = createCase01MemoryFixtureRuntime({ ...runtimeDeps, manifest: spec.previous });
    const current = createCase01MemoryFixtureRuntime({
      ...runtimeDeps,
      manifest: spec.current,
      previousOwner: previous,
    });
    const step = async (name, work) => {
      stage = name;
      await journal({ stage, phase: 'INTENT', captureRunId: input.captureRunId });
      const result = await work();
      await journal({
        stage,
        phase: 'VERIFIED',
        resultSha256: sha256Stable(result),
        captureRunId: input.captureRunId,
      });
      return result;
    };
    await step('PREVIOUS_SEED', () => previous.seed());
    await step('PREVIOUS_RETIRE', () => previous.retire());
    await step('CURRENT_SEED', () => current.seed());
    const bindingOwner = createCaptureBindingOwner({
      prisma: deps.prisma,
      sourceAuthority: current,
    });
    const request = {
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      actorUserId: ctx.userId,
      clerkUserId: input.clerkUserId,
      clientId: spec.current.clients.ASTER.physicalId,
      caseId: '01',
      captureRunId: input.captureRunId,
    };
    const bound = await step('BIND', async () => {
      const plan = await bindingOwner.inspect(request);
      if (plan.status !== 'READY') fail('BINDING_NOT_READY');
      return bindingOwner.bind({
        ...request,
        ...plan,
        expectedCurrentVerifySha256: plan.currentVerifySha256,
      });
    });
    const hydrated = createHydratedCase01MemoryOwner(runtimeDeps);
    const installed = await step('LOCATOR', () =>
      deps.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        const rows = await tx.$queryRawUnsafe(
          'SELECT settings_jsonb AS settings,xmin::text AS version FROM tenants WHERE id=$1::uuid FOR UPDATE',
          ctx.tenantId,
        );
        if (rows.length !== 1) fail('TENANT_MISSING');
        return hydrated.installLocatorInTx(tx, ctx, {
          locator: case01MemoryOwnerLocator(spec.current, spec.previous, ctx.userId),
          expectedPriorLocatorSha256: sha256Stable(
            rows[0].settings.meriFoundationFixture.case01MemoryOwner ?? null,
          ),
          expectedTenantRowVersion: rows[0].version,
        });
      }),
    );
    const conversation = await step('CONVERSATION', () =>
      createConversation(ctx, {
        clientId: request.clientId,
        title: `${FIXTURE_NAMESPACE} case01 ${input.captureRunId}`,
      }),
    );
    const qualified = await step('READBACK', () =>
      deps.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        const actual = await tx.clioConversation.findFirst({
          where: {
            id: conversation.id,
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            clientId: request.clientId,
            archivedAt: null,
          },
          include: { _count: { select: { messages: true } } },
        });
        if (!actual || actual._count.messages !== 0) fail('CONVERSATION_NOT_EMPTY_OWNED');
        return hydrated.qualifyInTx(tx, ctx, { caseId: '01', clientId: request.clientId });
      }),
    );
    const receipt = {
      kind: 'meri-case01-execution-setup-receipt',
      schemaVersion: 1,
      status: 'SETUP_COMPLETE',
      captureRunId: input.captureRunId,
      conversationId: conversation.id,
      ctx,
      clientId: request.clientId,
      binding: bound.binding,
      bindingSha256: bound.bindingSha256,
      locatorSha256: installed.locatorSha256,
      sourceMap: qualified.sourceMap,
      currentVerifySha256: qualified.currentVerifySha256,
      seedReceiptId: qualified.seedReceiptId,
      resetReceiptId: qualified.resetReceiptId,
      projectionStatus: 'CANONICAL_OUTBOX_RECORDED_NOT_QUALIFIED',
      liveAcceptance: 'NOT_RUN',
      synthesisSubmissionCount: 0,
    };
    await deps.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const changed = await tx.$queryRawUnsafe(
        `UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,$4::text[],$1::jsonb,true)
        WHERE id=$2::uuid AND settings_jsonb#>$4::text[]=$3::jsonb
          AND settings_jsonb->'meriFoundationFixture'->'case01ExecutionSetup'=$5::jsonb
          AND ($6::jsonb IS NULL OR settings_jsonb->'meriFoundationFixture'->'case01ExecutionSetupRecovery'=$6::jsonb)
          AND ($7::jsonb IS NULL OR settings_jsonb->'meriFoundationFixture'->'case01ExecutionSetupContinuation'=$7::jsonb)
          RETURNING id::text`,
        stableJson({
          ...operation,
          status: 'SETUP_COMPLETE',
          receiptSha256: sha256Stable(receipt),
        }),
        ctx.tenantId,
        stableJson(operation),
        ['meriFoundationFixture', claimKey],
        stableJson(originalOperation),
        originalRecoveryOperation ? stableJson(originalRecoveryOperation) : null,
        originalContinuationOperation ? stableJson(originalContinuationOperation) : null,
      );
      if (changed.length !== 1) fail('FINAL_CLAIM_CHANGED');
    });
    await journal({ stage: 'COMPLETE', phase: 'VERIFIED', receipt });
    return receipt;
  } catch (error) {
    // Never clear the claim, repeat canonical writes, or turn uncertain setup into success.
    await journal({ stage, phase: 'RECONCILIATION_REQUIRED', captureRunId: input.captureRunId, failure: safeCase01SetupFailure(error, stage) });
    throw error;
  }
}

/** Safe operator diagnostics: never serialize Error, message, query, meta or cause. */
export function safeCase01SetupFailure(error, stage = 'OPERATOR') {
  const classes = new Set(['Error', 'FixtureProvisioningError', 'ForbiddenException', 'BadRequestException',
    'NotFoundException', 'ConflictException', 'PrismaClientKnownRequestError', 'PrismaClientUnknownRequestError',
    'PrismaClientInitializationError', 'PrismaClientValidationError']);
  const prisma = new Set(['P1000', 'P1001', 'P1002', 'P1008', 'P1010', 'P1011', 'P1017',
    'P2000', 'P2002', 'P2003', 'P2004', 'P2006', 'P2010', 'P2011', 'P2014', 'P2021', 'P2022', 'P2024', 'P2025', 'P2028', 'P2034']);
  const sql = new Set(['08001', '08006', '08P01', '22001', '22P02', '23502', '23503', '23505', '23514',
    '25006', '25P02', '40001', '40P01', '42501', '42703', '42883', '42P01', '57014', 'P0001']);
  const stages = new Set(['OPERATOR', 'CLAIMED', 'PREVIOUS_SEED', 'PREVIOUS_RETIRE', 'CURRENT_SEED',
    'BIND', 'LOCATOR', 'CONVERSATION', 'READBACK', 'RECOVERY_ADMISSION', 'CONTINUATION_ADMISSION', 'FIRST_CANONICAL_APPROVAL', 'POST_APPROVAL_ADMISSION', 'FIRST_CANONICAL_PROJECTION']);
  return {
    stage: stages.has(stage) ? stage : 'OPERATOR',
    errorClass: classes.has(error?.constructor?.name) ? error.constructor.name : 'UnknownError',
    prismaCode: prisma.has(error?.code) ? error.code : null,
    sqlState: sql.has(error?.meta?.code) ? error.meta.code : sql.has(error?.code) ? error.code : null,
  };
}

function originalOperationFor(spec) {
  return { kind: 'meri-case01-execution-setup', captureRunId: spec.input.captureRunId,
    recipeSha256: sha256Stable(spec.input), status: 'STARTED', liveAcceptance: 'NOT_RUN' };
}

async function firstApprovalPendingInTx(deps, tx, spec, expected, continuation = false) {
  const expectedKeys = continuation ? 'candidateRowVersion|originalClaimSha256|recoveryClaimSha256' : 'candidateRowVersion|originalClaimSha256';
  if (!expected || Object.keys(expected).sort().join('|') !== expectedKeys ||
    !/^[a-f0-9]{64}$/u.test(expected.originalClaimSha256 ?? '') ||
    (continuation && !/^[a-f0-9]{64}$/u.test(expected.recoveryClaimSha256 ?? '')) ||
    !/^[0-9]{1,15}$/u.test(expected.candidateRowVersion ?? '')) fail('RECOVERY_EXPECTATION_INVALID');
  const row = await inspectInTx(tx, spec, deps.memoryAuthorization);
  const originalOperation = originalOperationFor(spec);
  if (sha256Stable(row.fixture.case01ExecutionSetup) !== sha256Stable(originalOperation) ||
    sha256Stable(originalOperation) !== expected.originalClaimSha256) fail('RECOVERY_ORIGINAL_CLAIM_CHANGED');
  if ([...(!continuation ? ['case01ExecutionSetupRecovery'] : []), 'case01ExecutionSetupContinuation', 'case01MemoryOwner', 'captureEvidence'].some(
    key => Object.hasOwn(row.fixture, key))) fail('RECOVERY_DOWNSTREAM_OWNER_PRESENT');
  const definitions = [spec.previous, spec.current].flatMap(manifest => [
    ...lifecycleSeedMemoryDefinitions(manifest, ['MA1-v1', 'MA3']).map(entry => entry.candidate),
    ...selectedApprovedMemoryDefinitions(manifest, ['MB1']).map(entry => entry.candidate),
    manifest.records.find(record => record.logicalId === 'MA2'),
  ]);
  const first = definitions[0], ids = definitions.map(record => record.physicalId);
  let originalRecoveryOperation = null;
  if (continuation) {
    originalRecoveryOperation = row.fixture.case01ExecutionSetupRecovery;
    const exactRecovery = { kind: 'meri-case01-first-approval-recovery', schemaVersion: 1,
      recoveryMode: 'FIRST_APPROVAL_PENDING', status: 'STARTED', captureRunId: spec.input.captureRunId,
      originalClaimSha256: expected.originalClaimSha256, recipeSha256: sha256Stable(spec.input),
      planSha256: originalRecoveryOperation?.planSha256, candidateId: first.physicalId,
      candidateRowVersion: expected.candidateRowVersion, liveAcceptance: 'NOT_RUN' };
    if (!/^[a-f0-9]{64}$/u.test(exactRecovery.planSha256 ?? '') ||
      sha256Stable(originalRecoveryOperation ?? null) !== expected.recoveryClaimSha256 ||
      sha256Stable(originalRecoveryOperation ?? null) !== sha256Stable(exactRecovery)) fail('CONTINUATION_RECOVERY_CLAIM_CHANGED');
  }
  const payloads = definitions.map(record => expectedMemoryCandidatePayload(record, spec.input.ctx.userId,
    stableJson({ ownership: record.ownership, payload: record.payload })));
  const keys = payloads.map(payload => payload.key), markers = definitions.map(record => record.ownership.markerSha256);
  // Include a rebound id with the same source marker/key, not just expected ids.
  const candidates = await tx.$queryRawUnsafe(
    `SELECT id::text,xmin::text AS version FROM memory_candidate WHERE tenant_id=$1::uuid
      AND (id=ANY($2::uuid[]) OR source_id=ANY($3::text[]) OR payload_jsonb->>'key'=ANY($4::text[]))
      ORDER BY id FOR UPDATE`, spec.input.ctx.tenantId, ids, markers, keys);
  if (candidates.length !== 1 || candidates[0].id !== first.physicalId ||
    candidates[0].version !== expected.candidateRowVersion) fail('RECOVERY_NOT_FIRST_APPROVAL_PENDING');
  const guard = { expectedRowVersion: expected.candidateRowVersion, expectedPayload: payloads[0] };
  await deps.assertSyntheticCandidateWithdrawalInTx(tx, spec.input.ctx.tenantId, spec.input.ctx.userId, first.physicalId, guard);
  const legacy = await tx.$queryRawUnsafe(
    'SELECT id::text FROM clio_memory WHERE tenant_id=$1::uuid AND key=ANY($2::text[]) ORDER BY id FOR UPDATE',
    spec.input.ctx.tenantId, keys);
  const items = await tx.$queryRawUnsafe(
    `SELECT id::text FROM memory_items WHERE tenant_id=$1::uuid
      AND (title=ANY($2::text[]) OR source_id=ANY($3::text[])) ORDER BY id FOR UPDATE`,
    spec.input.ctx.tenantId, keys, [...ids, ...markers]);
  const audits = await tx.$queryRawUnsafe(
    'SELECT id::text FROM memory_transition_audit WHERE tenant_id=$1::uuid AND memory_candidate_id=ANY($2::uuid[]) LIMIT 1',
    spec.input.ctx.tenantId, ids);
  const conversations = await tx.$queryRawUnsafe(
    'SELECT id::text FROM clio_conversations WHERE tenant_id=$1::uuid AND title=$2 LIMIT 1',
    spec.input.ctx.tenantId, `${FIXTURE_NAMESPACE} case01 ${spec.input.captureRunId}`);
  if (legacy.length || items.length || audits.length || conversations.length) fail('RECOVERY_DOWNSTREAM_STATE_PRESENT');
  return { ...row, originalOperation, originalRecoveryOperation, first, guard };
}

function recoveryPlan(spec, row) {
  const body = { kind: 'meri-case01-first-approval-recovery-plan', schemaVersion: 1,
    recoveryMode: 'FIRST_APPROVAL_PENDING', recipeSha256: sha256Stable(spec.input),
    captureRunId: spec.input.captureRunId, originalClaimSha256: sha256Stable(row.originalOperation),
    candidateId: row.first.physicalId, candidateRowVersion: row.guard.expectedRowVersion,
    candidatePayloadSha256: sha256Stable(row.guard.expectedPayload),
    previousManifestSha256: spec.previous.contentSha256, currentManifestSha256: spec.current.contentSha256,
    tenantRowVersion: row.version, priorSettingsSha256: sha256Stable(row.settings), liveAcceptance: 'NOT_RUN' };
  return { ...body, planSha256: sha256Stable(body) };
}

export async function inspectCase01FirstApprovalRecovery(deps, input, expected) {
  const spec = await recipe(input);
  return deps.prisma.withTenantUser(spec.input.ctx.tenantId, spec.input.ctx.userId, async tx =>
    recoveryPlan(spec, await firstApprovalPendingInTx(deps, tx, spec, expected)));
}

/** Separate one-shot recovery claim. The original failed operation is immutable.
 * The first canonical service receives the admitted exact version again under
 * its own pending-row lock; an inspect/claim/write race cannot substitute it. */
export async function executeCase01FirstApprovalRecovery(deps, input, expected,
  { expectedPlanSha256, createConversation, journal }) {
  if (typeof createConversation !== 'function' || typeof journal !== 'function') fail('PORTS_REQUIRED');
  const spec = await recipe(input), { ctx } = spec.input;
  let admitted, operation;
  await journal({ stage: 'RECOVERY_ADMISSION', phase: 'INTENT', captureRunId: spec.input.captureRunId });
  await deps.prisma.withTenantUser(ctx.tenantId, ctx.userId, async tx => {
    admitted = await firstApprovalPendingInTx(deps, tx, spec, expected);
    const plan = recoveryPlan(spec, admitted);
    if (plan.planSha256 !== expectedPlanSha256) fail('RECOVERY_STALE_PLAN');
    operation = { kind: 'meri-case01-first-approval-recovery', schemaVersion: 1,
      recoveryMode: 'FIRST_APPROVAL_PENDING', status: 'STARTED', captureRunId: spec.input.captureRunId,
      originalClaimSha256: plan.originalClaimSha256, recipeSha256: plan.recipeSha256,
      planSha256: plan.planSha256, candidateId: plan.candidateId, candidateRowVersion: plan.candidateRowVersion,
      liveAcceptance: 'NOT_RUN' };
    const changed = await tx.$queryRawUnsafe(
      `UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,case01ExecutionSetupRecovery}',$1::jsonb,true)
        WHERE id=$2::uuid AND xmin::text=$3 AND settings_jsonb=$4::jsonb RETURNING id::text`,
      stableJson(operation), ctx.tenantId, admitted.version, stableJson(admitted.settings));
    if (changed.length !== 1) fail('RECOVERY_CLAIM_CAS_FAILED');
  });
  await journal({ stage: 'RECOVERY_ADMISSION', phase: 'VERIFIED', captureRunId: spec.input.captureRunId,
    claimSha256: sha256Stable(operation) });
  return approveFirstAndContinue(deps, spec, admitted, operation, 'case01ExecutionSetupRecovery', { createConversation, journal });
}

async function approveFirstAndContinue(deps, spec, admitted, operation, claimKey, { createConversation, journal }) {
  const { ctx } = spec.input;
  const canonicalCandidates = deps.memoryCandidates;
  await journal({ stage: 'FIRST_CANONICAL_APPROVAL', phase: 'INTENT', captureRunId: spec.input.captureRunId });
  try {
    const result = await canonicalCandidates.approveSyntheticFixture(ctx.tenantId, admitted.first.physicalId,
      spec.input.reviewerUserId, admitted.reviewer, admitted.guard);
    await journal({ stage: 'FIRST_CANONICAL_APPROVAL', phase: 'VERIFIED', captureRunId: spec.input.captureRunId,
      resultSha256: sha256Stable(result) });
  } catch (error) {
    await journal({ stage: 'FIRST_CANONICAL_APPROVAL', phase: 'RECONCILIATION_REQUIRED',
      captureRunId: spec.input.captureRunId, failure: safeCase01SetupFailure(error, 'FIRST_CANONICAL_APPROVAL') });
    throw error;
  }
  const scopedCandidates = Object.create(canonicalCandidates);
  scopedCandidates.approveSyntheticFixture = (tenantId, candidateId, ...args) => {
    if (candidateId === admitted.first.physicalId) fail('RECOVERY_FIRST_APPROVAL_ALREADY_ATTEMPTED');
    return canonicalCandidates.approveSyntheticFixture(tenantId, candidateId, ...args);
  };
  return continueClaimedSetup({ ...deps, memoryCandidates: scopedCandidates }, spec,
    { createConversation, journal, operation, claimKey, originalOperation: admitted.originalOperation,
      originalRecoveryOperation: admitted.originalRecoveryOperation });
}

function continuationPlan(spec, row) {
  const { planSha256: _priorPlanHash, ...pending } = recoveryPlan(spec, row);
  const body = { ...pending, kind: 'meri-case01-first-approval-continuation-plan',
    recoveryClaimSha256: sha256Stable(row.originalRecoveryOperation) };
  return { ...body, planSha256: sha256Stable(body) };
}

/** Exact failed first approval only. Both historical claims remain immutable;
 * caller expectations locate current state, never authorize or reconstruct it. */
export async function inspectCase01FirstApprovalContinuation(deps, input, expected) {
  const spec = await recipe(input);
  return deps.prisma.withTenantUser(spec.input.ctx.tenantId, spec.input.ctx.userId, async tx =>
    continuationPlan(spec, await firstApprovalPendingInTx(deps, tx, spec, expected, true)));
}

export async function executeCase01FirstApprovalContinuation(deps, input, expected,
  { expectedPlanSha256, createConversation, journal }) {
  if (typeof createConversation !== 'function' || typeof journal !== 'function') fail('PORTS_REQUIRED');
  const spec = await recipe(input), { ctx } = spec.input;
  let admitted, operation;
  await journal({ stage: 'CONTINUATION_ADMISSION', phase: 'INTENT', captureRunId: spec.input.captureRunId });
  await deps.prisma.withTenantUser(ctx.tenantId, ctx.userId, async tx => {
    admitted = await firstApprovalPendingInTx(deps, tx, spec, expected, true);
    const plan = continuationPlan(spec, admitted);
    if (plan.planSha256 !== expectedPlanSha256) fail('CONTINUATION_STALE_PLAN');
    operation = { kind: 'meri-case01-first-approval-continuation', schemaVersion: 1,
      status: 'STARTED', captureRunId: spec.input.captureRunId, recipeSha256: plan.recipeSha256,
      originalClaimSha256: plan.originalClaimSha256, recoveryClaimSha256: plan.recoveryClaimSha256,
      candidateId: plan.candidateId, candidateRowVersion: plan.candidateRowVersion,
      planSha256: plan.planSha256, liveAcceptance: 'NOT_RUN' };
    const changed = await tx.$queryRawUnsafe(
      `UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,case01ExecutionSetupContinuation}',$1::jsonb,true)
       WHERE id=$2::uuid AND xmin::text=$3 AND settings_jsonb=$4::jsonb RETURNING id::text`,
      stableJson(operation), ctx.tenantId, admitted.version, stableJson(admitted.settings));
    if (changed.length !== 1) fail('CONTINUATION_CLAIM_CAS_FAILED');
  });
  await journal({ stage: 'CONTINUATION_ADMISSION', phase: 'VERIFIED', captureRunId: spec.input.captureRunId,
    claimSha256: sha256Stable(operation) });
  return approveFirstAndContinue(deps, spec, admitted, operation, 'case01ExecutionSetupContinuation', { createConversation, journal });
}

const postApprovalClaimKey = 'case01ExecutionSetupPostApproval';

/** Reconcile only the already committed first approval. No payload, approval
 * result, projection receipt or readiness assertion is accepted from the caller. */
async function postApprovalInTx(
  deps,
  tx,
  spec,
  expected,
  { operation = null, projected = false } = {},
) {
  const keys = [
    'originalClaimSha256',
    'recoveryClaimSha256',
    'continuationClaimSha256',
    'candidateRowVersion',
    'itemRowVersion',
    'clioRowVersion',
    'projectionJobId',
  ];
  if (
    !expected ||
    Object.keys(expected).sort().join('|') !== keys.sort().join('|') ||
    keys
      .filter((k) => k.endsWith('Sha256'))
      .some((k) => !/^[a-f0-9]{64}$/u.test(expected[k] ?? '')) ||
    keys
      .filter((k) => k.endsWith('RowVersion'))
      .some((k) => !/^[0-9]{1,10}$/u.test(expected[k] ?? '')) ||
    !uuid.test(expected.projectionJobId ?? '') ||
    typeof deps.canonicalProjectionSnapshot !== 'function' ||
    typeof deps.assertSyntheticApprovedMemoryInTx !== 'function' ||
    typeof deps.memoryIngest?.projectClioMemory !== 'function'
  )
    fail('POST_APPROVAL_EXPECTATION_INVALID');
  const row = await inspectInTx(tx, spec, deps.memoryAuthorization),
    { ctx } = spec.input;
  const originalOperation = originalOperationFor(spec);
  const originalRecoveryOperation = row.fixture.case01ExecutionSetupRecovery;
  const originalContinuationOperation = row.fixture.case01ExecutionSetupContinuation;
  if (
    sha256Stable(row.fixture.case01ExecutionSetup ?? null) !== sha256Stable(originalOperation) ||
    sha256Stable(originalOperation) !== expected.originalClaimSha256 ||
    sha256Stable(originalRecoveryOperation ?? null) !== expected.recoveryClaimSha256 ||
    sha256Stable(originalContinuationOperation ?? null) !== expected.continuationClaimSha256
  )
    fail('POST_APPROVAL_HISTORICAL_CLAIM_CHANGED');
  for (const [claim, kind] of [
    [originalRecoveryOperation, 'meri-case01-first-approval-recovery'],
    [originalContinuationOperation, 'meri-case01-first-approval-continuation'],
  ]) {
    if (
      claim?.kind !== kind ||
      claim.status !== 'STARTED' ||
      claim.schemaVersion !== 1 ||
      claim.captureRunId !== spec.input.captureRunId ||
      claim.recipeSha256 !== sha256Stable(spec.input) ||
      claim.originalClaimSha256 !== expected.originalClaimSha256 ||
      claim.liveAcceptance !== 'NOT_RUN'
    )
      fail('POST_APPROVAL_HISTORICAL_CLAIM_INVALID');
  }
  if (
    originalContinuationOperation.recoveryClaimSha256 !== expected.recoveryClaimSha256 ||
    originalContinuationOperation.candidateId !== originalRecoveryOperation.candidateId ||
    originalContinuationOperation.candidateRowVersion !==
      originalRecoveryOperation.candidateRowVersion
  )
    fail('POST_APPROVAL_HISTORICAL_CLAIM_INVALID');
  if (
    ['case01MemoryOwner', 'captureEvidence'].some((k) => Object.hasOwn(row.fixture, k)) ||
    (operation
      ? sha256Stable(row.fixture[postApprovalClaimKey] ?? null) !== sha256Stable(operation)
      : Object.hasOwn(row.fixture, postApprovalClaimKey))
  )
    fail('POST_APPROVAL_DOWNSTREAM_OWNER_PRESENT');

  const definitions = [spec.previous, spec.current].flatMap((manifest) => [
    ...lifecycleSeedMemoryDefinitions(manifest, ['MA1-v1', 'MA3']).map((entry) => entry.candidate),
    ...selectedApprovedMemoryDefinitions(manifest, ['MB1']).map((entry) => entry.candidate),
    manifest.records.find((record) => record.logicalId === 'MA2'),
  ]);
  const first = definitions[0],
    ids = definitions.map((r) => r.physicalId),
    markers = definitions.map((r) => r.ownership.markerSha256),
    payloads = definitions.map((record) =>
      expectedMemoryCandidatePayload(
        record,
        ctx.userId,
        stableJson({ ownership: record.ownership, payload: record.payload }),
      ),
    ),
    sourceKeys = payloads.map((p) => p.key);
  const candidates = await tx.$queryRawUnsafe(
    `SELECT id::text,xmin::text AS version,committed_memory_id::text AS clio_id,
       committed_memory_item_id::text AS item_id,approved_by_user_id::text AS approved_by
     FROM memory_candidate WHERE tenant_id=$1::uuid
       AND (id=ANY($2::uuid[]) OR source_id=ANY($3::text[]) OR payload_jsonb->>'key'=ANY($4::text[]))
     ORDER BY id FOR UPDATE`,
    ctx.tenantId,
    ids,
    markers,
    sourceKeys,
  );
  const candidate = candidates[0];
  if (
    candidates.length !== 1 ||
    candidate.id !== first.physicalId ||
    candidate.id !== originalContinuationOperation.candidateId ||
    candidate.version !== expected.candidateRowVersion ||
    candidate.approved_by !== spec.input.reviewerUserId
  )
    fail('POST_APPROVAL_NOT_EXACT_FIRST');
  const items = await tx.$queryRawUnsafe(
    `SELECT id::text,xmin::text AS version,title,sections_jsonb AS sections FROM memory_items
     WHERE tenant_id=$1::uuid AND (id=$2::uuid OR title=ANY($3::text[]) OR source_id=ANY($4::text[]))
     ORDER BY id FOR UPDATE`,
    ctx.tenantId,
    candidate.item_id,
    sourceKeys,
    [...ids, ...markers],
  );
  if (
    items.length !== 1 ||
    items[0].id !== candidate.item_id ||
    items[0].version !== expected.itemRowVersion
  )
    fail('POST_APPROVAL_ITEM_CHANGED');
  await deps.assertSyntheticApprovedMemoryInTx(tx, row.reviewer, candidate.item_id, {
    candidateId: candidate.id,
    expectedRowVersion: expected.candidateRowVersion,
    expectedItemRowVersion: expected.itemRowVersion,
    expectedPayload: payloads[0],
  });
  const legacy = await tx.$queryRawUnsafe(
    `SELECT id::text,xmin::text AS version,updated_at AS source_version,embedding IS NOT NULL AS embedded
     FROM clio_memory WHERE tenant_id=$1::uuid AND (id=$2::uuid OR key=ANY($3::text[])) ORDER BY id FOR UPDATE`,
    ctx.tenantId,
    candidate.clio_id,
    sourceKeys,
  );
  if (
    legacy.length !== 1 ||
    legacy[0].id !== candidate.clio_id ||
    legacy[0].version !== expected.clioRowVersion ||
    !legacy[0].embedded
  )
    fail('POST_APPROVAL_CLIO_CHANGED');
  const contentHash = deps.canonicalProjectionSnapshot(items[0]).contentHash;
  const sourceVersion = new Date(legacy[0].source_version).toISOString();
  const idempotencyKey = `index_memory_item:${candidate.clio_id}:${sourceVersion}:${contentHash}`;
  const jobs = await tx.$queryRawUnsafe(
    `SELECT id::text,memory_item_id::text AS item_id,operation,status,attempts,idempotency_key,
       expected_source_version,expected_content_hash,last_error,completed_at,superseded_at,
       lease_owner,lease_expires_at FROM memory_cleanup_outbox
     WHERE tenant_id=$1::uuid AND (clio_memory_id=$2::uuid OR memory_item_id=$3::uuid) ORDER BY id FOR UPDATE`,
    ctx.tenantId,
    candidate.clio_id,
    candidate.item_id,
  );
  const job = jobs[0];
  if (
    jobs.length !== 1 ||
    job.id !== expected.projectionJobId ||
    job.item_id !== candidate.item_id ||
    job.operation !== 'index_memory_item' ||
    job.status !== (projected ? 'completed' : 'pending') ||
    job.attempts !== 0 ||
    job.idempotency_key !== idempotencyKey ||
    new Date(job.expected_source_version).toISOString() !== sourceVersion ||
    job.expected_content_hash !== contentHash ||
    job.last_error !== null ||
    job.superseded_at !== null ||
    job.lease_owner !== null ||
    job.lease_expires_at !== null ||
    (projected ? !job.completed_at : job.completed_at !== null)
  )
    fail('POST_APPROVAL_JOB_CHANGED');
  const embeddings = await tx.$queryRawUnsafe(
    `SELECT model,content_hash,embedding IS NOT NULL AS embedded FROM context_embeddings
     WHERE tenant_id=$1::uuid AND source_type='memory_item' AND source_id=$2 FOR UPDATE`,
    ctx.tenantId,
    candidate.item_id,
  );
  if (
    projected
      ? embeddings.length !== 1 ||
        embeddings[0].model !== 'amazon.titan-embed-text-v2:0' ||
        embeddings[0].content_hash !== contentHash ||
        !embeddings[0].embedded
      : embeddings.length !== 0
  )
    fail('POST_APPROVAL_EMBEDDING_CHANGED');
  const audits = await tx.$queryRawUnsafe(
    `SELECT from_status,to_status,actor_user_id::text AS actor FROM memory_transition_audit
     WHERE tenant_id=$1::uuid AND memory_candidate_id=ANY($2::uuid[]) ORDER BY occurred_at,id`,
    ctx.tenantId,
    ids,
  );
  if (
    audits.length !== 2 ||
    audits.some((a) => a.actor !== spec.input.reviewerUserId) ||
    !audits.some((a) => a.from_status === 'suggested' && a.to_status === 'pending_review') ||
    !audits.some((a) => a.from_status === 'pending_review' && a.to_status === 'active')
  )
    fail('POST_APPROVAL_AUDIT_CHANGED');
  const conversations = await tx.$queryRawUnsafe(
    'SELECT id::text FROM clio_conversations WHERE tenant_id=$1::uuid AND title=$2 LIMIT 1',
    ctx.tenantId,
    `${FIXTURE_NAMESPACE} case01 ${spec.input.captureRunId}`,
  );
  if (conversations.length) fail('POST_APPROVAL_CONVERSATION_PRESENT');
  return {
    ...row,
    originalOperation,
    originalRecoveryOperation,
    originalContinuationOperation,
    first,
    projection: {
      candidateId: candidate.id,
      itemId: candidate.item_id,
      clioId: candidate.clio_id,
      jobId: job.id,
      contentHash,
      sourceVersion,
      idempotencyKeySha256: sha256Stable(idempotencyKey),
    },
  };
}

function postApprovalPlan(spec, row, expected) {
  const body = {
    kind: 'meri-case01-post-approval-resume-plan',
    schemaVersion: 1,
    recipeSha256: sha256Stable(spec.input),
    captureRunId: spec.input.captureRunId,
    ...expected,
    projection: row.projection,
    previousManifestSha256: spec.previous.contentSha256,
    currentManifestSha256: spec.current.contentSha256,
    tenantRowVersion: row.version,
    priorSettingsSha256: sha256Stable(row.settings),
    liveAcceptance: 'NOT_RUN',
  };
  return { ...body, planSha256: sha256Stable(body) };
}

export async function inspectCase01PostApprovalResume(deps, input, expected) {
  const spec = await recipe(input);
  return deps.prisma.withTenantUser(spec.input.ctx.tenantId, spec.input.ctx.userId, async (tx) =>
    postApprovalPlan(spec, await postApprovalInTx(deps, tx, spec, expected), expected),
  );
}

export async function executeCase01PostApprovalResume(
  deps,
  input,
  expected,
  { expectedPlanSha256, createConversation, journal },
) {
  if (typeof createConversation !== 'function' || typeof journal !== 'function')
    fail('PORTS_REQUIRED');
  const spec = await recipe(input),
    { ctx } = spec.input;
  let admitted, operation;
  await journal({
    stage: 'POST_APPROVAL_ADMISSION',
    phase: 'INTENT',
    captureRunId: spec.input.captureRunId,
  });
  await deps.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
    admitted = await postApprovalInTx(deps, tx, spec, expected);
    const plan = postApprovalPlan(spec, admitted, expected);
    if (plan.planSha256 !== expectedPlanSha256) fail('POST_APPROVAL_STALE_PLAN');
    operation = {
      kind: 'meri-case01-post-approval-resume',
      schemaVersion: 1,
      status: 'STARTED',
      captureRunId: spec.input.captureRunId,
      recipeSha256: plan.recipeSha256,
      originalClaimSha256: expected.originalClaimSha256,
      recoveryClaimSha256: expected.recoveryClaimSha256,
      continuationClaimSha256: expected.continuationClaimSha256,
      projection: admitted.projection,
      planSha256: plan.planSha256,
      liveAcceptance: 'NOT_RUN',
    };
    const changed = await tx.$queryRawUnsafe(
      `UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,case01ExecutionSetupPostApproval}',$1::jsonb,true)
       WHERE id=$2::uuid AND xmin::text=$3 AND settings_jsonb=$4::jsonb RETURNING id::text`,
      stableJson(operation),
      ctx.tenantId,
      admitted.version,
      stableJson(admitted.settings),
    );
    if (changed.length !== 1) fail('POST_APPROVAL_CLAIM_CAS_FAILED');
  });
  await journal({
    stage: 'POST_APPROVAL_ADMISSION',
    phase: 'VERIFIED',
    captureRunId: spec.input.captureRunId,
    claimSha256: sha256Stable(operation),
  });
  const stage = 'FIRST_CANONICAL_PROJECTION';
  await journal({ stage, phase: 'INTENT', captureRunId: spec.input.captureRunId });
  try {
    await deps.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      postApprovalInTx(deps, tx, spec, expected, { operation }),
    );
    const projection = admitted.projection;
    await deps.memoryIngest.projectClioMemory(ctx.tenantId, projection.clioId, {
      id: projection.jobId,
      memoryItemId: projection.itemId,
      sourceVersion: projection.sourceVersion,
      contentHash: projection.contentHash,
      idempotencyKey: `index_memory_item:${projection.clioId}:${projection.sourceVersion}:${projection.contentHash}`,
    });
    const readback = await deps.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      postApprovalInTx(deps, tx, spec, expected, { operation, projected: true }),
    );
    await journal({
      stage,
      phase: 'VERIFIED',
      captureRunId: spec.input.captureRunId,
      resultSha256: sha256Stable(readback.projection),
    });
  } catch (error) {
    await journal({
      stage,
      phase: 'RECONCILIATION_REQUIRED',
      captureRunId: spec.input.captureRunId,
      failure: safeCase01SetupFailure(error, stage),
    });
    throw error;
  }
  const canonicalCandidates = deps.memoryCandidates;
  const scopedCandidates = Object.create(canonicalCandidates);
  scopedCandidates.approveSyntheticFixture = (tenantId, candidateId, ...args) => {
    if (candidateId === admitted.first.physicalId) fail('POST_APPROVAL_MUST_NOT_REAPPROVE');
    return canonicalCandidates.approveSyntheticFixture(tenantId, candidateId, ...args);
  };
  return continueClaimedSetup({ ...deps, memoryCandidates: scopedCandidates }, spec, {
    createConversation,
    journal,
    operation,
    claimKey: postApprovalClaimKey,
    originalOperation: admitted.originalOperation,
    originalRecoveryOperation: admitted.originalRecoveryOperation,
    originalContinuationOperation: admitted.originalContinuationOperation,
  });
}
