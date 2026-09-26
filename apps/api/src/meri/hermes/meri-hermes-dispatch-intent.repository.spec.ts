import {
  createMeriDispatchRequestIdentityV2,
  type MeriDispatchRequestIdentityV2,
  type MeriDispatchRequestMaterialV2,
} from './meri-hermes-dispatch-intent.contract.js';
import { MeriHermesDispatchIntentRepository } from './meri-hermes-dispatch-intent.repository.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const MESSAGE = '44444444-4444-4444-8444-444444444444';
const RUN = '55555555-5555-4555-8555-555555555555';
const SCOPE = `tenant:${TENANT}:user:${ACTOR}`;
const DIGEST = 'a'.repeat(64);

const material: MeriDispatchRequestMaterialV2 = {
  metadata: {
    version: 2,
    tenantId: TENANT,
    actorType: 'user',
    actorId: ACTOR,
    meriAudience: 'private',
    clientId: null,
    workspaceId: null,
    scopeId: SCOPE,
    conversationId: CONVERSATION,
    userMessageId: MESSAGE,
    runId: RUN,
    idempotencyKey: 'phase4-repository-spec',
    conversationEpoch: 3,
    workerAudience: 'meri-hermes-scope-worker',
    workerIngressId: 'private-ingress-a',
    workerGeneration: 'worker-image-sha256:2026',
    workerCredentialId: 'worker-credential-2026-09',
    authorizationVersion: 'authorization-v8',
    authorizationPolicyVersion: 'policy-v8',
    grantVersion: 'grant-v4',
    catalogDigest: DIGEST,
    toolViewDigest: 'b'.repeat(64),
    sessionHeaderKeyId: 'dispatch-hmac-2026-09',
    claimNotAfterEpochMicros: '1790366400000000',
    deliveryNotAfterEpochMicros: '1790366460000000',
    workerCredentialNotAfterEpochMicros: '1790366460000000',
    reconciliationNotAfterEpochMicros: '1790456460000000',
    retainUntilEpochMicros: '1790546460000000',
  },
  sourceMessage: {
    body: 'hello source',
    metadata: { runtime: 'hermes', provenance: { mode: 'new' } },
  },
  bodyBytes: Buffer.from('{"input":"hello"}'),
  sessionKeyHeaderValue: `${SCOPE}:conversation:${CONVERSATION}:e3`,
  sessionHeaderHmacKey: Buffer.alloc(32, 7),
};

const identity = createMeriDispatchRequestIdentityV2(material);
const authenticated = () => Promise.resolve({
  authenticated: true as const,
  notAfterEpochMicros: identity.claimNotAfterEpochMicros,
});

