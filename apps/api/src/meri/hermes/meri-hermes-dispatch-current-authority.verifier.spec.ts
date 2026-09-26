import type { Prisma } from '@prisma/client';
import type { MeriDispatchGateBearerClaimsV1 } from './meri-hermes-dispatch-gate-bearer.js';
import type { MeriDispatchRequestIdentityV2 } from './meri-hermes-dispatch-intent.contract.js';
import type { MeriDispatchLockedContextV2 } from './meri-hermes-dispatch-intent.repository.js';
import { MeriHermesDispatchDbCurrentAuthorityVerifierV2 } from './meri-hermes-dispatch-current-authority.verifier.js';
import {
  computeMeriPhase4AuthorizationVersionV2,
  MERI_PHASE4_AUTHORIZATION_POLICY_VERSION,
  meriPhase4GrantVersionV2,
} from './meri-hermes-phase4-authorization.contract.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const clientId = '33333333-3333-4333-8333-333333333333';
const mailboxId = '44444444-4444-4444-8444-444444444444';
const role = 'standard_user';
const grantVersion = meriPhase4GrantVersionV2(7n);
const authorizationVersion = computeMeriPhase4AuthorizationVersionV2({
  tenantId, actorId, role, policyVersion: MERI_PHASE4_AUTHORIZATION_POLICY_VERSION,
  grantVersion, authorizedClientIds: [clientId],
  authorizedMailboxConnectionIds: [mailboxId],
});
const identity = {
  tenantId, actorType: 'user', actorId, meriAudience: 'private', clientId, workspaceId: null,
  runId: '55555555-5555-4555-8555-555555555555',
  scopeId: `tenant:${tenantId}:user:${actorId}`,
  conversationId: '66666666-6666-4666-8666-666666666666',
  requestSha256: 'a'.repeat(64),
  workerAudience: 'private-worker', workerIngressId: 'ingress-a',
  workerGeneration: 'generation-a', workerCredentialId: 'credential-a',
  catalogDigest: 'a'.repeat(64),
  authorizationVersion,
  authorizationPolicyVersion: MERI_PHASE4_AUTHORIZATION_POLICY_VERSION,
  grantVersion, claimNotAfterEpochMicros: '1791000000000000',
  deliveryNotAfterEpochMicros: '1791000000000000',
  workerCredentialNotAfterEpochMicros: '1791000000000000',
} as unknown as MeriDispatchRequestIdentityV2;
const context = {
  identity, runStatus: 'queued', dispatchStatus: 'pending',
  stopRequestedAt: null, scopeAuthorizationVersion: authorizationVersion,
} as MeriDispatchLockedContextV2;
const claims = {
  tenantId, actorId, scopeId: identity.scopeId, runId: identity.runId,
  requestSha256: identity.requestSha256, authorizationVersion,
  workerAudience: identity.workerAudience, workerIngressId: identity.workerIngressId,
  workerGeneration: identity.workerGeneration, workerCredentialId: identity.workerCredentialId,
} as MeriDispatchGateBearerClaimsV1;

