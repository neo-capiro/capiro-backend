import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { StrategyService } from '../src/strategy/strategy.service.js';
import { NodeService } from '../src/strategy/node.service.js';
import { VersionService } from '../src/strategy/version.service.js';
import { VersioningService } from '../src/strategy/versioning.service.js';

/**
 * DB-backed G3 node CRUD + versioning-policy + restore round-trip. Self-skips
 * without DATABASE_URL (the ci-pr condition), runs in the DB-backed path
 * (local postgres + migrate, or the deploy migrate/canary). Requires the
 * 20260723 coalescible migration applied.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const suite = hasDb ? describe : describe.skip;

const TENANT = '00000000-0000-0000-0000-0000000000e3';
const CLIENT = '00000000-0000-0000-0000-0000000000e4';
const USER = 'user_g3';

suite('G3 node CRUD + versioning + restore (integration)', () => {
  let prisma: PrismaService;
  let strategies: StrategyService;
  let nodes: NodeService;
  let versions: VersionService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    const versioning = new VersioningService();
    strategies = new StrategyService(prisma, versioning);
    nodes = new NodeService(prisma, versioning);
    versions = new VersionService(prisma, versioning);
    await prisma.withSystem(async (tx) => {
      await tx.spStrategy.deleteMany({ where: { tenantId: TENANT } });
    });
    // create() now validates clientId belongs to the tenant, so seed a client
    // row for the fake test tenant (only name + tenant_id lack DB defaults).
    await prisma.$executeRawUnsafe(
      `INSERT INTO clients (id, tenant_id, name, updated_at) VALUES ($1::uuid, $2::uuid, 'G3 int-spec client', now()) ON CONFLICT (id) DO NOTHING`,
      CLIENT,
      TENANT,
    );
  });

  afterAll(async () => {
    await prisma.withSystem(async (tx) => {
      await tx.spStrategy.deleteMany({ where: { tenantId: TENANT } });
    });
    await prisma.$executeRawUnsafe(`DELETE FROM clients WHERE id = $1::uuid`, CLIENT);
    await prisma.onModuleDestroy();
  });

  it('runs the full lifecycle with a faithful versioning policy', async () => {
    // create → version 1
    const created = await strategies.create(TENANT, USER, {
      clientId: CLIENT,
      type: 'appropriations',
      goal: 'Win the plus-up',
    });
    const sid = created.id;
    let hist = await versions.list(TENANT, sid);
    expect(hist.items).toHaveLength(1);
    expect(hist.items[0]!.note).toBe('Created strategy');

    // add node → fresh version (stands alone)
    const afterAdd = await nodes.add(TENANT, USER, sid, {
      kind: 'action',
      subject: 'deliverable',
      title: 'Submit request',
      startsOn: '2027-02-06',
    });
    expect(afterAdd.nodes).toHaveLength(1);
    const nodeId = afterAdd.nodes[0]!.id;
    hist = await versions.list(TENANT, sid);
    expect(hist.items).toHaveLength(2);

    // first field edit after an add → fresh (add is non-coalescible)
    await nodes.update(TENANT, USER, sid, nodeId, { title: 'Submit FY27 request' });
    hist = await versions.list(TENANT, sid);
    expect(hist.items).toHaveLength(3);

    // second consecutive field edit by same author → COALESCES (no new version)
    const afterEdit2 = await nodes.update(TENANT, USER, sid, nodeId, {
      status: 'in_progress',
      changeNote: 'Marked in progress',
    });
    hist = await versions.list(TENANT, sid);
    expect(hist.items).toHaveLength(3);
    expect(hist.items[0]!.note).toBe('Marked in progress');
    expect(afterEdit2.nodes[0]!.title).toBe('Submit FY27 request');
    expect(afterEdit2.nodes[0]!.status).toBe('in_progress');

    // the "Added" snapshot = 1 node with the original title/status
    const v2 = hist.items.find((v) => v.note === 'Added Submit request')!;
    expect(v2).toBeTruthy();

    // restore v2 → node reverts to original title/status, fresh restore version
    const restored = await versions.restore(TENANT, USER, sid, v2.id);
    expect(restored.nodes).toHaveLength(1);
    expect(restored.nodes[0]!.title).toBe('Submit request');
    expect(restored.nodes[0]!.status).toBe('draft');
    expect(restored.nodes[0]!.id).toBe(nodeId); // id preserved across restore
    hist = await versions.list(TENANT, sid);
    expect(hist.items).toHaveLength(4);
    expect(hist.items[0]!.note).toMatch(/^Restored version from /);
    expect(hist.items[0]!.restoredFromVersionId).toBe(v2.id);

    // delete → fresh version, node gone
    const afterDelete = await nodes.remove(TENANT, USER, sid, nodeId);
    expect(afterDelete.nodes).toHaveLength(0);
    hist = await versions.list(TENANT, sid);
    expect(hist.items).toHaveLength(5);
    expect(hist.items[0]!.note).toBe('Deleted Submit request');
  });

  it('rejects a calendar-impossible node date without writing', async () => {
    const created = await strategies.create(TENANT, USER, {
      clientId: CLIENT,
      type: 'regulatory',
    });
    await expect(
      nodes.add(TENANT, USER, created.id, {
        kind: 'milestone',
        subject: 'outcome',
        title: 'Bad date',
        startsOn: '2027-02-30',
      }),
    ).rejects.toThrow();
    const detail = await strategies.byId(TENANT, created.id);
    expect(detail.nodes).toHaveLength(0);
  });
});
