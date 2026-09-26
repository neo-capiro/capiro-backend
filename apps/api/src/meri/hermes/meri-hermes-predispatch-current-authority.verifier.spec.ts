import type { Prisma } from '@prisma/client';
import {
  MeriHermesPreDispatchDbCurrentAuthorityV2,
  canonicalMeriHermesToolPolicyV2,
  type MeriHermesPreDispatchPinnedPolicyV2,
} from './meri-hermes-predispatch-current-authority.verifier.js';
import {
  computeMeriPhase4AuthorizationVersionV2,
  MERI_PHASE4_AUTHORIZATION_POLICY_VERSION,
  meriPhase4GrantVersionV2,
} from './meri-hermes-phase4-authorization.contract.js';
import type { MeriHermesPreDispatchAuthorityContextV2 } from './meri-hermes-predispatch-transaction.js';
import { compileMeriHermesToolViewV1 } from './meri-hermes-tool-view.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const conversationId = '33333333-3333-4333-8333-333333333333';
const userMessageId = '44444444-4444-4444-8444-444444444444';
const runId = '55555555-5555-4555-8555-555555555555';
const scopeId = `tenant:${tenantId}:user:${actorId}`;
const now = 1_790_000_000_000_000n;
const catalogTools = ['read', 'meri_memory_search', 'meri_fetch_attachment'].map((name) => ({
  type: 'function' as const,
  function: { name, description: `${name} tool`, parameters: { type: 'object' } },
}));
const toolViewInput = {
  catalogVersion: 'meri-catalog-7', expectedCatalogVersion: 'meri-catalog-7',
  meriCatalogDigest: 'e'.repeat(64), expectedMeriCatalogDigest: 'e'.repeat(64),
  capabilityMappingVersion: 'mapping-7', expectedCapabilityMappingVersion: 'mapping-7',
  capabilityMappingDigest: 'f'.repeat(64), expectedCapabilityMappingDigest: 'f'.repeat(64),
  catalogTools,
  deploymentToolNames: catalogTools.map((tool) => tool.function.name),
  authorizedToolNames: catalogTools.map((tool) => tool.function.name),
  availableToolNames: catalogTools.map((tool) => tool.function.name),
  requiredToolNames: ['read'], relevantToolNames: [], runLocalToolNames: [],
};
const toolView = compileMeriHermesToolViewV1(toolViewInput);
const policy: MeriHermesPreDispatchPinnedPolicyV2 = {
  workerAudience: 'private-worker', workerIngressId: 'ingress-a',
  workerGeneration: 'generation-a', workerCredentialId: 'credential-a',
  workerImageDigest: 'd'.repeat(64), workerBuildId: 'build-a',
  catalogDigest: toolView.catalogDigest, sessionHeaderKeyId: 'key-a',
  meriCatalogVersion: 'meri-catalog-7', meriCatalogDigest: 'e'.repeat(64),
  capabilityMappingVersion: 'mapping-7', capabilityMappingDigest: 'f'.repeat(64),
  sessionHeaderHmacKey: new Uint8Array(32).fill(7),
  maxToolCalls: 40, maxOutputTokens: 8000, maxWallClockMs: 600_000,
  bodyPolicy: () => ({ toolView }),
};
const context: MeriHermesPreDispatchAuthorityContextV2 = {
  intent: { tenantId, actorId, conversationId, runId, idempotencyKey: 'attempt-a',
    body: { input: 'hello' } },
  conversation: { id: conversationId, tenant_id: tenantId, user_id: actorId,
    client_id: null, workspace_id: null, session_epoch_text: null, session_id: null },
  userMessageId, priorIdentity: null, fenceRevision: 7n,
};
const versionAt = (revision: bigint) => computeMeriPhase4AuthorizationVersionV2({
  tenantId, actorId, role: 'standard_user',
  policyVersion: MERI_PHASE4_AUTHORIZATION_POLICY_VERSION,
  grantVersion: meriPhase4GrantVersionV2(revision),
  authorizedClientIds: [], authorizedMailboxConnectionIds: [],
});