function transaction(options: {
  revision?: bigint;
  clients?: readonly string[];
  routeEnabled?: boolean;
  routeClosed?: boolean;
  bindingActive?: boolean;
  bindingPresent?: boolean;
  bindingImageDigest?: string;
  bindingOverrides?: Readonly<Record<string, unknown>>;
  routeNotBefore?: bigint;
  routeNotAfter?: bigint;
  bindingNotBefore?: bigint;
  bindingNotAfter?: bigint;
  now?: bigint;
  tenantSlug?: string;
  clerkUserId?: string;
  persistedTenantSlug?: string;
  persistedClerkUserId?: string;
} = {}) {
  const rows = [
    [{ revision: options.revision ?? 7n,
      policy_version: MERI_PHASE4_AUTHORIZATION_POLICY_VERSION }],
    [{ role, tenant_slug: options.tenantSlug ?? 'tenant-a',
      clerk_user_id: options.clerkUserId ?? 'clerk-a' }],
    (options.clients ?? [clientId]).map((id) => ({ id })),
    [{ id: mailboxId }],
    [{ status: 'active', archived_at: null,
      envelope_jsonb: { version: 1, tenantId, actorType: identity.actorType, actorId,
        conversationId: identity.conversationId, workspaceId: identity.workspaceId,
        executionScopeId: identity.scopeId, audience: identity.meriAudience,
        runId: identity.runId, authorizationVersion, authorizedClientIds: [clientId],
        authorizedMailboxConnectionIds: [mailboxId],
        issuedAt: '2026-09-24T00:00:00.000Z', expiresAt: '2026-10-03T00:00:00.000Z' },
      actor_context_jsonb: { tenantId, userId: actorId, role,
        tenantSlug: options.persistedTenantSlug ?? 'tenant-a',
        clerkUserId: options.persistedClerkUserId ?? 'clerk-a' } }],
    [{ binding_id: '77777777-7777-4777-8777-777777777777',
      enabled: options.routeEnabled ?? true,
      closed_at_epoch_micros: options.routeClosed ? 1790366300000000n : null,
      not_before_epoch_micros: options.routeNotBefore ?? 1790000000000000n,
      not_after_epoch_micros: options.routeNotAfter ?? 1791000000000000n }],
    options.bindingPresent === false ? [] : [{ active: options.bindingActive ?? true,
      not_before_epoch_micros: options.bindingNotBefore ?? 1790000000000000n,
      not_after_epoch_micros: options.bindingNotAfter ?? 1791000000000000n,
      worker_image_digest: options.bindingImageDigest ?? 'b'.repeat(64),
      worker_build_id: 'build-a',
      worker_catalog_digest_algorithm: 'capiro.meri.phase4.worker-catalog/v1',
      worker_catalog_digest: identity.catalogDigest,
      applied_tool_view_digest_algorithm: 'capiro.meri.phase4.applied-tool-view/v1',
      meri_catalog_version: 'meri-catalog-7', meri_catalog_digest: 'c'.repeat(64),
      capability_mapping_version: 'mapping-7', capability_mapping_digest: 'd'.repeat(64),
      tool_view_protocol: 'capiro.meri.phase4.request-local-tool-view/v1',
      claim_attestation_protocol: 'capiro.meri.phase4.claim-tool-view-attestation/v1',
      attestation_credential_id: identity.workerCredentialId,
      ...options.bindingOverrides }],
    [{ now_epoch_micros: options.now ?? 1790366390000000n }],
  ];
  const query = jest.fn().mockImplementation(async () => rows.shift() ?? []);
  return { tx: { $queryRaw: query } as unknown as Prisma.TransactionClient, query };
}

