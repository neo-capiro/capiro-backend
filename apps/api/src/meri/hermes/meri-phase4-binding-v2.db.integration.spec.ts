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

const attestSql = `SELECT * FROM public.meri_phase4_attest_worker_binding_v2(
  $1::uuid,$2::varchar,$3::varchar,$4::uuid,$5::varchar,$6::varchar,
  $7::varchar,$8::varchar,$9::bigint,$10::bigint,$11::char(64),
  $12::varchar,$13::varchar,$14::char(64),$15::varchar,$16::char(64),
  $17::varchar,$18::char(64),$19::varchar,$20::varchar,$21::varchar,
  $22::varchar)`;
const attestSignature = `public.meri_phase4_attest_worker_binding_v2(
  uuid,varchar,varchar,uuid,varchar,varchar,varchar,varchar,bigint,bigint,
  char,varchar,varchar,char,varchar,char,varchar,char,varchar,varchar,varchar,varchar
)`;
const revokeSignature =
  'public.meri_phase4_revoke_worker_binding(uuid,uuid,varchar,uuid)';

describeDb('Phase 4 source-qualified binding V2 on disposable migrated PostgreSQL', () => {
  jest.setTimeout(30_000);

  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const tenantId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const scopeId = `tenant:${tenantId}:user:${userId}`;
  const sourceId = `v2-source-${suffix}`;
  const otherSourceId = `v2-other-${suffix}`;
  const producerRole = `meri_phase4_v2_${suffix}`;
  const otherProducerRole = `meri_phase4_v2_other_${suffix}`;
  const producerPassword = `phase4-v2-${suffix}-password`;
  const ingress = `v2-ingress-${suffix}`;
  const generation = `v2-generation-${suffix}`;
  const credential = `v2-credential-${suffix}`;
  const admin = new Client({ connectionString: databaseUrl });
  const app = new Client({ connectionString: databaseUrl });
  const producerUrl = new URL(
    databaseUrl ?? 'postgresql://invalid:invalid@127.0.0.1/invalid',
  );
  producerUrl.username = producerRole;
  producerUrl.password = producerPassword;
  const producer = new Client({ connectionString: producerUrl.toString() });
  const bindingId = randomUUID();
  const externalRecordId = `v2-record-${suffix}`;
  const notBefore = (BigInt(Date.now() - 60_000) * 1_000n).toString();
  const notAfter = (BigInt(Date.now() + 86_400_000) * 1_000n).toString();

  const params = (selectedBindingId = bindingId, selectedExternal = externalRecordId) => [
    selectedBindingId, sourceId, selectedExternal, tenantId, scopeId, ingress,
    generation, credential, notBefore, notAfter, 'a'.repeat(64), 'build-a',
    'capiro.meri.phase4.worker-catalog/v1', 'b'.repeat(64), 'meri-catalog-7',
    'c'.repeat(64), 'mapping-7', 'd'.repeat(64),
    'capiro.meri.phase4.request-local-tool-view/v1',
    'capiro.meri.phase4.claim-tool-view-attestation/v1', credential,
    'capiro.meri.phase4.applied-tool-view/v1',
  ];

  beforeAll(async () => {
    await Promise.all([admin.connect(), app.connect()]);
    await admin.query(
      `CREATE ROLE ${producerRole} LOGIN PASSWORD '${producerPassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
       CONNECTION LIMIT 2`,
    );
    await admin.query(
      `CREATE ROLE ${otherProducerRole} LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB
       NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1`,
    );
    await admin.query(`GRANT EXECUTE ON FUNCTION ${attestSignature} TO ${producerRole}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION ${revokeSignature} TO ${producerRole}`);
    await admin.query(
      `INSERT INTO public.tenants (id,slug,name,status)
       VALUES ($1::uuid,$2,$3,'active')`,
      [tenantId, `phase4-v2-${suffix}`, `Phase 4 V2 ${suffix}`],
    );
    await admin.query(
      `INSERT INTO public.users (id,clerk_user_id,email)
       VALUES ($1::uuid,$2,$3)`,
      [userId, `phase4_v2_${suffix}`, `phase4-v2-${suffix}@example.invalid`],
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
      [scopeId, tenantId, userId, `phase4-v2-${suffix}`],
    );
    await admin.query(
      `INSERT INTO public.meri_phase4_worker_binding_sources
         (source_id,producer_role,qualified,qualification_sha256,qualified_at_epoch_micros)
       VALUES ($1,$2,true,repeat('e',64),
         floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint)`,
      [sourceId, producerRole],
    );
    await admin.query(
      `INSERT INTO public.meri_phase4_worker_binding_sources
         (source_id,producer_role,qualified,qualification_sha256,qualified_at_epoch_micros)
       VALUES ($1,$2,true,repeat('7',64),
         floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint)`,
      [otherSourceId, otherProducerRole],
    );
    await producer.connect();
    await producer.query("SELECT set_config('app.current_tenant',$1,false)", [tenantId]);
    await expect(producer.query('SELECT session_user, current_user')).resolves.toMatchObject({
      rows: [{ session_user: producerRole, current_user: producerRole }],
    });
    await app.query('SET SESSION AUTHORIZATION capiro_app');
    await app.query("SELECT set_config('app.current_tenant',$1,false)", [tenantId]);
  });

  afterAll(async () => {
    await Promise.allSettled([producer.end(), app.query('RESET SESSION AUTHORIZATION')]);
    await Promise.allSettled([app.end()]);
    await admin.query(`REVOKE EXECUTE ON FUNCTION ${attestSignature} FROM ${producerRole}`)
      .catch(() => undefined);
    await admin.query(`REVOKE EXECUTE ON FUNCTION ${revokeSignature} FROM ${producerRole}`)
      .catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${producerRole}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${otherProducerRole}`).catch(() => undefined);
    await admin.end();
  });

  it('cuts over application grants and keeps producer authority source-specific', async () => {
    const result = await admin.query<{
      app_v1_lock: boolean; app_v2_lock: boolean; app_v2_attest: boolean;
      app_revoke: boolean; operator_v2_lock: boolean; operator_v2_attest: boolean;
      producer_v1_lock: boolean; producer_v2_lock: boolean;
      producer_v2_attest: boolean; producer_revoke: boolean;
    }>(`SELECT
      has_function_privilege('capiro_app',
        'public.meri_phase4_lock_worker_binding(uuid,uuid,varchar,text,text,text,text)',
        'EXECUTE') AS app_v1_lock,
      has_function_privilege('capiro_app',
        'public.meri_phase4_lock_worker_binding_v2(uuid,uuid,varchar,text,text,text,text)',
        'EXECUTE') AS app_v2_lock,
      has_function_privilege('capiro_app', $1, 'EXECUTE') AS app_v2_attest,
      has_function_privilege('capiro_app', $3, 'EXECUTE') AS app_revoke,
      has_function_privilege('meri_phase4_route_operator',
        'public.meri_phase4_lock_worker_binding_v2(uuid,uuid,varchar,text,text,text,text)',
        'EXECUTE') AS operator_v2_lock,
      has_function_privilege('meri_phase4_route_operator', $1, 'EXECUTE')
        AS operator_v2_attest,
      has_function_privilege($2,
        'public.meri_phase4_lock_worker_binding(uuid,uuid,varchar,text,text,text,text)',
        'EXECUTE') AS producer_v1_lock,
      has_function_privilege($2,
        'public.meri_phase4_lock_worker_binding_v2(uuid,uuid,varchar,text,text,text,text)',
        'EXECUTE') AS producer_v2_lock,
      has_function_privilege($2, $1, 'EXECUTE') AS producer_v2_attest,
      has_function_privilege($2, $3, 'EXECUTE') AS producer_revoke`,
    [attestSignature.replace(/\s+/g, ' '), producerRole, revokeSignature]);
    expect(result.rows[0]).toEqual({
      app_v1_lock: false, app_v2_lock: true, app_v2_attest: false,
      app_revoke: false, operator_v2_lock: false, operator_v2_attest: false,
      producer_v1_lock: false, producer_v2_lock: false,
      producer_v2_attest: true, producer_revoke: true,
    });
  });

  it('rejects partial V2 rows, including NULL version and a NULL required field', async () => {
    const baseInsert = `INSERT INTO public.meri_phase4_worker_bindings (
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
      repeat('f',64),$9,$10::bigint,$11::bigint,
      floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint,$12::smallint,
      $13::char(64),$14,$15,$16::char(64),$17,$18,$19::char(64),$20,
      $21::char(64),$22,$23,$24
    )`;
    const common = [tenantId, scopeId, ingress, generation, credential, sourceId,
      `partial-${suffix}`, producerRole, notBefore, notAfter];
    await expect(admin.query(baseInsert, [
      randomUUID(), ...common, null, 'a'.repeat(64), null, null, null, null,
      null, null, null, null, null, null, null,
    ])).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(baseInsert, [
      randomUUID(), ...common, 2, 'a'.repeat(64), 'build-a',
      'capiro.meri.phase4.worker-catalog/v1', 'b'.repeat(64),
      'capiro.meri.phase4.applied-tool-view/v1', 'meri-catalog-7', 'c'.repeat(64),
      'mapping-7', null, 'capiro.meri.phase4.request-local-tool-view/v1',
      'capiro.meri.phase4.claim-tool-view-attestation/v1', credential,
    ])).rejects.toMatchObject({ code: '23514' });
  });

  it('attests an exact V2 replay and rejects caller, input, window, and replay drift', async () => {
    const first = await producer.query(attestSql, params());
    const replay = await producer.query(attestSql, params());
    expect(first.rows).toHaveLength(1);
    expect(replay.rows).toEqual(first.rows);

    const wrongSource = params(randomUUID(), `wrong-source-${suffix}`);
    wrongSource[1] = `missing-source-${suffix}`;
    await expect(producer.query(attestSql, wrongSource)).rejects.toMatchObject({ code: '42501' });

    const wrongSessionRole = params(randomUUID(), `wrong-role-${suffix}`);
    wrongSessionRole[1] = otherSourceId;
    await expect(producer.query(attestSql, wrongSessionRole))
      .rejects.toMatchObject({ code: '42501' });

    const invalidAlgorithm = params(randomUUID(), `bad-algorithm-${suffix}`);
    invalidAlgorithm[12] = 'wrong-algorithm';
    await expect(producer.query(attestSql, invalidAlgorithm)).rejects.toMatchObject({ code: '22023' });

    const expired = params(randomUUID(), `expired-${suffix}`);
    expired[8] = '1';
    expired[9] = '2';
    await expect(producer.query(attestSql, expired)).rejects.toMatchObject({ code: '22023' });

    const replayDrift = params();
    replayDrift[11] = 'build-b';
    await expect(producer.query(attestSql, replayDrift)).rejects.toMatchObject({ code: '23505' });

    await expect(app.query(attestSql, params(randomUUID(), `app-${suffix}`)))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('locks only exact V2 authority, denies legacy rows, and exposes revocation', async () => {
    const lockSql = `SELECT * FROM public.meri_phase4_lock_worker_binding_v2(
      $1::uuid,$2::uuid,$3::varchar,$4::text,$5::text,$6::text,$7::text)`;
    const lockParams = [bindingId, tenantId, scopeId, 'meri-hermes-scope-worker',
      ingress, generation, credential];
    const active = await app.query(lockSql, lockParams);
    expect(active.rows).toHaveLength(1);
    expect(active.rows[0]).toMatchObject({
      active: true, worker_image_digest: 'a'.repeat(64), worker_build_id: 'build-a',
      worker_catalog_digest_algorithm: 'capiro.meri.phase4.worker-catalog/v1',
      worker_catalog_digest: 'b'.repeat(64),
      applied_tool_view_digest_algorithm: 'capiro.meri.phase4.applied-tool-view/v1',
      meri_catalog_version: 'meri-catalog-7', meri_catalog_digest: 'c'.repeat(64),
      capability_mapping_version: 'mapping-7',
      capability_mapping_digest: 'd'.repeat(64),
      tool_view_protocol: 'capiro.meri.phase4.request-local-tool-view/v1',
      claim_attestation_protocol: 'capiro.meri.phase4.claim-tool-view-attestation/v1',
      attestation_credential_id: credential,
    });
    await expect(app.query(lockSql, [...lockParams.slice(0, 6), `${credential}-wrong`]))
      .resolves.toMatchObject({ rows: [] });

    const legacyBindingId = randomUUID();
    await admin.query(
      `INSERT INTO public.meri_phase4_worker_bindings (
        binding_id,tenant_id,scope_id,worker_audience,worker_ingress_id,
        worker_generation,worker_credential_id,source_id,external_record_id,
        attestation_sha256,attested_by_role,not_before_epoch_micros,
        not_after_epoch_micros,attested_at_epoch_micros
      ) VALUES ($1::uuid,$2::uuid,$3,'meri-hermes-scope-worker',$4,$5,$6,$7,$8,
        repeat('9',64),$9,$10::bigint,$11::bigint,
        floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint)`,
      [legacyBindingId, tenantId, scopeId, `${ingress}-legacy`, generation, credential,
        sourceId, `legacy-${suffix}`, producerRole, notBefore, notAfter],
    );
    const legacy = await app.query(lockSql, [legacyBindingId, tenantId, scopeId,
      'meri-hermes-scope-worker', `${ingress}-legacy`, generation, credential]);
    expect(legacy.rows).toHaveLength(0);

    await producer.query(
      `SELECT * FROM public.meri_phase4_revoke_worker_binding(
        $1::uuid,$2::uuid,$3::varchar,$4::uuid)`,
      [bindingId, tenantId, sourceId, randomUUID()],
    );
    const revoked = await app.query(lockSql, lockParams);
    expect(revoked.rows).toHaveLength(1);
    expect(revoked.rows[0]?.active).toBe(false);
  });

  it('leaves no owner membership and no PUBLIC access to non-extension routines', async () => {
    const result = await admin.query<{
      owner_members: string; owner_schema_create: boolean; public_routines: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM pg_auth_members m
          WHERE m.roleid='meri_phase4_authority_owner'::regrole
             OR m.member='meri_phase4_authority_owner'::regrole) AS owner_members,
        has_schema_privilege('meri_phase4_authority_owner','public','CREATE')
          AS owner_schema_create,
        (SELECT count(*)::text FROM pg_proc p
          JOIN pg_namespace n ON n.oid=p.pronamespace
          CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) x
          WHERE x.grantee=0 AND x.privilege_type='EXECUTE' AND n.nspname='public'
            AND NOT EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid
              WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e'))
          AS public_routines`);
    expect(result.rows[0]).toEqual({
      owner_members: '0', owner_schema_create: false, public_routines: '0',
    });
  });
});
