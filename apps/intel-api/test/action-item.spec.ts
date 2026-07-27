/**
 * Gate J (HP-06) — every action-item write now proves TWO things before
 * touching a row: the CLIENT belongs to the tenant (assertClientInTenant,
 * pre-existing on some routes) and the ALERT belongs to that CLIENT
 * (assertAlertInClient, new in this gate). Before this gate, routes 2-5
 * (recordMemo, getMemo, addTalkingPoint, setReport) had NEITHER check —
 * ActionItemService's constructor took only Prisma. Every test in this file
 * is new; there was no action-item.service.spec.ts before Gate J.
 */
import { ActionItemService } from '../src/feed/action-item.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { TrackerWatchlistService } from '../src/tracker/tracker-watchlist.service.js';

const TENANT = 't1';
const CLIENT_A = 'client-a';
const CLIENT_B = 'client-b';
const ALERT = 'alert-1';
const USER = 'user-1';

interface ActionItemRow {
  id: string;
  tenantId: string;
  clientId: string;
  alertId: string;
  kind: string;
  text?: string | null;
  documentAttachmentId?: string | null;
  title?: string | null;
  createdBy: string;
}

/** In-memory stand-in for intel_action_item. Predicates mirror exactly what
 *  the service passes — if the service ever drops `clientId` from a
 *  where-clause (regressing a-4), a same-alertId row under another client
 *  becomes reachable again and the relevant test below will catch it. */
function makeStore() {
  const rows: ActionItemRow[] = [];
  let seq = 0;
  const matches = (r: ActionItemRow, where: Record<string, unknown>) =>
    (where.tenantId === undefined || r.tenantId === where.tenantId) &&
    (where.clientId === undefined || r.clientId === where.clientId) &&
    (where.alertId === undefined || r.alertId === where.alertId) &&
    (where.kind === undefined || r.kind === where.kind);

  const table = {
    updateMany: async ({ where, data }: any) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    },
    findFirst: async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null,
    create: async ({ data }: any) => {
      seq += 1;
      const row = { id: `ai-${seq}`, ...data } as ActionItemRow;
      rows.push(row);
      return row;
    },
    deleteMany: async ({ where }: any) => {
      const keep = rows.filter((r) => !matches(r, where));
      const removed = rows.length - keep.length;
      rows.length = 0;
      rows.push(...keep);
      return { count: removed };
    },
  };

  const prisma = {
    withTenant: async (_t: string, fn: (tx: any) => any) => fn({ intelActionItem: table }),
  } as unknown as PrismaService;

  return { rows, prisma };
}

function makeSvc(
  over: { assertClientInTenant?: jest.Mock; assertAlertInClient?: jest.Mock } = {},
) {
  const store = makeStore();
  const assertClientInTenant = over.assertClientInTenant ?? jest.fn().mockResolvedValue(undefined);
  const assertAlertInClient = over.assertAlertInClient ?? jest.fn().mockResolvedValue(undefined);
  const watchlist = { assertClientInTenant, assertAlertInClient } as unknown as TrackerWatchlistService;
  return {
    svc: new ActionItemService(store.prisma, watchlist),
    ...store,
    assertClientInTenant,
    assertAlertInClient,
  };
}

describe('ActionItemService.recordMemo — Gate J (HP-06)', () => {
  it('proves client ownership before writing', async () => {
    const assertClientInTenant = jest.fn().mockRejectedValue(new Error('404'));
    const { svc, rows } = makeSvc({ assertClientInTenant });
    await expect(svc.recordMemo(TENANT, CLIENT_A, ALERT, USER, { title: 'Memo' })).rejects.toThrow();
    expect(rows).toHaveLength(0);
  });

  it('proves the alert belongs to the client before writing (foreign alert rejected)', async () => {
    const assertAlertInClient = jest.fn().mockRejectedValue(new Error('404'));
    const { svc, rows } = makeSvc({ assertAlertInClient });
    await expect(svc.recordMemo(TENANT, CLIENT_A, ALERT, USER, { title: 'Memo' })).rejects.toThrow();
    expect(assertAlertInClient).toHaveBeenCalledWith(TENANT, CLIENT_A, ALERT);
    expect(rows).toHaveLength(0);
  });

  it('creates a memo link on first write', async () => {
    const { svc, rows } = makeSvc();
    await svc.recordMemo(TENANT, CLIENT_A, ALERT, USER, { documentAttachmentId: 'att-1', title: 'Memo' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: TENANT, clientId: CLIENT_A, alertId: ALERT, kind: 'memo' });
  });

  it('updates the existing memo link in place on a retry (idempotent)', async () => {
    const { svc, rows } = makeSvc();
    await svc.recordMemo(TENANT, CLIENT_A, ALERT, USER, { documentAttachmentId: 'att-1', title: 'Memo v1' });
    await svc.recordMemo(TENANT, CLIENT_A, ALERT, USER, { documentAttachmentId: 'att-2', title: 'Memo v2' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.documentAttachmentId).toBe('att-2');
  });

  /**
   * a-4: the predicate fix, tested independent of the ownership guard (which
   * is mocked to always succeed here so this test isolates ONLY the
   * where-clause change). Before Gate J, updateMany matched on
   * (tenantId, alertId, kind) with no clientId, so this would have updated
   * client B's row instead of creating a new one for client A.
   */
  it('does not update a same-alertId memo link belonging to a different client', async () => {
    const { svc, rows } = makeSvc();
    await svc.recordMemo(TENANT, CLIENT_B, ALERT, USER, { documentAttachmentId: 'b-att', title: 'B memo' });
    await svc.recordMemo(TENANT, CLIENT_A, ALERT, USER, { documentAttachmentId: 'a-att', title: 'A memo' });

    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.clientId === CLIENT_B)!.documentAttachmentId).toBe('b-att');
    expect(rows.find((r) => r.clientId === CLIENT_A)!.documentAttachmentId).toBe('a-att');
  });
});

