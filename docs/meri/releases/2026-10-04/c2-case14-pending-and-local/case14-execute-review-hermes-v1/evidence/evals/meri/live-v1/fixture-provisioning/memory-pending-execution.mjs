import { buildFixtureManifest } from './manifest.mjs';
import { selectPendingMemoryFixturePlan } from './memory-pending-fixture-plan.mjs';
import { createMemoryCandidateOwnerPort } from './memory-candidate-owner.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE } from './contract.mjs';
import { sha256Stable, stableJson } from '../lib/stable.mjs';

const fail = (code) => {
  throw new Error(`PENDING_MEMORY_${code}`);
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export async function resolvePendingMemorySetupRecipe(input) {
  const value = structuredClone(input);
  if (
    !value ||
    Object.keys(value).sort().join('|') !==
      'actors|caseId|clerkUserId|clients|ctx|fixtureInstanceId|fixtureNamespace|schemaVersion|target' ||
    value.schemaVersion !== 1 ||
    value.target !== 'capiro-dev' ||
    value.fixtureNamespace !== FIXTURE_NAMESPACE ||
    process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== FIXTURE_NAMESPACE ||
    Object.keys(value.ctx ?? {})
      .sort()
      .join('|') !== 'role|tenantId|tenantSlug|userId' ||
    value.ctx.tenantId !== AUTHORIZED_TENANTS.T1.id ||
    value.ctx.tenantSlug !== AUTHORIZED_TENANTS.T1.slug ||
    value.ctx.role !== (value.caseId === '17' ? 'user_admin' : 'standard_user') ||
    !UUID.test(value.ctx.userId ?? '') ||
    typeof value.clerkUserId !== 'string' ||
    !value.clerkUserId.startsWith('user_')
  )
    fail('RECIPE_INVALID');
  const manifest = await buildFixtureManifest({
    fixtureInstanceId: value.fixtureInstanceId,
    actors: value.actors,
    clients: value.clients,
  });
  const plan = selectPendingMemoryFixturePlan(manifest, value.caseId);
  if (plan.proposerUserId !== value.ctx.userId) fail('PROPOSER_MISMATCH');
  return { input: value, manifest, selection: plan };
}
const select = resolvePendingMemorySetupRecipe;

async function current(tx, deps, spec) {
  const { input, selection } = spec,
    { ctx } = input;
  const tenants = await tx.$queryRawUnsafe(
    'SELECT slug,settings_jsonb AS settings,xmin::text AS version FROM tenants WHERE id=$1::uuid FOR UPDATE',
    ctx.tenantId,
  );
  const tenant = tenants[0];
  if (
    tenants.length !== 1 ||
    tenant.slug !== ctx.tenantSlug ||
    tenant.settings?.meriFoundationFixture?.fixtureNamespace !== FIXTURE_NAMESPACE
  )
    fail('TENANT_INVALID');
  const rows = await tx.$queryRawUnsafe(
    `SELECT u.clerk_user_id,u.email,u.first_name,u.last_name,tm.role
    FROM users u JOIN tenant_memberships tm ON tm.user_id=u.id
    WHERE u.id=$1::uuid AND tm.tenant_id=$2::uuid AND tm.status='active' FOR SHARE OF u,tm`,
    ctx.userId,
    ctx.tenantId,
  );
  const actor = rows[0];
  if (
    rows.length !== 1 ||
    actor.role !== ctx.role ||
    actor.clerk_user_id !== input.clerkUserId ||
    typeof actor.email !== 'string' ||
    !actor.email.toLowerCase().includes(FIXTURE_NAMESPACE) ||
    !actor.email.toLowerCase().endsWith('@example.com') ||
    !/synthetic/iu.test(`${actor.first_name ?? ''} ${actor.last_name ?? ''}`)
  )
    fail('ACTOR_INVALID');
  for (const id of new Set(selection.records.map((row) => row.clientPhysicalId).filter(Boolean))) {
    const clients = await tx.$queryRawUnsafe(
      'SELECT id FROM clients WHERE id=$1::uuid AND tenant_id=$2::uuid AND status <> $3 FOR SHARE',
      id,
      ctx.tenantId,
      'archived',
    );
    if (clients.length !== 1 || !(await deps.clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, id)))
      fail('CLIENT_WALL');
  }
  return {
    ...tenant,
    operation: tenant.settings.meriFoundationFixture.pendingMemorySetups?.[input.caseId] ?? null,
  };
}

