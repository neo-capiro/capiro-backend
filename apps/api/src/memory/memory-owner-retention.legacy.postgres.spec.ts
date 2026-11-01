import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** Historical-guard functions observed on those tables before 0500. */
const HISTORICAL_FUNCTIONS = [
  'check_client_ordered_owners',
  'enforce_memory_review_assignment_on_decision',
  'ensure_memory_review_request_for_candidate',
  'guard_held_memory_terminal_transition',
  'guard_immutable_memory_version_insert',
  'guard_memory_version_candidate_activation',
  'guard_noncontrolling_memory_supersession',
  'set_updated_at',
  'sync_memory_review_request_terminal_status',
];
const preMigrationHashes = new Map<string, string>();

async function seedLegacy(db: Client) {
  // Bounded compatibility prefix: the real pre-0500 guard functions and their
  // triggers exist before the forward migration, as they do on the cluster.
  await db.query(
    readFileSync(join(__dirname, '../../test/fixtures/memory-owner-historical-prefix.sql'), 'utf8'),
  );
  const observed = await db.query(
    `SELECT p.proname, md5(p.prosrc) AS hash FROM pg_proc p
     JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname = ANY($1::text[])`,
    [HISTORICAL_FUNCTIONS],
  );
  for (const row of observed.rows) preMigrationHashes.set(row.proname, row.hash);
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
    it('keeps the historical guard prefix present, unmodified and name-ordered', async () => {
      const live = await store.db.$queryRawUnsafe<{ proname: string; hash: string }[]>(
        `SELECT p.proname, md5(p.prosrc) AS hash FROM pg_proc p
         JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname = ANY($1::text[])`,
        HISTORICAL_FUNCTIONS,
      );
      expect(new Set(live.map((row) => row.proname))).toEqual(new Set(HISTORICAL_FUNCTIONS));
      for (const row of live) expect(row.hash).toBe(preMigrationHashes.get(row.proname));
      // Same-timing firing order is by trigger name. memory_items_bind_retention
      // must stay first, ahead of the pre-existing guards, as on the cluster.
      const triggers = await store.db.$queryRawUnsafe<{ tgname: string }[]>(
        `SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
         WHERE c.relname='memory_items' AND c.relnamespace='public'::regnamespace
           AND NOT t.tgisinternal ORDER BY t.tgname`,
      );
      expect(triggers.map((row) => row.tgname)).toEqual([
        'memory_items_bind_retention',
        'memory_items_controlling_supersession_guard',
        'memory_items_immutable_version_insert_guard',
        'memory_items_legal_hold_transition_guard',
        'memory_items_retention_deletion',
      ]);
    });
  },
);
