import type { Client } from 'pg';
import { ownerRetentionDatabase } from './memory-owner-retention.postgres-fixture.js';

const url = process.env.MEMORY_OWNER_LEGACY_TEST_DATABASE_URL;
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenant = id(1),
  active = id(2),
  removed = id(3),
  source = id(4),
  valid = id(5),
  contradictory = id(6),
  unowned = id(7),
  departed = id(8);
async function seedLegacy(db: Client) {
  await db.query('BEGIN');
  try {
    await db.query(
      "INSERT INTO tenants(id,slug,name,status,updated_at) VALUES($1,'synthetic-legacy-owners','Synthetic legacy ownership','active',now())",
      [tenant],
    );
    for (const [user, status] of [
      [active, 'active'],
      [removed, 'removed'],
    ]) {
      await db.query(
        'INSERT INTO users(id,clerk_user_id,email,updated_at) VALUES($1,$2,$3,now())',
        [user, 'synthetic-' + user, user + '@example.invalid'],
      );
      await db.query(
        "INSERT INTO tenant_memberships(tenant_id,user_id,role,status,updated_at) VALUES($1,$2,'standard_user',$3::membership_status,now())",
        [tenant, user, status],
      );
    }
    await db.query(
      "INSERT INTO clio_memory(id,tenant_id,owner_user_id,scope,key,value,updated_at) VALUES($1,$2,$3,'user_private','synthetic-key','Synthetic legacy content',now())",
      [source, tenant, active],
    );
    for (const row of [
      { id: valid, owner: active, visibility: 'user', slug: 'synthetic-valid' },
      { id: contradictory, owner: null, visibility: 'tenant', slug: 'clio:' + source },
      { id: unowned, owner: null, visibility: 'user', slug: 'synthetic-unowned' },
      { id: departed, owner: removed, visibility: 'user', slug: 'synthetic-departed' },
    ])
      await db.query(
        `INSERT INTO memory_items(id,tenant_id,owner_user_id,visibility,type,slug,title,source,updated_at)
      VALUES($1,$2,$3,$4,'note',$5,'Synthetic legacy item','manual',now())`,
        [row.id, tenant, row.owner, row.visibility, row.slug],
      );
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
(url ? describe : describe.skip)(
  'legacy ownership attribution during the real forward migration',
  () => {
    let store: Awaited<ReturnType<typeof ownerRetentionDatabase>>;
    beforeAll(async () => {
      store = await ownerRetentionDatabase(url!, seedLegacy);
    }, 60000);
    afterAll(async () => {
      await store?.db.$disconnect();
    });
    it('attributes explicit active ownership and restricts missing, inactive and contradictory sources', async () => {
      const rows = await store.db.memoryItem.findMany({
        where: { tenantId: tenant },
        select: { id: true, retentionSubjectId: true },
      });
      expect(rows.find((row) => row.id === valid)?.retentionSubjectId).toBeTruthy();
      for (const rowId of [contradictory, unowned, departed])
        expect(rows.find((row) => row.id === rowId)?.retentionSubjectId).toBeNull();
      expect(
        await store.scoped(tenant, (tx) =>
          tx.memoryItem.findMany({ where: { tenantId: tenant }, select: { id: true } }),
        ),
      ).toEqual([{ id: valid }]);
    });
    it('does not silently assign a fresh owner when a restricted legacy record is edited', async () => {
      await expect(
        store.scoped(null, (tx) =>
          tx.memoryItem.update({
            where: { id: unowned },
            data: { ownerUserId: active, title: 'Attempted reassignment' },
          }),
        ),
      ).rejects.toThrow('memory_ownership_restricted');
      expect(
        (await store.db.memoryItem.findUniqueOrThrow({ where: { id: unowned } }))
          .retentionSubjectId,
      ).toBeNull();
    });
  },
);
