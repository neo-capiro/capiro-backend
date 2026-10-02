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
  if (fixture.case01ExecutionSetup) fail('EXISTING_OPERATION_REQUIRES_RECONCILIATION');
  if (fixture.case01MemoryOwner || fixture.captureEvidence)
    fail('EXISTING_OWNER_REQUIRES_RECONCILIATION');
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
  return { version: tenant.version, settings: tenant.settings, fixture };
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

export async function inspectCase01ExecutionSetup(deps, input) {
  const spec = await recipe(input);
  return deps.prisma.withTenantUser(spec.input.ctx.tenantId, spec.input.ctx.userId, async (tx) =>
    planFor(spec, await inspectInTx(tx, spec, deps.memoryAuthorization)),
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
  let stage = 'CLAIM',
    claimed = false;
  const operation = {
    kind: 'meri-case01-execution-setup',
    captureRunId: input.captureRunId,
    recipeSha256: sha256Stable(spec.input),
    status: 'STARTED',
    liveAcceptance: 'NOT_RUN',
  };
  await journal({ stage, phase: 'INTENT', ...operation });
  await deps.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
    const row = await inspectInTx(tx, spec, deps.memoryAuthorization);
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
  claimed = true;
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
        `UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,case01ExecutionSetup}',$1::jsonb,true)
        WHERE id=$2::uuid AND settings_jsonb->'meriFoundationFixture'->'case01ExecutionSetup'=$3::jsonb RETURNING id::text`,
        stableJson({
          ...operation,
          status: 'SETUP_COMPLETE',
          receiptSha256: sha256Stable(receipt),
        }),
        ctx.tenantId,
        stableJson(operation),
      );
      if (changed.length !== 1) fail('FINAL_CLAIM_CHANGED');
    });
    await journal({ stage: 'COMPLETE', phase: 'VERIFIED', receipt });
    return receipt;
  } catch (error) {
    // Never clear the claim, repeat canonical writes, or turn uncertain setup into success.
    if (claimed)
      await journal({ stage, phase: 'RECONCILIATION_REQUIRED', captureRunId: input.captureRunId });
    throw error;
  }
}
