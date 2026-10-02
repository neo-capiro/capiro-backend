import { sha256Stable, stableJson } from '../artifact-collector.mjs';
import { buildFixtureManifest } from './manifest.mjs';
import { createCase01MemoryFixtureRuntime } from './case01-memory-runtime.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE, FixtureProvisioningError } from './contract.mjs';

const fail = (code) => {
  throw new FixtureProvisioningError(code, code);
};
const keys = [
  'kind',
  'version',
  'fixtureNamespace',
  'currentFixtureInstanceId',
  'previousFixtureInstanceId',
  'proposerUserId',
  'clients',
  'actors',
  'uploaderActors',
];

/** A locator is not authority: no caller-supplied receipts, versions or ready bits
 * are accepted. Source modules rebuild both frozen manifests and actual owners.
 */
export function case01MemoryOwnerLocator(currentManifest, previousManifest, proposerUserId) {
  return structuredClone({
    kind: 'meri-case01-memory-owner-locator',
    version: 1,
    fixtureNamespace: FIXTURE_NAMESPACE,
    currentFixtureInstanceId: currentManifest.fixtureInstanceId,
    previousFixtureInstanceId: previousManifest.fixtureInstanceId,
    proposerUserId,
    clients: currentManifest.clients,
    actors: currentManifest.actors,
    uploaderActors: currentManifest.uploaderActors,
  });
}

async function reconstruct(tx, ctx, scope, input, deps) {
  const locator = structuredClone(input);
  if (
    !locator ||
    typeof locator !== 'object' ||
    Array.isArray(locator) ||
    stableJson(Object.keys(locator).sort()) !== stableJson([...keys].sort()) ||
    locator.kind !== 'meri-case01-memory-owner-locator' ||
    locator.version !== 1 ||
    locator.fixtureNamespace !== FIXTURE_NAMESPACE ||
    locator.currentFixtureInstanceId === locator.previousFixtureInstanceId ||
    !locator.currentFixtureInstanceId ||
    !locator.previousFixtureInstanceId ||
    locator.proposerUserId !== ctx.userId ||
    ctx.role !== 'standard_user' ||
    ctx.tenantId !== AUTHORIZED_TENANTS.T1.id ||
    ctx.tenantSlug !== AUTHORIZED_TENANTS.T1.slug ||
    scope.caseId !== '01' ||
    locator.clients?.ASTER?.physicalId !== scope.clientId
  )
    fail('CASE01_LOCATOR_SCOPE_INVALID');
  const config = {
    clients: locator.clients,
    actors: locator.actors,
    uploaderActors: locator.uploaderActors,
  };
  const previousManifest = await buildFixtureManifest({
    ...config,
    fixtureInstanceId: locator.previousFixtureInstanceId,
  });
  const currentManifest = await buildFixtureManifest({
    ...config,
    fixtureInstanceId: locator.currentFixtureInstanceId,
  });
  const runtimeDeps = {
    ...deps,
    proposerForTenant: (tenantId) => {
      if (tenantId !== ctx.tenantId) fail('CASE01_LOCATOR_TENANT_INVALID');
      return locator.proposerUserId;
    },
    reviewerForTenant: () => fail('CASE01_HYDRATED_OWNER_READ_ONLY'),
  };
  const previous = createCase01MemoryFixtureRuntime({ ...runtimeDeps, manifest: previousManifest });
  await previous.hydrateInTx(tx, ctx, { lifecycle: 'retired' });
  const current = createCase01MemoryFixtureRuntime({
    ...runtimeDeps,
    manifest: currentManifest,
    previousOwner: previous,
  });
  await current.hydrateInTx(tx, ctx, { lifecycle: 'current' });
  return current.qualifyInTx(tx, ctx, scope);
}

function assertBinding(qualified, binding, ctx, scope) {
  if (
    !binding ||
    qualified.fixtureReady !== true ||
    qualified.missing.length ||
    binding.actorUserId !== ctx.userId ||
    binding.clientId !== scope.clientId ||
    binding.caseId !== scope.caseId ||
    binding.fixtureNamespace !== FIXTURE_NAMESPACE ||
    [
      'fixtureVersion',
      'physicalMapSha256',
      'seedReceiptId',
      'resetReceiptId',
      'currentVerifySha256',
    ].some((key) => binding[key] !== qualified[key])
  )
    fail('CASE01_LOCATOR_BINDING_MISMATCH');
}

