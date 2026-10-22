/** Legacy projection specs use a deterministic DB double; the separate ledger suite exercises SQL with PGlite. */
export function singleMailTestState() {
  const rows = new Map<string, any>();
  return (tx: any) => {
    tx.tenantMembership ??= { findFirst: jest.fn().mockResolvedValue({ id: 'active-member' }) };
    tx.client ??= { findFirst: jest.fn().mockImplementation(async ({ where }) => ({ id: where.id })) };
    // Unconfigured person fixtures deny association rather than inventing recipients.
    tx.clientPerson ??= { findMany: jest.fn().mockResolvedValue([]) };
    tx.integrationConnection ??= {
      findFirst: jest.fn().mockImplementation(async ({ where }) => ({ id: where.id })),
    };
    tx.$queryRawUnsafe ??= jest.fn().mockResolvedValue([{ allowed: true }]);
    tx.$queryRaw = jest.fn().mockImplementation(async (sql: any) => {
      const v = sql.values;
      if (sql.sql.includes('INSERT INTO single_mail_intents')) {
        const key = `${v[1]}:${v[2]}:${v[3]}`;
        if (rows.has(key)) return [];
        const row = {
          id: v[0],
          tenant_id: v[1],
          actor_id: v[2],
          request_key: v[3],
          request_hash: v[4],
          connection_id: v[5],
          client_id: v[6],
          state: 'pending',
          snapshot: JSON.parse(v[7]),
          receipt: null,
        };
        rows.set(key, row);
        return [{ ...row }];
      }
      const row = rows.get(`${v[0]}:${v[1]}:${v[2]}`);
      return row ? [{ ...row }] : [];
    });
    tx.$executeRaw = jest.fn().mockImplementation(async (sql: any) => {
      const v = sql.values;
      const isClaim = sql.sql.includes("SET state='sending'");
      const isReceipt = sql.sql.includes('SET receipt=');
      const [id, tenant, actor] = isClaim ? v : isReceipt ? v.slice(1) : v.slice(2);
      const row = [...rows.values()].find(
        (r) => r.id === id && r.tenant_id === tenant && r.actor_id === actor,
      );
      if (!row) return 0;
      if (isClaim && row.state === 'pending') {
        row.state = 'sending';
        return 1;
      }
      if (isReceipt && row.state === 'accepted') {
        row.receipt = JSON.parse(v[0]);
        return 1;
      }
      if (!isClaim && !isReceipt && row.state === 'sending') {
        row.state = v[0];
        return 1;
      }
      return 0;
    });
    return tx;
  };
}
