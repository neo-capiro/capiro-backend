import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import {
  createMeriDispatchRequestIdentityV2,
  type MeriDispatchRequestIdentityV2,
  type MeriDispatchRequestMaterialV2,
} from './meri-hermes-dispatch-intent.contract.js';
import {
  MERI_HERMES_RECOVERY_COMMAND_PURPOSE,
  MERI_HERMES_RECOVERY_RECEIPT_PURPOSE,
  type MeriHermesRecoveryCommandKeyV1,
  type MeriHermesRecoveryReceiptKeyV1,
} from './meri-hermes-dispatch-recovery.contract.js';
import type {
  MeriHermesRecoveryPersistenceDatabaseV1,
  MeriHermesRecoveryPersistenceTransactionV1,
} from './meri-hermes-dispatch-recovery.repository.js';
import {
  mintMeriHermesReservationCommandV1,
  verifyMeriHermesReservationCommandV1,
  verifyMeriHermesReservationReceiptV1,
} from './meri-hermes-reservation-recovery.contract.js';
import {
  MeriHermesReservationRecoveryPersistenceConflictError,
  MeriHermesReservationRecoveryRepositoryV1,
} from './meri-hermes-reservation-recovery.repository.js';

const databaseUrl = process.env.MERI_PHASE4_ROUTE_TEST_DATABASE_URL;
const parsed = databaseUrl ? new URL(databaseUrl) : null;
const isolated = Boolean(
  parsed?.protocol === 'postgresql:' && parsed.hostname === '127.0.0.1' &&
  parsed.username === 'postgres' && parsed.pathname === '/capiro' &&
  process.env.MERI_PHASE4_ROUTE_TEST_ACKNOWLEDGE_DISPOSABLE === 'yes',
);
const describeDb = isolated ? describe : describe.skip;

const micros = (milliseconds: number) => (BigInt(milliseconds) * 1_000n).toString();
const sha256 = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

interface Fixture {
  readonly identity: MeriDispatchRequestIdentityV2;
  readonly material: MeriDispatchRequestMaterialV2;
  readonly operationId: string;
  readonly workerRunId: string;
}

class PgRecoveryDatabase implements MeriHermesRecoveryPersistenceDatabaseV1 {
  constructor(
    private readonly connectionString: string,
    private readonly tenantId: string,
  ) {}