function planned(spec, row) {
  if (row.operation) fail('EXISTING_OPERATION_REQUIRES_RECONCILIATION');
  const body = {
    kind: 'meri-pending-memory-setup-plan',
    schemaVersion: 1,
    caseId: spec.input.caseId,
    recipeSha256: sha256Stable(spec.input),
    manifestContentSha256: spec.manifest.contentSha256,
    tenantRowVersion: row.version,
    priorSettingsSha256: sha256Stable(row.settings),
    sourceIds: spec.selection.records.map((row) => row.logicalId),
    liveAcceptance: 'NOT_RUN',
  };
  return { ...body, planSha256: sha256Stable(body) };
}

const port = (deps, spec) =>
  createMemoryCandidateOwnerPort({ ...deps, actorForTenant: () => spec.selection.proposerUserId });

/** Operator-only context composition for existing source actors. Case17 Priya
 * retains her current reviewer role; case14 Pat remains an ordinary proposer.
 * The current database membership must match before either ALS is installed. */
export async function runWithPendingMemorySetupActor(deps, input, work) {
  const spec = await select(input),
    { ctx } = spec.input;
  if (
    typeof work !== 'function' ||
    typeof deps.runWithMemoryGovernanceTenant !== 'function' ||
    typeof deps.tenantContext?.run !== 'function'
  )
    fail('CONTEXT_PORTS_REQUIRED');
  await deps.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) => current(tx, deps, spec));
  return deps.runWithMemoryGovernanceTenant(ctx.tenantId, () =>
    deps.tenantContext.run({ ...ctx, clerkUserId: input.clerkUserId }, work),
  );
}

async function readRows(owner, spec) {
  const records = [];
  for (const record of spec.selection.records) {
    const actual = await owner.read(record);
    if (
      !actual ||
      actual.payloadSha256 !== record.payloadSha256 ||
      sha256Stable(actual.ownership) !== sha256Stable(record.ownership) ||
      !actual.rowVersion
    )
      fail('OWNER_READBACK_INVALID');
    records.push({
      logicalSourceId: record.logicalId,
      physicalId: actual.physicalId,
      tenantId: actual.tenantId,
      proposerUserId: spec.selection.proposerUserId,
      clientId: record.clientPhysicalId,
      scope:
        record.payload.facts.scope === 'private'
          ? 'personal'
          : record.clientPhysicalId
            ? 'client'
            : 'firm',
      status: 'pending',
      rowVersion: actual.rowVersion,
      payloadSha256: actual.payloadSha256,
      ownershipMarkerSha256: record.ownership.markerSha256,
    });
  }
  return records;
}

export async function inspectPendingMemorySetup(deps, input) {
  const spec = await select(input);
  const plan = await deps.prisma.withTenantUser(input.ctx.tenantId, input.ctx.userId, async (tx) =>
    planned(spec, await current(tx, deps, spec)),
  );
  const owner = port(deps, spec);
  for (const record of spec.selection.records)
    if (await owner.read(record)) fail('EXISTING_CANDIDATE');
  return plan;
}

