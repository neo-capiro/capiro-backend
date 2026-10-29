import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { BizDevBriefService } from '../bizdev-brief.service.js';
import type { TenantContext } from '@capiro/shared';
import type { EvidenceItem } from '../bizdev-evidence.types.js';

// Explicit disposable database only. Never falls back to an application's DATABASE_URL.
const url = process.env.BRIEF_REFRESH_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('retained brief refresh with ordinary-role PostgreSQL transactions', () => {
  let db: PrismaClient;
  let rollbackNext = false;
  beforeAll(async () => {
    if (
      !url ||
      !/^postgresql:\/\/wave6_fixture_admin@127\.0\.0\.1:55486\/brief_refresh_[a-z0-9_]+$/.test(url)
    )
      throw Error('Only the task-owned disposable brief_refresh database is admitted.');
    db = new PrismaClient({ datasources: { db: { url } } });
    const ready = await db.$queryRawUnsafe<Array<{ exists: boolean }>>(
      "SELECT to_regclass('public.business_development_brief_refresh_proposals') IS NOT NULL AS exists",
    );
    if (ready[0].exists) return;
    // Split source migrations at statement boundaries through the database's own parser.
    const { Client } = await import('pg');
    const admin = new Client({ connectionString: url });
    await admin.connect();
    try {
      await admin.query(`
        CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
        DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='capiro_app')
          THEN CREATE ROLE capiro_app NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$;
        CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS
          $$SELECT nullif(current_setting('app.current_tenant',true),'')::uuid$$;
        CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
        CREATE TABLE tenants(id uuid PRIMARY KEY,status text NOT NULL,settings_jsonb jsonb NOT NULL);
        CREATE TABLE users(id uuid PRIMARY KEY,clerk_user_id text NOT NULL);
        CREATE TABLE tenant_memberships(tenant_id uuid NOT NULL,user_id uuid NOT NULL,status text NOT NULL,role text NOT NULL);
        CREATE TABLE business_development_prospects(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),
          display_name text NOT NULL,canonical_entity_id uuid,status text NOT NULL,linked_client_id uuid,dismissed_at timestamptz);
        GRANT SELECT ON tenants,users,tenant_memberships,business_development_prospects TO capiro_app;
        GRANT UPDATE ON tenants,users,tenant_memberships,business_development_prospects TO capiro_app;
      `);
      for (const name of [
        '20280927010000_business_development_phase4_brief',
        '20281029010000_bizdev_brief_refresh_proposals',
      ])
        await admin.query(
          readFileSync(
            join(__dirname, '../../../prisma/migrations', name, 'migration.sql'),
            'utf8',
          ),
        );
    } finally {
      await admin.end();
    }
  }, 30000);
  afterAll(async () => {
    await db?.$disconnect();
  });
  async function fixture() {
    const tenantId = randomUUID(),
      userId = randomUUID(),
      prospectId = randomUUID();
    await db.$executeRawUnsafe(
      "INSERT INTO tenants VALUES ($1::uuid,'active',$2::jsonb)",
      tenantId,
      JSON.stringify({
        clioFeatureFlags: {
          'businessDevelopment.enabled': true,
          'businessDevelopment.brief.enabled': true,
        },
      }),
    );
    await db.$executeRawUnsafe('INSERT INTO users VALUES ($1::uuid,$2)', userId, 'clerk-' + userId);
    await db.$executeRawUnsafe(
      "INSERT INTO tenant_memberships VALUES ($1::uuid,$2::uuid,'active','standard_user')",
      tenantId,
      userId,
    );
    await db.$executeRawUnsafe(
      "INSERT INTO business_development_prospects(id,tenant_id,display_name,status) VALUES ($1::uuid,$2::uuid,'Fixture','active')",
      prospectId,
      tenantId,
    );
    const ctx = { tenantId, userId, role: 'standard_user' } as TenantContext;
    const evidence: EvidenceItem[] = [
      {
        sourceFamily: 'usaspending_contract',
        recordId: 'award',
        locator: null,
        originalSourceName: 'Fixture',
        originalSourceId: 'award',
        claimType: 'government_exposure',
        relationshipStrength: 'direct',
        eventDate: '2026-01-01',
        effectiveDate: null,
        fiscalYear: 2026,
        stage: 'obligated',
        sourceUpdatedAt: null,
        fetchedAt: null,
        scopeChecked: 'fixture',
        status: 'available',
        title: 'Fixture obligation',
        detail: { amount: 100 },
      },
    ];
    const prisma = {
      withTenant: async <T>(tenant: string, run: (tx: any) => Promise<T>) =>
        db.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
            await tx.$queryRawUnsafe("SELECT set_config('app.current_tenant',$1,true)", tenant);
            const result = await run(tx);
            if (rollbackNext) {
              rollbackNext = false;
              throw Error('Injected disconnect before commit');
            }
            return result;
          },
          { timeout: 15000 },
        ),
    };
    const service = new BizDevBriefService(
      prisma as never,
      {
        prospectDossier: async () => ({
          canonicalName: 'Fixture',
          canonicalEntityId: null,
          identityBasis: 'manual',
          sections: { exposure: { evidence } },
        }),
      } as never,
    );
    const initial = await service.createInitialVersion(ctx, prospectId, {
      idempotencyKey: randomUUID(),
    });
    const request = { proposalId: randomUUID(), expectedVersionNumber: 1, keepUserEdits: true };
    const proposal = await service.prepareRefreshProposal(ctx, prospectId, request);
    return { ctx, prospectId, evidence, service, prisma, initial, proposal, request };
  }
  test('concurrent acceptance commits exactly one version with the reviewed bytes', async () => {
    const f = await fixture(),
      input = { proposalId: f.proposal.proposalId, proposalHash: f.proposal.proposalHash };
    const results = await Promise.all([
      f.service.acceptRefreshProposal(f.ctx, f.prospectId, input),
      f.service.acceptRefreshProposal(f.ctx, f.prospectId, input),
    ]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.version.id)).size).toBe(1);
    expect(results[0].version.sections).toEqual(f.proposal.proposed);
    expect(results[0].version.citations).toEqual(f.proposal.citations);
    expect(results[0].version.sourceSnapshot).toEqual(f.proposal.sourceSnapshot);
    expect(
      await db.businessDevelopmentBriefVersion.count({ where: { briefId: f.initial.brief.id } }),
    ).toBe(2);
    expect(
      (await f.service.getRefreshProposal(f.ctx, f.prospectId, f.proposal.proposalId))
        .acceptedVersion?.id,
    ).toBe(results[0].version.id);
  }, 30000);
  test('ordinary role cannot mutate retained content or see another tenant proposal', async () => {
    const a = await fixture(),
      b = await fixture();
    await expect(
      a.prisma.withTenant(a.ctx.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          'UPDATE business_development_brief_refresh_proposals SET payload=payload WHERE id=$1::uuid',
          a.proposal.proposalId,
        ),
      ),
    ).rejects.toThrow();
    const rows = await b.prisma.withTenant(b.ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe(
        'SELECT id FROM business_development_brief_refresh_proposals WHERE id=$1::uuid',
        a.proposal.proposalId,
      ),
    );
    expect(rows).toEqual([]);
    await db.$executeRawUnsafe(
      "UPDATE tenant_memberships SET status='inactive' WHERE tenant_id=$1::uuid AND user_id=$2::uuid",
      a.ctx.tenantId,
      a.ctx.userId,
    );
    await expect(
      a.service.acceptRefreshProposal(a.ctx, a.prospectId, {
        proposalId: a.proposal.proposalId,
        proposalHash: a.proposal.proposalHash,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await db.businessDevelopmentBriefVersion.count({ where: { briefId: a.initial.brief.id } }),
    ).toBe(1);
  }, 30000);
  test('transaction failure rolls back the new version and pointer together', async () => {
    const f = await fixture();
    await expect(
      f.prisma.withTenant(f.ctx.tenantId, async (tx) => {
        await tx.businessDevelopmentBriefVersion
          .create({
            data: {
              tenantId: f.ctx.tenantId,
              briefId: f.initial.brief.id,
              versionNumber: 2,
              sections: f.proposal.proposed,
              sectionsHash: 'a'.repeat(64),
              sourceSnapshot: f.proposal.sourceSnapshot,
              snapshotHash: f.proposal.snapshotHash,
              citations: f.proposal.citations,
              idempotencyKey: 'rollback',
              idempotencyOp: 'accept',
              idempotencyFingerprint: 'b'.repeat(64),
            },
          })
          .then((v: any) =>
            tx.businessDevelopmentBrief.update({
              where: { id: f.initial.brief.id },
              data: { currentVersionId: v.id },
            }),
          );
        rollbackNext = true;
      }),
    ).rejects.toThrow('Injected disconnect');
    expect(
      await db.businessDevelopmentBriefVersion.count({ where: { briefId: f.initial.brief.id } }),
    ).toBe(1);
    expect(
      (await db.businessDevelopmentBrief.findUnique({ where: { id: f.initial.brief.id } }))
        ?.currentVersionId,
    ).toBe(f.initial.version.id);
    const result = await f.service.acceptRefreshProposal(f.ctx, f.prospectId, {
      proposalId: f.proposal.proposalId,
      proposalHash: f.proposal.proposalHash,
    });
    expect(result.version.versionNumber).toBe(2);
  }, 30000);
});