function intentRow(
  value: MeriDispatchRequestIdentityV2 = identity,
  state: 'prepared' | 'claimed' | 'sealed_absent' = 'prepared',
) {
  return {
    run_id: value.runId,
    tenant_id: value.tenantId,
    identity_version: value.version,
    actor_type: value.actorType,
    actor_id: value.actorId,
    meri_audience: value.meriAudience,
    client_id: value.clientId,
    workspace_id: value.workspaceId,
    scope_id: value.scopeId,
    conversation_id: value.conversationId,
    user_message_id: value.userMessageId,
    idempotency_key: value.idempotencyKey,
    conversation_epoch: BigInt(value.conversationEpoch),
    worker_audience: value.workerAudience,
    worker_ingress_id: value.workerIngressId,
    worker_generation: value.workerGeneration,
    worker_credential_id: value.workerCredentialId,
    authorization_version: value.authorizationVersion,
    authorization_policy_version: value.authorizationPolicyVersion,
    grant_version: value.grantVersion,
    catalog_digest: value.catalogDigest,
    tool_view_digest: value.toolViewDigest,
    session_header_key_id: value.sessionHeaderKeyId,
    claim_not_after_epoch_micros: BigInt(value.claimNotAfterEpochMicros),
    delivery_not_after_epoch_micros: BigInt(value.deliveryNotAfterEpochMicros),
    worker_credential_not_after_epoch_micros: BigInt(value.workerCredentialNotAfterEpochMicros),
    reconciliation_not_after_epoch_micros: BigInt(value.reconciliationNotAfterEpochMicros),
    retain_until_epoch_micros: BigInt(value.retainUntilEpochMicros),
    source_message_sha256: value.sourceMessageSha256,
    body_length_bytes: BigInt(value.bodyLengthBytes),
    body_sha256: value.bodySha256,
    request_assembly_sha256: value.requestAssemblySha256,
    session_header_hmac_sha256: value.sessionHeaderHmacSha256,
    request_sha256: value.requestSha256,
    state,
    worker_run_id: state === 'claimed' ? 'worker-run-1' : null,
    claimed_at_epoch_micros: state === 'claimed' ? 1790366399000000n : null,
    sealed_absent_at_epoch_micros: state === 'sealed_absent' ? 1790456460000001n : null,
    absence_proof_sha256: state === 'sealed_absent' ? DIGEST : null,
    tombstoned_at_epoch_micros: null,
  };
}

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    run_id: RUN,
    tenant_id: TENANT,
    scope_id: SCOPE,
    actor_id: ACTOR,
    conversation_id: CONVERSATION,
    user_message_id: MESSAGE,
    idempotency_key: identity.idempotencyKey,
    run_status: 'provisioning',
    dispatch_status: 'pending',
    existing_worker_run_id: null,
    stop_requested_at: null,
    envelope_authorization_version: identity.authorizationVersion,
    scope_principal_type: 'user',
    scope_principal_id: ACTOR,
    scope_kind: 'private',
    scope_authorization_version: identity.authorizationVersion,
    conversation_user_id: ACTOR,
    conversation_client_id: null,
    conversation_workspace_id: null,
    conversation_epoch_text: '3',
    message_tenant_id: TENANT,
    message_user_id: ACTOR,
    message_client_id: null,
    message_conversation_id: CONVERSATION,
    message_role: 'user',
    message_body: material.sourceMessage.body,
    message_metadata_jsonb: material.sourceMessage.metadata,
    ...overrides,
  };
}

function fixture(responses: unknown[], bearerActive = true) {
  const tx = { $queryRaw: jest.fn(async (query?: { strings: readonly string[] }) => {
    const sql = query?.strings.join('?') ?? '';
    if (sql.includes('meri_phase4_lock_authority_fence')) return [{ revision: 7n }];
    if (sql.includes('AS bearer_active')) return [{ bearer_active: bearerActive }];
    return responses.shift();
  }) };
  const prisma = {
    withTenant: jest.fn(async (_tenant: string, callback: (value: typeof tx) => unknown) => callback(tx)),
  };
  return { repo: new MeriHermesDispatchIntentRepository(prisma as never), tx, prisma };
}

