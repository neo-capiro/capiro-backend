import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';

const databaseUrl = process.env.MERI_PHASE4_ROUTE_TEST_DATABASE_URL;
const parsed = databaseUrl ? new URL(databaseUrl) : null;
const isolated = Boolean(
  parsed?.protocol === 'postgresql:' && parsed.hostname === '127.0.0.1' &&
  parsed.username === 'postgres' && parsed.pathname === '/capiro' &&
  process.env.MERI_PHASE4_ROUTE_TEST_ACKNOWLEDGE_DISPOSABLE === 'yes',
);
const describeDb = isolated ? describe : describe.skip;
const emptySha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const stopSha = createHash('sha256').update('{}').digest('hex');
const micros = (milliseconds: number) => BigInt(milliseconds) * 1_000n;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const nonce = (value: string) => createHash('sha256').update(value).digest()
  .subarray(0, 16).toString('base64url');
const signature = (value: string) => createHash('sha256').update(value).digest()
  .toString('base64url');

type RunStatus = 'provisioning' | 'running' | 'cancelling';
type DispatchObservation = 'run_terminal' | 'stop_accepted';

interface SeededRun {
  runId: string;
  conversationId: string;
  workerRunId: string;
  requestSha256: string;
  idempotencyKey: string;
  deliveryNotAfter: bigint;
  reconciliationNotAfter: bigint;
  retainUntil: bigint;
}

interface ClaimedOutcome {
  tenantId: string;
  runId: string;
  operationId: string;
  attemptNonce: string;
  ownerId: string;
  claimToken: string;
}

interface RunRow {
  status: string;
  finish_reason: string | null;
  partial: boolean;
  output: string;
  assistant_message_id: string | null;
  output_seq: number;
  last_seq: number;
  finished_at: Date | null;
  consumer_id: string | null;
}

