import {
  assertMeriPhase4AttestationV1,
  assertMeriPhase4AttestationV2,
  assertMeriPhase4LifetimeV1,
  assertMeriPhase4RouteIdentityV1,
  assertMeriPhase4TrustedOperatorContextV1,
  assertMeriPhase4UuidV1,
  assertMeriPhase4PrivateScopeV1,
  assertMeriPhase4RouteTokenV1,
  computeMeriPhase4RouteRequestDigestV1,
  MERI_PHASE4_WORKER_AUDIENCE_V1,
  type MeriPhase4AttestBindingV1,
  type MeriPhase4AttestBindingV2,
  type MeriPhase4BindingReceiptV1,
  type MeriPhase4BindingOperatorResultV1,
  type MeriPhase4BindingOperationV1,
  type MeriPhase4ProvisionRouteV1,
  type MeriPhase4RevokeBindingV1,
  type MeriPhase4RouteGrantRequestV1,
  type MeriPhase4RouteIdentityV1,
  type MeriPhase4RouteOperationV1,
  type MeriPhase4RouteOperatorResultV1,
  type MeriPhase4RouteReceiptV1,
  type MeriPhase4RouteReceiptRecoveryV1,
  type MeriPhase4RotateRouteV1,
  type MeriPhase4TrustedBindingAttestorV1,
  type MeriPhase4TrustedOperatorContextV1,
} from './meri-phase4-route-operator.contract.js';

export interface MeriPhase4OperatorTransactionV1 {
  /** Fixed SQL only; values are bound separately and never string-interpolated. */
  query<T extends object>(sql: string, parameters: readonly unknown[]): Promise<readonly T[]>;
}

/**
 * Must use the separate operator LOGIN principal and commit the callback
 * atomically. PostgreSQL authorizes the exact command from the grant nonce;
 * caller-set GUCs are not authority. It must not use capiro_app, SET ROLE,
 * withSystem, or table DML.
 */
export interface MeriPhase4OperatorDatabaseV1 {
  withVerifiedOperatorTransaction<T>(
    context: MeriPhase4TrustedOperatorContextV1,
    run: (tx: MeriPhase4OperatorTransactionV1) => Promise<T>,
  ): Promise<T>;
  /** External binding producer connection; never shares the route operator login. */
  withAuthenticatedBindingAttestor<T>(
    attestor: MeriPhase4TrustedBindingAttestorV1,
    tenantId: string,
    run: (tx: MeriPhase4OperatorTransactionV1) => Promise<T>,
  ): Promise<T>;
}

/** Uses capiro_app only to invoke the database-authoritative grant issuer. */
export interface MeriPhase4GrantIssuerDatabaseV1 {
  withRouteGrantIssuerTransaction<T>(
    run: (tx: MeriPhase4OperatorTransactionV1) => Promise<T>,
  ): Promise<T>;
}

/** Adapter error is emitted only when commit may have succeeded but its ack was lost. */
export class MeriPhase4OperatorCommitUnknownError extends Error {
  constructor(readonly requestId: string, readonly requestDigest: string) {
    super('Phase 4 route operation commit is unconfirmed');
    this.name = 'MeriPhase4OperatorCommitUnknownError';
  }
}

/** Adapter signal when a binding operation may have committed without an acknowledgement. */
export class MeriPhase4BindingCommitUnknownError extends Error {
  constructor(
    readonly operation: MeriPhase4BindingOperationV1,
    readonly tenantId: string,
    readonly sourceId: string,
    readonly bindingId: string,
    readonly idempotencyKey: string,
  ) {
    super('Phase 4 binding operation commit is unconfirmed');
    this.name = 'MeriPhase4BindingCommitUnknownError';
  }
}

interface ReceiptRow {
  receipt_id: string;
  tenant_id: string;
  request_id: string;
  request_digest: string;
  operation: string;
  outcome: string;
  actor_user_id: string;
  impersonation_session_id: string;
  reason: string;
  scope_id: string;
  worker_audience: string;
  worker_ingress_id: string;
  old_generation: string | null;
  old_credential_id: string | null;
  new_generation: string | null;
  new_credential_id: string | null;
  binding_id: string | null;
  occurred_at_epoch_micros: bigint | string;
  fence_revision: bigint | string;
}