/** Canonical pending creation only: no review decision, embedding, chat or model call. */
export async function executePendingMemorySetup(deps, input, { expectedPlanSha256, journal } = {}) {
  if (typeof journal !== 'function' || !/^[a-f0-9]{64}$/u.test(expectedPlanSha256 ?? ''))
    fail('PLAN_AND_JOURNAL_REQUIRED');
  const spec = await select(input),
    { ctx } = spec.input;
  const owner = port(deps, spec);
  const plan = await inspectPendingMemorySetup(deps, input);
  if (plan.planSha256 !== expectedPlanSha256) fail('PLAN_STALE');
  const claim = {
    schemaVersion: 1,
    status: 'CLAIMED',
    recipeSha256: sha256Stable(spec.input),
    fixtureInstanceId: input.fixtureInstanceId,
    planSha256: expectedPlanSha256,
    // Source-validated locator only. Restart reads must revalidate canonical rows;
    // this stored recipe is never accepted as an owner receipt or readiness flag.
    locator: spec.input,
  };
  await deps.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
    const row = await current(tx, deps, spec);
    if (planned(spec, row).planSha256 !== expectedPlanSha256) fail('PLAN_STALE');
    const next = structuredClone(row.settings.meriFoundationFixture.pendingMemorySetups ?? {});
    next[input.caseId] = claim;
    const changed = await tx.$queryRawUnsafe(
      `UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,pendingMemorySetups}',$1::jsonb,true)
      WHERE id=$2::uuid AND xmin::text=$3 RETURNING id`,
      stableJson(next),
      ctx.tenantId,
      row.version,
    );
    if (changed.length !== 1) fail('CLAIM_CHANGED');
  });
  try {
    await journal({
      stage: 'CLAIM',
      phase: 'VERIFIED',
      caseId: input.caseId,
      fixtureInstanceId: input.fixtureInstanceId,
    });
    for (const record of spec.selection.records) {
      await journal({
        stage: 'CREATE_PENDING',
        phase: 'INTENT',
        logicalSourceId: record.logicalId,
        physicalId: record.physicalId,
      });
      await owner.create(record, {
        tenantId: ctx.tenantId,
        physicalId: record.physicalId,
        expectedOwnershipMarkerSha256: record.ownership.markerSha256,
        expectedRowVersion: null,
      });
      await journal({
        stage: 'CREATE_PENDING',
        phase: 'ACKNOWLEDGED',
        logicalSourceId: record.logicalId,
        physicalId: record.physicalId,
      });
    }
    const records = await readRows(owner, spec);
    const body = {
      kind: 'meri-pending-memory-setup-receipt',
      schemaVersion: 1,
      caseId: input.caseId,
      status: 'SETUP_COMPLETE',
      recipeSha256: claim.recipeSha256,
      manifestContentSha256: spec.manifest.contentSha256,
      fixtureInstanceId: input.fixtureInstanceId,
      ctx,
      records,
      synthesisSubmissionCount: 0,
      liveAcceptance: 'NOT_RUN',
    };
    const receipt = { ...body, receiptSha256: sha256Stable(body) };
    await deps.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const row = await current(tx, deps, spec);
      if (sha256Stable(row.operation) !== sha256Stable(claim)) fail('CLAIM_CHANGED');
      const next = structuredClone(row.settings.meriFoundationFixture.pendingMemorySetups);
      next[input.caseId] = {
        ...claim,
        status: 'SETUP_COMPLETE',
        receiptSha256: receipt.receiptSha256,
      };
      const changed = await tx.$queryRawUnsafe(
        `UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,pendingMemorySetups}',$1::jsonb,true)
        WHERE id=$2::uuid AND xmin::text=$3 RETURNING id`,
        stableJson(next),
        ctx.tenantId,
        row.version,
      );
      if (changed.length !== 1) fail('CLAIM_CHANGED');
    });
    await journal({ stage: 'COMPLETE', phase: 'VERIFIED', receipt });
    return receipt;
  } catch (error) {
    await journal({
      stage: 'SETUP',
      phase: 'RECONCILIATION_REQUIRED',
      caseId: input.caseId,
      fixtureInstanceId: input.fixtureInstanceId,
    });
    throw error;
  }
}

/** Fresh canonical readback after restart; recipe is only a locator, never a receipt. */
export async function readPendingMemorySetup(deps, input) {
  const spec = await select(input),
    { ctx } = spec.input;
  const row = await deps.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
    current(tx, deps, spec),
  );
  if (
    row.operation?.status !== 'SETUP_COMPLETE' ||
    row.operation.recipeSha256 !== sha256Stable(spec.input) ||
    row.operation.fixtureInstanceId !== input.fixtureInstanceId
  )
    fail('COMPLETED_OWNER_REQUIRED');
  const records = await readRows(port(deps, spec), spec);
  return {
    kind: 'meri-pending-memory-current-readback',
    schemaVersion: 1,
    caseId: input.caseId,
    recipeSha256: row.operation.recipeSha256,
    setupReceiptSha256: row.operation.receiptSha256,
    manifestContentSha256: spec.manifest.contentSha256,
    fixtureInstanceId: input.fixtureInstanceId,
    ctx,
    records,
    currentVerifySha256: sha256Stable(records),
    liveAcceptance: 'NOT_RUN',
  };
}

/** Existing authenticated own-proposal GET only. Ordinary callers are unchanged;
 * only a completed source-owned case17 operation supplies a restart locator. */
export async function readPendingMemoryEvidenceForActor(deps, ctx) {
  if (
    process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== FIXTURE_NAMESPACE ||
    ctx?.tenantId !== AUTHORIZED_TENANTS.T1.id ||
    ctx.tenantSlug !== AUTHORIZED_TENANTS.T1.slug ||
    ctx.role !== 'user_admin'
  )
    return null;
  const rows = await deps.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
    tx.$queryRawUnsafe(
      `SELECT settings_jsonb #> '{meriFoundationFixture,pendingMemorySetups,17}' AS operation
      FROM tenants WHERE id=$1::uuid AND slug=$2`,
      ctx.tenantId,
      ctx.tenantSlug,
    ),
  );
  const operation = rows[0]?.operation;
  if (
    !operation ||
    operation.status !== 'SETUP_COMPLETE' ||
    operation.locator?.ctx?.userId !== ctx.userId
  )
    return null;
  if (
    operation.locator.caseId !== '17' ||
    operation.locator.ctx.tenantId !== ctx.tenantId ||
    operation.locator.ctx.tenantSlug !== ctx.tenantSlug ||
    operation.locator.ctx.role !== ctx.role ||
    operation.locator.clerkUserId !== ctx.clerkUserId
  )
    fail('CURRENT_ACTOR_MISMATCH');
  return readPendingMemorySetup(deps, operation.locator);
}
