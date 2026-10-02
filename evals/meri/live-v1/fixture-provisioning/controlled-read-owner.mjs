import { randomUUID } from 'node:crypto';
import { sha256Stable, stableJson } from '../artifact-collector.mjs';
import { createControlledReadDefinition } from './controlled-read-definitions.mjs';
import {
  AUTHORIZED_TENANTS,
  FIXTURE_NAMESPACE,
  receiptWithHash,
  fixtureReceiptId,
  assertReceiptHash,
} from './contract.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const fail = (code) => {
  throw new Error(`CONTROLLED_READ_OWNER_${code}`);
};
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) =>
  record(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
function scope(ctx, input) {
  if (
    process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== FIXTURE_NAMESPACE ||
    ctx?.tenantId !== AUTHORIZED_TENANTS.T1.id ||
    ctx.tenantSlug !== AUTHORIZED_TENANTS.T1.slug ||
    ctx.role !== 'standard_user' ||
    !UUID.test(ctx.userId ?? '') ||
    typeof ctx.clerkUserId !== 'string' ||
    !ctx.clerkUserId ||
    !['20', '21', '22', '23', '24', '26', '27', '72'].includes(input?.caseId) ||
    !UUID.test(input.clientId ?? '') ||
    !UUID.test(input.captureRunId ?? '')
  )
    fail('SCOPE_INVALID');
  return createControlledReadDefinition({ ...input, tenantId: ctx.tenantId });
}
async function currentRows(tx, ctx, input, lock) {
  const definition = scope(ctx, input);
  const rows = await tx.$queryRawUnsafe(
    `SELECT id::text,slug,settings_jsonb AS settings,xmin::text AS row_version FROM tenants WHERE id=$1::uuid FOR ${lock}`,
    ctx.tenantId,
  );
  const row = rows[0];
  const fixture = row?.settings?.meriFoundationFixture;
  if (
    rows.length !== 1 ||
    row.slug !== ctx.tenantSlug ||
    !record(row.settings) ||
    !record(fixture) ||
    fixture.fixtureNamespace !== FIXTURE_NAMESPACE
  )
    fail('TENANT_INVALID');
  const actors = await tx.$queryRawUnsafe(
    `SELECT u.id::text,u.clerk_user_id,u.email,u.first_name,u.last_name,tm.role
     FROM users u JOIN tenant_memberships tm ON tm.user_id=u.id
     WHERE u.id=$1::uuid AND tm.tenant_id=$2::uuid AND tm.status='active' FOR SHARE OF u,tm`,
    ctx.userId,
    ctx.tenantId,
  );
  const actor = actors[0];
  if (
    actors.length !== 1 ||
    actor.clerk_user_id !== ctx.clerkUserId ||
    actor.role !== 'standard_user' ||
    typeof actor.email !== 'string' ||
    !actor.email.toLowerCase().includes(FIXTURE_NAMESPACE) ||
    !actor.email.toLowerCase().endsWith('@example.com') ||
    !/synthetic/iu.test(`${actor.first_name ?? ''} ${actor.last_name ?? ''}`)
  )
    fail('ACTOR_INVALID');
  const clients = await tx.$queryRawUnsafe(
    'SELECT id::text,tenant_id::text,memory_wall,status FROM clients WHERE tenant_id=$1::uuid AND id=$2::uuid FOR SHARE',
    ctx.tenantId,
    input.clientId,
  );
  const client = clients[0];
  const grants = await tx.$queryRawUnsafe(
    'SELECT user_id::text FROM client_memory_access WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND user_id=$3::uuid FOR SHARE',
    ctx.tenantId,
    input.clientId,
    ctx.userId,
  );
  if (
    clients.length !== 1 ||
    client.tenant_id !== ctx.tenantId ||
    client.status === 'archived' ||
    (client.memory_wall && grants.length !== 1)
  )
    fail('CLIENT_INVALID');
  return {
    row,
    fixture,
    definition,
    actor: { id: actor.id, role: actor.role, clerkUserId: actor.clerk_user_id },
    client: {
      id: client.id,
      tenantId: client.tenant_id,
      memoryWall: client.memory_wall,
      authorized: true,
    },
  };
}
function planFor(ctx, input, current) {
  return {
    kind: 'meri-controlled-read-setup-plan',
    version: 1,
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    clientId: input.clientId,
    caseId: input.caseId,
    captureRunId: input.captureRunId,
    tenantRowVersion: current.row.row_version,
    priorSettingsSha256: sha256Stable(current.row.settings),
    definitionSha256: sha256Stable(current.definition),
    physicalMapSha256: current.definition.physicalMapSha256,
    sourceMap: current.definition.sourceMap,
    sourceStorage: 'immutable_source_owned_controlled_adapter',
    sharedCorpusWrites: 0,
    liveAcceptance: 'NOT_RUN',
  };
}

/** Real owner current readback, including locks on the current actor/client. The
 * persisted locator selects ONLY fixed immutable source code; it supplies no text,
 * error body, ready bit, provider settings or executable path.
 */
export async function qualifyControlledReadInTx(tx, ctx, input) {
  const current = await currentRows(tx, ctx, input, 'SHARE');
  const locator = current.fixture.controlledReadOwner;
  if (
    !exactKeys(locator, [
      'kind',
      'version',
      'caseId',
      'captureRunId',
      'tenantId',
      'actorUserId',
      'clientId',
      'definitionSha256',
      'seedReceipt',
      'resetReceipt',
    ]) ||
    locator.kind !== 'meri-controlled-read-owner' ||
    locator.version !== 1 ||
    locator.caseId !== input.caseId ||
    locator.captureRunId !== input.captureRunId ||
    locator.tenantId !== ctx.tenantId ||
    locator.actorUserId !== ctx.userId ||
    locator.clientId !== input.clientId ||
    locator.definitionSha256 !== sha256Stable(current.definition)
  )
    fail('LOCATOR_INVALID');
  const seed = assertReceiptHash(locator.seedReceipt, 'meri-synthetic-fixture-seed-receipt');
  const reset = assertReceiptHash(locator.resetReceipt, 'meri-synthetic-fixture-reset-receipt');
  if (
    seed.owner !== 'meri_controlled_read_v1' ||
    reset.owner !== seed.owner ||
    seed.operationId !== reset.operationId ||
    !UUID.test(seed.operationId ?? '') ||
    seed.tenantId !== ctx.tenantId ||
    seed.actorUserId !== ctx.userId ||
    seed.clientId !== input.clientId ||
    seed.caseId !== input.caseId ||
    seed.captureRunId !== input.captureRunId ||
    seed.definitionSha256 !== locator.definitionSha256 ||
    seed.physicalMapSha256 !== current.definition.physicalMapSha256 ||
    seed.sourceStorage !== 'immutable_source_owned_controlled_adapter' ||
    reset.scope !== 'replace_owned_capture_binding_and_controlled_locator_only' ||
    reset.sharedCorpusWrites !== 0 ||
    seed.sharedCorpusWrites !== 0 ||
    !/^[a-f0-9]{64}$/u.test(reset.priorSettingsSha256 ?? '')
  )
    fail('RECEIPT_INVALID');
  if (
    current.fixture.controlledReadRuns?.[input.captureRunId]?.operationId !== seed.operationId ||
    current.fixture.controlledReadRuns[input.captureRunId].definitionSha256 !==
      locator.definitionSha256
  )
    fail('RUN_HISTORY_INVALID');
  const currentVerify = {
    kind: 'meri-controlled-read-current-verify',
    version: 1,
    definitionSha256: locator.definitionSha256,
    actor: current.actor,
    client: current.client,
    seedReceiptSha256: locator.seedReceipt.contentSha256,
    resetReceiptSha256: locator.resetReceipt.contentSha256,
  };
  return {
    fixtureReady: true,
    missing: [],
    liveAcceptance: 'NOT_RUN',
    fixtureNamespace: FIXTURE_NAMESPACE,
    fixtureVersion: current.definition.fixtureVersion,
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    clientId: input.clientId,
    caseId: input.caseId,
    captureRunId: input.captureRunId,
    sourceMap: current.definition.sourceMap,
    physicalMapSha256: current.definition.physicalMapSha256,
    currentVerify,
    currentVerifySha256: sha256Stable(currentVerify),
    seedReceiptId: fixtureReceiptId(locator.seedReceipt, 'meri-synthetic-fixture-seed-receipt'),
    resetReceiptId: fixtureReceiptId(locator.resetReceipt, 'meri-synthetic-fixture-reset-receipt'),
    definition: current.definition,
  };
}

export async function inspectControlledReadSetup({ prisma }, { ctx, ...input }) {
  if (!exactKeys(input, ['caseId', 'clientId', 'captureRunId'])) fail('INPUT_FIELDS_INVALID');
  return prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
    const plan = planFor(ctx, input, await currentRows(tx, ctx, input, 'UPDATE'));
    return { ...plan, planSha256: sha256Stable(plan) };
  });
}

