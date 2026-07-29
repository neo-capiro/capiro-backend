from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{path}: expected one anchor, found {count}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


service = 'apps/intel-api/src/tracker/tracker-board.service.ts'
replace_once(
    service,
    """interface BoardCursor {
  t: string;
  id: string;
}""",
    """interface BoardCursor {
  t: string;
  id: string;
  /** Tenant-wide board only: completes the (trackedAt,billId,clientId) key. */
  c?: string;
}""",
)
replace_once(
    service,
    """    return parsed &&
      typeof (parsed as BoardCursor).t === 'string' &&
      typeof (parsed as BoardCursor).id === 'string'
      ? (parsed as BoardCursor)
      : null;""",
    """    return parsed &&
      typeof (parsed as BoardCursor).t === 'string' &&
      typeof (parsed as BoardCursor).id === 'string' &&
      ((parsed as BoardCursor).c === undefined || typeof (parsed as BoardCursor).c === 'string')
      ? (parsed as BoardCursor)
      : null;""",
)
replace_once(
    service,
    """function encodeBoardCursor(row: { trackedAt: Date; billId: string }): string {
  return b64encode({ t: row.trackedAt.toISOString(), id: row.billId } satisfies BoardCursor);
}""",
    """function encodeBoardCursor(row: { trackedAt: Date; billId: string }): string {
  return b64encode({ t: row.trackedAt.toISOString(), id: row.billId } satisfies BoardCursor);
}
function encodeTenantBoardCursor(row: { trackedAt: Date; billId: string; clientId: string }): string {
  return b64encode({
    t: row.trackedAt.toISOString(),
    id: row.billId,
    c: row.clientId,
  } satisfies BoardCursor);
}""",
)

# Only the tenant-wide occurrence has the clientIds filter immediately above it.
replace_once(
    service,
    """    if (opts.filters?.clientIds?.length) baseWhere['clientId'] = { in: opts.filters.clientIds };
    if (opts.filters?.stages?.length) baseWhere['stage'] = { in: opts.filters.stages };
    else if (opts.filters?.activeOnly) baseWhere['stage'] = { not: 'enacted' };
    const pageWhere: Record<string, unknown> = { ...baseWhere };
    if (cur) {
      pageWhere['OR'] = [
        { trackedAt: { lt: new Date(cur.t) } },
        { trackedAt: new Date(cur.t), billId: { lt: cur.id } },
      ];
    }

    const [tracked, total] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.trackedBill.findMany({
          where: pageWhere,
          orderBy: [{ trackedAt: 'desc' }, { billId: 'desc' }],
          take: take + 1,
        }),
      ),""",
    """    if (opts.filters?.clientIds?.length) baseWhere['clientId'] = { in: opts.filters.clientIds };
    if (opts.filters?.stages?.length) baseWhere['stage'] = { in: opts.filters.stages };
    else if (opts.filters?.activeOnly) baseWhere['stage'] = { not: 'enacted' };
    const pageWhere: Record<string, unknown> = { ...baseWhere };
    if (cur) {
      // The tenant board's real row identity is (clientId,billId). Two clients
      // commonly track the same bill, and batch sync can give them the exact same
      // trackedAt. A two-column cursor skipped the remaining client at a page
      // boundary. New cursors carry `c`; old deployed cursors retain the legacy
      // two-column continuation until they naturally expire from the UI.
      pageWhere['OR'] = [
        { trackedAt: { lt: new Date(cur.t) } },
        { trackedAt: new Date(cur.t), billId: { lt: cur.id } },
        ...(cur.c
          ? [{ trackedAt: new Date(cur.t), billId: cur.id, clientId: { lt: cur.c } }]
          : []),
      ];
    }

    const [tracked, total] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.trackedBill.findMany({
          where: pageWhere,
          orderBy: [{ trackedAt: 'desc' }, { billId: 'desc' }, { clientId: 'desc' }],
          take: take + 1,
        }),
      ),""",
)
replace_once(
    service,
    """    const nextCursor =
      hasMore && last ? encodeBoardCursor({ trackedAt: last.trackedAt, billId: last.billId }) : null;
    const withheld = Math.max(0, total - page.length);
    if (!page.length) return { columns: empty(), nextCursor, hasMore, total, withheld };

    const billIds = Array.from(new Set(page.map((t) => t.billId)));""",
    """    const nextCursor =
      hasMore && last
        ? encodeTenantBoardCursor({
            trackedAt: last.trackedAt,
            billId: last.billId,
            clientId: last.clientId,
          })
        : null;
    const withheld = Math.max(0, total - page.length);
    if (!page.length) return { columns: empty(), nextCursor, hasMore, total, withheld };

    const billIds = Array.from(new Set(page.map((t) => t.billId)));""",
)