  async withRecoveryAuthorityTransaction<T>(
    run: (tx: MeriHermesRecoveryPersistenceTransactionV1) => Promise<T>,
  ): Promise<T> {
    const client = new Client({ connectionString: this.connectionString });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant',$1,true)", [this.tenantId]);
      const tx: MeriHermesRecoveryPersistenceTransactionV1 = {
        execute: async (sql, parameters) => { await client.query(sql, [...parameters]); },
        query: async <R extends object>(sql: string, parameters: readonly unknown[]) =>
          (await client.query<R>(sql, [...parameters])).rows,
      };
      const result = await run(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
}

describeDb('Phase 4 signed reservation recovery on disposable migrated PostgreSQL', () => {
  jest.setTimeout(45_000);

  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const tenantId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const scopeId = `tenant:${tenantId}:user:${userId}`;
  const authorizationVersion = `reservation-db-${suffix}`;
  const admin = new Client({ connectionString: databaseUrl });
  const deliveryAtMs = Date.now() + 6_000;
  const delivery = micros(deliveryAtMs);
  const reconciliation = micros(deliveryAtMs + 2 * 86_400_000);
  const retain = micros(deliveryAtMs + 4 * 86_400_000);
  const fixtures: Fixture[] = [];

  function makeFixture(label: string): Fixture {
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const runId = randomUUID();
    const material: MeriDispatchRequestMaterialV2 = {
      metadata: {
        version: 2,
        tenantId,
        actorType: 'user',
        actorId: userId,
        meriAudience: 'private',
        clientId: null,
        workspaceId: null,
        scopeId,
        conversationId,
        userMessageId: messageId,
        runId,
        idempotencyKey: `reservation-db-${label}-${suffix}`,
        conversationEpoch: 3,
        workerAudience: 'meri-hermes-scope-worker',
        workerIngressId: `reservation-ingress-${suffix}`,
        workerGeneration: `reservation-generation-${suffix}`,
        workerCredentialId: `reservation-credential-${suffix}`,
        authorizationVersion,
        authorizationPolicyVersion: `reservation-policy-${suffix}`,
        grantVersion: `reservation-grant-${suffix}`,
        catalogDigest: 'a'.repeat(64),
        toolViewDigest: 'b'.repeat(64),
        sessionHeaderKeyId: `reservation-session-${suffix}`,
        claimNotAfterEpochMicros: delivery,
        deliveryNotAfterEpochMicros: delivery,
        workerCredentialNotAfterEpochMicros: delivery,
        reconciliationNotAfterEpochMicros: reconciliation,
        retainUntilEpochMicros: retain,
      },
      sourceMessage: {
        body: `reservation recovery database ${label}`,
        metadata: { runtime: 'hermes', label },
      },
      bodyBytes: Buffer.from(JSON.stringify({ input: label })),
      sessionKeyHeaderValue: `${scopeId}:conversation:${conversationId}:e3`,
      sessionHeaderHmacKey: Buffer.alloc(32, 71),
    };
    return {
      identity: createMeriDispatchRequestIdentityV2(material),
      material,
      operationId: randomUUID(),
      workerRunId: `reservation-worker-${label}-${suffix}`,
    };
  }

  function commitInput(fixture: Fixture, outcome: 'reserved' | 'sealed_absent') {
    const nowMs = Date.now();
    const issued = (BigInt(micros(nowMs - 1_000)) > BigInt(delivery)
      ? BigInt(micros(nowMs - 1_000)) : BigInt(delivery)).toString();
    const observed = micros(nowMs);
    const expires = micros(nowMs + 30_000);
    const binding = {
      tenantId,
      workerAudience: fixture.identity.workerAudience,
      workerIngressId: fixture.identity.workerIngressId,
      workerGeneration: fixture.identity.workerGeneration,
      workerCredentialId: fixture.identity.workerCredentialId,
    };
    const commandKey: MeriHermesRecoveryCommandKeyV1 = {
      purpose: MERI_HERMES_RECOVERY_COMMAND_PURPOSE,
      keyId: `reservation-command-${suffix}`,
      ...binding,
      secret: Buffer.alloc(32, 73),
      notBeforeEpochMicros: micros(nowMs - 60_000),
      notAfterEpochMicros: micros(nowMs + 120_000),
    };
    const receiptKey: MeriHermesRecoveryReceiptKeyV1 = {
      purpose: MERI_HERMES_RECOVERY_RECEIPT_PURPOSE,
      keyId: `reservation-receipt-${suffix}`,
      ...binding,
      secret: Buffer.alloc(32, 79),
      notBeforeEpochMicros: micros(nowMs - 60_000),
      notAfterEpochMicros: micros(nowMs + 120_000),
    };
    const attemptNonce = createHash('sha256')
      .update(`${fixture.operationId}:${outcome}`).digest().subarray(0, 16).toString('base64url');
    const commandToken = mintMeriHermesReservationCommandV1({
      identity: fixture.identity,
      idempotencyKey: fixture.identity.idempotencyKey,
      deliveryNotBeforeEpochMicros: delivery,
      operationId: fixture.operationId,
      attemptNonce,
      notBeforeEpochMicros: issued,
      notAfterEpochMicros: expires,
    }, commandKey);
    const command = verifyMeriHermesReservationCommandV1(
      commandToken, fixture.identity, commandKey, observed,
    )!;
    const body = outcome === 'reserved'
      ? Buffer.from(
        `{"outcome":"reserved","workerRunId":"${fixture.workerRunId}",` +
        '"workerStatus":"running"}',
      )
      : Buffer.from(
        `{"outcome":"sealed_absent","sealedAtEpochMicros":"${observed}",` +
        `"retainUntilEpochMicros":"${retain}"}`,
      );
    const claims = {
      version: 1,
      purpose: 'meri-hermes-reservation-receipt',
      keyId: receiptKey.keyId,
      tenantId: command.tenantId,
      runId: command.runId,
      requestSha256: command.requestSha256,
      workerAudience: command.workerAudience,
      workerIngressId: command.workerIngressId,
      workerGeneration: command.workerGeneration,
      workerCredentialId: command.workerCredentialId,
      idempotencyKey: command.idempotencyKey,
      deliveryNotBeforeEpochMicros: command.deliveryNotBeforeEpochMicros,
      retainUntilEpochMicros: command.retainUntilEpochMicros,
      operationId: command.operationId,
      attemptNonce: command.attemptNonce,
      commandSha256: sha256(commandToken),
      nativeMethod: command.nativeMethod,
      nativePath: command.nativePath,
      nativeBodySha256: command.nativeBodySha256,
      nativeHttpStatus: 200,
      nativeResponseBodySha256: sha256(body),
      outcome,
      workerRunId: outcome === 'reserved' ? fixture.workerRunId : null,
      workerStatus: outcome === 'reserved' ? 'running' : null,
      sealedAtEpochMicros: outcome === 'sealed_absent' ? observed : null,
      observedAtEpochMicros: observed,
      notBeforeEpochMicros: command.notBeforeEpochMicros,
      notAfterEpochMicros: command.notAfterEpochMicros,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = createHmac('sha256', receiptKey.secret)
      .update('capiro.meri.phase4.reservation-receipt/v1\0', 'utf8')
      .update(`mhrqr1.${payload}`, 'ascii').digest('base64url');
    const receiptToken = `mhrqr1.${payload}.${signature}`;
    const receipt = verifyMeriHermesReservationReceiptV1(
      receiptToken, commandToken, fixture.identity, commandKey, receiptKey, observed,
    )!;
    return {
      identity: fixture.identity,
      idempotencyKey: fixture.identity.idempotencyKey,
      deliveryNotBeforeEpochMicros: delivery,
      commandToken,
      commandKey,
      receiptToken,
      receiptKey,
      verifiedCommand: command,
      verifiedReceipt: receipt,
    };
  }

  async function seedFixture(fixture: Fixture) {
    const { identity, material } = fixture;
    const issuedAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    await admin.query(
      `INSERT INTO public.clio_conversations
        (id,tenant_id,user_id,title,metadata_jsonb)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb)`,
      [identity.conversationId, tenantId, userId, `Reservation ${suffix}`,
        JSON.stringify({ hermes: { sessionEpoch: '3' } })],
    );
    await admin.query(
      `INSERT INTO public.clio_messages
        (id,tenant_id,user_id,conversation_id,role,body,metadata_jsonb)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'user',$5,$6::jsonb)`,
      [identity.userMessageId, tenantId, userId, identity.conversationId,
        material.sourceMessage.body, JSON.stringify(material.sourceMessage.metadata)],
    );
    await admin.query(
      `INSERT INTO public.meri_agent_runs
        (id,tenant_id,scope_id,actor_id,conversation_id,user_message_id,status,
         idempotency_key,envelope_jsonb,actor_context_jsonb,dispatch_status)
       VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::uuid,'provisioning',
         $7,$8::jsonb,'{}'::jsonb,'pending')`,
      [identity.runId, tenantId, scopeId, userId, identity.conversationId,
        identity.userMessageId, identity.idempotencyKey,
        JSON.stringify({ authorizationVersion, issuedAt, expiresAt })],
    );
    await admin.query(
      `INSERT INTO public.meri_agent_run_reservations
        (run_id,tenant_id,scope_id,conversation_id,period_date,max_run_tokens,
         estimated_tokens,estimated_micro_usd)
       VALUES ($1::uuid,$2::uuid,$3,$4::uuid,(clock_timestamp() AT TIME ZONE 'UTC')::date,
         1000,100,1000)`,
      [identity.runId, tenantId, scopeId, identity.conversationId],
    );
    await admin.query(
      `INSERT INTO public.meri_agent_dispatch_intents (
        run_id,tenant_id,identity_version,actor_type,actor_id,meri_audience,
        client_id,workspace_id,scope_id,conversation_id,user_message_id,idempotency_key,
        conversation_epoch,worker_audience,worker_ingress_id,worker_generation,
        worker_credential_id,authorization_version,authorization_policy_version,
        grant_version,catalog_digest,tool_view_digest,session_header_key_id,
        claim_not_after_epoch_micros,delivery_not_after_epoch_micros,
        worker_credential_not_after_epoch_micros,reconciliation_not_after_epoch_micros,
        retain_until_epoch_micros,source_message_sha256,body_length_bytes,body_sha256,
        request_assembly_sha256,session_header_hmac_sha256,request_sha256
      ) VALUES (
        $1::uuid,$2::uuid,2,'user',$3::uuid,'private',NULL,NULL,$4,$5::uuid,$6::uuid,$7,
        $8::bigint,$9,$10,$11,$12,$13,$14,$15,$16::char(64),$17::char(64),$18,
        $19::bigint,$20::bigint,$21::bigint,$22::bigint,$23::bigint,$24::char(64),
        $25::bigint,$26::char(64),$27::char(64),$28::char(64),$29::char(64)
      )`,
      [identity.runId, tenantId, userId, scopeId, identity.conversationId,
        identity.userMessageId, identity.idempotencyKey, identity.conversationEpoch,
        identity.workerAudience, identity.workerIngressId, identity.workerGeneration,
        identity.workerCredentialId, identity.authorizationVersion,
        identity.authorizationPolicyVersion, identity.grantVersion,
        identity.catalogDigest, identity.toolViewDigest, identity.sessionHeaderKeyId,
        identity.claimNotAfterEpochMicros, identity.deliveryNotAfterEpochMicros,
        identity.workerCredentialNotAfterEpochMicros,
        identity.reconciliationNotAfterEpochMicros, identity.retainUntilEpochMicros,
        identity.sourceMessageSha256, identity.bodyLengthBytes, identity.bodySha256,
        identity.requestAssemblySha256, identity.sessionHeaderHmacSha256,
        identity.requestSha256],
    );
  }

  beforeAll(async () => {
    await admin.connect();
    await admin.query(
      `INSERT INTO public.tenants (id,slug,name,status)
       VALUES ($1::uuid,$2,$3,'active')`,
      [tenantId, `reservation-db-${suffix}`, `Reservation DB ${suffix}`],
    );
    await admin.query(
      `INSERT INTO public.users (id,clerk_user_id,email)
       VALUES ($1::uuid,$2,$3)`,
      [userId, `reservation_db_${suffix}`, `reservation-db-${suffix}@example.invalid`],
    );
    await admin.query(
      `INSERT INTO public.tenant_memberships
        (id,tenant_id,user_id,role,status,joined_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,'capiro_admin','active',clock_timestamp())`,
      [membershipId, tenantId, userId],
    );
    await admin.query(
      `INSERT INTO public.meri_execution_scopes
        (id,tenant_id,principal_type,principal_id,kind,authorization_version)
       VALUES ($1,$2::uuid,'user',$3::uuid,'private',$4)`,
      [scopeId, tenantId, userId, authorizationVersion],
    );
    for (const label of ['claim-race', 'revoke-race', 'reserved', 'sealed']) {
      const fixture = makeFixture(label);
      fixtures.push(fixture);
      await seedFixture(fixture);
    }
  });

  afterAll(async () => { await admin.end(); });

  it('serializes an ordinary claim ahead of a competing signed absence seal', async () => {
    const fixture = fixtures[0]!;
    const claim = new Client({ connectionString: databaseUrl });
    await claim.connect();
    try {
      await claim.query('BEGIN');
      await claim.query("SELECT set_config('app.current_tenant',$1,true)", [tenantId]);
      await claim.query('SET LOCAL ROLE capiro_app');
      await claim.query(
        'SELECT revision FROM public.meri_phase4_lock_authority_fence($1::uuid)',
        [tenantId],
      );
      await claim.query(
        `SELECT r.id FROM public.meri_agent_runs r
         JOIN public.meri_execution_scopes s ON s.id=r.scope_id AND s.tenant_id=r.tenant_id
         JOIN public.clio_conversations c ON c.id=r.conversation_id AND c.tenant_id=r.tenant_id
         JOIN public.clio_messages m ON m.id=r.user_message_id AND m.tenant_id=r.tenant_id
         WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid FOR UPDATE OF r,s,c,m`,
        [tenantId, fixture.identity.runId],
      );
      await claim.query(
        `SELECT run_id FROM public.meri_agent_dispatch_intents
         WHERE tenant_id=$1::uuid AND run_id=$2::uuid FOR UPDATE`,
        [tenantId, fixture.identity.runId],
      );
      await claim.query(
        `UPDATE public.meri_agent_runs SET hermes_run_id=$3
         WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenantId, fixture.identity.runId, fixture.workerRunId],
      );
      await claim.query(
        `UPDATE public.meri_agent_dispatch_intents SET state='claimed',worker_run_id=$3
         WHERE tenant_id=$1::uuid AND run_id=$2::uuid`,
        [tenantId, fixture.identity.runId, fixture.workerRunId],
      );

      await delay(Math.max(0, deliveryAtMs - Date.now() + 25));
      const database = new PgRecoveryDatabase(databaseUrl!, tenantId);
      let settled = false;
      const competing = new MeriHermesReservationRecoveryRepositoryV1(database)
        .commitVerified(commitInput(fixture, 'sealed_absent'))
        .finally(() => { settled = true; });
      await delay(150);
      expect(settled).toBe(false);
      await claim.query('COMMIT');
      await expect(competing).rejects.toBeInstanceOf(
        MeriHermesReservationRecoveryPersistenceConflictError,
      );
    } finally {
      await claim.query('ROLLBACK').catch(() => undefined);
      await claim.end();
    }
    const result = await admin.query(
      `SELECT i.state,i.worker_run_id,count(o.*)::int AS operations,count(q.*)::int AS receipts
       FROM public.meri_agent_dispatch_intents i
       LEFT JOIN public.meri_phase4_reservation_recovery_operations o
         ON o.tenant_id=i.tenant_id AND o.run_id=i.run_id
       LEFT JOIN public.meri_phase4_reservation_recovery_receipts q
         ON q.tenant_id=i.tenant_id AND q.run_id=i.run_id
       WHERE i.tenant_id=$1::uuid AND i.run_id=$2::uuid
       GROUP BY i.state,i.worker_run_id`,
      [tenantId, fixture.identity.runId],
    );
    expect(result.rows[0]).toEqual({
      state: 'claimed', worker_run_id: fixture.workerRunId, operations: 0, receipts: 0,
    });
  });

  it('serializes an exclusive revocation fence ahead of an absence seal', async () => {
    const fixture = fixtures[1]!;
    const revocation = new Client({ connectionString: databaseUrl });
    await revocation.connect();
    try {
      await revocation.query('BEGIN');
      await revocation.query(
        `SELECT revision FROM public.meri_phase4_authority_fences
         WHERE tenant_id=$1::uuid FOR UPDATE`,
        [tenantId],
      );
      const database = new PgRecoveryDatabase(databaseUrl!, tenantId);
      let settled = false;
      const competing = new MeriHermesReservationRecoveryRepositoryV1(database)
        .commitVerified(commitInput(fixture, 'sealed_absent'))
        .finally(() => { settled = true; });
      await delay(150);
      expect(settled).toBe(false);
      await revocation.query('COMMIT');
      await expect(competing).resolves.toEqual({ kind: 'sealed_absent' });
    } finally {
      await revocation.query('ROLLBACK').catch(() => undefined);
      await revocation.end();
    }
  });

  it('binds a late reserved worker and exactly replays its receipt', async () => {
    const fixture = fixtures[2]!;
    const input = commitInput(fixture, 'reserved');
    const repository = new MeriHermesReservationRecoveryRepositoryV1(
      new PgRecoveryDatabase(databaseUrl!, tenantId),
    );
    await expect(repository.commitVerified(input)).resolves.toEqual({
      kind: 'bound_worker', workerRunId: fixture.workerRunId,
    });
    await expect(repository.commitVerified(input)).resolves.toEqual({
      kind: 'bound_worker', workerRunId: fixture.workerRunId,
    });
    const result = await admin.query(
      `SELECT i.state,i.worker_run_id,r.hermes_run_id,
        (SELECT count(*)::int FROM public.meri_phase4_reservation_recovery_operations o
         WHERE o.tenant_id=i.tenant_id AND o.run_id=i.run_id) AS operations,
        (SELECT count(*)::int FROM public.meri_phase4_reservation_recovery_receipts q
         WHERE q.tenant_id=i.tenant_id AND q.run_id=i.run_id) AS receipts
       FROM public.meri_agent_dispatch_intents i
       JOIN public.meri_agent_runs r ON r.tenant_id=i.tenant_id AND r.id=i.run_id
       WHERE i.tenant_id=$1::uuid AND i.run_id=$2::uuid`,
      [tenantId, fixture.identity.runId],
    );
    expect(result.rows[0]).toEqual({
      state: 'claimed', worker_run_id: fixture.workerRunId,
      hermes_run_id: fixture.workerRunId, operations: 1, receipts: 1,
    });
  });

  it('seals signed absence with the exact receipt digest and no worker id', async () => {
    const fixture = fixtures[3]!;
    const input = commitInput(fixture, 'sealed_absent');
    const repository = new MeriHermesReservationRecoveryRepositoryV1(
      new PgRecoveryDatabase(databaseUrl!, tenantId),
    );
    await expect(repository.commitVerified(input)).resolves.toEqual({ kind: 'sealed_absent' });
    const result = await admin.query(
      `SELECT i.state,i.worker_run_id,i.absence_proof_sha256,r.hermes_run_id,q.receipt_sha256
       FROM public.meri_agent_dispatch_intents i
       JOIN public.meri_agent_runs r ON r.tenant_id=i.tenant_id AND r.id=i.run_id
       JOIN public.meri_phase4_reservation_recovery_receipts q
         ON q.tenant_id=i.tenant_id AND q.run_id=i.run_id
       WHERE i.tenant_id=$1::uuid AND i.run_id=$2::uuid`,
      [tenantId, fixture.identity.runId],
    );
    expect(result.rows[0]).toEqual({
      state: 'sealed_absent', worker_run_id: null,
      absence_proof_sha256: sha256(input.receiptToken), hermes_run_id: null,
      receipt_sha256: sha256(input.receiptToken),
    });
  });
});