async function tenantInTx(tx, ctx) {
  if (
    process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== FIXTURE_NAMESPACE ||
    ctx.tenantId !== AUTHORIZED_TENANTS.T1.id ||
    ctx.tenantSlug !== AUTHORIZED_TENANTS.T1.slug ||
    ctx.role !== 'standard_user'
  )
    fail('CASE01_OWNER_SCOPE_INVALID');
  const rows = await tx.$queryRawUnsafe(
    `SELECT id::text,slug,settings_jsonb AS settings,xmin::text AS version
     FROM tenants WHERE id=$1::uuid FOR UPDATE`,
    ctx.tenantId,
  );
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row.slug !== ctx.tenantSlug ||
    row.settings?.meriFoundationFixture?.fixtureNamespace !== FIXTURE_NAMESPACE
  )
    fail('CASE01_OWNER_NAMESPACE_INVALID');
  const actors = await tx.$queryRawUnsafe(
    `SELECT u.email,u.first_name,u.last_name,tm.role FROM users u
     JOIN tenant_memberships tm ON tm.user_id=u.id
     WHERE u.id=$1::uuid AND tm.tenant_id=$2::uuid AND tm.status='active' FOR SHARE OF u,tm`,
    ctx.userId,
    ctx.tenantId,
  );
  const actor = actors[0];
  if (
    actors.length !== 1 ||
    actor.role !== 'standard_user' ||
    typeof actor.email !== 'string' ||
    !actor.email.toLowerCase().includes(FIXTURE_NAMESPACE) ||
    !actor.email.toLowerCase().endsWith('@example.com') ||
    !/synthetic/iu.test(`${actor.first_name ?? ''} ${actor.last_name ?? ''}`)
  )
    fail('CASE01_OWNER_ACTOR_NOT_CURRENT');
  return row;
}

/** Operator evidence only: the canonical five-source corpus can outlive the
 * active conversation capture binding. Keep every namespace, actor, lifecycle,
 * source-version and permission check; grant no capture or provider authority. */
export async function readCase01MemoryCorpusInTx(deps, tx, ctx, clientId) {
  const row = await tenantInTx(tx, ctx);
  const qualified = await reconstruct(
    tx,
    ctx,
    { caseId: '01', clientId },
    row.settings.meriFoundationFixture.case01MemoryOwner,
    deps,
  );
  return {
    ...qualified,
    evidenceKind: 'canonical-memory-corpus-readback',
    captureAuthority: false,
  };
}

/** Internal server port. Qualifies inside the existing authenticated transaction.
 * Reconstruct each time, so neither tenant configuration nor row versions cache
 * across requests or restarts. Canonical helpers hold the current source locks.
 */
export function createHydratedCase01MemoryOwner(deps) {
  return Object.freeze({
    async qualifyInTx(tx, ctx, scope) {
      const row = await tenantInTx(tx, ctx);
      const fixture = row.settings.meriFoundationFixture;
      const qualified = await reconstruct(tx, ctx, scope, fixture.case01MemoryOwner, deps);
      assertBinding(qualified, fixture.captureEvidence, ctx, scope);
      return qualified;
    },
    // Operator only: the expected prior locator is a CAS token, never evidence.
    // Bind canonical captureEvidence first, then install this replayable locator.
    async installLocatorInTx(
      tx,
      ctx,
      { locator, expectedPriorLocatorSha256, expectedTenantRowVersion },
    ) {
      const row = await tenantInTx(tx, ctx);
      const fixture = row.settings.meriFoundationFixture;
      if (
        row.version !== expectedTenantRowVersion ||
        sha256Stable(fixture.case01MemoryOwner ?? null) !== expectedPriorLocatorSha256
      )
        fail('CASE01_LOCATOR_STALE_PRIOR');
      const scope = { caseId: '01', clientId: fixture.captureEvidence?.clientId };
      const frozenLocator = structuredClone(locator);
      const qualified = await reconstruct(tx, ctx, scope, frozenLocator, deps);
      assertBinding(qualified, fixture.captureEvidence, ctx, scope);
      const rows = await tx.$queryRawUnsafe(
        `UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,case01MemoryOwner}',$1::jsonb,true)
         WHERE id=$2::uuid AND xmin::text=$3 AND settings_jsonb=$4::jsonb
         RETURNING settings_jsonb AS settings,xmin::text AS version`,
        stableJson(frozenLocator),
        ctx.tenantId,
        row.version,
        stableJson(row.settings),
      );
      if (
        rows.length !== 1 ||
        stableJson(rows[0].settings.meriFoundationFixture.case01MemoryOwner) !==
          stableJson(frozenLocator)
      )
        fail('CASE01_LOCATOR_CAS_FAILED');
      return {
        status: 'LOCATOR_INSTALLED',
        locatorSha256: sha256Stable(frozenLocator),
        tenantRowVersion: rows[0].version,
        currentVerifySha256: qualified.currentVerifySha256,
        liveAcceptance: 'NOT_RUN',
      };
    },
  });
}