describeDb('Phase 4 recovery outcome application on disposable migrated PostgreSQL', () => {
  jest.setTimeout(90_000);

  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const loginRole = `meri_p4_apply_test_${suffix}`;
  const loginPassword = `MeriP4Apply_${suffix}_Only`;
  const tenantId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const scopeId = `tenant:${tenantId}:user:${userId}`;
  const admin = new Client({ connectionString: databaseUrl });
  const quoteRole = (value: string) => `"${value.replaceAll('"', '""')}"`;

  async function loginClient(): Promise<Client> {
    const url = new URL(databaseUrl!);
    url.username = loginRole;
    url.password = loginPassword;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    return client;
  }

  async function record(
    outcome: ClaimedOutcome,
    kind: 'reservation_bound_worker' | 'reservation_sealed_absent' |
      'dispatch_terminal' | 'dispatch_nonterminal' | 'unknown',
    detail: 'reserved' | 'sealed_absent' | 'run_terminal' |
      'stop_accepted' | 'transport_unconfirmed',
    withReceipt: boolean,
  ): Promise<string> {
    const client = await loginClient();
    try {
      await client.query('SET ROLE meri_phase4_recovery_operator');
      const result = await client.query<{ record_result: string }>(
        `SELECT record_result FROM public.meri_phase4_record_recovery_outcome(
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,
          $6::varchar,$7::varchar,$8::uuid,$9::varchar,$10::varchar
        )`,
        [outcome.tenantId, outcome.operationId, outcome.ownerId,
          outcome.claimToken, outcome.operationId, outcome.attemptNonce,
          kind, withReceipt ? outcome.operationId : null,
          withReceipt ? outcome.attemptNonce : null, detail],
      );
      return result.rows[0]!.record_result;
    } finally {
      await client.end();
    }
  }

  async function seedRun(
    label: string,
    options: {
      status?: RunStatus;
      output?: string;
      stopRequested?: boolean;
      finishReason?: string | null;
      consumerId?: string | null;
      consumerHeartbeat?: Date | null;
      recoveryWindow?: boolean;
      claimIntent?: boolean;
    } = {},
  ): Promise<SeededRun> {
    const runId = randomUUID();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const workerRunId = `recovery-${label}-${suffix}`;
    const idempotencyKey = `recovery-apply-${label}-${suffix}`;
    const requestSha256 = sha(`request:${label}:${suffix}`);
    const now = micros(Date.now());
    const day = 86_400_000_000n;
    const claimNotAfter = options.recoveryWindow ? now + 2_000_000n : now + day;
    const deliveryNotAfter = options.recoveryWindow ? now + 2_000_000n : now + day;
    const credentialNotAfter = deliveryNotAfter;
    const reconciliationNotAfter = deliveryNotAfter + day;
    const retainUntil = reconciliationNotAfter + day;
    const body = `recovery outcome ${label}`;
    const authorizationVersion = `auth-${suffix}`;
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Number(retainUntil / 1_000n)).toISOString();

    await admin.query(
      `INSERT INTO public.clio_conversations
        (id,tenant_id,user_id,title,metadata_jsonb)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,'{}'::jsonb)`,
      [conversationId, tenantId, userId, `Recovery ${label} ${suffix}`],
    );
    await admin.query(
      `INSERT INTO public.clio_messages
        (id,tenant_id,user_id,conversation_id,role,body,metadata_jsonb)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'user',$5,'{}'::jsonb)`,
      [messageId, tenantId, userId, conversationId, body],
    );
    await admin.query(
      `INSERT INTO public.meri_agent_runs (
        id,tenant_id,scope_id,actor_id,conversation_id,user_message_id,status,
        finish_reason,idempotency_key,envelope_jsonb,actor_context_jsonb,
        dispatch_status,hermes_run_id,output,stop_requested_at,
        consumer_id,consumer_heartbeat_at
      ) VALUES (
        $1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9,
        $10::jsonb,'{}'::jsonb,$11,$12,$13,$14,$15,$16
      )`,
      [runId, tenantId, scopeId, userId, conversationId, messageId,
        options.status ?? 'running', options.finishReason ?? null, idempotencyKey,
        JSON.stringify({ authorizationVersion, issuedAt, expiresAt, model: 'recovery-test' }),
        options.recoveryWindow ? 'pending' : 'dispatched',
        options.recoveryWindow ? null : workerRunId, options.output ?? '',
        options.stopRequested ? new Date().toISOString() : null,
        options.consumerId ?? null, options.consumerHeartbeat ?? null],
    );
    await admin.query(
      `INSERT INTO public.meri_agent_run_reservations
        (run_id,tenant_id,scope_id,conversation_id,period_date,max_run_tokens,
         estimated_tokens,estimated_micro_usd)
       VALUES ($1::uuid,$2::uuid,$3,$4::uuid,
         (clock_timestamp() AT TIME ZONE 'UTC')::date,1000,100,1000)`,
      [runId, tenantId, scopeId, conversationId],
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
        1,'meri-hermes-scope-worker',$8,$9,$10,$11,$12,$13,
        $14::char(64),$15::char(64),$16,$17::bigint,$18::bigint,$19::bigint,
        $20::bigint,$21::bigint,$22::char(64),$23::bigint,$24::char(64),
        $25::char(64),$26::char(64),$27::char(64)
      )`,
      [runId, tenantId, userId, scopeId, conversationId, messageId, idempotencyKey,
        `ingress-${suffix}`, `generation-${suffix}`, `credential-${suffix}`,
        authorizationVersion, `policy-${suffix}`, `grant-${suffix}`,
        sha(`catalog:${suffix}`), sha(`tools:${suffix}`), `session-${suffix}`,
        claimNotAfter.toString(), deliveryNotAfter.toString(),
        credentialNotAfter.toString(), reconciliationNotAfter.toString(),
        retainUntil.toString(), sha(`source:${label}:${suffix}`),
        Buffer.byteLength(body), sha(body), sha(`assembly:${label}:${suffix}`),
        sha(`session-hmac:${label}:${suffix}`), requestSha256],
    );

    if (options.claimIntent !== false && !options.recoveryWindow) {
      await admin.query('BEGIN');
      try {
        await admin.query("SELECT set_config('app.current_tenant',$1,true)", [tenantId]);
        await admin.query('SET LOCAL ROLE capiro_app');
        await admin.query(
          `UPDATE public.meri_agent_dispatch_intents
           SET state='claimed',worker_run_id=$3
           WHERE tenant_id=$1::uuid AND run_id=$2::uuid`,
          [tenantId, runId, workerRunId],
        );
        await admin.query('COMMIT');
      } catch (error) {
        await admin.query('ROLLBACK');
        throw error;
      }
    }

    return {
      runId, conversationId, workerRunId, requestSha256, idempotencyKey,
      deliveryNotAfter, reconciliationNotAfter, retainUntil,
    };
  }

  async function seedDispatchOutcome(
    run: SeededRun,
    label: string,
    options: {
      action?: 'status' | 'stop';
      observation?: DispatchObservation;
      workerStatus?: 'completed' | null;
      displayOutput?: string | null;
      displayUsage?: Record<string, number> | null;
      expiresInMicros?: bigint;
    } = {},
  ): Promise<ClaimedOutcome> {
    const operationId = randomUUID();
    const attemptNonce = nonce(`dispatch:${label}:${suffix}`);
    const ownerId = randomUUID();
    const claimToken = randomUUID();
    const receiptId = randomUUID();
    const action = options.action ?? 'status';
    const observation = options.observation ?? 'run_terminal';
    const workerStatus = options.workerStatus === undefined ? 'completed' : options.workerStatus;
    const now = micros(Date.now());
    const issued = now - 1_000_000n;
    const receiptExpiry = now + 30_000_000n;
    const obligationExpiry = options.expiresInMicros === undefined
      ? now + 86_400_000_000n : now + options.expiresInMicros;
    const nextAttempt = obligationExpiry < now ? obligationExpiry : now;
    const claimExpiry = obligationExpiry < now + 30_000_000n
      ? obligationExpiry : now + 30_000_000n;
    const responseBody = observation === 'run_terminal'
      ? JSON.stringify({
          run_id: run.workerRunId,
          status: workerStatus,
          session_id: `session-${label}-${suffix}`,
          output: options.displayOutput ?? undefined,
          usage: options.displayUsage ?? undefined,
        })
      : '{"accepted":true}';
    const responseSha = sha(responseBody);
    const intent = (await admin.query<{
      worker_audience: string;
      worker_ingress_id: string;
      worker_generation: string;
      worker_credential_id: string;
    }>(
      `SELECT worker_audience,worker_ingress_id,worker_generation,worker_credential_id
       FROM public.meri_agent_dispatch_intents
       WHERE tenant_id=$1::uuid AND run_id=$2::uuid`,
      [tenantId, run.runId],
    )).rows[0]!;

    await admin.query(
      `INSERT INTO public.meri_phase4_dispatch_recovery_operations (
        tenant_id,operation_id,run_id,request_sha256,worker_run_id,
        worker_audience,worker_ingress_id,worker_generation,worker_credential_id,action
      ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10)`,
      [tenantId, operationId, run.runId, run.requestSha256, run.workerRunId,
        intent.worker_audience, intent.worker_ingress_id, intent.worker_generation,
        intent.worker_credential_id, action],
    );
    await admin.query(
      `INSERT INTO public.meri_phase4_dispatch_recovery_receipts (
        receipt_id,contract_version,receipt_purpose,tenant_id,run_id,request_sha256,
        worker_run_id,worker_audience,worker_ingress_id,worker_generation,
        worker_credential_id,action,operation_id,attempt_nonce,command_key_id,
        command_sha256,native_request_body_sha256,native_response_body_sha256,
        receipt_sha256,observation,worker_status,native_http_status,
        issued_at_epoch_micros,expires_at_epoch_micros,observed_at_epoch_micros,
        key_id,signature
      ) VALUES (
        $1::uuid,1,'meri-hermes-recovery-receipt',$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,
        $10,$11::uuid,$12,$13,$14::char(64),$15::char(64),$16::char(64),
        $17::char(64),$18,$19,$20,$21::bigint,$22::bigint,$23::bigint,$24,$25
      )`,
      [receiptId, tenantId, run.runId, run.requestSha256, run.workerRunId,
        intent.worker_audience, intent.worker_ingress_id, intent.worker_generation,
        intent.worker_credential_id, action, operationId, attemptNonce,
        `command-${label}-${suffix}`, sha(`command:${label}:${suffix}`),
        action === 'status' ? emptySha : stopSha, responseSha,
        sha(`receipt:${label}:${suffix}`), observation, workerStatus,
        observation === 'stop_accepted' ? 202 : 200, issued.toString(),
        receiptExpiry.toString(), now.toString(), `receipt-${label}-${suffix}`,
        signature(`signature:${label}:${suffix}`)],
    );
    if (observation === 'run_terminal' && options.displayOutput !== undefined) {
      await admin.query(
        `INSERT INTO public.meri_phase4_recovery_display_receipts (
          receipt_id,tenant_id,run_id,operation_id,attempt_nonce,
          native_response_body_sha256,worker_status,hermes_session_id,
          output_text,error_text,usage_jsonb,display_state
        ) VALUES (
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,NULL,$10::jsonb,$11
        )`,
        [receiptId, tenantId, run.runId, operationId, attemptNonce, responseSha,
          workerStatus, `session-${label}-${suffix}`, options.displayOutput,
          options.displayUsage === undefined || options.displayUsage === null
            ? null : JSON.stringify(options.displayUsage),
          workerStatus === 'completed' && options.displayOutput !== null &&
            options.displayOutput.length > 0 ? 'available' : 'unavailable'],
      );
    }
    await admin.query(
      `INSERT INTO public.meri_phase4_recovery_obligations (
        obligation_id,tenant_id,run_id,obligation_kind,action,sequence,
        operation_id,attempt_nonce,native_body_bytes,state,
        next_attempt_at_epoch_micros,expires_at_epoch_micros,
        claim_owner,claim_token,claim_expires_at_epoch_micros,attempt_count
      ) VALUES (
        $1::uuid,$2::uuid,$3::uuid,'dispatch',$4,0,$1::uuid,$5,$6::bytea,
        'claimed',$7::bigint,$8::bigint,$9::uuid,$10::uuid,$11::bigint,1
      )`,
      [operationId, tenantId, run.runId, action, attemptNonce,
        action === 'status' ? Buffer.alloc(0) : Buffer.from('{}'),
        nextAttempt.toString(), obligationExpiry.toString(), ownerId, claimToken,
        claimExpiry.toString()],
    );
    return { tenantId, runId: run.runId, operationId, attemptNonce, ownerId, claimToken };
  }

  async function seedReservationOutcome(
    run: SeededRun,
    label: string,
    outcome: 'reserved' | 'sealed_absent',
  ): Promise<ClaimedOutcome> {
    const waitForRecoveryWindow = Number(run.deliveryNotAfter / 1_000n) - Date.now() + 25;
    if (waitForRecoveryWindow > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, waitForRecoveryWindow));
    }
    const operationId = randomUUID();
    const attemptNonce = nonce(`reservation:${label}:${suffix}`);
    const ownerId = randomUUID();
    const claimToken = randomUUID();
    const now = micros(Date.now());
    const issued = now;
    const expires = now + 30_000_000n;
    const sealedAt = outcome === 'sealed_absent' ? now : null;
    const intent = (await admin.query<{
      worker_audience: string;
      worker_ingress_id: string;
      worker_generation: string;
      worker_credential_id: string;
    }>(
      `SELECT worker_audience,worker_ingress_id,worker_generation,worker_credential_id
       FROM public.meri_agent_dispatch_intents
       WHERE tenant_id=$1::uuid AND run_id=$2::uuid`,
      [tenantId, run.runId],
    )).rows[0]!;

    await admin.query(
      `INSERT INTO public.meri_phase4_reservation_recovery_operations (
        tenant_id,operation_id,run_id,request_sha256,idempotency_key,
        worker_audience,worker_ingress_id,worker_generation,worker_credential_id,
        delivery_not_before_epoch_micros,retain_until_epoch_micros,outcome,
        worker_run_id,sealed_at_epoch_micros
      ) VALUES (
        $1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10::bigint,$11::bigint,
        $12,$13,$14::bigint
      )`,
      [tenantId, operationId, run.runId, run.requestSha256, run.idempotencyKey,
        intent.worker_audience, intent.worker_ingress_id, intent.worker_generation,
        intent.worker_credential_id, run.deliveryNotAfter.toString(),
        run.retainUntil.toString(), outcome,
        outcome === 'reserved' ? run.workerRunId : null,
        sealedAt?.toString() ?? null],
    );
    await admin.query('BEGIN');
    try {
      await admin.query("SELECT set_config('app.current_tenant',$1,true)", [tenantId]);
      await admin.query('SET LOCAL ROLE meri_phase4_authority_owner');
      await admin.query(
        `UPDATE public.meri_agent_dispatch_intents
         SET state=$3,worker_run_id=$4,absence_proof_sha256=$5
         WHERE tenant_id=$1::uuid AND run_id=$2::uuid`,
        [tenantId, run.runId, outcome === 'reserved' ? 'claimed' : 'sealed_absent',
          outcome === 'reserved' ? run.workerRunId : null,
          outcome === 'sealed_absent' ? sha(`absence:${label}:${suffix}`) : null],
      );
      if (outcome === 'reserved') {
        await admin.query(
          `UPDATE public.meri_agent_runs
           SET hermes_run_id=$3,dispatch_status='dispatched'
           WHERE tenant_id=$1::uuid AND id=$2::uuid`,
          [tenantId, run.runId, run.workerRunId],
        );
      }
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
    await admin.query(
      `INSERT INTO public.meri_phase4_reservation_recovery_receipts (
        contract_version,receipt_purpose,tenant_id,run_id,request_sha256,idempotency_key,
        worker_audience,worker_ingress_id,worker_generation,worker_credential_id,
        delivery_not_before_epoch_micros,retain_until_epoch_micros,outcome,
        worker_run_id,worker_status,sealed_at_epoch_micros,operation_id,attempt_nonce,
        command_key_id,command_sha256,native_request_body_sha256,
        native_response_body_sha256,receipt_sha256,native_http_status,
        issued_at_epoch_micros,expires_at_epoch_micros,observed_at_epoch_micros,
        key_id,signature
      ) VALUES (
        1,'meri-hermes-reservation-receipt',$1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,
        $9::bigint,$10::bigint,$11,$12,$13,$14::bigint,$15::uuid,$16,$17,
        $18::char(64),$19::char(64),$20::char(64),$21::char(64),200,
        $22::bigint,$23::bigint,$24::bigint,$25,$26
      )`,
      [tenantId, run.runId, run.requestSha256, run.idempotencyKey,
        intent.worker_audience, intent.worker_ingress_id, intent.worker_generation,
        intent.worker_credential_id, run.deliveryNotAfter.toString(),
        run.retainUntil.toString(), outcome,
        outcome === 'reserved' ? run.workerRunId : null,
        outcome === 'reserved' ? 'running' : null, sealedAt?.toString() ?? null,
        operationId, attemptNonce, `reservation-command-${label}-${suffix}`,
        sha(`reservation-command:${label}:${suffix}`), emptySha,
        sha(`reservation-response:${label}:${suffix}`),
        sha(`reservation-receipt:${label}:${suffix}`), issued.toString(),
        expires.toString(), now.toString(), `reservation-receipt-${label}-${suffix}`,
        signature(`reservation-signature:${label}:${suffix}`)],
    );
    await admin.query(
      `INSERT INTO public.meri_phase4_recovery_obligations (
        obligation_id,tenant_id,run_id,obligation_kind,action,sequence,
        operation_id,attempt_nonce,native_body_bytes,state,
        next_attempt_at_epoch_micros,expires_at_epoch_micros,
        claim_owner,claim_token,claim_expires_at_epoch_micros,attempt_count
      ) VALUES (
        $1::uuid,$2::uuid,$3::uuid,'reservation',NULL,0,$1::uuid,$4,''::bytea,
        'claimed',$5::bigint,$6::bigint,$7::uuid,$8::uuid,$9::bigint,1
      )`,
      [operationId, tenantId, run.runId, attemptNonce, now.toString(),
        run.retainUntil.toString(), ownerId, claimToken,
        (now + 30_000_000n).toString()],
    );
    return { tenantId, runId: run.runId, operationId, attemptNonce, ownerId, claimToken };
  }

  async function readRun(runId: string): Promise<RunRow> {
    return (await admin.query<RunRow>(
      `SELECT status,finish_reason,partial,output,assistant_message_id,
        output_seq,last_seq,finished_at,consumer_id
       FROM public.meri_agent_runs
       WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [tenantId, runId],
    )).rows[0]!;
  }

  beforeAll(async () => {
    await admin.connect();
    await admin.query(
      `CREATE ROLE ${quoteRole(loginRole)} LOGIN PASSWORD '${loginPassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    );
    await admin.query(`GRANT meri_phase4_recovery_operator TO ${quoteRole(loginRole)}`);
    await admin.query(
      `INSERT INTO public.tenants (id,slug,name,status)
       VALUES ($1::uuid,$2,$3,'active')`,
      [tenantId, `recovery-apply-${suffix}`, `Recovery Apply ${suffix}`],
    );
    await admin.query(
      `INSERT INTO public.users (id,clerk_user_id,email) VALUES ($1::uuid,$2,$3)`,
      [userId, `recovery_apply_${suffix}`, `recovery-apply-${suffix}@example.invalid`],
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
      [scopeId, tenantId, userId, `recovery-apply-${suffix}`],
    );
  });

  afterAll(async () => {
    await admin.query(
      `UPDATE public.meri_phase4_recovery_obligations
       SET state='superseded',claim_owner=NULL,claim_token=NULL,
           claim_expires_at_epoch_micros=NULL,superseded_at=clock_timestamp(),
           updated_at=clock_timestamp()
       WHERE tenant_id=$1::uuid AND state IN ('pending','claimed')`,
      [tenantId],
    ).catch(() => undefined);
    await admin.query('DELETE FROM public.tenants WHERE id=$1::uuid', [tenantId])
      .catch(() => undefined);
    await admin.query('DELETE FROM public.users WHERE id=$1::uuid', [userId])
      .catch(() => undefined);
    await admin.query(`REVOKE meri_phase4_recovery_operator FROM ${quoteRole(loginRole)}`)
      .catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${quoteRole(loginRole)}`).catch(() => undefined);
    await admin.end();
  });

  test('publishes one receipt-bound completion and exact replay publishes nothing twice', async () => {
    const run = await seedRun('terminal-display');
    const outcome = await seedDispatchOutcome(run, 'terminal-display', {
      displayOutput: 'Recovered verified answer',
      displayUsage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
    });
    await expect(record(outcome, 'dispatch_terminal', 'run_terminal', true))
      .resolves.toBe('recorded');

    const terminal = await readRun(run.runId);
    expect(terminal).toMatchObject({
      status: 'completed', finish_reason: 'stop', partial: false,
      output: 'Recovered verified answer',
    });
    expect(terminal.finished_at).toBeInstanceOf(Date);
    expect(terminal.assistant_message_id).not.toBeNull();
    expect(terminal.output_seq).toBeGreaterThan(0);
    expect(terminal.output_seq).toBe(terminal.last_seq);

    const messages = await admin.query<{
      id: string; body: string; metadata_jsonb: Record<string, unknown>;
    }>(
      `SELECT id,body,metadata_jsonb FROM public.clio_messages
       WHERE tenant_id=$1::uuid AND conversation_id=$2::uuid AND role='assistant'`,
      [tenantId, run.conversationId],
    );
    expect(messages.rows).toHaveLength(1);
    expect(messages.rows[0]).toMatchObject({
      id: terminal.assistant_message_id!, body: 'Recovered verified answer',
    });
    expect(messages.rows[0]!.metadata_jsonb).toMatchObject({
      runtime: 'hermes', meriRunId: run.runId,
    });
    const events = await admin.query<{
      seq: number; kind: string; visibility: string;
      payload_jsonb: { status?: string; final?: boolean; frames?: unknown[] };
    }>(
      `SELECT seq,kind,visibility,payload_jsonb
       FROM public.meri_agent_run_events
       WHERE run_id=$1::uuid AND kind='run.status'
         AND payload_jsonb->>'final'='true'`,
      [run.runId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({
      seq: terminal.output_seq, kind: 'run.status', visibility: 'public',
      payload_jsonb: { status: 'completed', final: true },
    });
    expect(Array.isArray(events.rows[0]!.payload_jsonb.frames)).toBe(true);

    await expect(record(outcome, 'dispatch_terminal', 'run_terminal', true))
      .resolves.toBe('replayed');
    const replayCounts = await admin.query<{ messages: string; events: string }>(
      `SELECT
        (SELECT count(*)::text FROM public.clio_messages
         WHERE tenant_id=$1::uuid AND conversation_id=$2::uuid AND role='assistant') AS messages,
        (SELECT count(*)::text FROM public.meri_agent_run_events
         WHERE run_id=$3::uuid AND kind='run.status'
           AND payload_jsonb->>'final'='true') AS events`,
      [tenantId, run.conversationId, run.runId],
    );
    expect(replayCounts.rows[0]).toEqual({ messages: '1', events: '1' });
  });

  test('keeps completed proof unresolved when no normalized display is available', async () => {
    const run = await seedRun('terminal-no-display', { output: 'durable partial' });
    const outcome = await seedDispatchOutcome(run, 'terminal-no-display');
    await expect(record(outcome, 'dispatch_terminal', 'run_terminal', true))
      .resolves.toBe('recorded');
    expect(await readRun(run.runId)).toMatchObject({
      status: 'running', output: 'durable partial', assistant_message_id: null,
      finished_at: null,
    });
    const provenance = await admin.query<{ state: string; result: string }>(
      `SELECT o.state,a.result
       FROM public.meri_phase4_recovery_obligations o
       JOIN public.meri_phase4_recovery_outcome_applications a
         ON a.tenant_id=o.tenant_id AND a.obligation_id=o.obligation_id
       WHERE o.tenant_id=$1::uuid AND o.obligation_id=$2::uuid`,
      [tenantId, outcome.operationId],
    );
    expect(provenance.rows[0]).toEqual({ state: 'unresolved', result: 'unresolved' });
  });

  test('lets durable Stop override recovered completed display', async () => {
    const run = await seedRun('stop-overrides-completed', {
      status: 'cancelling', stopRequested: true, output: 'durable pre-Stop output',
    });
    const outcome = await seedDispatchOutcome(run, 'stop-overrides-completed', {
      action: 'stop', displayOutput: 'late worker answer',
    });
    await expect(record(outcome, 'dispatch_terminal', 'run_terminal', true))
      .resolves.toBe('recorded');
    expect(await readRun(run.runId)).toMatchObject({
      status: 'cancelled', finish_reason: 'aborted', partial: true,
      output: 'durable pre-Stop output',
    });
    const body = await admin.query<{ body: string }>(
      `SELECT body FROM public.clio_messages
       WHERE tenant_id=$1::uuid AND conversation_id=$2::uuid AND role='assistant'`,
      [tenantId, run.conversationId],
    );
    expect(body.rows).toEqual([{ body: 'durable pre-Stop output' }]);
  });

  test('turns a recovered reservation after Stop into exact two-byte Stop work', async () => {
    const run = await seedRun('reservation-after-stop', {
      status: 'cancelling', stopRequested: true, recoveryWindow: true,
      claimIntent: false,
    });
    const outcome = await seedReservationOutcome(run, 'reservation-after-stop', 'reserved');
    await expect(record(outcome, 'reservation_bound_worker', 'reserved', true))
      .resolves.toBe('recorded');
    const stopWork = await admin.query<{
      state: string; action: string; native_body_bytes: Buffer;
    }>(
      `SELECT state,action,native_body_bytes
       FROM public.meri_phase4_recovery_obligations
       WHERE tenant_id=$1::uuid AND run_id=$2::uuid
         AND obligation_kind='dispatch' AND action='stop'`,
      [tenantId, run.runId],
    );
    expect(stopWork.rows).toHaveLength(1);
    expect(stopWork.rows[0]).toMatchObject({ state: 'pending', action: 'stop' });
    expect(stopWork.rows[0]!.native_body_bytes).toEqual(Buffer.from('{}'));
  });

  test('keeps stop_accepted nonterminal and schedules status proof', async () => {
    const run = await seedRun('stop-accepted', {
      status: 'cancelling', stopRequested: true,
    });
    const outcome = await seedDispatchOutcome(run, 'stop-accepted', {
      action: 'stop', observation: 'stop_accepted', workerStatus: null,
    });
    await expect(record(outcome, 'dispatch_nonterminal', 'stop_accepted', true))
      .resolves.toBe('recorded');
    expect(await readRun(run.runId)).toMatchObject({
      status: 'cancelling', assistant_message_id: null, finished_at: null,
    });
    const statusWork = await admin.query<{ state: string; action: string; sequence: number }>(
      `SELECT state,action,sequence FROM public.meri_phase4_recovery_obligations
       WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND action='status'`,
      [tenantId, run.runId],
    );
    expect(statusWork.rows).toEqual([{ state: 'pending', action: 'status', sequence: 1 }]);
  });

  test('defers to a fresh normal consumer but takes over its stale lease', async () => {
    const run = await seedRun('consumer-takeover', {
      consumerId: `api:live-${suffix}`, consumerHeartbeat: new Date(),
    });
    const outcome = await seedDispatchOutcome(run, 'consumer-takeover', {
      displayOutput: 'takeover answer',
    });
    await expect(record(outcome, 'dispatch_terminal', 'run_terminal', true))
      .rejects.toMatchObject({ code: '40001' });
    expect(await readRun(run.runId)).toMatchObject({
      status: 'running', assistant_message_id: null, consumer_id: `api:live-${suffix}`,
    });
    const claim = await admin.query<{ state: string; claim_token: string | null }>(
      `SELECT state,claim_token FROM public.meri_phase4_recovery_obligations
       WHERE obligation_id=$1::uuid`,
      [outcome.operationId],
    );
    expect(claim.rows[0]).toEqual({ state: 'claimed', claim_token: outcome.claimToken });

    await admin.query(
      `UPDATE public.meri_agent_runs
       SET consumer_heartbeat_at=clock_timestamp()-interval '2 minutes',
           updated_at=clock_timestamp()-interval '2 minutes'
       WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [tenantId, run.runId],
    );
    await expect(record(outcome, 'dispatch_terminal', 'run_terminal', true))
      .resolves.toBe('recorded');
    expect(await readRun(run.runId)).toMatchObject({
      status: 'completed', output: 'takeover answer',
    });
  });

  test('keeps expired no-proof work unresolved and never terminalizes sealed absence', async () => {
    const expiredRun = await seedRun('expired-no-proof');
    const expired = await seedDispatchOutcome(expiredRun, 'expired-no-proof', {
      expiresInMicros: -1_000_000n,
    });
    await expect(record(expired, 'unknown', 'transport_unconfirmed', false))
      .resolves.toBe('recorded');
    expect(await readRun(expiredRun.runId)).toMatchObject({
      status: 'running', assistant_message_id: null, finished_at: null,
    });
    const unresolved = await admin.query<{ state: string; expired: boolean }>(
      `SELECT state,
        expires_at_epoch_micros < floor(extract(epoch FROM clock_timestamp())*1000000)::bigint
          AS expired
       FROM public.meri_phase4_recovery_obligations
       WHERE obligation_id=$1::uuid`,
      [expired.operationId],
    );
    expect(unresolved.rows[0]).toEqual({ state: 'unresolved', expired: true });

    const absentRun = await seedRun('sealed-absent', {
      status: 'provisioning', recoveryWindow: true, claimIntent: false,
    });
    const absent = await seedReservationOutcome(absentRun, 'sealed-absent', 'sealed_absent');
    await expect(record(absent, 'reservation_sealed_absent', 'sealed_absent', true))
      .resolves.toBe('recorded');
    expect(await readRun(absentRun.runId)).toMatchObject({
      status: 'provisioning', assistant_message_id: null, finished_at: null,
    });
    const finalCount = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.meri_agent_run_events
       WHERE run_id=$1::uuid AND payload_jsonb->>'final'='true'`,
      [absentRun.runId],
    );
    expect(finalCount.rows[0]!.count).toBe('0');
  });

  test('gives the recovery operator routine execution but no table DML', async () => {
    const run = await seedRun('least-authority');
    const client = await loginClient();
    try {
      await client.query('SET ROLE meri_phase4_recovery_operator');
      await expect(client.query(
        `UPDATE public.meri_agent_runs SET output='forbidden' WHERE id=$1::uuid`,
        [run.runId],
      )).rejects.toMatchObject({ code: '42501' });
      await expect(client.query(
        `DELETE FROM public.meri_phase4_recovery_obligations
         WHERE tenant_id=$1::uuid`,
        [tenantId],
      )).rejects.toMatchObject({ code: '42501' });
      await expect(client.query(
        `INSERT INTO public.clio_messages
          (id,tenant_id,user_id,conversation_id,role,body,metadata_jsonb)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'assistant','forbidden','{}'::jsonb)`,
        [randomUUID(), tenantId, userId, run.conversationId],
      )).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.end();
    }
  });
});