describe('dormant Phase 4 dispatch intent repository', () => {
  test('resolves an exact durable replay without consulting mutable source rows', async () => {
    const exact = fixture([[intentRow(identity, 'claimed')]]);
    await expect(exact.repo.resolveReplayInTransaction(exact.tx as never, identity)).resolves.toMatchObject({
      kind: 'status_only', observation: { intent: { state: 'claimed' } },
    });
    expect(exact.tx.$queryRaw).toHaveBeenCalledTimes(1);

    const conflict = fixture([[intentRow({ ...identity, requestSha256: 'f'.repeat(64) })]]);
    await expect(conflict.repo.resolveReplayInTransaction(conflict.tx as never, identity)).resolves.toEqual({
      kind: 'rejected', reason: 'identity_conflict',
    });

    const dormantV1 = fixture([[{ ...intentRow(), identity_version: 1 }]]);
    await expect(dormantV1.repo.resolveReplayInTransaction(dormantV1.tx as never, identity)).resolves.toEqual({
      kind: 'rejected', reason: 'identity_conflict',
    });
  });

  test('prepares only against locked exact source rows and treats an exact replay as status-only', async () => {
    const inserted = fixture([[sourceRow({ run_status: 'queued' })], [intentRow()]]);
    await expect(inserted.repo.prepareInTransaction(inserted.tx as never, identity)).resolves.toMatchObject({
      kind: 'inserted', observation: { kind: 'known', intent: { state: 'prepared' } },
    });

    const replay = fixture([[sourceRow({ run_status: 'queued' })], [], [intentRow()]]);
    await expect(replay.repo.prepareInTransaction(replay.tx as never, identity)).resolves.toMatchObject({
      kind: 'status_only', observation: { intent: { state: 'prepared' } },
    });
  });

  test('returns a newly claimed persistence fact once; exact duplicate is status-only', async () => {
    const claimed = intentRow(identity, 'claimed');
    const first = fixture([[sourceRow()], [intentRow()], [{ id: RUN }], [claimed]]);
    const verify = jest.fn(async () => true);
    const authenticate = jest.fn(async (_tx: unknown, _context: { identity: MeriDispatchRequestIdentityV2 }) =>
      authenticated());
    await expect(first.repo.claim({
      tenantId: TENANT, runId: RUN, requestSha256: identity.requestSha256, workerRunId: 'worker-run-1',
    }, authenticate, verify)).resolves.toMatchObject({
      kind: 'transitioned', observation: { intent: { state: 'claimed', workerRunId: 'worker-run-1' } },
    });
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(authenticate.mock.calls[0]![1])).toBe(true);
    expect(Object.isFrozen(authenticate.mock.calls[0]![1].identity)).toBe(true);
    for (const call of first.tx.$queryRaw.mock.calls.slice(3)) {
      expect(call[0]?.strings.join('?')).toContain('clock_timestamp()');
      expect(call[0]?.strings.join('?')).toContain('::bigint');
    }

    const duplicate = fixture([[sourceRow({ existing_worker_run_id: 'worker-run-1' })], [claimed]]);
    const duplicateVerify = jest.fn(async () => true);
    const duplicateAuthenticate = jest.fn(authenticated);
    await expect(duplicate.repo.claim({
      tenantId: TENANT, runId: RUN, requestSha256: identity.requestSha256, workerRunId: 'worker-run-1',
    }, duplicateAuthenticate, duplicateVerify)).resolves.toMatchObject({ kind: 'status_only' });
    expect(duplicateAuthenticate).toHaveBeenCalledTimes(1);
    expect(duplicateVerify).not.toHaveBeenCalled();
  });

  test('rejects different claim IDs/digests and never converts an ambiguous commit to durable state', async () => {
    const differentId = fixture([[sourceRow({ existing_worker_run_id: 'worker-run-1' })],
      [intentRow(identity, 'claimed')]]);
    await expect(differentId.repo.claim({
      tenantId: TENANT, runId: RUN, requestSha256: identity.requestSha256, workerRunId: 'worker-run-2',
    }, authenticated, async () => true)).resolves.toEqual({ kind: 'rejected', reason: 'different_worker_run_id' });

    const differentDigest = fixture([[sourceRow()], [intentRow()]]);
    await expect(differentDigest.repo.claim({
      tenantId: TENANT, runId: RUN, requestSha256: 'f'.repeat(64), workerRunId: 'worker-run-1',
    }, authenticated, async () => true)).resolves.toEqual({ kind: 'rejected', reason: 'identity_conflict' });

    const uncertain = fixture([]);
    uncertain.prisma.withTenant.mockRejectedValueOnce(new Error('connection lost after commit boundary'));
    await expect(uncertain.repo.claim({
      tenantId: TENANT, runId: RUN, requestSha256: identity.requestSha256, workerRunId: 'worker-run-1',
    }, authenticated, async () => true)).resolves.toEqual({ version: 2, kind: 'UNKNOWN', reason: 'commit_unconfirmed' });
  });

  test('authenticates before digest and state branches and treats denial/errors as closed', async () => {
    const claimed = fixture([[sourceRow({ existing_worker_run_id: 'worker-run-1' })],
      [intentRow(identity, 'claimed')]]);
    const denied = jest.fn(async () => false as const);
    await expect(claimed.repo.claim({
      tenantId: TENANT, runId: RUN, requestSha256: identity.requestSha256, workerRunId: 'worker-run-1',
    }, denied, async () => true)).resolves.toEqual({ kind: 'rejected', reason: 'verification_denied' });
    expect(denied).toHaveBeenCalledTimes(1);

    const expired = fixture([[sourceRow({ existing_worker_run_id: 'worker-run-1' })],
      [intentRow(identity, 'claimed')]], false);
    await expect(expired.repo.claim({
      tenantId: TENANT, runId: RUN, requestSha256: identity.requestSha256, workerRunId: 'worker-run-1',
    }, authenticated, async () => true)).resolves.toEqual({
      kind: 'rejected', reason: 'verification_denied',
    });

    const wrongDigest = fixture([[sourceRow()], [intentRow()]]);
    const checked = jest.fn(authenticated);
    await expect(wrongDigest.repo.claim({
      tenantId: TENANT, runId: RUN, requestSha256: 'f'.repeat(64), workerRunId: 'worker-run-1',
    }, checked, async () => true)).resolves.toEqual({ kind: 'rejected', reason: 'identity_conflict' });
    expect(checked).toHaveBeenCalledTimes(1);

    const error = fixture([[sourceRow()], [intentRow()]]);
    await expect(error.repo.claim({
      tenantId: TENANT, runId: RUN, requestSha256: identity.requestSha256, workerRunId: 'worker-run-1',
    }, async () => { throw new Error('key resolver unavailable'); }, async () => true))
      .resolves.toEqual({ version: 2, kind: 'UNKNOWN', reason: 'commit_unconfirmed' });
  });

  test('rejects invalid authenticated deadline and rolls back either expired conditional write', async () => {
    const badDeadline = fixture([[sourceRow()], [intentRow()]]);
    await expect(badDeadline.repo.claim({
      tenantId: TENANT, runId: RUN, requestSha256: identity.requestSha256, workerRunId: 'worker-run-1',
    }, async () => ({ authenticated: true, notAfterEpochMicros: '0' }), async () => true))
      .resolves.toEqual({ kind: 'rejected', reason: 'verification_denied' });
    expect(badDeadline.tx.$queryRaw).toHaveBeenCalledTimes(3);

    const expiredBeforeBind = fixture([[sourceRow()], [intentRow()], []]);
    await expect(expiredBeforeBind.repo.claim({
      tenantId: TENANT, runId: RUN, requestSha256: identity.requestSha256, workerRunId: 'worker-run-1',
    }, authenticated, async () => true)).resolves.toEqual({
      version: 2, kind: 'UNKNOWN', reason: 'commit_unconfirmed',
    });

    const expiredBetweenWrites = fixture([[sourceRow()], [intentRow()], [{ id: RUN }], []]);
    await expect(expiredBetweenWrites.repo.claim({
      tenantId: TENANT, runId: RUN, requestSha256: identity.requestSha256, workerRunId: 'worker-run-1',
    }, authenticated, async () => true)).resolves.toEqual({
      version: 2, kind: 'UNKNOWN', reason: 'commit_unconfirmed',
    });
    expect(expiredBetweenWrites.tx.$queryRaw).toHaveBeenCalledTimes(6);
  });

  test('does not expose the former unsigned generic absence transition', () => {
    expect('sealAbsent' in MeriHermesDispatchIntentRepository.prototype).toBe(false);
  });
});