interface BindingRow {
  binding_id: string;
  tenant_id: string;
  source_id: string;
  external_record_id: string;
  attestation_sha256: string;
  revoked_at_epoch_micros: bigint | string | null;
}

interface GrantRow {
  grant_id: string;
  tenant_id: string;
  actor_user_id: string;
  impersonation_session_id: string;
  reason: string;
  operation: string;
  request_id: string;
  request_digest: string;
  grant_nonce: string;
  expires_at_epoch_micros: bigint | string;
}

function assertPlainRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${field} must be a plain object`);
  }
}

function snapshotOperatorContext(
  context: MeriPhase4TrustedOperatorContextV1,
): MeriPhase4TrustedOperatorContextV1 {
  assertPlainRecord(context, 'operator context');
  const snapshot = Object.freeze({
    role: context.role,
    tenantId: context.tenantId,
    actorUserId: context.actorUserId,
    impersonationSessionId: context.impersonationSessionId,
    reason: context.reason,
    grantId: context.grantId,
    grantNonce: context.grantNonce,
    grantOperation: context.grantOperation,
  }) as MeriPhase4TrustedOperatorContextV1;
  assertMeriPhase4TrustedOperatorContextV1(snapshot);
  return snapshot;
}

function snapshotProvisionCommand(command: MeriPhase4ProvisionRouteV1): MeriPhase4ProvisionRouteV1 {
  assertPlainRecord(command, 'provision command');
  const snapshot = Object.freeze({
    requestId: command.requestId,
    bindingId: command.bindingId,
    lifetimeMicros: command.lifetimeMicros,
  });
  assertMeriPhase4UuidV1(snapshot.requestId, 'requestId');
  assertMeriPhase4UuidV1(snapshot.bindingId, 'bindingId');
  assertMeriPhase4LifetimeV1(snapshot.lifetimeMicros);
  return snapshot;
}

function snapshotIdentityCommand(command: MeriPhase4RouteIdentityV1): MeriPhase4RouteIdentityV1 {
  assertPlainRecord(command, 'route identity command');
  return Object.freeze({
    requestId: command.requestId,
    scopeId: command.scopeId,
    ingressId: command.ingressId,
    expectedGeneration: command.expectedGeneration,
    expectedCredentialId: command.expectedCredentialId,
  });
}

function snapshotRotateCommand(command: MeriPhase4RotateRouteV1): MeriPhase4RotateRouteV1 {
  assertPlainRecord(command, 'rotate command');
  return Object.freeze({
    ...snapshotIdentityCommand(command),
    bindingId: command.bindingId,
    lifetimeMicros: command.lifetimeMicros,
  });
}

function snapshotBindingAttestor(
  attestor: MeriPhase4TrustedBindingAttestorV1,
): MeriPhase4TrustedBindingAttestorV1 {
  assertPlainRecord(attestor, 'binding attestor');
  const snapshot = Object.freeze({
    sourceId: attestor.sourceId,
    producerRole: attestor.producerRole,
  });
  if (!snapshot.sourceId || snapshot.sourceId.length > 64 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(snapshot.sourceId) ||
      typeof snapshot.producerRole !== 'string' || snapshot.producerRole.length > 63 ||
      !/^[A-Za-z0-9_]+$/.test(snapshot.producerRole) ||
      snapshot.producerRole === 'meri_phase4_route_operator' ||
      snapshot.producerRole === 'capiro_app') {
    throw new Error('qualified route binding attestor required');
  }
  return snapshot;
}

function snapshotAttestCommand(command: MeriPhase4AttestBindingV1): MeriPhase4AttestBindingV1 {
  assertPlainRecord(command, 'binding attestation command');
  const snapshot = Object.freeze({
    bindingId: command.bindingId,
    externalRecordId: command.externalRecordId,
    tenantId: command.tenantId,
    scopeId: command.scopeId,
    ingressId: command.ingressId,
    generation: command.generation,
    credentialId: command.credentialId,
    notBeforeEpochMicros: command.notBeforeEpochMicros,
    notAfterEpochMicros: command.notAfterEpochMicros,
  });
  assertMeriPhase4AttestationV1(snapshot);
  return snapshot;
}

function snapshotAttestCommandV2(command: MeriPhase4AttestBindingV2): MeriPhase4AttestBindingV2 {
  assertPlainRecord(command, 'binding v2 attestation command');
  const snapshot = Object.freeze({
    ...snapshotAttestCommand(command),
    bindingVersion: command.bindingVersion,
    workerImageDigest: command.workerImageDigest,
    workerBuildId: command.workerBuildId,
    workerCatalogDigestAlgorithm: command.workerCatalogDigestAlgorithm,
    workerCatalogDigest: command.workerCatalogDigest,
    meriCatalogVersion: command.meriCatalogVersion,
    meriCatalogDigest: command.meriCatalogDigest,
    capabilityMappingVersion: command.capabilityMappingVersion,
    capabilityMappingDigest: command.capabilityMappingDigest,
    toolViewProtocol: command.toolViewProtocol,
    claimAttestationProtocol: command.claimAttestationProtocol,
    attestationCredentialId: command.attestationCredentialId,
    appliedToolViewDigestAlgorithm: command.appliedToolViewDigestAlgorithm,
  });
  assertMeriPhase4AttestationV2(snapshot);
  return snapshot;
}

function snapshotRevokeCommand(command: MeriPhase4RevokeBindingV1): MeriPhase4RevokeBindingV1 {
  assertPlainRecord(command, 'binding revocation command');
  const snapshot = Object.freeze({
    tenantId: command.tenantId,
    bindingId: command.bindingId,
    revocationId: command.revocationId,
  });
  assertMeriPhase4UuidV1(snapshot.tenantId, 'tenantId');
  assertMeriPhase4UuidV1(snapshot.bindingId, 'bindingId');
  assertMeriPhase4UuidV1(snapshot.revocationId, 'revocationId');
  return snapshot;
}

function snapshotGrantRequest(
  request: MeriPhase4RouteGrantRequestV1,
): MeriPhase4RouteGrantRequestV1 {
  assertPlainRecord(request, 'route grant request');
  const snapshot = Object.freeze({
    tenantId: request.tenantId,
    impersonationSessionId: request.impersonationSessionId,
    operation: request.operation,
    requestId: request.requestId,
    requestDigest: request.requestDigest,
  });
  assertMeriPhase4UuidV1(snapshot.tenantId, 'tenantId');
  assertMeriPhase4UuidV1(snapshot.impersonationSessionId, 'impersonationSessionId');
  assertMeriPhase4UuidV1(snapshot.requestId, 'requestId');
  if (!isRouteOperation(snapshot.operation) || !/^[0-9a-f]{64}$/.test(snapshot.requestDigest)) {
    throw new Error('invalid route grant request');
  }
  return snapshot;
}

function canonicalDigest(
  action: MeriPhase4RouteOperationV1,
  context: MeriPhase4TrustedOperatorContextV1,
  fields: readonly string[],
): string {
  return computeMeriPhase4RouteRequestDigestV1([
    action, context.tenantId, context.actorUserId, context.impersonationSessionId,
    context.reason, ...fields,
  ]);
}

function assertGrantOperation(
  context: MeriPhase4TrustedOperatorContextV1,
  operation: MeriPhase4RouteOperationV1,
): void {
  if (context.grantOperation !== operation) {
    throw new Error('route-operator grant operation mismatch');
  }
}

function toStringInteger(value: bigint | string): string {
  const result = typeof value === 'bigint' ? value.toString() : value;
  if (!/^(0|[1-9][0-9]{0,18})$/.test(result)) throw new Error('invalid database integer');
  if (BigInt(result) > 9_223_372_036_854_775_807n) throw new Error('database integer overflow');
  return result;
}

function receiptFromRow(
  row: ReceiptRow,
  context: MeriPhase4TrustedOperatorContextV1,
  requestId: string,
  requestDigest: string,
  operation: MeriPhase4RouteOperationV1,
): MeriPhase4RouteReceiptV1 {
  if (row.tenant_id !== context.tenantId || row.actor_user_id !== context.actorUserId ||
      row.impersonation_session_id !== context.impersonationSessionId ||
      row.request_id !== requestId || row.request_digest !== requestDigest ||
      row.reason !== context.reason || !/^[0-9a-f]{64}$/.test(row.request_digest) ||
      row.operation !== operation ||
      (row.outcome !== 'changed' && row.outcome !== 'no_op') ||
      row.worker_audience !== MERI_PHASE4_WORKER_AUDIENCE_V1) {
    throw new Error('operator receipt does not match the submitted command');
  }
  assertMeriPhase4PrivateScopeV1(context.tenantId, row.scope_id);
  assertMeriPhase4RouteTokenV1(row.worker_ingress_id, 'receipt ingress');
  return Object.freeze({
    receiptId: row.receipt_id,
    tenantId: row.tenant_id,
    requestId: row.request_id,
    requestDigest: row.request_digest,
    operation,
    outcome: row.outcome,
    actorUserId: row.actor_user_id,
    impersonationSessionId: row.impersonation_session_id,
    reason: row.reason,
    scopeId: row.scope_id,
    workerAudience: MERI_PHASE4_WORKER_AUDIENCE_V1,
    workerIngressId: row.worker_ingress_id,
    oldGeneration: row.old_generation,
    oldCredentialId: row.old_credential_id,
    newGeneration: row.new_generation,
    newCredentialId: row.new_credential_id,
    bindingId: row.binding_id,
    occurredAtEpochMicros: toStringInteger(row.occurred_at_epoch_micros),
    fenceRevision: toStringInteger(row.fence_revision),
    ingressClosureProven: false,
    workerTerminationProven: false,
  });
}

function isRouteOperation(value: string): value is MeriPhase4RouteOperationV1 {
  return value === 'provision' || value === 'enable' || value === 'close' || value === 'rotate';
}

function bindingFromRow(row: BindingRow, tenantId: string): MeriPhase4BindingReceiptV1 {
  if (row.tenant_id !== tenantId || !/^[0-9a-f]{64}$/.test(row.attestation_sha256)) {
    throw new Error('binding receipt tenant or digest mismatch');
  }
  return Object.freeze({
    bindingId: row.binding_id,
    tenantId: row.tenant_id,
    sourceId: row.source_id,
    externalRecordId: row.external_record_id,
    attestationSha256: row.attestation_sha256,
    revokedAtEpochMicros: row.revoked_at_epoch_micros === null
      ? null : toStringInteger(row.revoked_at_epoch_micros),
  });
}

/** Dormant capiro_app boundary that asks PostgreSQL to derive the live authority facts. */
export class MeriPhase4RouteOperatorGrantIssuerV1 {
  constructor(private readonly database: MeriPhase4GrantIssuerDatabaseV1) {}

  async issue(
    request: MeriPhase4RouteGrantRequestV1,
  ): Promise<MeriPhase4TrustedOperatorContextV1> {
    const snapshot = snapshotGrantRequest(request);
    return this.database.withRouteGrantIssuerTransaction(async (tx) => {
      const rows = await tx.query<GrantRow>(
        `SELECT * FROM public.meri_phase4_issue_route_operator_grant(
          $1::uuid,$2::uuid,$3::varchar,$4::uuid,$5::char(64))`,
        Object.freeze([snapshot.tenantId, snapshot.impersonationSessionId,
          snapshot.operation, snapshot.requestId, snapshot.requestDigest]),
      );
      const row = rows[0];
      if (rows.length !== 1 || !row || row.tenant_id !== snapshot.tenantId ||
          row.impersonation_session_id !== snapshot.impersonationSessionId ||
          row.operation !== snapshot.operation || row.request_id !== snapshot.requestId ||
          row.request_digest !== snapshot.requestDigest || !/^[0-9a-f]{64}$/.test(row.grant_nonce)) {
        throw new Error('route grant issuer returned a mismatched grant');
      }
      assertMeriPhase4UuidV1(row.grant_id, 'grantId');
      assertMeriPhase4UuidV1(row.actor_user_id, 'actorUserId');
      toStringInteger(row.expires_at_epoch_micros);
      const context = Object.freeze({
        role: 'capiro_admin' as const,
        tenantId: row.tenant_id,
        actorUserId: row.actor_user_id,
        impersonationSessionId: row.impersonation_session_id,
        reason: row.reason,
        grantId: row.grant_id,
        grantNonce: row.grant_nonce,
        grantOperation: row.operation,
      }) as MeriPhase4TrustedOperatorContextV1;
      assertMeriPhase4TrustedOperatorContextV1(context);
      return context;
    });
  }
}

/** Dormant operator API. It has no Nest decorators and is not registered. */
export class MeriPhase4WorkerRouteOperatorV1 {
  constructor(private readonly database: MeriPhase4OperatorDatabaseV1) {}

  provisionDisabled(
    context: MeriPhase4TrustedOperatorContextV1,
    command: MeriPhase4ProvisionRouteV1,
  ): Promise<MeriPhase4RouteOperatorResultV1> {
    const contextSnapshot = snapshotOperatorContext(context);
    assertGrantOperation(contextSnapshot, 'provision');
    const commandSnapshot = snapshotProvisionCommand(command);
    const requestDigest = canonicalDigest('provision', contextSnapshot, [
      commandSnapshot.bindingId, commandSnapshot.lifetimeMicros.toString(),
    ]);
    return this.runRouteCommand(contextSnapshot, commandSnapshot.requestId, requestDigest, 'provision',
      `SELECT * FROM public.meri_phase4_route_provision_disabled(
        $1::uuid,$2::uuid,$3::char(64),$4::uuid,$5::uuid,$6::bigint,$7::char(64))`,
      [contextSnapshot.tenantId, contextSnapshot.grantId, contextSnapshot.grantNonce,
        commandSnapshot.requestId, commandSnapshot.bindingId,
        commandSnapshot.lifetimeMicros.toString(), requestDigest]);
  }

  enable(
    context: MeriPhase4TrustedOperatorContextV1,
    command: MeriPhase4RouteIdentityV1,
  ): Promise<MeriPhase4RouteOperatorResultV1> {
    return this.identityCommand(context, command, 'enable',
      `SELECT * FROM public.meri_phase4_route_enable(
        $1::uuid,$2::uuid,$3::char(64),$4::uuid,$5::varchar,$6::varchar,
        $7::varchar,$8::varchar,$9::char(64))`);
  }

  close(
    context: MeriPhase4TrustedOperatorContextV1,
    command: MeriPhase4RouteIdentityV1,
  ): Promise<MeriPhase4RouteOperatorResultV1> {
    return this.identityCommand(context, command, 'close',
      `SELECT * FROM public.meri_phase4_route_close(
        $1::uuid,$2::uuid,$3::char(64),$4::uuid,$5::varchar,$6::varchar,
        $7::varchar,$8::varchar,$9::char(64))`);
  }

  rotate(
    context: MeriPhase4TrustedOperatorContextV1,
    command: MeriPhase4RotateRouteV1,
  ): Promise<MeriPhase4RouteOperatorResultV1> {
    const contextSnapshot = snapshotOperatorContext(context);
    assertGrantOperation(contextSnapshot, 'rotate');
    const commandSnapshot = snapshotRotateCommand(command);
    assertMeriPhase4RouteIdentityV1(contextSnapshot.tenantId, commandSnapshot);
    assertMeriPhase4UuidV1(commandSnapshot.bindingId, 'bindingId');
    assertMeriPhase4LifetimeV1(commandSnapshot.lifetimeMicros);
    const requestDigest = canonicalDigest('rotate', contextSnapshot, [
      commandSnapshot.scopeId, commandSnapshot.ingressId,
      commandSnapshot.expectedGeneration, commandSnapshot.expectedCredentialId,
      commandSnapshot.bindingId, commandSnapshot.lifetimeMicros.toString(),
    ]);
    return this.runRouteCommand(contextSnapshot, commandSnapshot.requestId, requestDigest, 'rotate',
      `SELECT * FROM public.meri_phase4_route_rotate_cas(
        $1::uuid,$2::uuid,$3::char(64),$4::uuid,$5::varchar,$6::varchar,
        $7::varchar,$8::varchar,$9::uuid,$10::bigint,$11::char(64))`,
      [contextSnapshot.tenantId, contextSnapshot.grantId, contextSnapshot.grantNonce,
        commandSnapshot.requestId, commandSnapshot.scopeId, commandSnapshot.ingressId,
        commandSnapshot.expectedGeneration, commandSnapshot.expectedCredentialId,
        commandSnapshot.bindingId, commandSnapshot.lifetimeMicros.toString(), requestDigest]);
  }

  private identityCommand(
    context: MeriPhase4TrustedOperatorContextV1,
    command: MeriPhase4RouteIdentityV1,
    operation: 'enable' | 'close',
    sql: string,
  ): Promise<MeriPhase4RouteOperatorResultV1> {
    const contextSnapshot = snapshotOperatorContext(context);
    assertGrantOperation(contextSnapshot, operation);
    const commandSnapshot = snapshotIdentityCommand(command);
    assertMeriPhase4RouteIdentityV1(contextSnapshot.tenantId, commandSnapshot);
    const requestDigest = canonicalDigest(operation, contextSnapshot, [
      commandSnapshot.scopeId, commandSnapshot.ingressId,
      commandSnapshot.expectedGeneration, commandSnapshot.expectedCredentialId,
    ]);
    return this.runRouteCommand(contextSnapshot, commandSnapshot.requestId,
      requestDigest, operation, sql,
      [contextSnapshot.tenantId, contextSnapshot.grantId, contextSnapshot.grantNonce,
        commandSnapshot.requestId, commandSnapshot.scopeId, commandSnapshot.ingressId,
        commandSnapshot.expectedGeneration, commandSnapshot.expectedCredentialId,
        requestDigest]);
  }

  private async runRouteCommand(
    context: MeriPhase4TrustedOperatorContextV1,
    requestId: string,
    requestDigest: string,
    operation: MeriPhase4RouteOperationV1,
    sql: string,
    parameters: readonly unknown[],
  ): Promise<MeriPhase4RouteOperatorResultV1> {
    const parameterSnapshot = Object.freeze([...parameters]);
    try {
      const receipt = await this.database.withVerifiedOperatorTransaction(context, async (tx) => {
        const rows = await tx.query<ReceiptRow>(sql, parameterSnapshot);
        const row = rows[0];
        if (rows.length !== 1 || !row) throw new Error('route operator returned no unique receipt');
        return receiptFromRow(row, context, requestId, requestDigest, operation);
      });
      return Object.freeze({ kind: 'receipt', receipt });
    } catch (error) {
      if (error instanceof MeriPhase4OperatorCommitUnknownError) {
        if (error.requestId !== requestId || error.requestDigest !== requestDigest) {
          throw new Error('unknown commit command mismatch');
        }
        return Object.freeze({ kind: 'UNKNOWN', requestId, requestDigest,
          retryWithSameRequestId: true });
      }
      throw error;
    }
  }

  /** Read-only recovery after an UNKNOWN commit acknowledgement. */
  async recoverReceipt(
    context: MeriPhase4TrustedOperatorContextV1,
    requestId: string,
    requestDigest: string,
  ): Promise<MeriPhase4RouteReceiptRecoveryV1> {
    const contextSnapshot = snapshotOperatorContext(context);
    const requestIdSnapshot = requestId;
    const requestDigestSnapshot = requestDigest;
    assertMeriPhase4UuidV1(requestIdSnapshot, 'requestId');
    if (typeof requestDigestSnapshot !== 'string' || !/^[0-9a-f]{64}$/.test(requestDigestSnapshot)) {
      throw new Error('invalid request digest');
    }
    return this.database.withVerifiedOperatorTransaction(contextSnapshot, async (tx) => {
      const rows = await tx.query<ReceiptRow>(
        `SELECT * FROM public.meri_phase4_route_operator_receipt(
          $1::uuid,$2::uuid,$3::char(64),$4::varchar,$5::uuid,$6::char(64))`,
        Object.freeze([contextSnapshot.tenantId, contextSnapshot.grantId,
          contextSnapshot.grantNonce, contextSnapshot.grantOperation,
          requestIdSnapshot, requestDigestSnapshot]),
      );
      if (rows.length === 0) return Object.freeze({
        kind: 'not_found' as const,
        requestId: requestIdSnapshot,
        requestDigest: requestDigestSnapshot,
      });
      const row = rows[0];
      if (rows.length !== 1 || !row || !isRouteOperation(row.operation)) {
        throw new Error('route operator returned an invalid recovery receipt');
      }
      return Object.freeze({ kind: 'receipt',
        receipt: receiptFromRow(row, contextSnapshot, requestIdSnapshot,
          requestDigestSnapshot, row.operation) });
    });
  }
}

/** Separate authenticated producer boundary; an arbitrary digest is not proof. */
export class MeriPhase4WorkerBindingAttestorV1 {
  constructor(private readonly database: MeriPhase4OperatorDatabaseV1) {}

  async attest(
    attestor: MeriPhase4TrustedBindingAttestorV1,
    command: MeriPhase4AttestBindingV1,
  ): Promise<MeriPhase4BindingOperatorResultV1> {
    const attestorSnapshot = snapshotBindingAttestor(attestor);
    const commandSnapshot = snapshotAttestCommand(command);
    try {
      const receipt = await this.database.withAuthenticatedBindingAttestor(
        attestorSnapshot,
        commandSnapshot.tenantId,
        async (tx) => {
          const rows = await tx.query<BindingRow>(
            `SELECT * FROM public.meri_phase4_attest_worker_binding(
              $1::uuid,$2::varchar,$3::varchar,$4::uuid,$5::varchar,$6::varchar,
              $7::varchar,$8::varchar,$9::bigint,$10::bigint)`,
            Object.freeze([commandSnapshot.bindingId, attestorSnapshot.sourceId,
              commandSnapshot.externalRecordId, commandSnapshot.tenantId,
              commandSnapshot.scopeId, commandSnapshot.ingressId,
              commandSnapshot.generation, commandSnapshot.credentialId,
              commandSnapshot.notBeforeEpochMicros.toString(),
              commandSnapshot.notAfterEpochMicros.toString()]),
          );
          const row = rows[0];
          if (rows.length !== 1 || !row) {
            throw new Error('binding attestor returned no unique binding');
          }
          return bindingFromRow(row, commandSnapshot.tenantId);
        });
      return Object.freeze({ kind: 'receipt', receipt });
    } catch (error) {
      return this.bindingUnknownOrThrow(error, 'attest', commandSnapshot.tenantId,
        attestorSnapshot.sourceId, commandSnapshot.bindingId,
        commandSnapshot.externalRecordId);
    }
  }

  /** V2 is the only binding shape eligible for dormant predispatch/claim. */
  async attestV2(
    attestor: MeriPhase4TrustedBindingAttestorV1,
    command: MeriPhase4AttestBindingV2,
  ): Promise<MeriPhase4BindingOperatorResultV1> {
    const attestorSnapshot = snapshotBindingAttestor(attestor);
    const commandSnapshot = snapshotAttestCommandV2(command);
    try {
      const receipt = await this.database.withAuthenticatedBindingAttestor(
        attestorSnapshot,
        commandSnapshot.tenantId,
        async (tx) => {
          const rows = await tx.query<BindingRow>(
            `SELECT * FROM public.meri_phase4_attest_worker_binding_v2(
              $1::uuid,$2::varchar,$3::varchar,$4::uuid,$5::varchar,$6::varchar,
              $7::varchar,$8::varchar,$9::bigint,$10::bigint,$11::char(64),
              $12::varchar,$13::varchar,$14::char(64),$15::varchar,$16::char(64),
              $17::varchar,$18::char(64),$19::varchar,$20::varchar,$21::varchar,
              $22::varchar)` ,
            Object.freeze([commandSnapshot.bindingId, attestorSnapshot.sourceId,
              commandSnapshot.externalRecordId, commandSnapshot.tenantId,
              commandSnapshot.scopeId, commandSnapshot.ingressId,
              commandSnapshot.generation, commandSnapshot.credentialId,
              commandSnapshot.notBeforeEpochMicros.toString(),
              commandSnapshot.notAfterEpochMicros.toString(),
              commandSnapshot.workerImageDigest, commandSnapshot.workerBuildId,
              commandSnapshot.workerCatalogDigestAlgorithm,
              commandSnapshot.workerCatalogDigest, commandSnapshot.meriCatalogVersion,
              commandSnapshot.meriCatalogDigest, commandSnapshot.capabilityMappingVersion,
              commandSnapshot.capabilityMappingDigest, commandSnapshot.toolViewProtocol,
              commandSnapshot.claimAttestationProtocol,
              commandSnapshot.attestationCredentialId,
              commandSnapshot.appliedToolViewDigestAlgorithm]),
          );
          const row = rows[0];
          if (rows.length !== 1 || !row) {
            throw new Error('binding v2 attestor returned no unique binding');
          }
          return bindingFromRow(row, commandSnapshot.tenantId);
        });
      return Object.freeze({ kind: 'receipt', receipt });
    } catch (error) {
      return this.bindingUnknownOrThrow(error, 'attest', commandSnapshot.tenantId,
        attestorSnapshot.sourceId, commandSnapshot.bindingId,
        commandSnapshot.externalRecordId);
    }
  }

  async revoke(
    attestor: MeriPhase4TrustedBindingAttestorV1,
    command: MeriPhase4RevokeBindingV1,
  ): Promise<MeriPhase4BindingOperatorResultV1> {
    const attestorSnapshot = snapshotBindingAttestor(attestor);
    const commandSnapshot = snapshotRevokeCommand(command);
    try {
      const receipt = await this.database.withAuthenticatedBindingAttestor(
        attestorSnapshot,
        commandSnapshot.tenantId,
        async (tx) => {
          const rows = await tx.query<BindingRow>(
            `SELECT * FROM public.meri_phase4_revoke_worker_binding(
              $1::uuid,$2::uuid,$3::varchar,$4::uuid)`,
            Object.freeze([commandSnapshot.bindingId, commandSnapshot.tenantId,
              attestorSnapshot.sourceId, commandSnapshot.revocationId]),
          );
          const row = rows[0];
          if (rows.length !== 1 || !row) {
            throw new Error('binding revocation returned no unique receipt');
          }
          return bindingFromRow(row, commandSnapshot.tenantId);
        });
      return Object.freeze({ kind: 'receipt', receipt });
    } catch (error) {
      return this.bindingUnknownOrThrow(error, 'revoke', commandSnapshot.tenantId,
        attestorSnapshot.sourceId, commandSnapshot.bindingId,
        commandSnapshot.revocationId);
    }
  }

  /** Retry/recover with the exact original command; a missing commit is never reported as success. */
  recoverAttestation(
    attestor: MeriPhase4TrustedBindingAttestorV1,
    command: MeriPhase4AttestBindingV1,
  ): Promise<MeriPhase4BindingOperatorResultV1> {
    return this.attest(attestor, command);
  }

  recoverAttestationV2(
    attestor: MeriPhase4TrustedBindingAttestorV1,
    command: MeriPhase4AttestBindingV2,
  ): Promise<MeriPhase4BindingOperatorResultV1> {
    return this.attestV2(attestor, command);
  }

  /** Retry/recover with the exact original revocation identity. */
  recoverRevocation(
    attestor: MeriPhase4TrustedBindingAttestorV1,
    command: MeriPhase4RevokeBindingV1,
  ): Promise<MeriPhase4BindingOperatorResultV1> {
    return this.revoke(attestor, command);
  }

  private bindingUnknownOrThrow(
    error: unknown,
    operation: MeriPhase4BindingOperationV1,
    tenantId: string,
    sourceId: string,
    bindingId: string,
    idempotencyKey: string,
  ): MeriPhase4BindingOperatorResultV1 {
    if (!(error instanceof MeriPhase4BindingCommitUnknownError)) throw error;
    if (error.operation !== operation || error.tenantId !== tenantId ||
        error.sourceId !== sourceId || error.bindingId !== bindingId ||
        error.idempotencyKey !== idempotencyKey) {
      throw new Error('unknown binding commit command mismatch');
    }
    return Object.freeze({ kind: 'UNKNOWN', operation, tenantId, sourceId,
      bindingId, idempotencyKey, retryWithSameCommand: true });
  }
}