function transaction(scopeVersion: string | null, finalRevision: bigint =
  scopeVersion === versionAt(7n) ? 7n : 8n,
bindingOverrides: Record<string, unknown> | null = {}) {
  const rows: unknown[] = [
    [{ role: 'standard_user', tenant_slug: 'tenant', clerk_user_id: 'clerk-actor' }],
    [], [],
    [{ locked: true }],
    scopeVersion === null ? [] : [{ tenant_id: tenantId, principal_type: 'user',
      principal_id: actorId, kind: 'private', authorization_version: scopeVersion }],
    [{ revision: 7n, policy_version: MERI_PHASE4_AUTHORIZATION_POLICY_VERSION }],
    [{ binding_id: '66666666-6666-4666-8666-666666666666',
      enabled: true, closed_at_epoch_micros: null,
      not_before_epoch_micros: now - 1_000_000n,
      not_after_epoch_micros: now + 600_000_000n }],
    bindingOverrides === null ? [] : [{ active: true, not_before_epoch_micros: now - 1_000_000n,
      not_after_epoch_micros: now + 600_000_000n,
      worker_image_digest: policy.workerImageDigest, worker_build_id: policy.workerBuildId,
      worker_catalog_digest_algorithm: 'capiro.meri.phase4.worker-catalog/v1',
      worker_catalog_digest: policy.catalogDigest,
      applied_tool_view_digest_algorithm: 'capiro.meri.phase4.applied-tool-view/v1',
      meri_catalog_version: policy.meriCatalogVersion,
      meri_catalog_digest: policy.meriCatalogDigest,
      capability_mapping_version: policy.capabilityMappingVersion,
      capability_mapping_digest: policy.capabilityMappingDigest,
      tool_view_protocol: 'capiro.meri.phase4.request-local-tool-view/v1',
      claim_attestation_protocol: 'capiro.meri.phase4.claim-tool-view-attestation/v1',
      attestation_credential_id: policy.workerCredentialId, ...bindingOverrides }],
    [{ revision: finalRevision, policy_version: MERI_PHASE4_AUTHORIZATION_POLICY_VERSION }],
    [{ now_epoch_micros: now }],
  ];
  const create = jest.fn().mockResolvedValue({ id: scopeId });
  const update = jest.fn().mockResolvedValue({ id: scopeId });
  const tx = { $queryRaw: jest.fn().mockImplementation(async () => rows.shift() ?? []),
    meriExecutionScope: { create, update } } as unknown as Prisma.TransactionClient;
  return { tx, create, update };
}

