import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
jest.setTimeout(60_000);
import {
  BillImpactService,
  IMPACT_CLIENT_SQL,
  IMPACT_STATE_SQL,
  IMPACT_FEDERAL_SQL,
} from './bill-impact.service.js';

// Full production API + Intel migration chains, disposable native PostgreSQL only.
const describeDb =
  process.env.DATABASE_URL && process.env.CAPIRO_DISPOSABLE_PG === '1' ? describe : describe.skip;
describeDb('bill impact native PostgreSQL scope and source contracts', () => {
  const prisma = new PrismaService();
  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());
  async function isolated(
    check: (
      tx: any,
      ids: { tenant: string; other: string; user: string; client: string },
    ) => Promise<void>,
  ) {
    const ids = {
      tenant: randomUUID(),
      other: randomUUID(),
      user: randomUUID(),
      client: randomUUID(),
    };
    const rollback = new Error('intentional fixture rollback');
    try {
      await prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO tenants(id,slug,name) VALUES($1::uuid,$1::text,'Impact fixture'),($2::uuid,$2::text,'Other fixture')`,
            ids.tenant,
            ids.other,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO users(id,clerk_user_id,email,updated_at) VALUES($1::uuid,$1::text,$2,now())`,
            ids.user,
            `${ids.user}@impact.invalid`,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,updated_at) VALUES($1::uuid,$2::uuid,$3::uuid,'standard_user','active',now())`,
            randomUUID(),
            ids.tenant,
            ids.user,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO clients(id,tenant_id,name,status,description) VALUES($1::uuid,$2::uuid,'Impact client','active','Manufactures domestic composite aircraft structures for defense suppliers.')`,
            ids.client,
            ids.tenant,
          );
          await check(tx, ids);
          throw rollback;
        },
        { timeout: 30_000 },
      );
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }
  it('denies foreign tenants, inactive memberships, archived and ungranted memory-wall clients', async () => {
    await isolated(async (tx, id) => {
      const read = (tenant = id.tenant) =>
        tx.$queryRawUnsafe(IMPACT_CLIENT_SQL, tenant, id.user, id.client);
      expect(await read()).toHaveLength(1);
      expect(await read(id.other)).toHaveLength(0);
      await tx.$executeRawUnsafe(
        `UPDATE clients SET memory_wall=true WHERE id=$1::uuid`,
        id.client,
      );
      expect(await read()).toHaveLength(0);
      await tx.$executeRawUnsafe(
        `INSERT INTO client_memory_access(id,tenant_id,client_id,user_id) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid)`,
        randomUUID(),
        id.tenant,
        id.client,
        id.user,
      );
      expect(await read()).toHaveLength(1);
      await tx.$executeRawUnsafe(
        `UPDATE clients SET status='archived' WHERE id=$1::uuid`,
        id.client,
      );
      expect(await read()).toHaveLength(0);
      await tx.$executeRawUnsafe(`UPDATE clients SET status='active' WHERE id=$1::uuid`, id.client);
      await tx.$executeRawUnsafe(
        `UPDATE tenant_memberships SET status='invited' WHERE tenant_id=$1::uuid`,
        id.tenant,
      );
      expect(await read()).toHaveLength(0);
    });
  });
  it('reads complete Florida text through the actual immutable source view and rejects wrong session/bill', async () => {
    await isolated(async (tx, id) => {
      const bill = `fl-2026-hb${Date.now()}`,
        version = randomUUID();
      await tx.$executeRawUnsafe(
        `INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title,synced_at) VALUES($1,'FL','2026','2026','HB fixture','HBfixture','Impact fixture',now())`,
        bill,
      );
      const evidence = {
        documentKind: 'text',
        versionType: 'Introduced',
        url: 'https://flsenate.gov/fixture',
        coverage: 'complete_document',
        extractionState: 'extracted',
        sections: [
          {
            locator: 'Section 1',
            text: 'A program may qualify suppliers. This does not appropriate funds.',
            hash: 'fixture',
          },
        ],
      };
      await tx.$executeRawUnsafe(
        `INSERT INTO state_bill_published_record(id,bill_key,kind,source_identity,revision_hash,event_date,source_order,evidence) VALUES($1::uuid,$2,'document','fixture','revision','2026-01-01',0,$3::jsonb)`,
        version,
        bill,
        JSON.stringify(evidence),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO published_record_source_observation(source_key,state_record_id) VALUES($1,$2::uuid)`,
        `state:${bill}:document:fixture`,
        version,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO intel_feature_flag(id,tenant_id,feature,enabled) VALUES($1,$2,'bill_360',true)`,
        randomUUID(),
        id.tenant,
      );
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant',$1,true)`, id.tenant);
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      const result = await tx.$queryRawUnsafe(IMPACT_STATE_SQL, bill, '2026');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(version);
      expect(await tx.$queryRawUnsafe(IMPACT_STATE_SQL, bill, '2025')).toHaveLength(0);
      expect(await tx.$queryRawUnsafe(IMPACT_STATE_SQL, `${bill}other`, '2026')).toHaveLength(0);
      const service = new BillImpactService(
        {
          withTenant: async (_: string, fn: any) => fn(tx),
          $queryRawUnsafe: tx.$queryRawUnsafe.bind(tx),
        } as never,
        {} as never,
        {} as never,
      );
      const resultOptions = await service.options(
        { tenantId: id.tenant, userId: id.user } as never,
        bill,
        id.client,
      );
      expect(resultOptions.versions[0]?.unavailableReason).toBeNull();
      expect(resultOptions.versions[0]?.revision).toBe('revision');
    });
  });
  it('federal adapter admits only present BILLS evidence for the exact bill', async () => {
    await isolated(async (tx) => {
      const bill = `119-hr-${Date.now()}`,
        version = randomUUID(),
        key = `impact:${version}`;
      await tx.$executeRawUnsafe(
        `INSERT INTO federal_evidence_revision(id,source_key,provider,collection,package_id,bill_id,version_code,lineage_key,content_hash,extraction_hash,parser_version,source_url,raw_content,extracted_text,completeness) VALUES($1::uuid,$2,'govinfo','BILLS',$2,$3,'ih',$2,$4,$4,'fixture','https://govinfo.gov/fixture','raw','This does not appropriate funds.','complete')`,
        version,
        key,
        bill,
        'a'.repeat(64),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO federal_evidence_observation(observation_key,source_key,state,revision_id,inventory_window_end) VALUES($1,$1,'present',$2::uuid,now())`,
        key,
        version,
      );
      for (const [collection, text] of [
        ['CRPT', 'A report is not selected bill text.'],
        ['BILLS', 'x'.repeat(90_001)],
      ]) {
        const extraId = randomUUID(),
          extraKey = `impact:${extraId}`;
        await tx.$executeRawUnsafe(
          `INSERT INTO federal_evidence_revision(id,source_key,provider,collection,package_id,bill_id,version_code,lineage_key,content_hash,extraction_hash,parser_version,source_url,raw_content,extracted_text,completeness) VALUES($1::uuid,$2,'govinfo',$3,$2,$4,'ih',$2,$5,$5,'fixture','https://govinfo.gov/fixture','raw',$6,'complete')`,
          extraId,
          extraKey,
          collection,
          bill,
          'b'.repeat(64),
          text,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO federal_evidence_observation(observation_key,source_key,state,revision_id,inventory_window_end) VALUES($1,$1,'present',$2::uuid,now())`,
          extraKey,
          extraId,
        );
      }
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      const result = await tx.$queryRawUnsafe(IMPACT_FEDERAL_SQL, bill);
      expect(result).toHaveLength(2);
      expect(result.find((r: any) => r.id === version).revision).toBe('a'.repeat(64));
      expect(result.find((r: any) => r.oversized)).toMatchObject({ text: '', oversized: true });
      expect(await tx.$queryRawUnsafe(IMPACT_FEDERAL_SQL, `${bill}other`)).toHaveLength(0);
      await tx.$executeRawUnsafe(
        `INSERT INTO federal_evidence_observation(observation_key,source_key,state,inventory_window_end) VALUES($1,$2,'removed',now())`,
        `${key}:removed`,
        key,
      );
      expect(
        (await tx.$queryRawUnsafe(IMPACT_FEDERAL_SQL, bill)).some((r: any) => r.id === version),
      ).toBe(false);
    });
  });
});
