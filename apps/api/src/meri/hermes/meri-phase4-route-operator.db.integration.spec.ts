import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

/**
 * Opt-in only: this test writes irreversible Phase 4 tombstones and therefore
 * refuses to run without both a loopback PostgreSQL URL and the explicit
 * disposable-database acknowledgement.
 */
const databaseUrl = process.env.MERI_PHASE4_ROUTE_TEST_DATABASE_URL;
const parsed = databaseUrl ? new URL(databaseUrl) : null;
const isolated = Boolean(
  parsed?.protocol === 'postgresql:' &&
    parsed.hostname === '127.0.0.1' &&
    parsed.username === 'postgres' &&
    parsed.pathname === '/capiro' &&
    process.env.MERI_PHASE4_ROUTE_TEST_ACKNOWLEDGE_DISPOSABLE === 'yes',
);
const describeDb = isolated ? describe : describe.skip;

describeDb('Phase 4 route/session fence on disposable migrated PostgreSQL', () => {
  jest.setTimeout(20_000);

  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const tenantId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const sessionId = randomUUID();
  const bindingId = randomUUID();
  const provisionRequestId = randomUUID();
  const enableRequestId = randomUUID();
  const reason = `Approved Phase 4 route race qualification ${suffix}`;
  const scopeId = `tenant:${tenantId}:user:${userId}`;
  const ingress = `race-ingress-${suffix}`;
  const generation = `race-generation-${suffix}`;
  const credential = `race-credential-${suffix}`;
  const sourceId = `race-source-${suffix}`;
  const producerRole = `meri_phase4_race_${suffix}`;

  const admin = new Client({ connectionString: databaseUrl });
  const app = new Client({ connectionString: databaseUrl });
  const operator = new Client({ connectionString: databaseUrl });
  const terminator = new Client({ connectionString: databaseUrl });

  async function digest(fields: string[]): Promise<string> {
    const result = await admin.query<{ digest: string }>(
      'SELECT trim(public.meri_phase4_route_digest_v1($1::text[])) AS digest',
      [fields],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Phase 4 digest query returned no row');
    return row.digest;
  }

  async function issueGrant(operation: string, requestId: string, requestDigest: string) {
    await app.query('SET SESSION AUTHORIZATION capiro_app');
    try {
      const result = await app.query<{ grant_id: string; grant_nonce: string }>(
        `SELECT grant_id, trim(grant_nonce) AS grant_nonce
         FROM public.meri_phase4_issue_route_operator_grant(
           $1::uuid,$2::uuid,$3::varchar,$4::uuid,$5::char(64)
         )`,
        [tenantId, sessionId, operation, requestId, requestDigest],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Phase 4 grant issuer returned no row');
      return row;
    } finally {
      await app.query('RESET SESSION AUTHORIZATION');
    }
  }

  beforeAll(async () => {
    await Promise.all([
      admin.connect(), app.connect(), operator.connect(), terminator.connect(),
    ]);
    await admin.query(
      `INSERT INTO public.tenants (id,slug,name,status)
       VALUES ($1::uuid,$2,$3,'active')`,
      [tenantId, `phase4-race-${suffix}`, `Phase 4 race ${suffix}`],
    );
    await admin.query(
      `INSERT INTO public.users (id,clerk_user_id,email)
       VALUES ($1::uuid,$2,$3)`,
      [userId, `phase4_race_${suffix}`, `phase4-race-${suffix}@example.invalid`],
    );
    await admin.query(
      `INSERT INTO public.tenant_memberships
         (id,tenant_id,user_id,role,status,joined_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,'capiro_admin','active',clock_timestamp())`,
      [membershipId, tenantId, userId],
    );
    await admin.query(
      `INSERT INTO public.impersonation_sessions
         (id,actor_user_id,tenant_id,reason,expires_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,clock_timestamp() + interval '30 minutes')`,
      [sessionId, userId, tenantId, reason],
    );
    await admin.query(
      `INSERT INTO public.meri_execution_scopes
         (id,tenant_id,principal_type,principal_id,kind,authorization_version)
       VALUES ($1,$2::uuid,'user',$3::uuid,'private',$4)`,
      [scopeId, tenantId, userId, `phase4-race-${suffix}`],
    );
    await admin.query(
      `INSERT INTO public.meri_phase4_worker_binding_sources
         (source_id,producer_role,qualified,qualification_sha256,qualified_at_epoch_micros)
       VALUES ($1,$2,true,repeat('a',64),
         floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint)`,
      [sourceId, producerRole],
    );
    await admin.query(
      `INSERT INTO public.meri_phase4_worker_bindings
         (binding_id,tenant_id,scope_id,worker_audience,worker_ingress_id,
          worker_generation,worker_credential_id,source_id,external_record_id,
          attestation_sha256,attested_by_role,not_before_epoch_micros,
          not_after_epoch_micros,attested_at_epoch_micros)
       VALUES ($1::uuid,$2::uuid,$3,'meri-hermes-scope-worker',$4,$5,$6,$7,$8,
         repeat('c',64),$9,
         floor(extract(epoch FROM clock_timestamp() - interval '1 minute') * 1000000)::bigint,
         floor(extract(epoch FROM clock_timestamp() + interval '1 day') * 1000000)::bigint,
         floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint)`,
      [
        bindingId, tenantId, scopeId, ingress, generation, credential, sourceId,
        `external-${suffix}`, producerRole,
      ],
    );
  });

  afterAll(async () => {
    await Promise.allSettled([
      operator.query('ROLLBACK'), terminator.query('ROLLBACK'),
    ]);
    await Promise.allSettled([
      admin.end(), app.end(), operator.end(), terminator.end(),
    ]);
  });

  it('does not let impersonation End return before an in-flight route mutation commits', async () => {
    const provisionDigest = await digest([
      'capiro.meri.phase4.route-command/v1', 'provision', tenantId, userId,
      sessionId, reason, bindingId, '60000000',
    ]);
    const provisionGrant = await issueGrant(
      'provision', provisionRequestId, provisionDigest,
    );

    await operator.query('SET SESSION AUTHORIZATION meri_phase4_route_operator');
    await operator.query(
      `SELECT * FROM public.meri_phase4_route_provision_disabled(
         $1::uuid,$2::uuid,$3::char(64),$4::uuid,$5::uuid,$6::bigint,$7::char(64)
       )`,
      [
        tenantId, provisionGrant.grant_id, provisionGrant.grant_nonce,
        provisionRequestId, bindingId, 60_000_000, provisionDigest,
      ],
    );
    await operator.query('RESET SESSION AUTHORIZATION');

    const enableDigest = await digest([
      'capiro.meri.phase4.route-command/v1', 'enable', tenantId, userId,
      sessionId, reason, scopeId, ingress, generation, credential,
    ]);
    const enableGrant = await issueGrant('enable', enableRequestId, enableDigest);

    await operator.query('BEGIN');
    await operator.query('SET LOCAL SESSION AUTHORIZATION meri_phase4_route_operator');
    await operator.query(
      `SELECT * FROM public.meri_phase4_route_enable(
         $1::uuid,$2::uuid,$3::char(64),$4::uuid,$5::varchar,$6::varchar,
         $7::varchar,$8::varchar,$9::char(64)
       )`,
      [
        tenantId, enableGrant.grant_id, enableGrant.grant_nonce, enableRequestId,
        scopeId, ingress, generation, credential, enableDigest,
      ],
    );

    let endReturned = false;
    const endPromise = terminator.query(
      `UPDATE public.impersonation_sessions
       SET ended_at=clock_timestamp(), ended_reason='race qualification'
       WHERE id=$1::uuid RETURNING id`,
      [sessionId],
    ).then((result) => {
      endReturned = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(endReturned).toBe(false);

    await operator.query('COMMIT');
    const ended = await endPromise;
    expect(ended.rowCount).toBe(1);

    const state = await admin.query<{ enabled: boolean; ended: boolean }>(
      `SELECT r.enabled, (i.ended_at IS NOT NULL) AS ended
       FROM public.meri_phase4_worker_routes r
       JOIN public.impersonation_sessions i ON i.id=$1::uuid
       WHERE r.tenant_id=$2::uuid AND r.worker_ingress_id=$3`,
      [sessionId, tenantId, ingress],
    );
    expect(state.rows[0]).toEqual({ enabled: true, ended: true });
  });
});
