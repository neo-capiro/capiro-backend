import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const databaseUrl = process.env.MERI_PHASE4_ROUTE_TEST_DATABASE_URL;
const parsed = databaseUrl ? new URL(databaseUrl) : null;
const isolated = Boolean(
  parsed?.protocol === 'postgresql:' && parsed.hostname === '127.0.0.1' &&
  parsed.username === 'postgres' && parsed.pathname === '/capiro' &&
  process.env.MERI_PHASE4_ROUTE_TEST_ACKNOWLEDGE_DISPOSABLE === 'yes',
);
const describeDb = isolated ? describe : describe.skip;
const micros = (milliseconds: number) => BigInt(milliseconds) * 1_000n;
const emptySha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

interface ClaimedRow {
  obligation_id: string;
  tenant_id: string;
  run_id: string;
  obligation_kind: 'reservation' | 'dispatch';
  action: 'status' | 'stop' | null;
  operation_id: string;
  attempt_nonce: string;
  claim_token: string;
  native_body_bytes: Buffer;
}

describeDb('Phase 4 recovery obligations on disposable migrated PostgreSQL', () => {
  jest.setTimeout(90_000);

  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const loginRole = `meri_p4_recovery_test_${suffix}`;
  const loginPassword = `MeriP4_${suffix}_Only`;
  const tenantId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const scopeId = `tenant:${tenantId}:user:${userId}`;
  const admin = new Client({ connectionString: databaseUrl });
  let cutoffMs = 0;
  let cutoff = 0n;
  let reconciliation = 0n;
  let retain = 0n;
  const runIds = {
    reservation: randomUUID(),
    stop: randomUUID(),
    status: randomUUID(),
  };
  const workerIds = {
    stop: `recovery-stop-${suffix}`,
    status: `recovery-status-${suffix}`,
  };
  const claimed = new Map<string, { row: ClaimedRow; ownerId: string }>();

  const quoteRole = (value: string) => `"${value.replaceAll('"', '""')}"`;

  async function loginClient(): Promise<Client> {
    const url = new URL(databaseUrl!);
    url.username = loginRole;
    url.password = loginPassword;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    return client;
  }

  async function claim(ownerId: string, limit = 10, lease = 30_000_000): Promise<ClaimedRow[]> {
    const client = await loginClient();
    try {
      await client.query('SET ROLE meri_phase4_recovery_operator');
      return (await client.query<ClaimedRow>(
        `SELECT * FROM public.meri_phase4_claim_recovery_obligations(
          $1::uuid,$2::integer,$3::bigint
        )`,
        [ownerId, limit, lease],
      )).rows;
    } finally {
      await client.end();
    }
  }

  async function record(
    row: ClaimedRow,
    ownerId: string,
    kind: string,
    detail: string,
    withReceipt = false,
  ): Promise<string> {
    const client = await loginClient();
    try {
      await client.query('SET ROLE meri_phase4_recovery_operator');
      const result = await client.query<{ record_result: string }>(
        `SELECT record_result FROM public.meri_phase4_record_recovery_outcome(
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,
          $6::varchar,$7::varchar,$8::uuid,$9::varchar,$10::varchar
        )`,
        [row.tenant_id, row.obligation_id, ownerId, row.claim_token,
          row.operation_id, row.attempt_nonce, kind,
          withReceipt ? row.operation_id : null,
          withReceipt ? row.attempt_nonce : null, detail],
      );
      return result.rows[0]!.record_result;
    } finally {
      await client.end();
    }
  }

  async function seedRun(
    label: 'reservation' | 'stop' | 'status',
    state: 'prepared' | 'claimed',
  ) {
    const runId = runIds[label];
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const idempotencyKey = `recovery-obligation-${label}-${suffix}`;
    const workerRunId = label === 'reservation' ? null : workerIds[label];
    const runStatus = label === 'stop' ? 'cancelling' :
      label === 'status' ? 'running' : 'provisioning';
    const dispatchStatus = label === 'reservation' ? 'pending' : 'dispatched';
    const body = `recovery obligation ${label}`;
    const authorizationVersion = `auth-${suffix}`;
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Number(retain / 1_000n)).toISOString();

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
      `INSERT INTO public.meri_agent_runs
        (id,tenant_id,scope_id,actor_id,conversation_id,user_message_id,status,
         idempotency_key,envelope_jsonb,actor_context_jsonb,dispatch_status,
         hermes_run_id,stop_requested_at)
       VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::uuid,$7,$8,
         $9::jsonb,'{}'::jsonb,$10,$11,$12)`,
      [runId, tenantId, scopeId, userId, conversationId, messageId, runStatus,
        idempotencyKey, JSON.stringify({ authorizationVersion, issuedAt, expiresAt }),
        dispatchStatus, workerRunId,
        label === 'stop' ? new Date().toISOString() : null],
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
        'a'.repeat(64), 'b'.repeat(64), `session-${suffix}`,
        cutoff.toString(), cutoff.toString(), cutoff.toString(),
        reconciliation.toString(), retain.toString(), 'c'.repeat(64), body.length,
        'd'.repeat(64), 'e'.repeat(64), 'f'.repeat(64),
        (label === 'reservation' ? '1' : label === 'stop' ? '2' : '3').repeat(64)],
    );
    if (state === 'claimed') {
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
  }

  async function persistStatusReceipt(row: ClaimedRow) {
    const intent = (await admin.query<{
      request_sha256: string; worker_run_id: string; worker_audience: string;
      worker_ingress_id: string; worker_generation: string; worker_credential_id: string;
    }>(
      `SELECT request_sha256,worker_run_id,worker_audience,worker_ingress_id,
        worker_generation,worker_credential_id
       FROM public.meri_agent_dispatch_intents
       WHERE tenant_id=$1::uuid AND run_id=$2::uuid`,
      [row.tenant_id, row.run_id],
    )).rows[0]!;
    const now = micros(Date.now());
    await admin.query(
      `INSERT INTO public.meri_phase4_dispatch_recovery_operations (
        tenant_id,operation_id,run_id,request_sha256,worker_run_id,
        worker_audience,worker_ingress_id,worker_generation,worker_credential_id,action
      ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10)`,
      [row.tenant_id, row.operation_id, row.run_id, intent.request_sha256,
        intent.worker_run_id, intent.worker_audience, intent.worker_ingress_id,
        intent.worker_generation, intent.worker_credential_id, row.action],
    );
    await admin.query(
      `INSERT INTO public.meri_phase4_dispatch_recovery_receipts (
        contract_version,receipt_purpose,tenant_id,run_id,request_sha256,
        worker_run_id,worker_audience,worker_ingress_id,worker_generation,
        worker_credential_id,action,operation_id,attempt_nonce,command_key_id,
        command_sha256,native_request_body_sha256,native_response_body_sha256,
        receipt_sha256,observation,worker_status,native_http_status,
        issued_at_epoch_micros,expires_at_epoch_micros,observed_at_epoch_micros,
        key_id,signature
      ) VALUES (
        1,'meri-hermes-recovery-receipt',$1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,
        $9,$10::uuid,$11,$12,$13::char(64),$14::char(64),$15::char(64),
        $16::char(64),'run_nonterminal','running',200,$17::bigint,$18::bigint,
        $19::bigint,$20,$21
      )`,
      [row.tenant_id, row.run_id, intent.request_sha256, intent.worker_run_id,
        intent.worker_audience, intent.worker_ingress_id, intent.worker_generation,
        intent.worker_credential_id, row.action, row.operation_id, row.attempt_nonce,
        `command-${suffix}`, '1'.repeat(64), emptySha, '2'.repeat(64),
        '3'.repeat(64), (now - 1_000_000n).toString(),
        (now + 30_000_000n).toString(), now.toString(), `receipt-${suffix}`,
        'A'.repeat(43)],
    );
  }

  beforeAll(async () => {
    await admin.connect();
    cutoffMs = Date.now() + 30_000;
    cutoff = micros(cutoffMs);
    reconciliation = cutoff + 2n * 86_400_000_000n;
    retain = cutoff + 4n * 86_400_000_000n;
    const originalMemberships = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_auth_members
       WHERE roleid='meri_phase4_recovery_operator'::regrole
          OR member='meri_phase4_recovery_operator'::regrole`,
    );
    expect(originalMemberships.rows[0]!.count).toBe('0');
    await admin.query(
      `CREATE ROLE ${quoteRole(loginRole)} LOGIN PASSWORD '${loginPassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    );
    await admin.query(`GRANT meri_phase4_recovery_operator TO ${quoteRole(loginRole)}`);
    await admin.query(
      `INSERT INTO public.tenants (id,slug,name,status)
       VALUES ($1::uuid,$2,$3,'active')`,
      [tenantId, `recovery-obligation-${suffix}`, `Recovery Obligation ${suffix}`],
    );
    await admin.query(
      `INSERT INTO public.users (id,clerk_user_id,email) VALUES ($1::uuid,$2,$3)`,
      [userId, `recovery_obligation_${suffix}`, `recovery-${suffix}@example.invalid`],
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
      [scopeId, tenantId, userId, `recovery-obligation-${suffix}`],
    );
    await seedRun('reservation', 'prepared');
    await seedRun('stop', 'claimed');
    await seedRun('status', 'claimed');
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, cutoffMs - Date.now() + 50)));
  });

  afterAll(async () => {
    await admin.query(`REVOKE meri_phase4_recovery_operator FROM ${quoteRole(loginRole)}`)
      .catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${quoteRole(loginRole)}`).catch(() => undefined);
    await admin.end();
  });

  test('grants only explicit role execution and denies direct obligation-table access', async () => {
    const client = await loginClient();
    try {
      await expect(client.query(
        'SELECT count(*) FROM public.meri_phase4_recovery_obligations',
      )).rejects.toMatchObject({ code: '42501' });
      await expect(client.query(
        'SELECT * FROM public.meri_phase4_claim_recovery_obligations($1::uuid,1,1000000)',
        [randomUUID()],
      )).rejects.toMatchObject({ code: '42501' });
      await client.query('SET ROLE meri_phase4_recovery_operator');
      await expect(client.query(
        'SELECT count(*) FROM public.meri_phase4_recovery_obligations',
      )).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.end();
    }
  });

  test('claims one copy across replicas in reservation, Stop, status priority order', async () => {
    const seeded = await claim(randomUUID(), 3);
    expect(seeded.map((row) => `${row.obligation_kind}:${row.action ?? ''}`).sort())
      .toEqual(['dispatch:status', 'dispatch:stop', 'reservation:']);
    await admin.query(
      `UPDATE public.meri_phase4_recovery_obligations
       SET state='pending',claim_owner=NULL,claim_token=NULL,
           claim_expires_at_epoch_micros=NULL,next_attempt_at_epoch_micros=1
       WHERE tenant_id=$1::uuid`,
      [tenantId],
    );
    const ownerA = randomUUID();
    const ownerB = randomUUID();
    const [left, right] = await Promise.all([claim(ownerA, 2), claim(ownerB, 2)]);
    const combined = [...left.map((row) => ({ row, ownerId: ownerA })),
      ...right.map((row) => ({ row, ownerId: ownerB }))];
    expect(combined).toHaveLength(3);
    expect(new Set(combined.map(({ row }) => row.obligation_id)).size).toBe(3);
    expect(combined.map(({ row }) => `${row.obligation_kind}:${row.action ?? ''}`).sort())
      .toEqual(['dispatch:status', 'dispatch:stop', 'reservation:']);
    for (const entry of combined) claimed.set(entry.row.run_id, entry);
    const bodyByAction = new Map(combined.map(({ row }) => [row.action, row.native_body_bytes]));
    expect(bodyByAction.get('status')).toEqual(Buffer.alloc(0));
    expect(bodyByAction.get('stop')).toEqual(Buffer.from('{}'));
  });

  test('preserves operation and nonce through UNKNOWN, exact replay, and reclaim', async () => {
    const original = claimed.get(runIds.reservation)!;
    await expect(record(
      original.row, original.ownerId, 'unknown', 'transport_unconfirmed',
    )).resolves.toBe('recorded');
    await expect(record(
      original.row, original.ownerId, 'unknown', 'transport_unconfirmed',
    )).resolves.toBe('replayed');
    await admin.query(
      `UPDATE public.meri_phase4_recovery_obligations
       SET next_attempt_at_epoch_micros=1
       WHERE obligation_id=$1::uuid`,
      [original.row.obligation_id],
    );
    const nextOwner = randomUUID();
    const reclaimed = await claim(nextOwner, 1);
    expect(reclaimed[0]).toMatchObject({
      obligation_id: original.row.obligation_id,
      operation_id: original.row.operation_id,
      attempt_nonce: original.row.attempt_nonce,
    });
    await expect(record(
      original.row, original.ownerId, 'unknown', 'transport_unconfirmed',
    )).resolves.toBe('replayed');
    await expect(record(
      reclaimed[0]!, nextOwner, 'unknown', 'transport_unconfirmed',
    )).resolves.toBe('recorded');
    const afterRepeatedUnknown = await admin.query<{ state: string; claim_token: string | null }>(
      `SELECT state,claim_token FROM public.meri_phase4_recovery_obligations
       WHERE obligation_id=$1::uuid`,
      [original.row.obligation_id],
    );
    expect(afterRepeatedUnknown.rows[0]).toEqual({ state: 'pending', claim_token: null });
    await admin.query(
      `UPDATE public.meri_phase4_recovery_obligations
       SET next_attempt_at_epoch_micros=1
       WHERE obligation_id=$1::uuid`,
      [original.row.obligation_id],
    );
    const finalOwner = randomUUID();
    const finalClaim = await claim(finalOwner, 1);
    expect(finalClaim[0]).toMatchObject({
      obligation_id: original.row.obligation_id,
      operation_id: original.row.operation_id,
      attempt_nonce: original.row.attempt_nonce,
    });
    expect(finalClaim[0]!.claim_token).not.toBe(reclaimed[0]!.claim_token);
    await expect(record(
      finalClaim[0]!, finalOwner, 'boundary_failure', 'reservation_unavailable',
    )).resolves.toBe('recorded');
  });

  test('rejects a missing receipt, then completes exact receipt and schedules status', async () => {
    const entry = claimed.get(runIds.status)!;
    await expect(record(
      entry.row, entry.ownerId, 'dispatch_nonterminal', 'run_nonterminal', true,
    )).rejects.toMatchObject({ code: '23503' });
    await persistStatusReceipt(entry.row);
    await expect(record(
      entry.row, entry.ownerId, 'dispatch_nonterminal', 'run_nonterminal', true,
    )).resolves.toBe('recorded');
    await expect(record(
      entry.row, entry.ownerId, 'dispatch_nonterminal', 'run_nonterminal', true,
    )).resolves.toBe('replayed');
    const history = await admin.query<{
      state: string; sequence: number; operation_id: string; attempt_nonce: string;
    }>(
      `SELECT state,sequence,operation_id,attempt_nonce
       FROM public.meri_phase4_recovery_obligations
       WHERE tenant_id=$1::uuid AND run_id=$2::uuid
       ORDER BY sequence`,
      [tenantId, runIds.status],
    );
    expect(history.rows).toHaveLength(2);
    expect(history.rows[0]).toMatchObject({ state: 'completed', sequence: 0 });
    expect(history.rows[1]).toMatchObject({ state: 'pending', sequence: 1 });
    expect(history.rows[1]!.operation_id).not.toBe(entry.row.operation_id);
    expect(history.rows[1]!.attempt_nonce).not.toBe(entry.row.attempt_nonce);
  });

  test('fences an in-flight status claim before Stop work is claimed', async () => {
    await admin.query(
      `UPDATE public.meri_phase4_recovery_obligations
       SET next_attempt_at_epoch_micros=1
       WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND sequence=1`,
      [tenantId, runIds.status],
    );
    const statusOwner = randomUUID();
    const inFlight = await claim(statusOwner, 1);
    expect(inFlight[0]).toMatchObject({
      run_id: runIds.status,
      obligation_kind: 'dispatch',
      action: 'status',
    });
    await admin.query(
      `UPDATE public.meri_agent_runs
       SET status='cancelling',stop_requested_at=clock_timestamp()
       WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [tenantId, runIds.status],
    );
    const stopOwner = randomUUID();
    const stopWork = await claim(stopOwner, 1);
    expect(stopWork[0]).toMatchObject({
      run_id: runIds.status,
      obligation_kind: 'dispatch',
      action: 'stop',
    });
    expect(stopWork[0]!.native_body_bytes).toEqual(Buffer.from('{}'));
    await expect(record(
      inFlight[0]!, statusOwner, 'boundary_failure', 'dispatch_unavailable',
    )).rejects.toMatchObject({ code: '40001' });
    const fenced = await admin.query<{ state: string; claim_token: string | null }>(
      `SELECT state,claim_token FROM public.meri_phase4_recovery_obligations
       WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND sequence=1`,
      [tenantId, runIds.status],
    );
    expect(fenced.rows[0]).toEqual({ state: 'pending', claim_token: null });
  });

  test('allows lease takeover and rejects the superseded owner', async () => {
    const entry = claimed.get(runIds.stop)!;
    await admin.query(
      `UPDATE public.meri_phase4_recovery_obligations
       SET claim_expires_at_epoch_micros=1
       WHERE obligation_id=$1::uuid`,
      [entry.row.obligation_id],
    );
    const nextOwner = randomUUID();
    const takeover = await claim(nextOwner, 1);
    expect(takeover[0]!.obligation_id).toBe(entry.row.obligation_id);
    await expect(record(
      entry.row, entry.ownerId, 'boundary_failure', 'dispatch_unavailable',
    )).rejects.toMatchObject({ code: '40001' });
    await expect(record(
      takeover[0]!, nextOwner, 'boundary_failure', 'dispatch_unavailable',
    )).resolves.toBe('recorded');
  });
});