describe('ActionItemService.getMemo — Gate J (HP-06/C-2)', () => {
  it('returns the memo scoped to the given client', async () => {
    const { svc } = makeSvc();
    await svc.recordMemo(TENANT, CLIENT_A, ALERT, USER, { documentAttachmentId: 'att-1', title: 'Memo' });
    const memo = await svc.getMemo(TENANT, CLIENT_A, ALERT);
    expect(memo?.documentAttachmentId).toBe('att-1');
  });

  it("does not return another client's memo for the same alertId (the discarded-clientId bug)", async () => {
    const { svc } = makeSvc();
    await svc.recordMemo(TENANT, CLIENT_B, ALERT, USER, { documentAttachmentId: 'b-att', title: 'B memo' });
    const memo = await svc.getMemo(TENANT, CLIENT_A, ALERT);
    expect(memo).toBeNull();
  });

  it('proves the alert belongs to the client before reading', async () => {
    const assertAlertInClient = jest.fn().mockRejectedValue(new Error('404'));
    const { svc } = makeSvc({ assertAlertInClient });
    await expect(svc.getMemo(TENANT, CLIENT_A, ALERT)).rejects.toThrow();
  });
});

describe('ActionItemService.addTalkingPoint — Gate J (HP-06)', () => {
  it('proves both ownership checks before creating', async () => {
    const assertClientInTenant = jest.fn().mockResolvedValue(undefined);
    const assertAlertInClient = jest.fn().mockResolvedValue(undefined);
    const { svc, rows } = makeSvc({ assertClientInTenant, assertAlertInClient });
    await svc.addTalkingPoint(TENANT, CLIENT_A, ALERT, USER, 'Lead with the jobs number.');
    expect(assertClientInTenant).toHaveBeenCalledWith(TENANT, CLIENT_A);
    expect(assertAlertInClient).toHaveBeenCalledWith(TENANT, CLIENT_A, ALERT);
    expect(rows).toHaveLength(1);
  });

  it('rejects a foreign alert and writes nothing', async () => {
    const assertAlertInClient = jest.fn().mockRejectedValue(new Error('404'));
    const { svc, rows } = makeSvc({ assertAlertInClient });
    await expect(svc.addTalkingPoint(TENANT, CLIENT_A, ALERT, USER, 'text')).rejects.toThrow();
    expect(rows).toHaveLength(0);
  });
});

describe('ActionItemService.setReport — Gate J (HP-06)', () => {
  it('proves ownership before toggling on', async () => {
    const assertAlertInClient = jest.fn().mockRejectedValue(new Error('404'));
    const { svc, rows } = makeSvc({ assertAlertInClient });
    await expect(svc.setReport(TENANT, CLIENT_A, ALERT, USER, true)).rejects.toThrow();
    expect(rows).toHaveLength(0);
  });

  it('proves ownership before toggling off', async () => {
    const assertAlertInClient = jest.fn().mockRejectedValue(new Error('404'));
    const { svc } = makeSvc({ assertAlertInClient });
    await expect(svc.setReport(TENANT, CLIENT_A, ALERT, USER, false)).rejects.toThrow();
  });

  it('toggles on then off, scoped to (tenantId, clientId, alertId)', async () => {
    const { svc, rows } = makeSvc();
    await svc.setReport(TENANT, CLIENT_A, ALERT, USER, true);
    expect(rows).toHaveLength(1);
    await svc.setReport(TENANT, CLIENT_A, ALERT, USER, false);
    expect(rows).toHaveLength(0);
  });

  it("does not delete another client's report flag for the same alertId (a-4)", async () => {
    const { svc, rows } = makeSvc();
    await svc.setReport(TENANT, CLIENT_B, ALERT, USER, true);
    await svc.setReport(TENANT, CLIENT_A, ALERT, USER, false); // A never set one — must be a no-op
    expect(rows).toHaveLength(1);
    expect(rows[0]!.clientId).toBe(CLIENT_B);
  });
});
