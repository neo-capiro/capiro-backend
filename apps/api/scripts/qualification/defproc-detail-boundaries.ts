/** Local synthetic boundary proof: explicit opt-in, original guards, rollback-only data. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from 'pg';
import { awardKey, canonicalJson, mapSamAction, payloadHash, SAM_ACTION_CONTRACT, transactionInput } from '../lib/sam-contract-action.js';
import { populationManifestHash, qualifiedMember, type ObservedAction } from '../lib/sam-action-projection.js';
import { buildAcquisitionIdentity } from '../../src/program-element/acquisition-continuity/acquisition-identity.js';

const ROOT = 'C:/dev/defproc-release1-backend';
const EVIDENCE = 'C:/dev/defproc-release1-evidence/native-boundaries/parent-result.json';
const DIRECTORY = 'C:/ProgramData/Hermes/profiles/kanbanqa/cache/scratch/pg16-fixture/data';
const CLOCK = '2026-11-01T00:00:00.000000Z';
const ROW_ERROR = 'Procurement actionDetails exceeds maximum row limit of 2500';
const SIZE_ERROR = 'Finite procurement result limit exceeded';
const TABLES = ['public.acquisition_award_transaction_revision', 'public.acquisition_record_revision',
  'public.federal_award', 'public.defproc_producer_qualification_v2',
  'public.defproc_producer_qualification_member_v2', 'defproc_v2_private.target_binding'];
const hashBytes = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

async function snapshot(client: Client) {
  const tables: Record<string, { count: string; hash: string }> = {};
  for (const table of TABLES) {
    // Fixed allowlist; hash whole row contents, not just their count.
    tables[table] = (await client.query(`SELECT count(*)::text count,
      encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,chr(10)
        ORDER BY to_jsonb(t)::text COLLATE "C"),''),'UTF8')),'hex') hash FROM ${table} t`)).rows[0];
  }
  const functions = (await client.query(`SELECT n.nspname,p.proname,
    pg_get_function_identity_arguments(p.oid) arguments,pg_get_userbyid(p.proowner) owner,p.proacl::text acl,
    encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') hash
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind='f'
    AND (n.nspname='defproc_v2_private' OR (n.nspname='public' AND p.proname LIKE 'defproc_%'))
    ORDER BY n.nspname,p.proname,arguments`)).rows;
  assert(functions.length > 5, 'complete projection/qualification function set required');
  return { tables, functions };
}

async function seed(client: Client, count: number) {
  const piid = `BND${count}`, uid = `CONT_AWD_${piid}_9700_-NONE-_-NONE-`, key = awardKey(uid)!;
  assert.equal((await client.query('SELECT count(*)::int n FROM public.federal_award WHERE award_unique_id=$1', [uid])).rows[0].n, 0);
  const catalog = { generated_internal_id: uid, 'Award ID': piid, 'Recipient Name': 'SYNTHETIC BOUNDARY VENDOR',
    'Recipient UEI': null, 'Awarding Agency': 'SYNTHETIC AGENCY', 'Awarding Sub Agency': 'SYNTHETIC SUBTIER' };
  await client.query(`INSERT INTO public.federal_award
    (id,award_unique_id,piid,contractor_name,recipient_uei,amount,action_date,raw_jsonb)
    VALUES ($1,$2,$3,$4,NULL,0,'2025-06-01','{}')`, [randomUUID(), uid, piid, catalog['Recipient Name']]);
  await client.query(`INSERT INTO public.acquisition_record_revision
    (id,identity_key,source_system,source_record_id,record_kind,content_hash,source_observed_at,recorded_at,raw_jsonb)
    VALUES ($1,$2,'usaspending',$3,'award',$4,'2025-01-01T00:00:00Z','2025-01-02T00:00:00Z',$5::jsonb)`,
    [randomUUID(), key, uid, payloadHash(catalog), JSON.stringify(catalog)]);
  const run = { contract: SAM_ACTION_CONTRACT, producerCommit: 'e'.repeat(40), imageDigest: `sha256:${'e'.repeat(64)}`,
    runId: `synthetic-boundary-${randomUUID()}`, targetId: 'fixture-target-1' };
  const rows = Array.from({ length: count }, (_, index) => {
    const source = {
      contractId: { piid, subtier: { code: '9700' }, modificationNumber: `P${index}`, transactionNumber: '1' },
      coreData: { awardOrIDV: 'AWARD', awardOrIDVType: { code: 'B' }, federalOrganization: {
        fundingInformation: { fundingDepartment: { code: '1200', name: 'SYNTHETIC FUNDING — café 測試' } },
        contractingInformation: { contractingDepartment: { code: '9700', name: 'SYNTHETIC CONTRACTING' } },
      } },
      awardDetails: { dollars: { actionObligation: '500000.00' }, dates: { dateSigned: '2025-06-01' },
        transactionData: { lastModifiedDate: '2025-06-15T00:00:00.000000Z' } },
    };
    const mapped = mapSamAction(source, [{ piid, awardUniqueId: uid, identityKey: key }]);
    assert(mapped.ok, 'owner mapper must admit the synthetic action');
    const input = transactionInput(source, mapped.value, run, '2025-06-16T00:00:00.000000Z');
    const identity = buildAcquisitionIdentity({ source: 'sam_gov', recordKind: 'modification', transactionId: input.sourceTransactionId });
    assert(identity.ok);
    return { id: randomUUID(), transaction_identity_key: identity.identity.key, award_identity_key: key,
      source_transaction_id: input.sourceTransactionId, piid, modification_number: input.modificationNumber,
      action_date: input.actionDate, signed_obligation_delta: input.signedObligationDelta,
      source_observed_at: input.sourceObservedAt, source_url: input.sourceUrl,
      content_hash: payloadHash(input), raw_jsonb: input.raw };
  });
  const inserted = await client.query(`INSERT INTO public.acquisition_award_transaction_revision
    (id,transaction_identity_key,award_identity_key,source_system,source_transaction_id,piid,modification_number,
     action_date,signed_obligation_delta,signed_outlay_delta,source_observed_at,recorded_at,source_url,content_hash,raw_jsonb)
    SELECT id,transaction_identity_key,award_identity_key,'sam_gov',source_transaction_id,piid,modification_number,
     action_date,signed_obligation_delta,NULL,source_observed_at,'2025-06-17T00:00:00.000000Z',source_url,content_hash,raw_jsonb
    FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,transaction_identity_key text,award_identity_key text,
     source_transaction_id text,piid text,modification_number text,action_date date,signed_obligation_delta numeric,
     source_observed_at timestamptz,source_url text,content_hash text,raw_jsonb jsonb)`, [JSON.stringify(rows)]);
  assert.equal(inserted.rowCount, count);
  const persisted = (await client.query<{ row: ObservedAction }>(`SELECT defproc_v2_private.row_object(t) row
    FROM public.acquisition_award_transaction_revision t WHERE id=ANY($1::uuid[])`, [rows.map(row => row.id)])).rows;
  assert.equal(persisted.length, count);
  const members = persisted.map(({ row }) => {
    const member = qualifiedMember(row);
    assert(row.raw && typeof row.raw === 'object' && 'sourcePayload' in row.raw);
    assert.equal(member.rowContentHash, payloadHash(row));
    assert.equal(member.sourcePayloadHash, payloadHash(row.raw.sourcePayload));
    return { ...member, reviewedCanonical: canonicalJson(row), payloadCanonical: canonicalJson(row.raw.sourcePayload) };
  });
  // Actual owner-only canonical-byte seal, never direct header/member inserts.
  await client.query('SELECT defproc_v2_private.seal_population($1::jsonb,$2::jsonb)', [JSON.stringify({
    contract_id: run.contract, producer_commit: run.producerCommit, image_digest: run.imageDigest,
    run_id: run.runId, target_id: run.targetId, completed_at: '2025-10-01T00:00:00.000000Z',
    approved_at: '2025-10-01T01:00:00.000000Z', revoked_at: null, award_identity_keys: [key], member_count: count,
    manifest_sha256: populationManifestHash(members), evidence_sha256: payloadHash({ syntheticOnly: true, count }),
    scope_description: 'Synthetic rollback-only boundary test; not publisher qualification',
  }), JSON.stringify(members)]);
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  return key;
}

async function main() {
  assert.equal(process.env.DEFPROC_LOCAL_BOUNDARY_TEST, '1', 'explicit DEFPROC_LOCAL_BOUNDARY_TEST=1 required before connecting');
  assert(!process.env.DATABASE_URL, 'unset generic DATABASE_URL for this isolated test');
  for (const [name, expected] of Object.entries({ PGHOST: '127.0.0.1', PG_HOST: '127.0.0.1', PGPORT: '5558', PG_PORT: '5558',
    PGDATABASE: 'capiro_fixture', PG_DB: 'capiro_fixture', PGUSER: 'capiro_master', PG_USER: 'capiro_master' })) {
    if (process.env[name] !== undefined) assert.equal(process.env[name], expected, `${name}: wrong fixture target`);
  }
  const client = new Client({ host: '127.0.0.1', port: 5558, user: 'capiro_master', database: 'capiro_fixture',
    ssl: false, connectionTimeoutMillis: 5000, statement_timeout: 120000, query_timeout: 125000 });
  await client.connect();
  try {
    const identity = (await client.query(`SELECT current_setting('data_directory') directory,
      current_setting('server_version_num') version,host(inet_server_addr()) address,inet_server_port() port,
      current_database() db,current_user role`)).rows[0];
    assert.equal(identity.directory.replaceAll('\\', '/'), DIRECTORY);
    assert.equal(identity.address, '127.0.0.1'); assert.equal(identity.port, 5558);
    assert.equal(identity.db, 'capiro_fixture'); assert.equal(identity.role, 'capiro_master');
    assert(Number(identity.version) >= 160000 && Number(identity.version) < 170000);
    assert.equal((await client.query('SELECT target_id FROM defproc_v2_private.target_binding')).rows[0]?.target_id, 'fixture-target-1');
    const migration = readFileSync(`${ROOT}/apps/api/prisma/migrations/20281101180000_defproc_scoped_money_flow_v2/migration.sql`, 'utf8');
    const sourceBody = migration.split('CREATE FUNCTION public.defproc_money_flow_details_v2')[1]?.match(/AS \$\$([\s\S]*?)\$\$;/)?.[1];
    assert(sourceBody, 'actual migration body required');
    const installedBody = (await client.query(`SELECT prosrc FROM pg_proc WHERE oid='public.defproc_money_flow_details_v2(text[],text,text)'::regprocedure`)).rows[0].prosrc;
    assert.equal(installedBody.replaceAll('\r\n', '\n').trim(), sourceBody.replaceAll('\r\n', '\n').trim());
    const baseline = await snapshot(client);
    const rights = (await client.query(`SELECT rolname,has_function_privilege(oid,
      'public.defproc_money_flow_details_v2(text[],text,text)','EXECUTE') allowed FROM pg_roles
      WHERE rolname=ANY(ARRAY['capiro_app','capiro_defense_job','capiro_defense_job_login','capiro_defense_serve']) ORDER BY rolname`)).rows;
    assert.equal(rights.length, 4);
    for (const role of rights) assert.equal(role.allowed, role.rolname === 'capiro_app');
    const cases: Record<string, unknown>[] = [];
    for (const [count, expectedError] of [[2501, ROW_ERROR], [2500, SIZE_ERROR], [900, SIZE_ERROR], [200, null]] as const) {
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='180s'");
        const key = await seed(client, count);
        const selected = (await client.query(`SELECT count(*)::int n FROM public.defproc_action_asof_v2($1::timestamptz,NULL)
          WHERE award_identity_key=$2`, [CLOCK, key])).rows[0].n;
        assert.equal(selected, count);
        await client.query('SET LOCAL ROLE capiro_app');
        const summary = (await client.query('SELECT public.defproc_money_flow_scope_v2($1::text[],$2::text,NULL) result', [[key], CLOCK])).rows[0].result;
        assert.equal(summary.totals.actions, String(count));
        assert.equal(summary.totals.obligationUsd, `${BigInt(count) * 500000n}.00`);
        assert.equal(summary.groups.length, 1); assert.equal(summary.provenance.length, 1);
        // One group/provenance entry rules out the other branches sharing SIZE_ERROR.
        const detail = () => client.query(`WITH q AS MATERIALIZED (
          SELECT public.defproc_money_flow_details_v2($1::text[],$2::text,NULL) result)
          SELECT result,octet_length(result::text) sql_bytes,char_length(result::text) sql_chars FROM q`, [[key], CLOCK]);
        if (expectedError) {
          await assert.rejects(detail, (error: unknown) => {
            assert(error instanceof Error && 'code' in error);
            assert.equal(error.code, '54000'); assert.equal(error.message, expectedError); return true;
          });
          cases.push({ selected, appRole: true, summaryActions: summary.totals.actions,
            summaryObligationUsd: summary.totals.obligationUsd, sqlstate: '54000', refusal: expectedError,
            rejectedBytes: null, note: 'Refused full population; exact rejected byte size not measured' });
        } else {
          const { result, sql_bytes: sqlBytes, sql_chars: sqlChars } = (await detail()).rows[0];
          assert(Array.isArray(result.actionDetails)); assert.equal(result.actionDetails.length, count);
          const { actionDetails: _details, ...rest } = result; assert.deepEqual(rest, summary);
          const compactBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
          assert(sqlBytes <= 1048576 && compactBytes <= sqlBytes);
          assert(sqlBytes > sqlChars, 'multibyte source labels must exercise UTF-8 byte accounting');
          cases.push({ selected, appRole: true, admitted: true, sqlBytes, sqlChars, compactBytes, summaryConserved: true });
        }
      } finally { await client.query('ROLLBACK'); }
      assert.deepEqual(await snapshot(client), baseline, 'rollback must preserve row content, function bodies, owners and ACLs');
    }
    const result = { status: 'LOCAL_BOUNDARIES_PASS', observedAt: new Date().toISOString(), identity, rights,
      sourceHash: hashBytes(readFileSync(`${ROOT}/apps/api/scripts/qualification/defproc-detail-boundaries.ts`, 'utf8')),
      migrationHash: hashBytes(migration), baseline, after: await snapshot(client), cases,
      liveClockCheck: 'SKIPPED_AT_USER_REQUEST', productionFunctionsChanged: false, persistentDataChanges: false };
    writeFileSync(EVIDENCE, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ status: result.status, cases, evidence: EVIDENCE }));
  } finally { await client.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
