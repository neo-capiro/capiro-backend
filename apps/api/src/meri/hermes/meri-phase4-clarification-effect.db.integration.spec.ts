import {
  createHash, generateKeyPairSync, randomUUID, sign,
} from 'node:crypto';
import { Client } from 'pg';
import {
  MERI_HERMES_BROKER_EFFECT_RECEIPT_PURPOSE,
  createMeriHermesClarificationEffectIdentityV1,
  createMeriHermesRecordTurnEffectIdentityV1,
  meriHermesBrokerEffectReceiptClaimsSha256V1,
  meriHermesClarificationReceiptClaimsSha256V1,
  parseMeriHermesClarificationEffectReceiptV1,
  type MeriHermesBrokerEffectReceiptKeyV1,
  type MeriHermesBrokerEffectReceiptRowV1,
  type MeriHermesBrokerEffectResultKindV1,
  type MeriHermesBrokerEffectReceiptFactsV1,
  type MeriHermesClarificationEffectIdentityV1,
  type MeriHermesClarificationEffectReceiptFactsV1,
} from './meri-hermes-broker-effect.contract.js';
import { computeMeriPhase4AuthorizationVersionV2 } from
  './meri-hermes-phase4-authorization.contract.js';

const databaseUrl = process.env.MERI_PHASE4_ROUTE_TEST_DATABASE_URL;
const parsed = databaseUrl ? new URL(databaseUrl) : null;
const isolated = Boolean(
  parsed?.protocol === 'postgresql:' && parsed.hostname === '127.0.0.1' &&
  parsed.username === 'postgres' && parsed.pathname === '/capiro' &&
  process.env.MERI_PHASE4_ROUTE_TEST_ACKNOWLEDGE_DISPOSABLE === 'yes',
);
const describeDb = isolated ? describe : describe.skip;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const micros = (milliseconds: number) => BigInt(milliseconds) * 1_000n;

interface Fixture {
  tenantId: string;
  userId: string;
  membershipId: string;
  scopeId: string;
  runId: string;
  workerRunId: string;
  dispatchRequestSha256: string;
  ingress: string;
}

interface EffectCall {
  fixture: Fixture;
  operationId: string;
  workerRunId?: string;
  question?: string;
  choices?: readonly string[];
  multiSelect?: boolean;
  disposition?: 'attempt' | 'effect_unknown';
  canonicalRequestSha256?: string;
}

type EffectRow = MeriHermesBrokerEffectReceiptRowV1;

const effectSql = `SELECT * FROM public.meri_phase4_request_clarification_effect(
  $1::uuid,$2::uuid,$3::varchar,$4::char(64),$5::varchar,$6::uuid,
  $7::char(64),$8::text,$9::jsonb,$10::boolean,$11::varchar
)`;

