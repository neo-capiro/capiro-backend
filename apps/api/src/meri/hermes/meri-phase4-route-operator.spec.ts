import {
  MeriPhase4BindingCommitUnknownError,
  MeriPhase4OperatorCommitUnknownError,
  MeriPhase4RouteOperatorGrantIssuerV1,
  MeriPhase4WorkerBindingAttestorV1,
  MeriPhase4WorkerRouteOperatorV1,
  type MeriPhase4OperatorDatabaseV1,
  type MeriPhase4GrantIssuerDatabaseV1,
  type MeriPhase4OperatorTransactionV1,
} from './meri-phase4-route-operator.js';
import type {
  MeriPhase4AttestBindingV1,
  MeriPhase4AttestBindingV2,
  MeriPhase4ProvisionRouteV1,
  MeriPhase4RevokeBindingV1,
  MeriPhase4RotateRouteV1,
  MeriPhase4RouteIdentityV1,
  MeriPhase4TrustedBindingAttestorV1,
  MeriPhase4TrustedOperatorContextV1,
} from './meri-phase4-route-operator.contract.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorUserId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const requestId = '44444444-4444-4444-8444-444444444444';
const bindingId = '55555555-5555-4555-8555-555555555555';
const revocationId = '88888888-8888-4888-8888-888888888888';
const grantId = '99999999-9999-4999-8999-999999999999';
const grantNonce = 'b'.repeat(64);
const scopeId = `tenant:${tenantId}:user:66666666-6666-4666-8666-666666666666`;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe('dormant Phase 4 route operator immutable snapshots', () => {
  it('derives a frozen trusted context from the database grant issuer', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let receivedParameters: readonly unknown[] | undefined;
    const database: MeriPhase4GrantIssuerDatabaseV1 = {
      async withRouteGrantIssuerTransaction(run) {
        entered.resolve();
        await release.promise;
        return run({
          async query(_sql, parameters) {
            receivedParameters = parameters;
            return [{
              grant_id: grantId,
              tenant_id: tenantId,
              actor_user_id: actorUserId,
              impersonation_session_id: sessionId,
              reason: 'Approved database-derived grant test',
              operation: 'provision',
              request_id: requestId,
              request_digest: 'a'.repeat(64),
              grant_nonce: grantNonce,
              expires_at_epoch_micros: '100',
            }] as never;
          },
        });
      },
    };
    const request = {
      tenantId, impersonationSessionId: sessionId, operation: 'provision' as const,
      requestId, requestDigest: 'a'.repeat(64),
    };

    const pending = new MeriPhase4RouteOperatorGrantIssuerV1(database).issue(request);
    await entered.promise;
    (request as { tenantId: string }).tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    (request as { requestDigest: string }).requestDigest = 'f'.repeat(64);
    release.resolve();

    const context = await pending;
    expect(context).toEqual({
      role: 'capiro_admin', tenantId, actorUserId,
      impersonationSessionId: sessionId,
      reason: 'Approved database-derived grant test',
      grantId, grantNonce, grantOperation: 'provision',
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(receivedParameters).toEqual([
      tenantId, sessionId, 'provision', requestId, 'a'.repeat(64),
    ]);
    expect(Object.isFrozen(receivedParameters!)).toBe(true);
  });

  it('uses a frozen operator context, command and SQL parameter snapshot after yielding', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let receivedContext: MeriPhase4TrustedOperatorContextV1 | undefined;
    let receivedParameters: readonly unknown[] | undefined;
    const database: MeriPhase4OperatorDatabaseV1 = {
      async withVerifiedOperatorTransaction(context, run) {
        receivedContext = context;
        entered.resolve();
        await release.promise;
        const tx: MeriPhase4OperatorTransactionV1 = {
          async query(_sql, parameters) {
            receivedParameters = parameters;
            const digest = String(parameters[6]);
            return [{
              receipt_id: '77777777-7777-4777-8777-777777777777',
              tenant_id: tenantId,
              request_id: requestId,
              request_digest: digest,
              operation: 'provision',
              outcome: 'changed',
              actor_user_id: actorUserId,
              impersonation_session_id: sessionId,
              reason: 'Approved route provisioning test',
              scope_id: scopeId,
              worker_audience: 'meri-hermes-scope-worker',
              worker_ingress_id: 'ingress-a',
              old_generation: null,
              old_credential_id: null,
              new_generation: 'generation-a',
              new_credential_id: 'credential-a',
              binding_id: bindingId,
              occurred_at_epoch_micros: '10',
              fence_revision: '1',
            }] as never;
          },
        };
        return run(tx);
      },
      async withAuthenticatedBindingAttestor() {
        throw new Error('unexpected attestor transaction');
      },
    };
    const context = {
      role: 'capiro_admin', tenantId, actorUserId,
      impersonationSessionId: sessionId,
      reason: 'Approved route provisioning test',
      grantId, grantNonce, grantOperation: 'provision',
    } as MeriPhase4TrustedOperatorContextV1;
    const command: MeriPhase4ProvisionRouteV1 = {
      requestId, bindingId, lifetimeMicros: 60_000_000n,
    };

    const pending = new MeriPhase4WorkerRouteOperatorV1(database)
      .provisionDisabled(context, command);
    await entered.promise;
    (context as { tenantId: string }).tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    (context as { reason: string }).reason = 'Mutated after the boundary';
    (command as { bindingId: string }).bindingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    (command as { lifetimeMicros: bigint }).lifetimeMicros = 1n;
    release.resolve();

    const result = await pending;
    expect(result.kind).toBe('receipt');
    expect(receivedContext).not.toBe(context);
    expect(receivedContext).toBeDefined();
    expect(Object.isFrozen(receivedContext!)).toBe(true);
    expect(receivedContext).toMatchObject({
      tenantId, actorUserId, impersonationSessionId: sessionId,
      reason: 'Approved route provisioning test',
      grantId, grantNonce, grantOperation: 'provision',
    });
    expect(receivedParameters).toBeDefined();
    expect(Object.isFrozen(receivedParameters!)).toBe(true);
    expect(receivedParameters?.slice(0, 6)).toEqual([
      tenantId, grantId, grantNonce, requestId, bindingId, '60000000',
    ]);
    expect(Object.isFrozen(context)).toBe(false);
    expect(Object.isFrozen(command)).toBe(false);
  });

  it('uses frozen attestor and attestation snapshots inside the delayed callback', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let receivedAttestor: MeriPhase4TrustedBindingAttestorV1 | undefined;
    let receivedParameters: readonly unknown[] | undefined;
    const database: MeriPhase4OperatorDatabaseV1 = {
      async withVerifiedOperatorTransaction() {
        throw new Error('unexpected operator transaction');
      },
      async withAuthenticatedBindingAttestor(attestor, selectedTenantId, run) {
        receivedAttestor = attestor;
        expect(selectedTenantId).toBe(tenantId);
        entered.resolve();
        await release.promise;
        return run({
          async query(_sql, parameters) {
            receivedParameters = parameters;
            return [{
              binding_id: bindingId,
              tenant_id: tenantId,
              source_id: 'source-a',
              external_record_id: 'record-a',
              attestation_sha256: 'a'.repeat(64),
              revoked_at_epoch_micros: null,
            }] as never;
          },
        });
      },
    };
    const attestor: MeriPhase4TrustedBindingAttestorV1 = {
      sourceId: 'source-a', producerRole: 'meri_phase4_attestor_source_a',
    };
    const command: MeriPhase4AttestBindingV1 = {
      bindingId, externalRecordId: 'record-a', tenantId, scopeId,
      ingressId: 'ingress-a', generation: 'generation-a', credentialId: 'credential-a',
      notBeforeEpochMicros: 10n, notAfterEpochMicros: 60_000_010n,
    };

    const pending = new MeriPhase4WorkerBindingAttestorV1(database).attest(attestor, command);
    await entered.promise;
    (attestor as { sourceId: string }).sourceId = 'source-mutated';
    (command as { tenantId: string }).tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    (command as { credentialId: string }).credentialId = 'credential-mutated';
    (command as { notAfterEpochMicros: bigint }).notAfterEpochMicros = 11n;
    release.resolve();

    await expect(pending).resolves.toMatchObject({
      kind: 'receipt',
      receipt: { bindingId, tenantId, sourceId: 'source-a', externalRecordId: 'record-a' },
    });
    expect(receivedAttestor).not.toBe(attestor);
    expect(receivedAttestor).toBeDefined();
    expect(Object.isFrozen(receivedAttestor!)).toBe(true);
    expect(receivedAttestor).toEqual({
      sourceId: 'source-a', producerRole: 'meri_phase4_attestor_source_a',
    });
    expect(receivedParameters).toBeDefined();
    expect(Object.isFrozen(receivedParameters!)).toBe(true);
    expect(receivedParameters).toEqual([
      bindingId, 'source-a', 'record-a', tenantId, scopeId, 'ingress-a',
      'generation-a', 'credential-a', '10', '60000010',
    ]);
    expect(Object.isFrozen(attestor)).toBe(false);
    expect(Object.isFrozen(command)).toBe(false);
  });

  it('submits a complete immutable source-qualified binding v2 command', async () => {
    let receivedSql = '';
    let receivedParameters: readonly unknown[] = [];
    const database: MeriPhase4OperatorDatabaseV1 = {
      async withVerifiedOperatorTransaction() { throw new Error('unexpected route transaction'); },
      async withAuthenticatedBindingAttestor(_attestor, selectedTenantId, run) {
        expect(selectedTenantId).toBe(tenantId);
        return run({ async query(sql, parameters) {
          receivedSql = sql;
          receivedParameters = parameters;
          return [{ binding_id: bindingId, tenant_id: tenantId, source_id: 'source-a',
            external_record_id: 'record-v2', attestation_sha256: 'a'.repeat(64),
            revoked_at_epoch_micros: null }] as never;
        } });
      },
    };
    const command: MeriPhase4AttestBindingV2 = {
      bindingId, externalRecordId: 'record-v2', tenantId, scopeId,
      ingressId: 'ingress-a', generation: 'generation-a', credentialId: 'credential-a',
      notBeforeEpochMicros: 10n, notAfterEpochMicros: 60_000_010n,
      bindingVersion: 2, workerImageDigest: 'b'.repeat(64), workerBuildId: 'build-a',
      workerCatalogDigestAlgorithm: 'capiro.meri.phase4.worker-catalog/v1',
      workerCatalogDigest: 'c'.repeat(64),
      appliedToolViewDigestAlgorithm: 'capiro.meri.phase4.applied-tool-view/v1',
      meriCatalogVersion: 'catalog-7', meriCatalogDigest: 'd'.repeat(64),
      capabilityMappingVersion: 'mapping-7', capabilityMappingDigest: 'e'.repeat(64),
      toolViewProtocol: 'capiro.meri.phase4.request-local-tool-view/v1',
      claimAttestationProtocol: 'capiro.meri.phase4.claim-tool-view-attestation/v1',
      attestationCredentialId: 'credential-a',
    };
    await expect(new MeriPhase4WorkerBindingAttestorV1(database).attestV2(
      { sourceId: 'source-a', producerRole: 'meri_phase4_attestor_source_a' }, command,
    )).resolves.toMatchObject({ kind: 'receipt', receipt: { bindingId, tenantId } });
    expect(receivedSql).toContain('meri_phase4_attest_worker_binding_v2');
    expect(Object.isFrozen(receivedParameters)).toBe(true);
    expect(receivedParameters).toHaveLength(22);
    expect(receivedParameters.slice(10)).toEqual([
      'b'.repeat(64), 'build-a', 'capiro.meri.phase4.worker-catalog/v1',
      'c'.repeat(64), 'catalog-7', 'd'.repeat(64), 'mapping-7', 'e'.repeat(64),
      'capiro.meri.phase4.request-local-tool-view/v1',
      'capiro.meri.phase4.claim-tool-view-attestation/v1', 'credential-a',
      'capiro.meri.phase4.applied-tool-view/v1',
    ]);
  });

  it.each(['enable', 'close'] as const)(
    'uses frozen context, identity and parameters for %s',
    async (operation) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      let receivedContext: MeriPhase4TrustedOperatorContextV1 | undefined;
      let receivedParameters: readonly unknown[] | undefined;
      const database: MeriPhase4OperatorDatabaseV1 = {
        async withVerifiedOperatorTransaction(context, run) {
          receivedContext = context;
          entered.resolve();
          await release.promise;
          return run({
            async query(_sql, parameters) {
              receivedParameters = parameters;
              return [{
                receipt_id: '77777777-7777-4777-8777-777777777777',
                tenant_id: tenantId,
                request_id: requestId,
                request_digest: String(parameters[8]),
                operation,
                outcome: 'changed',
                actor_user_id: actorUserId,
                impersonation_session_id: sessionId,
                reason: 'Approved identity operation test',
                scope_id: scopeId,
                worker_audience: 'meri-hermes-scope-worker',
                worker_ingress_id: 'ingress-a',
                old_generation: 'generation-a',
                old_credential_id: 'credential-a',
                new_generation: 'generation-a',
                new_credential_id: 'credential-a',
                binding_id: bindingId,
                occurred_at_epoch_micros: '10',
                fence_revision: '2',
              }] as never;
            },
          });
        },
        async withAuthenticatedBindingAttestor() {
          throw new Error('unexpected attestor transaction');
        },
      };
      const context = {
        role: 'capiro_admin', tenantId, actorUserId,
        impersonationSessionId: sessionId,
        reason: 'Approved identity operation test',
        grantId, grantNonce, grantOperation: operation,
      } as MeriPhase4TrustedOperatorContextV1;
      const command: MeriPhase4RouteIdentityV1 = {
        requestId, scopeId, ingressId: 'ingress-a',
        expectedGeneration: 'generation-a', expectedCredentialId: 'credential-a',
      };
      const operator = new MeriPhase4WorkerRouteOperatorV1(database);

      const pending = operation === 'enable'
        ? operator.enable(context, command)
        : operator.close(context, command);
      await entered.promise;
      (context as { reason: string }).reason = 'Mutated after the boundary';
      (command as { ingressId: string }).ingressId = 'ingress-mutated';
      (command as { expectedGeneration: string }).expectedGeneration = 'generation-mutated';
      release.resolve();

      await expect(pending).resolves.toMatchObject({
        kind: 'receipt', receipt: { operation, workerIngressId: 'ingress-a' },
      });
      expect(receivedContext).toBeDefined();
      expect(Object.isFrozen(receivedContext!)).toBe(true);
      expect(receivedParameters).toBeDefined();
      expect(Object.isFrozen(receivedParameters!)).toBe(true);
      expect(receivedParameters?.slice(0, 8)).toEqual([
        tenantId, grantId, grantNonce, requestId, scopeId,
        'ingress-a', 'generation-a', 'credential-a',
      ]);
    },
  );

  it('uses frozen rotate and recovery inputs across delayed callbacks', async () => {
    const rotateEntered = deferred<void>();
    const rotateRelease = deferred<void>();
    const recoverEntered = deferred<void>();
    const recoverRelease = deferred<void>();
    const calls: readonly unknown[][] = [];
    let callIndex = 0;
    const database: MeriPhase4OperatorDatabaseV1 = {
      async withVerifiedOperatorTransaction(_context, run) {
        const index = callIndex++;
        if (index === 0) {
          rotateEntered.resolve();
          await rotateRelease.promise;
        } else {
          recoverEntered.resolve();
          await recoverRelease.promise;
        }
        return run({
          async query(_sql, parameters) {
            (calls as unknown[][]).push(parameters as unknown[]);
            const digest = String(parameters[index === 0 ? 10 : 5]);
            return [{
              receipt_id: '77777777-7777-4777-8777-777777777777',
              tenant_id: tenantId,
              request_id: requestId,
              request_digest: digest,
              operation: 'rotate',
              outcome: 'changed',
              actor_user_id: actorUserId,
              impersonation_session_id: sessionId,
              reason: 'Approved route rotation test',
              scope_id: scopeId,
              worker_audience: 'meri-hermes-scope-worker',
              worker_ingress_id: 'ingress-a',
              old_generation: 'generation-a',
              old_credential_id: 'credential-a',
              new_generation: 'generation-b',
              new_credential_id: 'credential-b',
              binding_id: bindingId,
              occurred_at_epoch_micros: '10',
              fence_revision: '3',
            }] as never;
          },
        });
      },
      async withAuthenticatedBindingAttestor() {
        throw new Error('unexpected attestor transaction');
      },
    };
    const context = {
      role: 'capiro_admin', tenantId, actorUserId,
      impersonationSessionId: sessionId,
      reason: 'Approved route rotation test',
      grantId, grantNonce, grantOperation: 'rotate',
    } as MeriPhase4TrustedOperatorContextV1;
    const command: MeriPhase4RotateRouteV1 = {
      requestId, scopeId, ingressId: 'ingress-a',
      expectedGeneration: 'generation-a', expectedCredentialId: 'credential-a',
      bindingId, lifetimeMicros: 60_000_000n,
    };
    const operator = new MeriPhase4WorkerRouteOperatorV1(database);

    const rotate = operator.rotate(context, command);
    await rotateEntered.promise;
    (command as { bindingId: string }).bindingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    (command as { lifetimeMicros: bigint }).lifetimeMicros = 1n;
    rotateRelease.resolve();
    const rotated = await rotate;
    expect(rotated.kind).toBe('receipt');
    expect(calls[0]?.slice(4, 10)).toEqual([
      scopeId, 'ingress-a', 'generation-a', 'credential-a', bindingId, '60000000',
    ]);
    expect(Object.isFrozen(calls[0]!)).toBe(true);

    const digest = calls[0]?.[10] as string;
    const recovery = operator.recoverReceipt(context, requestId, digest);
    await recoverEntered.promise;
    (context as { tenantId: string }).tenantId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    recoverRelease.resolve();
    await expect(recovery).resolves.toMatchObject({
      kind: 'receipt', receipt: { requestId, requestDigest: digest },
    });
    expect(calls[1]).toEqual([
      tenantId, grantId, grantNonce, 'rotate', requestId, digest,
    ]);
    expect(Object.isFrozen(calls[1]!)).toBe(true);
  });

  it('uses frozen attestor and revocation snapshots inside the delayed callback', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let receivedParameters: readonly unknown[] | undefined;
    const database: MeriPhase4OperatorDatabaseV1 = {
      async withVerifiedOperatorTransaction() {
        throw new Error('unexpected operator transaction');
      },
      async withAuthenticatedBindingAttestor(_attestor, _tenant, run) {
        entered.resolve();
        await release.promise;
        return run({
          async query(_sql, parameters) {
            receivedParameters = parameters;
            return [{
              binding_id: bindingId,
              tenant_id: tenantId,
              source_id: 'source-a',
              external_record_id: 'record-a',
              attestation_sha256: 'a'.repeat(64),
              revoked_at_epoch_micros: '20',
            }] as never;
          },
        });
      },
    };
    const attestor: MeriPhase4TrustedBindingAttestorV1 = {
      sourceId: 'source-a', producerRole: 'meri_phase4_attestor_source_a',
    };
    const command: MeriPhase4RevokeBindingV1 = { tenantId, bindingId, revocationId };

    const pending = new MeriPhase4WorkerBindingAttestorV1(database).revoke(attestor, command);
    await entered.promise;
    (attestor as { sourceId: string }).sourceId = 'source-mutated';
    (command as { bindingId: string }).bindingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    (command as { revocationId: string }).revocationId = requestId;
    release.resolve();

    await expect(pending).resolves.toMatchObject({
      kind: 'receipt', receipt: { bindingId, revokedAtEpochMicros: '20' },
    });
    expect(receivedParameters).toEqual([bindingId, tenantId, 'source-a', revocationId]);
    expect(Object.isFrozen(receivedParameters!)).toBe(true);
  });

  it('reports exact UNKNOWN outcomes and rejects mismatched adapter signals', async () => {
    let mismatch = false;
    const database: MeriPhase4OperatorDatabaseV1 = {
      async withVerifiedOperatorTransaction(_context, run) {
        return run({
          async query(_sql, parameters) {
            throw new MeriPhase4OperatorCommitUnknownError(
              mismatch ? revocationId : requestId,
              String(parameters[6]),
            );
          },
        });
      },
      async withAuthenticatedBindingAttestor(attestor, selectedTenantId, run) {
        return run({
          async query() {
            throw new MeriPhase4BindingCommitUnknownError(
              'revoke', selectedTenantId, attestor.sourceId, bindingId,
              mismatch ? requestId : revocationId,
            );
          },
        });
      },
    };
    const context = {
      role: 'capiro_admin', tenantId, actorUserId,
      impersonationSessionId: sessionId,
      reason: 'Approved unknown outcome test',
      grantId, grantNonce, grantOperation: 'provision',
    } as MeriPhase4TrustedOperatorContextV1;
    const operator = new MeriPhase4WorkerRouteOperatorV1(database);
    await expect(operator.provisionDisabled(context, {
      requestId, bindingId, lifetimeMicros: 60_000_000n,
    })).resolves.toMatchObject({ kind: 'UNKNOWN', requestId, retryWithSameRequestId: true });
    const attestor = new MeriPhase4WorkerBindingAttestorV1(database);
    await expect(attestor.revoke(
      { sourceId: 'source-a', producerRole: 'meri_phase4_attestor_source_a' },
      { tenantId, bindingId, revocationId },
    )).resolves.toEqual({
      kind: 'UNKNOWN', operation: 'revoke', tenantId, sourceId: 'source-a',
      bindingId, idempotencyKey: revocationId, retryWithSameCommand: true,
    });

    mismatch = true;
    await expect(operator.provisionDisabled(context, {
      requestId, bindingId, lifetimeMicros: 60_000_000n,
    })).rejects.toThrow('unknown commit command mismatch');
    await expect(attestor.revoke(
      { sourceId: 'source-a', producerRole: 'meri_phase4_attestor_source_a' },
      { tenantId, bindingId, revocationId },
    )).rejects.toThrow('unknown binding commit command mismatch');
  });

  it('rejects class instances before an asynchronous database boundary', () => {
    class ForgedContext {
      role = 'capiro_admin' as const;
      tenantId = tenantId;
      actorUserId = actorUserId;
      impersonationSessionId = sessionId;
      reason = 'Approved route provisioning test';
      grantId = '99999999-9999-4999-8999-999999999999';
      grantNonce = 'b'.repeat(64);
      grantOperation = 'provision' as const;
    }
    const database = {
      withVerifiedOperatorTransaction: jest.fn(),
      withAuthenticatedBindingAttestor: jest.fn(),
    } as unknown as MeriPhase4OperatorDatabaseV1;
    const operator = new MeriPhase4WorkerRouteOperatorV1(database);
    expect(() => operator.provisionDisabled(
      new ForgedContext() as MeriPhase4TrustedOperatorContextV1,
      { requestId, bindingId, lifetimeMicros: 1n },
    )).toThrow('operator context must be a plain object');
    expect(database.withVerifiedOperatorTransaction).not.toHaveBeenCalled();
  });
});