/** Operator-only transactional activation. Reset and seed here are actual
 * replacement of this adapter's locator and capture binding, NOT deletion or
 * insertion of global corpus/client source rows. Receipt and binding readback
 * must succeed in the same transaction or everything rolls back.
 */
export async function executeControlledReadSetup({ prisma }, { ctx, ...request }) {
  if (
    !exactKeys(request, [
      'caseId',
      'clientId',
      'captureRunId',
      'expectedPlanSha256',
      'confirmation',
    ]) ||
    request.confirmation !== 'INSTALL_OWNED_CONTROLLED_READ_FIXTURE'
  )
    fail('CONFIRMATION_REQUIRED');
  const input = {
    caseId: request.caseId,
    clientId: request.clientId,
    captureRunId: request.captureRunId,
  };
  return prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
    const current = await currentRows(tx, ctx, input, 'UPDATE');
    if (request.expectedPlanSha256 !== sha256Stable(planFor(ctx, input, current)))
      fail('STALE_PLAN');
    // Reusing a run would silently relabel old messages/receipts; force a fresh run.
    if (
      current.fixture.captureEvidence?.captureRunId === input.captureRunId ||
      current.fixture.controlledReadOwner?.captureRunId === input.captureRunId ||
      Object.hasOwn(current.fixture.controlledReadRuns ?? {}, input.captureRunId)
    )
      fail('RUN_ALREADY_USED');
    const operationId = randomUUID();
    const resetReceipt = receiptWithHash({
      kind: 'meri-synthetic-fixture-reset-receipt',
      owner: 'meri_controlled_read_v1',
      operationId,
      scope: 'replace_owned_capture_binding_and_controlled_locator_only',
      priorSettingsSha256: sha256Stable(current.row.settings),
      sharedCorpusWrites: 0,
    });
    const seedReceipt = receiptWithHash({
      kind: 'meri-synthetic-fixture-seed-receipt',
      owner: 'meri_controlled_read_v1',
      operationId,
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      ...input,
      definitionSha256: sha256Stable(current.definition),
      physicalMapSha256: current.definition.physicalMapSha256,
      sourceStorage: 'immutable_source_owned_controlled_adapter',
      sharedCorpusWrites: 0,
    });
    const locator = {
      kind: 'meri-controlled-read-owner',
      version: 1,
      ...input,
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      definitionSha256: sha256Stable(current.definition),
      seedReceipt,
      resetReceipt,
    };
    const settings = structuredClone(current.row.settings);
    settings.meriFoundationFixture.controlledReadOwner = locator;
    const runs = settings.meriFoundationFixture.controlledReadRuns ?? {};
    if (!record(runs) || Object.keys(runs).length >= 200)
      fail('RUN_HISTORY_RECONCILIATION_REQUIRED');
    settings.meriFoundationFixture.controlledReadRuns = {
      ...runs,
      [input.captureRunId]: { operationId, definitionSha256: locator.definitionSha256 },
    };
    // Prior qualification cannot authorize a differently bound case/run.
    settings.meriFoundationFixture.captureProviderBudget = null;
    settings.meriFoundationFixture.captureEvidence = null;
    const written = await tx.$queryRawUnsafe(
      `UPDATE tenants SET settings_jsonb=$1::jsonb WHERE id=$2::uuid AND xmin::text=$3 AND settings_jsonb=$4::jsonb RETURNING xmin::text AS row_version`,
      stableJson(settings),
      ctx.tenantId,
      current.row.row_version,
      stableJson(current.row.settings),
    );
    if (written.length !== 1) fail('CAS_FAILED');
    const proof = await qualifyControlledReadInTx(tx, ctx, input);
    const binding = {
      caseId: input.caseId,
      captureRunId: input.captureRunId,
      fixtureVersion: proof.fixtureVersion,
      physicalMapSha256: proof.physicalMapSha256,
      seedReceiptId: proof.seedReceiptId,
      resetReceiptId: proof.resetReceiptId,
      fixtureNamespace: FIXTURE_NAMESPACE,
      actorUserId: ctx.userId,
      clientId: input.clientId,
      currentVerifySha256: proof.currentVerifySha256,
    };
    const bound = await tx.$queryRawUnsafe(
      `UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,captureEvidence}',$1::jsonb,true)
       WHERE id=$2::uuid AND xmin::text=$3 RETURNING settings_jsonb AS settings`,
      stableJson(binding),
      ctx.tenantId,
      written[0].row_version,
    );
    if (
      bound.length !== 1 ||
      stableJson(bound[0].settings?.meriFoundationFixture?.captureEvidence) !==
        stableJson(binding) ||
      stableJson(bound[0].settings?.meriFoundationFixture?.controlledReadOwner) !==
        stableJson(locator)
    )
      fail('READBACK_MISMATCH');
    return {
      status: 'CONTROLLED_READ_BOUND',
      operationId,
      binding,
      sourceMap: proof.sourceMap,
      currentVerifySha256: proof.currentVerifySha256,
      seedReceipt,
      resetReceipt,
      sharedCorpusWrites: 0,
      liveAcceptance: 'NOT_RUN',
    };
  });
}