describeDb('Phase 4 clarification broker effect on disposable migrated PostgreSQL', () => {
  jest.setTimeout(120_000);

  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const loginRole = `meri_p4_effect_test_${suffix}`;
  const loginPassword = `MeriP4Effect_${suffix}_Only`;
  const admin = new Client({ connectionString: databaseUrl });
  const quoteRole = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const signingKeyId = `test-key-${suffix}`;
  const signingKeys = generateKeyPairSync('ed25519');
  const publicKeySpkiDer = signingKeys.publicKey.export({
    format: 'der', type: 'spki',
  });
  const publicKeySpkiSha256 = createHash('sha256')
    .update(publicKeySpkiDer).digest('hex');
  const qualificationSha256 = sha(`broker-effect-qualification:${suffix}`);

  async function routeDigest(fields: readonly string[]): Promise<string> {
    const result = await admin.query<{ digest: string }>(
      'SELECT trim(public.meri_phase4_route_digest_v1($1::text[])) AS digest',
      [[...fields]],
    );
    return result.rows[0]!.digest;
  }

  async function loginClient(): Promise<Client> {
    const url = new URL(databaseUrl!);
    url.username = loginRole;
    url.password = loginPassword;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    return client;
  }

  function values(input: EffectCall, canonicalRequestSha256: string): unknown[] {
    const fixture = input.fixture;
    return [
      fixture.tenantId, fixture.runId, input.workerRunId ?? fixture.workerRunId,
      fixture.dispatchRequestSha256, fixture.scopeId, input.operationId,
      canonicalRequestSha256, input.question ?? 'Which client?',
      JSON.stringify(input.choices ?? ['Acme', 'Beta']), input.multiSelect ?? false,
      input.disposition ?? 'attempt',
    ];
  }

  async function canonicalRequest(input: EffectCall): Promise<string> {
    if (input.canonicalRequestSha256) return input.canonicalRequestSha256;
    return routeDigest([
      'capiro.meri.phase4.broker-effect-request/v1', input.fixture.tenantId,
      input.fixture.runId, input.workerRunId ?? input.fixture.workerRunId,
      input.fixture.dispatchRequestSha256, input.fixture.scopeId,
      'meri_request_clarification', input.question ?? 'Which client?',
      String((input.choices ?? ['Acme', 'Beta']).length),
      ...(input.choices ?? ['Acme', 'Beta']),
      (input.multiSelect ?? false) ? 'true' : 'false',
    ]);
  }

  function identity(
    input: EffectCall,
    canonicalRequestSha256: string,
  ): MeriHermesClarificationEffectIdentityV1 {
    const identity = createMeriHermesClarificationEffectIdentityV1({
      tenantId: input.fixture.tenantId,
      runId: input.fixture.runId,
      workerRunId: input.workerRunId ?? input.fixture.workerRunId,
      dispatchRequestSha256: input.fixture.dispatchRequestSha256,
      scopeId: input.fixture.scopeId,
      operationId: input.operationId,
      request: {
        question: input.question ?? 'Which client?',
        choices: input.choices ?? ['Acme', 'Beta'],
        multiSelect: input.multiSelect ?? false,
      },
    });
    expect(identity.requestSha256).toBe(canonicalRequestSha256);
    return identity;
  }

  function receiptKey(fixture: Fixture): MeriHermesBrokerEffectReceiptKeyV1 {
    return {
      purpose: MERI_HERMES_BROKER_EFFECT_RECEIPT_PURPOSE,
      keyId: signingKeyId,
      tenantId: fixture.tenantId,
      scopeId: fixture.scopeId,
      publicKeySpkiDer,
      publicKeySpkiSha256,
      notBeforeEpochMicros: micros(Date.now() - 86_400_000).toString(),
      notAfterEpochMicros: micros(Date.now() + 31_536_000_000).toString(),
      qualificationSha256,
    };
  }

  async function attest(
    input: EffectCall,
    result: MeriHermesBrokerEffectResultKindV1,
    detail: MeriHermesClarificationEffectReceiptFactsV1['detail'],
    expired = false,
  ): Promise<MeriHermesBrokerEffectReceiptKeyV1> {
    const canonical = await canonicalRequest(input);
    const state = (await admin.query<{ broker_calls: number; last_seq: number }>(
      'SELECT broker_calls,last_seq FROM public.meri_agent_runs WHERE id=$1::uuid',
      [input.fixture.runId],
    )).rows[0]!;
    const committed = result === 'committed';
    const callsAfter = state.broker_calls + (committed ? 1 : 0);
    const eventSeq = committed ? state.last_seq + 1 : null;
    const claims = meriHermesClarificationReceiptClaimsSha256V1(
      identity(input, canonical),
      {
        result, detail, brokerCallsBefore: state.broker_calls,
        brokerCallsAfter: callsAfter, eventSeq,
      },
    );
    const signature = sign(
      null, Buffer.from(claims, 'hex'), signingKeys.privateKey,
    ).toString('base64url');
    expect(signature).toMatch(/^[A-Za-z0-9_-]{85}[AQgw]$/);
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL ROLE meri_phase4_broker_signer_owner');
      await admin.query(
        `INSERT INTO public.meri_phase4_broker_effect_signature_attestations (
          claims_sha256,signer_key_id,signature,verification_method,
          qualification_sha256,verified_at_epoch_micros,expires_at_epoch_micros
        ) VALUES (
          $1::char(64),$2,$3,'external-ed25519-v1',$4::char(64),
          floor(extract(epoch FROM clock_timestamp()+
            CASE WHEN $5::boolean THEN interval '-2 minutes' ELSE interval '-1 second' END
          )*1000000)::bigint,
          floor(extract(epoch FROM clock_timestamp()+
            CASE WHEN $5::boolean THEN interval '-1 minute' ELSE interval '1 minute' END
          )*1000000)::bigint
        ) ON CONFLICT (claims_sha256) DO NOTHING`,
        [claims, signingKeyId, signature, qualificationSha256, expired],
      );
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
    return receiptKey(input.fixture);
  }

  async function invoke(input: EffectCall, suppliedClient?: Client): Promise<EffectRow> {
    const canonical = await canonicalRequest(input);
    const client = suppliedClient ?? await loginClient();
    try {
      await client.query('SET ROLE meri_phase4_broker_effect_operator');
      const result = await client.query<EffectRow>(effectSql, values(input, canonical));
      expect(result.rows).toHaveLength(1);
      return result.rows[0]!;
    } finally {
      if (!suppliedClient) await client.end();
    }
  }

  async function invokeRecord(
    fixture: Fixture,
    operationId: string,
    disposition: 'attempt' | 'effect_unknown',
  ): Promise<EffectRow> {
    const requestSha256 = await routeDigest([
      'capiro.meri.phase4.broker-effect-request/v1', fixture.tenantId,
      fixture.runId, fixture.workerRunId, fixture.dispatchRequestSha256,
      fixture.scopeId, 'meri_record_turn', '3', '4',
    ]);
    const client = await loginClient();
    try {
      await client.query('SET ROLE meri_phase4_broker_effect_operator');
      const result = await client.query<EffectRow>(
        `SELECT * FROM public.meri_phase4_record_turn_effect(
          $1::uuid,$2::uuid,$3::varchar,$4::char(64),$5::varchar,$6::uuid,
          $7::char(64),3,4,$8::varchar
        )`,
        [fixture.tenantId, fixture.runId, fixture.workerRunId,
          fixture.dispatchRequestSha256, fixture.scopeId, operationId,
          requestSha256, disposition],
      );
      return result.rows[0]!;
    } finally {
      await client.end();
    }
  }

  async function attestRecord(
    fixture: Fixture,
    operationId: string,
    facts: MeriHermesBrokerEffectReceiptFactsV1,
  ): Promise<void> {
    const identity = createMeriHermesRecordTurnEffectIdentityV1({
      tenantId: fixture.tenantId, runId: fixture.runId,
      workerRunId: fixture.workerRunId,
      dispatchRequestSha256: fixture.dispatchRequestSha256,
      scopeId: fixture.scopeId, operationId,
      request: { userChars: 3, assistantChars: 4 },
    });
    const claims = meriHermesBrokerEffectReceiptClaimsSha256V1(identity, facts);
    const signature = sign(
      null, Buffer.from(claims, 'hex'), signingKeys.privateKey,
    ).toString('base64url');
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL ROLE meri_phase4_broker_signer_owner');
      await admin.query(
        `INSERT INTO public.meri_phase4_broker_effect_signature_attestations (
          claims_sha256,signer_key_id,signature,verification_method,
          qualification_sha256,verified_at_epoch_micros,expires_at_epoch_micros
        ) VALUES ($1::char(64),$2,$3,'external-ed25519-v1',$4::char(64),
          floor(extract(epoch FROM clock_timestamp()-interval '1 second')*1000000)::bigint,
          floor(extract(epoch FROM clock_timestamp()+interval '1 minute')*1000000)::bigint)`,
        [claims, signingKeyId, signature, qualificationSha256],
      );
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
  }

  async function seedFixture(
    label: string,
    options: { status?: string; stopRequested?: boolean; maxToolCalls?: number; readOnly?: boolean } = {},
  ): Promise<Fixture> {
    const tenantId = randomUUID();
    const userId = randomUUID();
    const membershipId = randomUUID();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const runId = randomUUID();
    const scopeId = `tenant:${tenantId}:user:${userId}`;
    const workerRunId = `effect-${label}-${suffix}`;
    const ingress = `effect-ingress-${label}-${suffix}`;
    const generation = `effect-generation-${label}-${suffix}`;
    const credential = `effect-credential-${label}-${suffix}`;
    const sourceId = `effect-source-${label}-${suffix}`;
    const producerRole = `effect_producer_${sha(label).slice(0, 8)}_${suffix}`;
    const bindingId = randomUUID();
    let authorizationVersion = `effect-auth-pending-${label}-${suffix}`;
    const catalogDigest = sha(`catalog:${label}:${suffix}`);
    const dispatchRequestSha256 = sha(`dispatch:${label}:${suffix}`);
    const body = `broker effect ${label}`;
    const now = micros(Date.now());
    const day = 86_400_000_000n;
    const notBefore = now - 60_000_000n;
    const notAfter = now + day;

    await admin.query(
      `INSERT INTO public.tenants (id,slug,name,status)
       VALUES ($1::uuid,$2,$3,'active')`,
      [tenantId, `p4-effect-${label}-${suffix}`, `P4 effect ${label} ${suffix}`],
    );
    await admin.query(
      'INSERT INTO public.users (id,clerk_user_id,email) VALUES ($1::uuid,$2,$3)',
      [userId, `p4_effect_${label}_${suffix}`, `${label}-${suffix}@example.invalid`],
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
    await admin.query(
      `INSERT INTO public.clio_conversations
        (id,tenant_id,user_id,title,metadata_jsonb)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,'{}'::jsonb)`,
      [conversationId, tenantId, userId, `Effect ${label} ${suffix}`],
    );
    await admin.query(
      `INSERT INTO public.clio_messages
        (id,tenant_id,user_id,conversation_id,role,body,metadata_jsonb)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'user',$5,'{}'::jsonb)`,
      [messageId, tenantId, userId, conversationId, body],
    );
    await admin.query(
      `INSERT INTO public.meri_phase4_worker_binding_sources
        (source_id,producer_role,qualified,qualification_sha256,qualified_at_epoch_micros)
       VALUES ($1,$2,true,$3::char(64),
         floor(extract(epoch FROM clock_timestamp())*1000000)::bigint)`,
      [sourceId, producerRole, sha(`source:${label}:${suffix}`)],
    );
    await admin.query(
      `INSERT INTO public.meri_phase4_worker_bindings (
        binding_id,tenant_id,scope_id,worker_audience,worker_ingress_id,
        worker_generation,worker_credential_id,source_id,external_record_id,
        attestation_sha256,attested_by_role,not_before_epoch_micros,
        not_after_epoch_micros,attested_at_epoch_micros,binding_version,
        worker_image_digest,worker_build_id,worker_catalog_digest_algorithm,
        worker_catalog_digest,applied_tool_view_digest_algorithm,
        meri_catalog_version,meri_catalog_digest,capability_mapping_version,
        capability_mapping_digest,tool_view_protocol,claim_attestation_protocol,
        attestation_credential_id
      ) VALUES (
        $1::uuid,$2::uuid,$3,'meri-hermes-scope-worker',$4,$5,$6,$7,$8,
        $9::char(64),$10,$11::bigint,$12::bigint,
        floor(extract(epoch FROM clock_timestamp())*1000000)::bigint,2,
        $13::char(64),$14,'capiro.meri.phase4.worker-catalog/v1',$15::char(64),
        'capiro.meri.phase4.applied-tool-view/v1',$16,$17::char(64),$18,
        $19::char(64),'capiro.meri.phase4.request-local-tool-view/v1',
        'capiro.meri.phase4.claim-tool-view-attestation/v1',$6
      )`,
      [bindingId, tenantId, scopeId, ingress, generation, credential, sourceId,
        `effect-record-${label}-${suffix}`, sha(`binding:${label}:${suffix}`),
        producerRole, notBefore.toString(), notAfter.toString(),
        sha(`image:${label}:${suffix}`), `build-${label}-${suffix}`, catalogDigest,
        `catalog-${label}-${suffix}`, sha(`meri-catalog:${label}:${suffix}`),
        `mapping-${label}-${suffix}`, sha(`mapping:${label}:${suffix}`)],
    );
    await admin.query(
      `INSERT INTO public.meri_phase4_worker_routes (
        tenant_id,scope_id,binding_id,worker_audience,worker_ingress_id,
        worker_generation,worker_credential_id,enabled,closed_at_epoch_micros,
        not_before_epoch_micros,not_after_epoch_micros
      ) VALUES (
        $1::uuid,$2,$3::uuid,'meri-hermes-scope-worker',$4,$5,$6,true,NULL,
        $7::bigint,$8::bigint
      )`,
      [tenantId, scopeId, bindingId, ingress, generation, credential,
        notBefore.toString(), notAfter.toString()],
    );
    const priorFence = (await admin.query<{ revision: string; policy_version: string }>(
      `SELECT revision::text,policy_version FROM public.meri_phase4_authority_fences
       WHERE tenant_id=$1::uuid`,
      [tenantId],
    )).rows[0]!;
    const predictedGrantVersion = `g2:${BigInt(priorFence.revision) + 1n}`;
    authorizationVersion = computeMeriPhase4AuthorizationVersionV2({
      tenantId, actorId: userId, role: 'capiro_admin',
      policyVersion: priorFence.policy_version,
      grantVersion: predictedGrantVersion,
      authorizedClientIds: [], authorizedMailboxConnectionIds: [],
    });
    await admin.query(
      `UPDATE public.meri_execution_scopes SET authorization_version=$3
       WHERE tenant_id=$1::uuid AND id=$2`,
      [tenantId, scopeId, authorizationVersion],
    );
    const fence = (await admin.query<{ revision: string; policy_version: string }>(
      `SELECT revision::text,policy_version FROM public.meri_phase4_authority_fences
       WHERE tenant_id=$1::uuid`,
      [tenantId],
    )).rows[0]!;
    expect(`g2:${fence.revision}`).toBe(predictedGrantVersion);
    const deliveryNotAfter = now + day;
    const reconciliationNotAfter = deliveryNotAfter + day;
    const retainUntil = reconciliationNotAfter + day;
    await admin.query(
      `INSERT INTO public.meri_agent_runs (
        id,tenant_id,scope_id,actor_id,conversation_id,user_message_id,status,
        finish_reason,idempotency_key,envelope_jsonb,actor_context_jsonb,
        dispatch_status,hermes_run_id,stop_requested_at
      ) VALUES (
        $1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9,
        $10::jsonb,$11::jsonb,'dispatched',$12,$13
      )`,
      [runId, tenantId, scopeId, userId, conversationId, messageId,
        options.status ?? 'running', options.status === 'completed' ? 'stop' : null,
        `effect-${label}-${suffix}`,
        JSON.stringify({
          version: 1, tenantId, actorType: 'user', actorId: userId, conversationId,
          workspaceId: null, executionScopeId: scopeId, audience: 'private',
          authorizedClientIds: [], authorizedMailboxConnectionIds: [],
          toolPolicy: { allow: ['meri_request_clarification'], deny: [], readOnly: options.readOnly ?? false },
          authorizationVersion, runId, traceId: randomUUID(),
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Number(retainUntil / 1_000n)).toISOString(),
          budget: {
            maxToolCalls: options.maxToolCalls ?? 5,
            maxOutputTokens: 2_000,
            maxWallClockMs: 60_000,
          },
        }), JSON.stringify({
          tenantId, tenantSlug: `p4-effect-${label}-${suffix}`,
          userId, clerkUserId: `p4_effect_${label}_${suffix}`, role: 'capiro_admin',
        }), workerRunId, options.stopRequested ? new Date().toISOString() : null],
    );
    await admin.query(
      `INSERT INTO public.meri_agent_run_reservations
        (run_id,tenant_id,scope_id,conversation_id,period_date,max_run_tokens,
         estimated_tokens,estimated_micro_usd)
       VALUES ($1::uuid,$2::uuid,$3,$4::uuid,
         (clock_timestamp() AT TIME ZONE 'UTC')::date,2000,100,1000)`,
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
        1,'meri-hermes-scope-worker',$8,$9,$10,$11,$12,$13,$14::char(64),$15::char(64),
        $16,$17::bigint,$18::bigint,$18::bigint,$19::bigint,$20::bigint,
        $21::char(64),$22::bigint,$23::char(64),$24::char(64),$25::char(64),$26::char(64)
      )`,
      [runId, tenantId, userId, scopeId, conversationId, messageId,
        `effect-${label}-${suffix}`, ingress, generation, credential,
        authorizationVersion, fence.policy_version, `g2:${fence.revision}`,
        catalogDigest, sha(`tools:${label}:${suffix}`), `session-${label}-${suffix}`,
        deliveryNotAfter.toString(), deliveryNotAfter.toString(),
        reconciliationNotAfter.toString(), retainUntil.toString(),
        sha(`source-message:${label}:${suffix}`), Buffer.byteLength(body), sha(body),
        sha(`assembly:${label}:${suffix}`), sha(`session:${label}:${suffix}`),
        dispatchRequestSha256],
    );
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
    return {
      tenantId, userId, membershipId, scopeId, runId, workerRunId,
      dispatchRequestSha256, ingress,
    };
  }

  async function counts(fixture: Fixture, operationId?: string) {
    const result = await admin.query<{
      broker_calls: number; effects: string; events: string; receipts: string;
      interactions: string; status: string;
    }>(
      `SELECT r.broker_calls,
        (SELECT count(*)::text FROM public.meri_phase4_broker_effect_operations o
         WHERE o.tenant_id=$1::uuid AND o.run_id=$2::uuid
           AND ($3::uuid IS NULL OR o.operation_id=$3::uuid)) AS effects,
        (SELECT count(*)::text FROM public.meri_agent_run_events e
         WHERE e.run_id=$2::uuid AND e.kind='clarification.requested') AS events,
        (SELECT count(*)::text FROM public.meri_phase4_broker_effect_receipts x
         WHERE x.tenant_id=$1::uuid AND x.run_id=$2::uuid
           AND ($3::uuid IS NULL OR x.operation_id=$3::uuid)) AS receipts,
        (SELECT count(*)::text FROM public.meri_agent_interactions x
         WHERE x.run_id=$2::uuid AND x.kind='clarification') AS interactions,
        r.status::text AS status
       FROM public.meri_agent_runs r WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid`,
      [fixture.tenantId, fixture.runId, operationId ?? null],
    );
    return result.rows[0]!;
  }

  beforeAll(async () => {
    await admin.connect();
    await admin.query(
      `CREATE ROLE ${quoteRole(loginRole)} LOGIN PASSWORD '${loginPassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    );
    await admin.query(`GRANT meri_phase4_broker_effect_operator TO ${quoteRole(loginRole)}`);
  });

  afterAll(async () => {
    await admin.query(`REVOKE meri_phase4_broker_effect_operator FROM ${quoteRole(loginRole)}`)
      .catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${quoteRole(loginRole)}`).catch(() => undefined);
    await admin.end();
  });

  test('commits read-only clarification once with exact durable facts and replays concurrently', async () => {
    const fixture = await seedFixture('commit-replay', { readOnly: true });
    const input: EffectCall = {
      fixture, operationId: randomUUID(), question: 'Which client should I use?',
      choices: ['Acme', 'Beta'], multiSelect: false,
    };
    const key = await attest(input, 'committed', 'clarification_requested');
    const [left, right] = await Promise.all([loginClient(), loginClient()]);
    let first: EffectRow;
    try {
      const results = await Promise.all([invoke(input, left), invoke(input, right)]);
      [first] = results;
      expect(results[1]).toEqual(first);
    } finally {
      await Promise.allSettled([left.end(), right.end()]);
    }
    const reconciliation = await invoke({ ...input, disposition: 'effect_unknown' });
    expect(reconciliation).toEqual(first!);
    expect(first!).toMatchObject({
      result: 'committed', detail: 'clarification_requested',
      broker_calls_before: 0, broker_calls_after: 1, event_seq: 1,
      signer_key_id: signingKeyId,
    });
    expect(await counts(fixture, input.operationId)).toEqual({
      broker_calls: 1, effects: '1', events: '1', receipts: '1',
      interactions: '1', status: 'waiting_for_clarification',
    });
    const requestId = `clar_${input.operationId}`;
    const durable = await admin.query<{
      request_id: string; kind: string; continuation: string; prompt: string;
      choices_jsonb: unknown; multi_select: boolean; resolution_jsonb: unknown;
      visibility: string; payload_jsonb: Record<string, unknown>;
    }>(
      `SELECT i.request_id,i.kind,i.continuation,i.prompt,i.choices_jsonb,
        i.multi_select,i.resolution_jsonb,e.visibility,e.payload_jsonb
       FROM public.meri_agent_interactions i
       JOIN public.meri_agent_run_events e ON e.run_id=i.run_id AND e.seq=1
       WHERE i.run_id=$1::uuid AND i.request_id=$2`,
      [fixture.runId, requestId],
    );
    expect(durable.rows[0]).toMatchObject({
      request_id: requestId, kind: 'clarification',
      continuation: 'durable_continuation', prompt: input.question,
      choices_jsonb: input.choices, multi_select: false,
      resolution_jsonb: null, visibility: 'public',
      payload_jsonb: {
        requestId, question: input.question, choices: input.choices,
        multiSelect: false, brokerEffectOperationId: input.operationId,
        frames: [{
          type: 'clarify', runtime: 'hermes', requestId,
          questions: [{
            id: requestId, question: input.question, choices: input.choices,
            multiSelect: false,
          }], continuation: 'durable_continuation',
        }],
      },
    });
    expect(parseMeriHermesClarificationEffectReceiptV1(
      first!, identity(input, await canonicalRequest(input)), new Map([[key.keyId, key]]),
    )).toMatchObject({
      result: 'committed', detail: 'clarification_requested', signed: true,
      domainRef: requestId,
    });
  });

  test('unknown-first tombstones execution before Stop, route, tool, or authority evaluation', async () => {
    const fixture = await seedFixture('unknown-first', {
      status: 'cancelling', stopRequested: true, maxToolCalls: 41,
    });
    await admin.query(
      `UPDATE public.tenant_memberships SET status='removed'
       WHERE id=$1::uuid AND tenant_id=$2::uuid`,
      [fixture.membershipId, fixture.tenantId],
    );
    await admin.query(
      `UPDATE public.meri_phase4_worker_routes SET enabled=false,
        closed_at_epoch_micros=floor(extract(epoch FROM clock_timestamp())*1000000)::bigint
       WHERE tenant_id=$1::uuid AND scope_id=$2`,
      [fixture.tenantId, fixture.scopeId],
    );
    const input: EffectCall = {
      fixture, operationId: randomUUID(), disposition: 'effect_unknown',
    };
    const unknown = await invoke(input);
    expect(unknown).toMatchObject({
      result: 'effect_unknown', detail: 'caller_reported_unknown',
      broker_calls_before: 0, broker_calls_after: 0, event_seq: null,
      signer_key_id: null, signature: null, qualification_sha256: null,
    });
    await expect(invoke({ ...input, disposition: 'attempt' })).resolves.toEqual(unknown);
    expect(await counts(fixture, input.operationId)).toEqual({
      broker_calls: 0, effects: '1', events: '0', receipts: '1',
      interactions: '0', status: 'cancelling',
    });
  });

  test('global operation identity rejects request, tool, and tenant drift', async () => {
    const fixture = await seedFixture('identity-a');
    const other = await seedFixture('identity-b');
    const operationId = randomUUID();
    const input: EffectCall = { fixture, operationId };
    await attest(input, 'committed', 'clarification_requested');
    await expect(invoke(input)).resolves.toMatchObject({ result: 'committed' });
    await expect(invoke({ ...input, question: 'A different question?' }))
      .rejects.toMatchObject({ code: '23505' });
    await expect(invoke({ fixture: other, operationId }))
      .rejects.toMatchObject({ code: '23505' });

    const recordRequestSha256 = await routeDigest([
      'capiro.meri.phase4.broker-effect-request/v1', fixture.tenantId,
      fixture.runId, fixture.workerRunId, fixture.dispatchRequestSha256,
      fixture.scopeId, 'meri_record_turn', '1', '2',
    ]);
    const client = await loginClient();
    try {
      await client.query('SET ROLE meri_phase4_broker_effect_operator');
      await expect(client.query(
        `SELECT * FROM public.meri_phase4_record_turn_effect(
          $1::uuid,$2::uuid,$3::varchar,$4::char(64),$5::varchar,$6::uuid,
          $7::char(64),1,2,'effect_unknown'
        )`,
        [fixture.tenantId, fixture.runId, fixture.workerRunId,
          fixture.dispatchRequestSha256, fixture.scopeId, operationId,
          recordRequestSha256],
      )).rejects.toMatchObject({ code: '23505' });
    } finally {
      await client.end();
    }
    expect(await counts(other)).toMatchObject({
      broker_calls: 0, effects: '0', events: '0', receipts: '0', interactions: '0',
    });
  });

  test('Stop, terminal, authority, tool policy, and bounded budgets deny without domain writes', async () => {
    const cases: Array<{
      label: string; options?: Parameters<typeof seedFixture>[1];
      mutate?: (fixture: Fixture) => Promise<unknown>;
      detail: MeriHermesClarificationEffectReceiptFactsV1['detail'];
    }> = [
      { label: 'stop', options: { status: 'cancelling', stopRequested: true },
        detail: 'stop_requested' },
      { label: 'terminal', options: { status: 'completed' }, detail: 'run_terminal' },
      { label: 'authority', detail: 'authority_closed', mutate: (fixture) => admin.query(
        `UPDATE public.tenant_memberships SET status='removed'
         WHERE id=$1::uuid AND tenant_id=$2::uuid`,
        [fixture.membershipId, fixture.tenantId],
      ) },
      { label: 'tool', detail: 'tool_denied', mutate: (fixture) => admin.query(
        `UPDATE public.meri_agent_runs
         SET envelope_jsonb=jsonb_set(envelope_jsonb,'{toolPolicy,allow}','[]'::jsonb)
         WHERE id=$1::uuid`, [fixture.runId],
      ) },
      { label: 'cap-invalid', options: { maxToolCalls: 41 },
        detail: 'tool_budget_exhausted' },
      { label: 'cap-exhausted', options: { maxToolCalls: 1 },
        detail: 'tool_budget_exhausted', mutate: (fixture) => admin.query(
          'UPDATE public.meri_agent_runs SET broker_calls=1 WHERE id=$1::uuid',
          [fixture.runId],
        ) },
    ];
    for (const candidate of cases) {
      const fixture = await seedFixture(candidate.label, candidate.options);
      if (candidate.mutate) await candidate.mutate(fixture);
      const input: EffectCall = { fixture, operationId: randomUUID() };
      await attest(input, 'denied_before_effect', candidate.detail);
      await expect(invoke(input)).resolves.toMatchObject({
        result: 'denied_before_effect', detail: candidate.detail, event_seq: null,
      });
      expect(await counts(fixture, input.operationId)).toMatchObject({
        effects: '1', events: '0', receipts: '1', interactions: '0',
      });
    }
  });

  test('missing or expired signature attestation rolls back the whole attempt', async () => {
    for (const expired of [false, true]) {
      const fixture = await seedFixture(expired ? 'expired-attestation' : 'missing-attestation');
      const input: EffectCall = { fixture, operationId: randomUUID() };
      if (expired) {
        await attest(input, 'committed', 'clarification_requested', true);
      }
      await expect(invoke(input)).rejects.toMatchObject({ code: '55000' });
      expect(await counts(fixture, input.operationId)).toEqual({
        broker_calls: 0, effects: '0', events: '0', receipts: '0',
        interactions: '0', status: 'running',
      });
    }
  });

  test('operator has execute-only access and append-only effect storage remains sealed', async () => {
    const fixture = await seedFixture('least-authority');
    const input: EffectCall = { fixture, operationId: randomUUID() };
    await attest(input, 'committed', 'clarification_requested');
    await invoke(input);
    const client = await loginClient();
    try {
      await client.query('SET ROLE meri_phase4_broker_effect_operator');
      const privileges = await client.query<{
        routine: boolean; interactions_dml: boolean; operations_dml: boolean;
        receipts_dml: boolean; public_execute: boolean;
      }>(`SELECT
        has_function_privilege(current_user,
          'public.meri_phase4_request_clarification_effect(uuid,uuid,varchar,char,varchar,uuid,char,text,jsonb,boolean,varchar)',
          'EXECUTE') AS routine,
        has_table_privilege(current_user,'public.meri_agent_interactions','INSERT')
          AS interactions_dml,
        has_table_privilege(current_user,
          'public.meri_phase4_broker_effect_operations','SELECT,INSERT,UPDATE,DELETE')
          AS operations_dml,
        has_table_privilege(current_user,
          'public.meri_phase4_broker_effect_receipts','SELECT,INSERT,UPDATE,DELETE')
          AS receipts_dml,
        has_function_privilege('public',
          'public.meri_phase4_request_clarification_effect(uuid,uuid,varchar,char,varchar,uuid,char,text,jsonb,boolean,varchar)',
          'EXECUTE') AS public_execute`);
      expect(privileges.rows[0]).toEqual({
        routine: true, interactions_dml: false, operations_dml: false,
        receipts_dml: false, public_execute: false,
      });
      await expect(client.query(
        `INSERT INTO public.meri_agent_interactions
          (run_id,request_id,kind,continuation,prompt,choices_jsonb,multi_select)
         VALUES ($1::uuid,'forged','clarification','durable_continuation','x','[]',false)`,
        [fixture.runId],
      )).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.end();
    }
    await expect(admin.query(
      `UPDATE public.meri_phase4_broker_effect_operations
       SET clarification_question=clarification_question WHERE operation_id=$1::uuid`,
      [input.operationId],
    )).rejects.toMatchObject({ code: '55000' });
  });

  test('replacement record-turn routine preserves read-only, replay, unknown, and cap invariants', async () => {
    const committedFixture = await seedFixture('record-read-only', { readOnly: true });
    await admin.query(
      `UPDATE public.meri_agent_runs SET envelope_jsonb=jsonb_set(
        envelope_jsonb,'{toolPolicy,allow}','["meri_record_turn"]'::jsonb)
       WHERE id=$1::uuid`,
      [committedFixture.runId],
    );
    const committedOperation = randomUUID();
    await attestRecord(committedFixture, committedOperation, {
      result: 'committed', detail: 'recorded', brokerCallsBefore: 0,
      brokerCallsAfter: 1, eventSeq: 1,
    });
    const committed = await invokeRecord(committedFixture, committedOperation, 'attempt');
    expect(committed).toMatchObject({ result: 'committed', detail: 'recorded' });
    await expect(invokeRecord(committedFixture, committedOperation, 'effect_unknown'))
      .resolves.toEqual(committed);

    const unknownFixture = await seedFixture('record-unknown', {
      status: 'cancelling', stopRequested: true,
    });
    await admin.query(
      `UPDATE public.tenant_memberships SET status='removed'
       WHERE id=$1::uuid AND tenant_id=$2::uuid`,
      [unknownFixture.membershipId, unknownFixture.tenantId],
    );
    const unknownOperation = randomUUID();
    const unknown = await invokeRecord(unknownFixture, unknownOperation, 'effect_unknown');
    expect(unknown).toMatchObject({
      result: 'effect_unknown', detail: 'caller_reported_unknown', signature: null,
    });
    await expect(invokeRecord(unknownFixture, unknownOperation, 'attempt'))
      .resolves.toEqual(unknown);

    const capFixture = await seedFixture('record-cap', { maxToolCalls: 41 });
    await admin.query(
      `UPDATE public.meri_agent_runs SET envelope_jsonb=jsonb_set(
        envelope_jsonb,'{toolPolicy,allow}','["meri_record_turn"]'::jsonb)
       WHERE id=$1::uuid`,
      [capFixture.runId],
    );
    const capOperation = randomUUID();
    await attestRecord(capFixture, capOperation, {
      result: 'denied_before_effect', detail: 'tool_budget_exhausted',
      brokerCallsBefore: 0, brokerCallsAfter: 0, eventSeq: null,
    });
    await expect(invokeRecord(capFixture, capOperation, 'attempt')).resolves.toMatchObject({
      result: 'denied_before_effect', detail: 'tool_budget_exhausted',
    });
  });

});