describe('dormant Phase 4 current authority verifier', () => {
  const verifier = new MeriHermesDispatchDbCurrentAuthorityVerifierV2();

  it('uses the full domain-separated v2 version and canonical sets', () => {
    expect(authorizationVersion).toMatch(/^m4a2:[0-9a-f]{64}$/);
    expect(authorizationVersion).toBe(computeMeriPhase4AuthorizationVersionV2({
      tenantId, actorId, role, policyVersion: MERI_PHASE4_AUTHORIZATION_POLICY_VERSION,
      grantVersion, authorizedClientIds: [clientId],
      authorizedMailboxConnectionIds: [mailboxId],
    }));
    expect(authorizationVersion).not.toMatch(/^v1:/);
    expect(() => computeMeriPhase4AuthorizationVersionV2({
      tenantId, actorId, role, policyVersion: MERI_PHASE4_AUTHORIZATION_POLICY_VERSION,
      grantVersion: 'g2:9223372036854775808', authorizedClientIds: [clientId],
      authorizedMailboxConnectionIds: [mailboxId],
    })).toThrow('invalid current authorization material');
  });

  it('accepts only exact current authority with an open valid route', async () => {
    const { tx, query } = transaction();
    await expect(verifier.verifyCurrentAuthorityInTransaction(
      tx, context, claims, 'worker-run-a',
    )).resolves.toBe(true);
    expect(query).toHaveBeenCalledTimes(8);
    const bindingSql = query.mock.calls[6]?.[0] as { strings?: readonly string[] } | undefined;
    const projected = bindingSql?.strings?.join(' ') ?? '';
    for (const column of [
      'worker_image_digest', 'worker_build_id', 'worker_catalog_digest_algorithm',
      'worker_catalog_digest', 'applied_tool_view_digest_algorithm',
      'meri_catalog_version', 'meri_catalog_digest', 'capability_mapping_version',
      'capability_mapping_digest', 'tool_view_protocol',
      'claim_attestation_protocol', 'attestation_credential_id',
    ]) expect(projected).toContain(column);
  });

  it.each([
    ['revision changed', { revision: 8n }],
    ['selected client missing', { clients: [] }],
    ['route disabled', { routeEnabled: false }],
    ['route closed', { routeClosed: true }],
    ['route binding revoked or unqualified', { bindingActive: false }],
    ['legacy v1 binding has no v2 row', { bindingPresent: false }],
    ['worker image digest is malformed', { bindingImageDigest: 'not-a-digest' }],
    ['tenant slug changed', { tenantSlug: 'tenant-b' }],
    ['Clerk user ID changed', { clerkUserId: 'clerk-b' }],
    ['persisted tenant slug is forged', { persistedTenantSlug: 'tenant-b' }],
    ['persisted Clerk user ID is forged', { persistedClerkUserId: 'clerk-b' }],
  ] as const)('denies when %s', async (_name, options) => {
    const { tx } = transaction(options);
    await expect(verifier.verifyCurrentAuthorityInTransaction(
      tx, context, claims, 'worker-run-a',
    )).resolves.toBe(false);
  });

  it.each([
    ['worker image digest', { worker_image_digest: 'not-a-digest' }],
    ['worker build ID', { worker_build_id: '' }],
    ['worker catalog algorithm', { worker_catalog_digest_algorithm: 'wrong' }],
    ['worker catalog digest', { worker_catalog_digest: '0'.repeat(64) }],
    ['applied-view algorithm', { applied_tool_view_digest_algorithm: 'wrong' }],
    ['Meri catalog version', { meri_catalog_version: '' }],
    ['Meri catalog digest', { meri_catalog_digest: 'not-a-digest' }],
    ['capability mapping version', { capability_mapping_version: '' }],
    ['capability mapping digest', { capability_mapping_digest: 'not-a-digest' }],
    ['tool-view protocol', { tool_view_protocol: 'wrong' }],
    ['claim-attestation protocol', { claim_attestation_protocol: 'wrong' }],
    ['attestation credential', { attestation_credential_id: 'credential-b' }],
  ] as const)('denies one-field binding drift in %s', async (_name, bindingOverrides) => {
    const { tx } = transaction({ bindingOverrides });
    await expect(verifier.verifyCurrentAuthorityInTransaction(
      tx, context, claims, 'worker-run-a',
    )).resolves.toBe(false);
  });

  it.each([
    ['route not active yet', { routeNotBefore: 1790366390000001n }],
    ['route expired', { routeNotAfter: 1790366390000000n }],
    ['binding not active yet', { bindingNotBefore: 1790366390000001n }],
    ['binding expired', { bindingNotAfter: 1790366390000000n }],
  ] as const)('denies when %s', async (_name, options) => {
    const { tx } = transaction(options);
    await expect(verifier.verifyCurrentAuthorityInTransaction(
      tx, context, claims, 'worker-run-a',
    )).resolves.toBe(false);
  });

  it('denies Stop before reading current authority', async () => {
    const { tx, query } = transaction();
    await expect(verifier.verifyCurrentAuthorityInTransaction(
      tx, { ...context, stopRequestedAt: new Date() }, claims, 'worker-run-a',
    )).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});
