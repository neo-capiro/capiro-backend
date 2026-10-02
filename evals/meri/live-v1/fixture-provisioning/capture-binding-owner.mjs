import { sha256Stable, stableJson } from '../artifact-collector.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE, FixtureProvisioningError } from './contract.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const fail = (code) => {
  throw new FixtureProvisioningError(code, code);
};
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);

/** Server composition only. sourceAuthority is an owner service, never request data.
 * Its qualifyInTx must hold source/version/authorization locks on this transaction.
 * No route, CLI, credential reader, HMAC signer or live capture admission is added.
 */
export function createCaptureBindingOwner({ prisma, sourceAuthority }) {
  if (
    typeof prisma?.withTenantUser !== 'function' ||
    typeof sourceAuthority?.qualifyInTx !== 'function'
  )
    fail('CAPTURE_BINDING_OWNER_INCOMPLETE');

  async function locked(request, apply) {
    const input = structuredClone(request);
    const tenant = Object.values(AUTHORIZED_TENANTS).find((value) => value.id === input?.tenantId);
    if (
      !tenant ||
      tenant.slug !== input.tenantSlug ||
      !UUID.test(input.actorUserId ?? '') ||
      typeof input.clerkUserId !== 'string' ||
      !input.clerkUserId ||
      !UUID.test(input.clientId ?? '') ||
      input.caseId !== '01' ||
      !UUID.test(input.captureRunId ?? '')
    )
      fail('CAPTURE_BINDING_SCOPE_INVALID');
    if (
      apply &&
      (!HASH.test(input.expectedPriorBindingSha256 ?? '') ||
        !/^[0-9]{1,10}$/u.test(input.expectedTenantRowVersion ?? '') ||
        !HASH.test(input.expectedCurrentVerifySha256 ?? ''))
    )
      fail('CAPTURE_BINDING_CAS_REQUIRED');
    return prisma.withTenantUser(tenant.id, input.actorUserId, async (tx) => {
      const tenants = await tx.$queryRawUnsafe(
        'SELECT id::text,slug,settings_jsonb AS settings,xmin::text AS row_version FROM tenants WHERE id=$1::uuid FOR UPDATE',
        tenant.id,
      );
      const row = tenants[0];
      const fixture = row?.settings?.meriFoundationFixture;
      if (
        tenants.length !== 1 ||
        row.id !== tenant.id ||
        row.slug !== tenant.slug ||
        !record(row.settings) ||
        !record(fixture) ||
        fixture.fixtureNamespace !== FIXTURE_NAMESPACE
      )
        fail('CAPTURE_BINDING_TENANT_OWNER_MISMATCH');
      const actors = await tx.$queryRawUnsafe(
        `SELECT u.id::text,u.clerk_user_id,u.email,u.first_name,u.last_name,tm.role
         FROM users u JOIN tenant_memberships tm ON tm.user_id=u.id
         WHERE u.id=$1::uuid AND tm.tenant_id=$2::uuid AND tm.status='active'
         FOR SHARE OF u,tm`,
        input.actorUserId,
        tenant.id,
      );
      const actor = actors[0];
      if (
        actors.length !== 1 ||
        actor.clerk_user_id !== input.clerkUserId ||
        actor.role !== 'standard_user' ||
        typeof actor.email !== 'string' ||
        !actor.email.toLowerCase().includes(FIXTURE_NAMESPACE) ||
        !actor.email.toLowerCase().endsWith('@example.com') ||
        !/synthetic/iu.test(`${actor.first_name ?? ''} ${actor.last_name ?? ''}`)
      )
        fail('CAPTURE_BINDING_ACTOR_NOT_CURRENT');
      const clients = await tx.$queryRawUnsafe(
        'SELECT id::text,tenant_id::text,memory_wall FROM clients WHERE id=$1::uuid AND tenant_id=$2::uuid FOR SHARE',
        input.clientId,
        tenant.id,
      );
      const grants = await tx.$queryRawUnsafe(
        'SELECT user_id::text FROM client_memory_access WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND user_id=$3::uuid FOR SHARE',
        tenant.id,
        input.clientId,
        actor.id,
      );
      if (
        clients.length !== 1 ||
        clients[0].tenant_id !== tenant.id ||
        (clients[0].memory_wall && grants.length === 0)
      )
        fail('CAPTURE_BINDING_CLIENT_NOT_CURRENT');
      const prior = Object.hasOwn(fixture, 'captureEvidence') ? fixture.captureEvidence : null;
      const priorHash = sha256Stable(prior);
      if (
        apply &&
        (input.expectedTenantRowVersion !== row.row_version ||
          input.expectedPriorBindingSha256 !== priorHash)
      )
        fail('CAPTURE_BINDING_STALE_PRIOR');
      const ctx = {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        userId: actor.id,
        clerkUserId: actor.clerk_user_id,
        role: actor.role,
      };
      const qualified = await sourceAuthority.qualifyInTx(tx, ctx, {
        caseId: input.caseId,
        clientId: input.clientId,
      });
      if (
        !record(qualified) ||
        qualified.tenantId !== tenant.id ||
        qualified.actorUserId !== actor.id ||
        qualified.clientId !== input.clientId ||
        qualified.caseId !== input.caseId ||
        qualified.fixtureNamespace !== FIXTURE_NAMESPACE ||
        !record(qualified.sourceMap) ||
        qualified.physicalMapSha256 !== sha256Stable(qualified.sourceMap) ||
        !record(qualified.currentVerify) ||
        qualified.currentVerifySha256 !== sha256Stable(qualified.currentVerify)
      )
        fail('CAPTURE_BINDING_OWNER_PROOF_INVALID');
      const base = {
        status: 'NOT_READY',
        fixtureReady: false,
        tenantId: tenant.id,
        expectedTenantRowVersion: row.row_version,
        expectedPriorBindingSha256: priorHash,
        currentVerifySha256: qualified.currentVerifySha256,
        physicalMapSha256: qualified.physicalMapSha256,
        missing: [...(qualified.missing ?? [])],
        liveAcceptance: 'NOT_RUN',
      };
      // Even an apparently valid seed hash is not permission to activate a partial corpus.
      if (qualified.fixtureReady !== true || base.missing.length) return base;
      if (
        typeof qualified.fixtureVersion !== 'string' ||
        !qualified.fixtureVersion ||
        typeof qualified.seedReceiptId !== 'string' ||
        !qualified.seedReceiptId ||
        typeof qualified.resetReceiptId !== 'string' ||
        !qualified.resetReceiptId
      )
        fail('CAPTURE_BINDING_SEED_RESET_AUTHORITY_MISSING');
      if (!apply) return { ...base, status: 'READY', fixtureReady: true };
      if (input.expectedCurrentVerifySha256 !== qualified.currentVerifySha256)
        fail('CAPTURE_BINDING_SOURCE_CHANGED');
      const binding = {
        caseId: input.caseId,
        captureRunId: input.captureRunId,
        fixtureVersion: qualified.fixtureVersion,
        physicalMapSha256: qualified.physicalMapSha256,
        seedReceiptId: qualified.seedReceiptId,
        resetReceiptId: qualified.resetReceiptId,
        fixtureNamespace: FIXTURE_NAMESPACE,
        actorUserId: actor.id,
        clientId: input.clientId,
        currentVerifySha256: qualified.currentVerifySha256,
      };
      const result = await tx.$queryRawUnsafe(
        `UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,captureEvidence}',$1::jsonb,true)
         WHERE id=$2::uuid AND slug=$3 AND xmin::text=$4
           AND settings_jsonb=$5::jsonb
         RETURNING settings_jsonb AS settings,xmin::text AS row_version`,
        stableJson(binding),
        tenant.id,
        tenant.slug,
        row.row_version,
        stableJson(row.settings),
      );
      if (
        result.length !== 1 ||
        stableJson(result[0].settings?.meriFoundationFixture?.captureEvidence) !==
          stableJson(binding)
      )
        fail('CAPTURE_BINDING_CAS_FAILED');
      return {
        ...base,
        status: 'BOUND',
        fixtureReady: true,
        binding,
        bindingSha256: sha256Stable(binding),
        tenantRowVersion: result[0].row_version,
      };
    });
  }
  return Object.freeze({
    inspect: (request) => locked(request, false),
    bind: (request) => locked(request, true),
  });
}
