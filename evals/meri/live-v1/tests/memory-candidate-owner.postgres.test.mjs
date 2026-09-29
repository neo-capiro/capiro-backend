import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { after, before, describe, it } from 'node:test';
import { createAdapter } from '../fixture-provisioning/memory-candidate-runtime.mjs';
import { buildFixtureManifest } from '../fixture-provisioning/manifest.mjs';
import { planFixture, applyFixture, verifyFixture } from '../fixture-provisioning/provisioner.mjs';
import {
  AUTHORIZED_TENANTS,
  APPLY_CONFIRMATION,
  RETIRE_CONFIRMATION,
} from '../fixture-provisioning/contract.mjs';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const { Pool } = require('pg');
const configPath = process.env.MERI_FIXTURE_POSTGRES_CONFIG;
const TENANT = AUTHORIZED_TENANTS.T1.id;
const USER = '44444444-4444-4444-8444-444444444444';
const CLIENT = '11111111-1111-4111-8111-111111111111';

describe('built canonical memory candidate command runtime', { skip: !configPath }, () => {
  const schema = `meri_candidate_${randomUUID().replaceAll('-', '')}`;
  let pool, adapter, manifest, config;
  const beforeEnv = {
    database: process.env.DATABASE_URL,
    namespace: process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE,
    review: process.env.MEMORY_CLIENT_REVIEW,
    lifecycle: process.env.MEMORY_GOVERNANCE_LIFECYCLE,
    enforcement: process.env.MEMORY_GOVERNANCE_ENFORCE,
  };

  before(async () => {
    const database = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(database.host, '127.0.0.1');
    assert.equal(database.port, 55433);
    assert.equal(database.database, 'postgres');
    assert.match(schema, /^meri_candidate_[a-f0-9]{32}$/u);
    pool = new Pool(database);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(`
      CREATE TABLE "${schema}".tenants(id uuid PRIMARY KEY, slug text);
      CREATE TABLE "${schema}".tenant_memberships(tenant_id uuid, user_id uuid, status text);
      CREATE TABLE "${schema}".clients(id uuid PRIMARY KEY, tenant_id uuid, memory_wall boolean NOT NULL DEFAULT false);
      CREATE TABLE "${schema}".client_memory_access(tenant_id uuid, client_id uuid, user_id uuid);
      CREATE TABLE "${schema}".clio_memory(id uuid, tenant_id uuid, scope text, key text, owner_user_id uuid, client_id uuid);
      CREATE TABLE "${schema}".memory_candidate(
        id uuid PRIMARY KEY, tenant_id uuid, proposed_by uuid, source_kind text,
        scope text, client_id uuid, payload_jsonb jsonb, provenance_jsonb jsonb,
        duplicate_of_id uuid, status text, confidence float,
        source_type text, source_id text, memory_class text DEFAULT 'legacy_unclassified',
        memory_authority text DEFAULT 'legacy_unclassified', contradicts_memory_item_id uuid,
        conflict_status text, committed_memory_id uuid, committed_memory_item_id uuid,
        decided_at timestamptz, created_at timestamptz DEFAULT now(),
        governed_status text DEFAULT 'suggested', instructions_allowed boolean DEFAULT false,
        approved_at timestamptz, approved_by_user_id uuid,
        revision_root_id uuid, predecessor_candidate_id uuid, revision_number int DEFAULT 1,
        superseded_by_id uuid, contradicts_id uuid, decided_by uuid,
        memory_scope text DEFAULT 'firm', source_ref text, source_excerpt text,
        source_content_hash text, source_version text, asserted_by_user_id uuid,
        second_approved_by_user_id uuid, second_approved_at timestamptz,
        as_of timestamptz, effective_from timestamptz, valid_until timestamptz,
        expires_at timestamptz, review_cadence_days int, review_due_at timestamptz,
        conflict_group_id uuid, controlling_item_id uuid, sensitivity text DEFAULT 'normal',
        retention_policy_jsonb jsonb, legal_hold boolean DEFAULT false,
        origin_surface text, origin_trace_id text, origin_context_packet_id uuid,
        origin_model text, origin_prompt_version text, duplicate_memory_item_id uuid
      );
      CREATE TABLE "${schema}".memory_transition_audit(
        id uuid PRIMARY KEY, tenant_id uuid, memory_item_id uuid, memory_candidate_id uuid,
        actor_user_id uuid, effective_tenant_id uuid, client_id uuid,
        from_status text, to_status text, reason_code text, reason text, source_type text,
        source_id text, proposal_id uuid, impersonation_session_id uuid,
        metadata_jsonb jsonb DEFAULT '{}', occurred_at timestamptz DEFAULT now()
      );
      CREATE TABLE "${schema}".review_request(id uuid PRIMARY KEY, tenant_id uuid, subject_id text, status text)
      `);
    await pool.query(`INSERT INTO "${schema}".tenants VALUES ($1,$2),($3,$4)`, [
      TENANT,
      AUTHORIZED_TENANTS.T1.slug,
      AUTHORIZED_TENANTS.T2.id,
      AUTHORIZED_TENANTS.T2.slug,
    ]);
    await pool.query(`INSERT INTO "${schema}".tenant_memberships VALUES ($1,$2,'active')`, [
      TENANT,
      USER,
    ]);
    await pool.query(`INSERT INTO "${schema}".clients(id,tenant_id) VALUES ($1,$2),($3,$2)`, [
      CLIENT,
      TENANT,
      '22222222-2222-4222-8222-222222222222',
    ]);
    const url = new URL(`postgresql://${database.host}:${database.port}/${database.database}`);
    url.username = database.user;
    url.password = database.password;
    url.searchParams.set('schema', schema);
    process.env.DATABASE_URL = url.href;
    process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE = 'meri-foundation-20260928';
    config = {
      target: 'capiro-dev',
      fixtureNamespace: 'meri-foundation-20260928',
      tenants: AUTHORIZED_TENANTS,
      clients: {
        ASTER: { tenantId: 'T1', physicalId: CLIENT },
        BLUEHAVEN: { tenantId: 'T1', physicalId: '22222222-2222-4222-8222-222222222222' },
        CEDAR: { tenantId: 'T2', physicalId: '33333333-3333-4333-8333-333333333333' },
      },
      actors: { PAT: { tenantId: 'T1', userId: USER } },
      availableOwners: ['memory_candidate'],
    };
    manifest = await buildFixtureManifest(config);
    adapter = await createAdapter({ config });
  });

  after(async () => {
    await adapter?.close();
    for (const [key, value] of [
      ['DATABASE_URL', beforeEnv.database],
      ['MERI_SYNTHETIC_FIXTURE_NAMESPACE', beforeEnv.namespace],
      ['MEMORY_CLIENT_REVIEW', beforeEnv.review],
      ['MEMORY_GOVERNANCE_LIFECYCLE', beforeEnv.lifecycle],
      ['MEMORY_GOVERNANCE_ENFORCE', beforeEnv.enforcement],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (pool) {
      assert.match(schema, /^meri_candidate_[a-f0-9]{32}$/u);
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      console.info(`Removed owned local candidate schema ${schema}`);
      await pool.end();
    }
  });

  it('creates and verifies pending client, firm and private proposals through the real service', async () => {
    const plan = await planFixture({ manifest, adapter });
    const result = await applyFixture({
      manifest,
      adapter,
      plan,
      confirmation: APPLY_CONFIRMATION,
    });
    assert.equal(
      result.status,
      'complete',
      JSON.stringify(
        result.records.filter((r) => r.outcome !== 'committed' && r.outcome !== 'verified_absent'),
      ),
    );
    const verified = await verifyFixture({ manifest, adapter });
    assert.equal(verified.status, 'complete');
    const replay = await planFixture({ manifest, adapter });
    assert.equal(replay.summary.creates, 0);
    assert.equal(replay.summary.replacements, 0);
    assert.equal(replay.summary.absent, 1);
    const rows = await pool.query(
      `SELECT scope,status,source_kind FROM "${schema}".memory_candidate`,
    );
    assert.deepEqual(
      new Set(rows.rows.map((row) => row.scope)),
      new Set(['client', 'firm', 'personal']),
    );
    assert.ok(
      rows.rows.every((row) => row.status === 'pending' && row.source_kind === 'model_extraction'),
    );
  });

  it('rejects a live environment without the explicit fixture opt-in', async () => {
    delete process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE;
    try {
      await assert.rejects(createAdapter({ config }), {
        code: 'MEMORY_CANDIDATE_RUNTIME_CONFIG_INVALID',
      });
    } finally {
      process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE = 'meri-foundation-20260928';
    }
  });

  it('detects changed canonical content and refuses replacement', async () => {
    const record = manifest.records.find((row) => row.logicalId === 'MEM-PROPOSAL-14');
    await pool.query(
      `UPDATE "${schema}".memory_candidate SET payload_jsonb=jsonb_set(payload_jsonb,'{value}','"changed"') WHERE id=$1`,
      [record.physicalId],
    );
    const verified = await verifyFixture({ manifest, adapter });
    assert.equal(
      verified.records.find((row) => row.logicalId === record.logicalId).errorCode,
      'ACTUAL_READBACK_MISMATCH',
    );
    const plan = await planFixture({ manifest, adapter });
    const result = await applyFixture({
      manifest,
      adapter,
      plan,
      confirmation: APPLY_CONFIRMATION,
    });
    assert.equal(result.status, 'failed');
    assert.equal(
      result.records.find((row) => row.logicalId === record.logicalId).errorCode,
      'MEMORY_CANDIDATE_REPLACE_REFUSED',
    );
  });

  it('detects an unauthorized governance promotion in persisted readback', async () => {
    const record = manifest.records.find((row) => row.logicalId === 'MEM-PROPOSAL-15');
    await pool.query(
      `UPDATE "${schema}".memory_candidate SET governed_status='active' WHERE id=$1`,
      [record.physicalId],
    );
    const row = await adapter.inspect(record);
    assert.equal(row.payloadSha256, null);
  });

  it('refuses reads after actor membership is revoked', async () => {
    await pool.query(
      `UPDATE "${schema}".tenant_memberships SET status='inactive' WHERE user_id=$1`,
      [USER],
    );
    try {
      await assert.rejects(
        adapter.inspect(manifest.records.find((row) => row.logicalId === 'MEM-PROPOSAL-15')),
        { code: 'MEMORY_CANDIDATE_ACTOR_NOT_MEMBER' },
      );
    } finally {
      await pool.query(
        `UPDATE "${schema}".tenant_memberships SET status='active' WHERE user_id=$1`,
        [USER],
      );
    }
  });

  it('rechecks the canonical client wall before returning fixture evidence', async () => {
    await pool.query(`UPDATE "${schema}".clients SET memory_wall=true WHERE id=$1`, [CLIENT]);
    try {
      await assert.rejects(
        adapter.inspect(manifest.records.find((row) => row.logicalId === 'MEM-PROPOSAL-15')),
        { code: 'MEMORY_CANDIDATE_CLIENT_NOT_ALLOWED' },
      );
    } finally {
      await pool.query(`UPDATE "${schema}".clients SET memory_wall=false WHERE id=$1`, [CLIENT]);
    }
  });

  it('seeds a fresh instance without overwriting earlier candidate content or governance', async () => {
    const before = await pool.query(
      `SELECT to_jsonb(mc) AS row, xmin::text AS version FROM "${schema}".memory_candidate mc ORDER BY id`,
    );
    const oldIds = before.rows.map(({ row }) => row.id);
    const fresh = await buildFixtureManifest({
      ...config,
      fixtureInstanceId: 'aaaaaaa1-1111-4111-8111-111111111111',
    });
    const plan = await planFixture({ manifest: fresh, adapter });
    assert.ok(plan.summary.creates > 0);
    const seeded = await applyFixture({
      manifest: fresh,
      adapter,
      plan,
      confirmation: APPLY_CONFIRMATION,
    });
    assert.equal(seeded.status, 'complete');
    assert.equal((await verifyFixture({ manifest: fresh, adapter })).status, 'complete');
    assert.equal((await planFixture({ manifest: fresh, adapter })).summary.creates, 0);
    const after = await pool.query(
      `SELECT to_jsonb(mc) AS row, xmin::text AS version FROM "${schema}".memory_candidate mc
       WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [oldIds],
    );
    assert.deepEqual(after.rows, before.rows);
    const original = manifest.records.find((row) => row.logicalId === 'MEM-PROPOSAL-14');
    const next = fresh.records.find((row) => row.logicalId === original.logicalId);
    assert.notEqual(next.physicalId, original.physicalId);
    const keys = await pool.query(
      `SELECT payload_jsonb->>'key' AS key FROM "${schema}".memory_candidate WHERE id=ANY($1::uuid[])`,
      [[original.physicalId, next.physicalId]],
    );
    assert.equal(new Set(keys.rows.map(({ key }) => key)).size, 2);
  });

  async function retirementFixture() {
    const fresh = await buildFixtureManifest({ ...config, fixtureInstanceId: randomUUID() });
    const record = fresh.records.find((row) => row.logicalId === 'MEM-PROPOSAL-14');
    const guards = {
      tenantId: record.tenantId,
      physicalId: record.physicalId,
      expectedOwnershipMarkerSha256: record.ownership.markerSha256,
      expectedRowVersion: null,
    };
    await adapter.createOwned(record, guards);
    const readback = await adapter.inspect(record);
    return { record, guards: { ...guards, expectedRowVersion: readback.rowVersion } };
  }

  async function withRetirementEnabled(work) {
    const names = [
      'MEMORY_CLIENT_REVIEW',
      'MEMORY_GOVERNANCE_LIFECYCLE',
      'MEMORY_GOVERNANCE_ENFORCE',
      'MEMORY_GOVERNANCE_TENANTS',
    ];
    const old = names.map((name) => process.env[name]);
    // This isolated operator runtime has no authenticated request tenant scope.
    // Only this test process opts in; the runtime never arms its own gates.
    for (const name of names)
      process.env[name] = name === 'MEMORY_GOVERNANCE_TENANTS' ? 'all' : 'enforce';
    try {
      return await work();
    } finally {
      names.forEach((name, index) => {
        if (old[index] === undefined) delete process.env[name];
        else process.env[name] = old[index];
      });
    }
  }

  it('retires through canonical withdrawal, retaining content, review history and audit evidence', async () => {
    await withRetirementEnabled(async () => {
      const { record, guards } = await retirementFixture();
      const previous = await pool.query(
        `SELECT payload_jsonb,provenance_jsonb FROM "${schema}".memory_candidate WHERE id=$1`,
        [record.physicalId],
      );
      const reviewId = randomUUID();
      await pool.query(`INSERT INTO "${schema}".review_request VALUES($1,$2,$3,'pending')`, [
        reviewId,
        TENANT,
        record.physicalId,
      ]);
      const proof = await adapter.retireOwned(record, guards);
      assert.equal(proof.retained, true);
      assert.equal(proof.status, 'withdrawn');
      assert.equal(proof.governedStatus, 'rejected');
      assert.notEqual(proof.rowVersion, guards.expectedRowVersion);
      assert.deepEqual(await adapter.inspectRetirement(record), proof);
      const retained = await pool.query(
        `SELECT payload_jsonb,provenance_jsonb,status FROM "${schema}".memory_candidate WHERE id=$1`,
        [record.physicalId],
      );
      assert.equal(retained.rowCount, 1);
      assert.equal(retained.rows[0].status, 'withdrawn');
      assert.deepEqual(retained.rows[0].payload_jsonb, previous.rows[0].payload_jsonb);
      assert.deepEqual(retained.rows[0].provenance_jsonb, previous.rows[0].provenance_jsonb);
      assert.equal(
        (await pool.query(`SELECT id FROM "${schema}".review_request WHERE id=$1`, [reviewId]))
          .rowCount,
        1,
      );
      assert.equal(
        (
          await pool.query(
            `SELECT id FROM "${schema}".memory_candidate WHERE id=$1 AND status='pending'`,
            [record.physicalId],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await pool.query(
            `SELECT id FROM "${schema}".memory_transition_audit WHERE id=$1 AND reason_code='withdrawn_by_proposer'`,
            [proof.transitionAuditId],
          )
        ).rowCount,
        1,
      );
    });
  });

  it('rejects changed, held, approved, linked or foreign-proposer rows even with their current version', async () => {
    await withRetirementEnabled(async () => {
      for (const mutation of [
        'legal_hold=true',
        "status='approved'",
        "governed_status='active'",
        'approved_at=now()',
        'revision_number=2',
        'revision_root_id=id',
        'duplicate_of_id=id',
        "proposed_by='55555555-5555-4555-8555-555555555555'",
        "payload_jsonb=jsonb_set(payload_jsonb,'{value}','\"changed\"')",
        "provenance_jsonb='{}'",
        "source_id='changed'",
        "retention_policy_jsonb='{}'",
        "origin_trace_id='changed'",
        "source_ref='changed'",
        'confidence=0.5',
        'review_due_at=now()',
      ]) {
        const { record, guards } = await retirementFixture();
        await pool.query(`UPDATE "${schema}".memory_candidate SET ${mutation} WHERE id=$1`, [
          record.physicalId,
        ]);
        const [{ version }] = (
          await pool.query(
            `SELECT xmin::text AS version FROM "${schema}".memory_candidate WHERE id=$1`,
            [record.physicalId],
          )
        ).rows;
        await assert.rejects(
          adapter.retireOwned(record, { ...guards, expectedRowVersion: version }),
          (error) => [403, 404].includes(error.getStatus?.()),
          mutation,
        );
        assert.equal(
          (
            await pool.query(
              `SELECT id FROM "${schema}".memory_transition_audit WHERE memory_candidate_id=$1`,
              [record.physicalId],
            )
          ).rowCount,
          0,
        );
      }
    });
  });

  it('retires legacy fixture identities while preserving their original marker', async () => {
    await withRetirementEnabled(async () => {
      const record = manifest.records.find(
        (row) =>
          row.owner === 'memory_candidate' &&
          row.expectedPresence === 'present' &&
          !['MEM-PROPOSAL-14', 'MEM-PROPOSAL-15'].includes(row.logicalId),
      );
      assert.ok(record);
      assert.equal(record.ownership.marker.fixtureInstanceId, undefined);
      const before = await adapter.inspect(record);
      const proof = await adapter.retireOwned(record, {
        tenantId: record.tenantId,
        physicalId: record.physicalId,
        expectedOwnershipMarkerSha256: record.ownership.markerSha256,
        expectedRowVersion: before.rowVersion,
      });
      assert.equal(proof.retained, true);
      assert.deepEqual(proof.ownership, record.ownership);
    });
  });

  it('refuses stale versions and revoked membership or client access without a transition', async () => {
    await withRetirementEnabled(async () => {
      const { record, guards } = await retirementFixture();
      await pool.query(
        `UPDATE "${schema}".memory_candidate SET confidence=confidence WHERE id=$1`,
        [record.physicalId],
      );
      await assert.rejects(
        adapter.retireOwned(record, guards),
        (error) => error.getStatus?.() === 403,
      );
      const current = (await adapter.inspect(record)).rowVersion;
      await pool.query(
        `UPDATE "${schema}".tenant_memberships SET status='inactive' WHERE user_id=$1`,
        [USER],
      );
      try {
        await assert.rejects(
          adapter.retireOwned(record, { ...guards, expectedRowVersion: current }),
          (error) => error.getStatus?.() === 403,
        );
      } finally {
        await pool.query(
          `UPDATE "${schema}".tenant_memberships SET status='active' WHERE user_id=$1`,
          [USER],
        );
      }
      await pool.query(`UPDATE "${schema}".clients SET memory_wall=true WHERE id=$1`, [
        record.clientPhysicalId,
      ]);
      try {
        await assert.rejects(
          adapter.retireOwned(record, { ...guards, expectedRowVersion: current }),
          (error) => error.getStatus?.() === 403,
        );
      } finally {
        await pool.query(`UPDATE "${schema}".clients SET memory_wall=false WHERE id=$1`, [
          record.clientPhysicalId,
        ]);
      }
      assert.equal(
        (
          await pool.query(`SELECT status FROM "${schema}".memory_candidate WHERE id=$1`, [
            record.physicalId,
          ])
        ).rows[0].status,
        'pending',
      );
    });
  });

  it('requires existing withdrawal feature gates and the exact synthetic namespace', async () => {
    const { record, guards } = await retirementFixture();
    await withRetirementEnabled(async () => {
      delete process.env.MEMORY_CLIENT_REVIEW;
      await assert.rejects(
        adapter.retireOwned(record, guards),
        (error) => error.getStatus?.() === 503,
      );
      process.env.MEMORY_CLIENT_REVIEW = 'enforce';
      process.env.MEMORY_GOVERNANCE_TENANTS = TENANT;
      await assert.rejects(
        adapter.retireOwned(record, guards),
        (error) => error.getStatus?.() === 503,
      );
      process.env.MEMORY_GOVERNANCE_TENANTS = 'all';
      delete process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE;
      try {
        await assert.rejects(
          adapter.retireOwned(record, guards),
          (error) => error.getStatus?.() === 403,
        );
      } finally {
        process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE = 'meri-foundation-20260928';
      }
    });
  });

  it('concurrent retirements produce one terminal transition and preserve the row', async () => {
    await withRetirementEnabled(async () => {
      const { record, guards } = await retirementFixture();
      const results = await Promise.allSettled([
        adapter.retireOwned(record, guards),
        adapter.retireOwned(record, guards),
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
      assert.equal(
        (
          await pool.query(
            `SELECT id FROM "${schema}".memory_transition_audit WHERE memory_candidate_id=$1 AND reason_code='withdrawn_by_proposer'`,
            [record.physicalId],
          )
        ).rowCount,
        1,
      );
      assert.equal((await adapter.inspectRetirement(record)).retained, true);
    });
  });

  it('rolls the candidate transition back when the audit writer fails', async () => {
    await withRetirementEnabled(async () => {
      const { record, guards } = await retirementFixture();
      await pool.query(`CREATE FUNCTION "${schema}".reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'controlled audit sink failure'; END $$;
        CREATE TRIGGER reject_fixture_audit BEFORE INSERT ON "${schema}".memory_transition_audit
        FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_audit()`);
      try {
        await assert.rejects(adapter.retireOwned(record, guards), /controlled audit sink failure/u);
        const row = await adapter.inspect(record);
        assert.equal(row.rowVersion, guards.expectedRowVersion);
        assert.equal(row.payloadSha256, record.payloadSha256);
      } finally {
        await pool.query(
          `DROP TRIGGER reject_fixture_audit ON "${schema}".memory_transition_audit; DROP FUNCTION "${schema}".reject_audit()`,
        );
      }
    });
  });

  it('runs the retirement CLI, reconciles a retry and seeds the bound replacement without deleting history', async () => {
    await withRetirementEnabled(async () => {
      const oldConfig = { ...config, fixtureInstanceId: randomUUID() };
      const priorManifest = await buildFixtureManifest(oldConfig);
      const replacement = await buildFixtureManifest({
        ...config,
        fixtureInstanceId: randomUUID(),
      });
      const seedReceipt = await applyFixture({
        manifest: priorManifest,
        adapter,
        plan: await planFixture({ manifest: priorManifest, adapter }),
        confirmation: APPLY_CONFIRMATION,
      });
      assert.equal(seedReceipt.status, 'complete');
      const root = resolve(process.cwd());
      const directory = await mkdtemp(join(root, '.meri-retirement-cli-'));
      try {
        const configFile = join(directory, 'config.json');
        const seedFile = join(directory, 'seed.json');
        const nextFile = join(directory, 'replacement.json');
        const planFile = join(directory, 'plan.json');
        const retirementFile = join(directory, 'retirement.json');
        const verifyFile = join(directory, 'verify.json');
        await writeFile(configFile, JSON.stringify(oldConfig));
        await writeFile(seedFile, JSON.stringify(seedReceipt));
        await writeFile(nextFile, JSON.stringify(replacement));
        const base = [
          '--config',
          configFile,
          '--seed-receipt',
          seedFile,
          '--replacement-manifest',
          nextFile,
          '--adapter',
          fileURLToPath(
            new URL('../fixture-provisioning/memory-candidate-runtime.mjs', import.meta.url),
          ),
        ];
        async function run(command, output, extra = []) {
          const result = spawnSync(
            process.execPath,
            [
              fileURLToPath(new URL('../fixture-provisioning/cli.mjs', import.meta.url)),
              command,
              ...base,
              '--out',
              output,
              ...extra,
            ],
            {
              encoding: 'utf8',
              timeout: 30_000,
            },
          );
          assert.ifError(result.error);
          assert.equal(result.status, 0, result.stderr || result.stdout);
          return JSON.parse(await readFile(output, 'utf8'));
        }
        const retirementPlan = await run('retirement-plan', planFile);
        const retirement = await run('owned-retirement', retirementFile, [
          '--retirement-plan',
          planFile,
          '--confirm',
          RETIRE_CONFIRMATION,
        ]);
        assert.equal(retirement.status, 'complete');
        assert.equal(retirement.fixtureComplete, false);
        assert.equal(retirement.replacementManifestContentSha256, replacement.contentSha256);
        assert.ok(retirement.unavailable.length > 0);
        const oldIds = priorManifest.records
          .filter(
            (row) =>
              row.owner === 'memory_candidate' &&
              row.availability.status === 'available' &&
              row.expectedPresence === 'present',
          )
          .map((row) => row.physicalId);
        const oldRows = await pool.query(
          `SELECT id,status,xmin::text AS version,payload_jsonb,provenance_jsonb FROM "${schema}".memory_candidate WHERE id=ANY($1::uuid[]) ORDER BY id`,
          [oldIds],
        );
        assert.equal(oldRows.rowCount, oldIds.length);
        assert.ok(oldRows.rows.every((row) => row.status === 'withdrawn'));
        const auditCount = await pool.query(
          `SELECT count(*)::int AS count FROM "${schema}".memory_transition_audit WHERE memory_candidate_id=ANY($1::uuid[])`,
          [oldIds],
        );
        assert.equal(auditCount.rows[0].count, oldIds.length);
        const retry = await run('owned-retirement', retirementFile, [
          '--retirement-plan',
          planFile,
          '--confirm',
          RETIRE_CONFIRMATION,
        ]);
        assert.deepEqual(retry, retirement);
        const verified = await run('verify-retirement', verifyFile, [
          '--retirement-plan',
          planFile,
          '--retirement-receipt',
          retirementFile,
        ]);
        assert.equal(verified.status, 'complete');
        const replacementSeed = await applyFixture({
          manifest: replacement,
          adapter,
          plan: await planFixture({ manifest: replacement, adapter }),
          confirmation: APPLY_CONFIRMATION,
        });
        assert.equal(replacementSeed.status, 'complete');
        assert.equal((await verifyFixture({ manifest: replacement, adapter })).status, 'complete');
        const retained = await pool.query(
          `SELECT id,status,xmin::text AS version,payload_jsonb,provenance_jsonb FROM "${schema}".memory_candidate WHERE id=ANY($1::uuid[]) ORDER BY id`,
          [oldIds],
        );
        assert.deepEqual(retained.rows, oldRows.rows);
        assert.equal(
          (
            await pool.query(
              `SELECT id FROM "${schema}".memory_candidate WHERE id=ANY($1::uuid[]) AND status='pending'`,
              [oldIds],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await pool.query(
              `SELECT count(*)::int AS count FROM "${schema}".memory_transition_audit WHERE memory_candidate_id=ANY($1::uuid[])`,
              [oldIds],
            )
          ).rows[0].count,
          oldIds.length,
        );
        console.info(
          JSON.stringify({
            retirementPlan: retirementPlan.contentSha256,
            retirementReceipt: retirement.contentSha256,
            verified: verified.status,
            replacementSeed: replacementSeed.contentSha256,
            retainedCandidates: oldIds.length,
            retainedAudits: oldIds.length,
          }),
        );
      } finally {
        assert.equal(dirname(resolve(directory)), root);
        assert.ok(basename(directory).startsWith('.meri-retirement-cli-'));
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
});