describe('dormant pre-dispatch current authority', () => {
  const verifier = new MeriHermesPreDispatchDbCurrentAuthorityV2(policy);

  it('persists the trusted compiled catalog and applied-schema digest meanings', async () => {
    const { tx } = transaction(versionAt(7n));
    const decision = await verifier.deriveAndSyncScope(tx, context);
    expect(decision?.metadata.catalogDigest).toBe(toolView.catalogDigest);
    expect(decision?.metadata.toolViewDigest).toBe(toolView.toolViewDigest);
  });

  it('rejects branded compiler output from a different catalog or capability mapping', async () => {
    for (const driftedView of [
      compileMeriHermesToolViewV1({
        ...toolViewInput,
        catalogVersion: 'meri-catalog-8', expectedCatalogVersion: 'meri-catalog-8',
      }),
      compileMeriHermesToolViewV1({
        ...toolViewInput,
        capabilityMappingVersion: 'mapping-8', expectedCapabilityMappingVersion: 'mapping-8',
        capabilityMappingDigest: '0'.repeat(64),
        expectedCapabilityMappingDigest: '0'.repeat(64),
      }),
    ]) {
      const verifier = new MeriHermesPreDispatchDbCurrentAuthorityV2({
        ...policy, bodyPolicy: () => ({ toolView: driftedView }),
      });
      const { tx } = transaction(versionAt(7n));
      await expect(verifier.deriveAndSyncScope(tx, context)).resolves.toBeNull();
    }
  });

  it('derives one sorted, unique broker ceiling from the same compiled view', async () => {
    const unsorted = { allow: ['meri_memory_search', 'meri_fetch_attachment', 'meri_memory_search'],
      deny: ['meri_publish_artifact', 'meri_memory_propose', 'meri_publish_artifact'],
      readOnly: false };
    const canonical = canonicalMeriHermesToolPolicyV2(unsorted);
    expect(canonical).toEqual({ allow: ['meri_fetch_attachment', 'meri_memory_search'],
      deny: ['meri_memory_propose', 'meri_publish_artifact'], readOnly: false });
    expect(() => canonicalMeriHermesToolPolicyV2({
      allow: [' meri_memory_search'], deny: [], readOnly: false,
    })).toThrow('invalid Phase 4 broker tool policy');
    const brokerView = compileMeriHermesToolViewV1({
      catalogVersion: 'meri-catalog-7', expectedCatalogVersion: 'meri-catalog-7',
      meriCatalogDigest: 'e'.repeat(64), expectedMeriCatalogDigest: 'e'.repeat(64),
      capabilityMappingVersion: 'mapping-7',
      expectedCapabilityMappingVersion: 'mapping-7',
      capabilityMappingDigest: 'f'.repeat(64),
      expectedCapabilityMappingDigest: 'f'.repeat(64),
      catalogTools,
      deploymentToolNames: catalogTools.map((tool) => tool.function.name),
      authorizedToolNames: catalogTools.map((tool) => tool.function.name),
      availableToolNames: catalogTools.map((tool) => tool.function.name),
      requiredToolNames: ['read'],
      relevantToolNames: ['meri_memory_search', 'meri_fetch_attachment'],
      runLocalToolNames: [],
    });
    const withUnsortedPolicy = new MeriHermesPreDispatchDbCurrentAuthorityV2({
      ...policy, bodyPolicy: () => ({ toolView: brokerView }),
    });
    const { tx } = transaction(versionAt(7n));
    const decision = await withUnsortedPolicy.deriveAndSyncScope(tx, context);
    expect(decision?.envelope.toolPolicy).toEqual({
      allow: ['meri_fetch_attachment', 'meri_memory_search'], deny: [], readOnly: false,
    });
    expect(decision?.metadata.toolViewDigest).toBe(brokerView.toolViewDigest);
  });

  it('creates a missing scope with the one-bump final m4a2 generation', async () => {
    const { tx, create, update } = transaction(null);
    const decision = await verifier.deriveAndSyncScope(tx, context);
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({
      id: scopeId, authorizationVersion: versionAt(8n),
    }) });
    expect(update).not.toHaveBeenCalled();
    expect(decision?.metadata.grantVersion).toBe('g2:8');
    expect(decision?.metadata.authorizationVersion).toBe(versionAt(8n));
    expect(decision?.envelope.authorizationVersion).toBe(versionAt(8n));
    expect(decision?.actorContext).toMatchObject({ tenantSlug: 'tenant',
      clerkUserId: 'clerk-actor', role: 'standard_user' });
  });

  it('refreshes a stale scope once and makes no write for a current scope', async () => {
    const stale = transaction('v1:old');
    const changed = await verifier.deriveAndSyncScope(stale.tx, context);
    expect(stale.update).toHaveBeenCalledWith({ where: { id: scopeId },
      data: { authorizationVersion: versionAt(8n) } });
    expect(changed?.metadata.grantVersion).toBe('g2:8');
    const current = transaction(versionAt(7n));
    const unchanged = await verifier.deriveAndSyncScope(current.tx, context);
    expect(current.create).not.toHaveBeenCalled();
    expect(current.update).not.toHaveBeenCalled();
    expect(unchanged?.metadata.grantVersion).toBe('g2:7');
  });

  it('denies a trigger revision other than the one predicted', async () => {
    const { tx, create } = transaction(null, 9n);
    await expect(verifier.deriveAndSyncScope(tx, context)).resolves.toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    // The outer prepare boundary must throw its rollback sentinel on null.
  });

  it('rejects legacy or drifted source-qualified bindings before scope mutation', async () => {
    const legacy = transaction(versionAt(7n), 7n, null);
    await expect(verifier.deriveAndSyncScope(legacy.tx, context)).resolves.toBeNull();
    expect(legacy.update).not.toHaveBeenCalled();
    const drifted = transaction(versionAt(7n), 7n, {
      worker_image_digest: '0'.repeat(64),
    });
    await expect(verifier.deriveAndSyncScope(drifted.tx, context)).resolves.toBeNull();
    expect(drifted.update).not.toHaveBeenCalled();
  });

  it.each([
    ['worker image digest', { worker_image_digest: '0'.repeat(64) }],
    ['worker build ID', { worker_build_id: 'build-b' }],
    ['worker catalog algorithm', { worker_catalog_digest_algorithm: 'wrong' }],
    ['worker catalog digest', { worker_catalog_digest: '0'.repeat(64) }],
    ['applied-view algorithm', { applied_tool_view_digest_algorithm: 'wrong' }],
    ['Meri catalog version', { meri_catalog_version: 'meri-catalog-8' }],
    ['Meri catalog digest', { meri_catalog_digest: '0'.repeat(64) }],
    ['capability mapping version', { capability_mapping_version: 'mapping-8' }],
    ['capability mapping digest', { capability_mapping_digest: '0'.repeat(64) }],
    ['tool-view protocol', { tool_view_protocol: 'wrong' }],
    ['claim-attestation protocol', { claim_attestation_protocol: 'wrong' }],
    ['attestation credential', { attestation_credential_id: 'credential-b' }],
  ] as const)('rejects one-field binding drift in %s', async (_name, bindingOverrides) => {
    const drifted = transaction(versionAt(7n), 7n, bindingOverrides);
    await expect(verifier.deriveAndSyncScope(drifted.tx, context)).resolves.toBeNull();
    expect(drifted.update).not.toHaveBeenCalled();
  });
});