spec = 'apps/intel-api/test/tracker-board-pagination.spec.ts'
replace_once(
    spec,
    """  const or = where['OR'] as
    | [{ trackedAt: { lt: Date } }, { trackedAt: Date; billId: { lt: string } }]
    | undefined;
  if (or) {
    const passLt = row.trackedAt.getTime() < or[0].trackedAt.lt.getTime();
    const passEq =
      row.trackedAt.getTime() === or[1].trackedAt.getTime() && row.billId < or[1].billId.lt;
    if (!(passLt || passEq)) return false;
  }""",
    """  const or = where['OR'] as
    | [
        { trackedAt: { lt: Date } },
        { trackedAt: Date; billId: { lt: string } },
        { trackedAt: Date; billId: string; clientId: { lt: string } }?,
      ]
    | undefined;
  if (or) {
    const passLt = row.trackedAt.getTime() < or[0].trackedAt.lt.getTime();
    const passBill =
      row.trackedAt.getTime() === or[1].trackedAt.getTime() && row.billId < or[1].billId.lt;
    const clientTie = or[2];
    const passClient = Boolean(
      clientTie &&
        row.trackedAt.getTime() === clientTie.trackedAt.getTime() &&
        row.billId === clientTie.billId &&
        row.clientId < clientTie.clientId.lt,
    );
    if (!(passLt || passBill || passClient)) return false;
  }""",
)
replace_once(
    spec,
    """function sortRows(rows: FakeBillRow[]): FakeBillRow[] {
  return [...rows].sort(
    (a, b) => b.trackedAt.getTime() - a.trackedAt.getTime() || (a.billId < b.billId ? 1 : -1),
  );
}""",
    """function sortRows(rows: FakeBillRow[]): FakeBillRow[] {
  return [...rows].sort(
    (a, b) =>
      b.trackedAt.getTime() - a.trackedAt.getTime() ||
      (a.billId < b.billId ? 1 : a.billId > b.billId ? -1 : 0) ||
      (a.clientId < b.clientId ? 1 : a.clientId > b.clientId ? -1 : 0),
  );
}""",
)
replace_once(
    spec,
    """  it('a-8.4 (a-6 lock): query count is CONSTANT in client count — 1 client and 50 clients issue the same number of queries', async () => {""",
    """  it('a-8.3b: same bill + same timestamp across two clients is never skipped at a page boundary', async () => {
    const tied = new Date(BASE_MS);
    const common = {
      billId: 'bill-shared',
      stage: 'introduced',
      trackedAt: tied,
      note: null,
      isManual: true,
      unread: false,
      lastSeenActionText: null,
      lastSeenActionDate: null,
      lastHearingSessionId: null,
      lastHearingAt: null,
    };
    const rows: FakeBillRow[] = [
      { ...common, clientId: 'client-z' },
      { ...common, clientId: 'client-a' },
      ...makeRows(1, 'client-older', 10_000),
    ];
    const h = makeHarness(rows);
    const page1 = await h.svc.getTenantBoard(TENANT, { limit: 1 });
    const page2 = await h.svc.getTenantBoard(TENANT, { cursor: page1.nextCursor!, limit: 1 });

    const keys = [...page1.columns, ...page2.columns]
      .flatMap((c) => c.cards)
      .map((card) => `${card.clientId}:${card.billId}`);
    expect(keys).toEqual(['client-z:bill-shared', 'client-a:bill-shared']);
    expect(new Set(keys).size).toBe(2);
  });

  it('a-8.4 (a-6 lock): query count is CONSTANT in client count — 1 client and 50 clients issue the same number of queries', async () => {""",
)

print('Applied tenant-board three-column cursor fix')
