import { describe, expect, it, jest } from '@jest/globals';
import { MemoryPurgeService } from './memory-purge.service.js';

/**
 * Unit test with a recording transaction mock (no live DB): verifies the
 * safety invariants of the destructive purge — dry-run deletes nothing, execute
 * issues the cross-store deletes, legal-held rows are excluded, every statement
 * is tenant-scoped, and the action is audited.
 */
type Recorded = { executed: string[]; queried: string[]; audits: Array<Record<string, unknown>> };

const receiptRelation = {
  relationKind: 'r', persistence: 'p', rowSecurityEnabled: true,
  rowSecurityForced: true, hasChildren: false, builtInType: true,
};
const receiptColumns: Array<readonly [string, string, number, boolean, boolean]> = [
  ['tenant_id', 'uuid', -1, true, false],
  ['candidate_id', 'uuid', -1, true, false],
  ['candidate_sha256', 'bpchar', 68, true, false],
  ['proposer_user_id', 'uuid', -1, true, false],
  ['review_id', 'uuid', -1, true, false],
  ['created_at', 'timestamptz', 6, true, true],
];
const canonicalReceiptShape = () => receiptColumns.map(
  ([columnName, typeName, typeModifier, notNull, hasDefault]) => ({
    ...receiptRelation, columnName, typeName, typeModifier, notNull, hasDefault,
  }),
);

function makeService(opts?: {
  held?: Array<{ id: string; slug: string }>;
  receiptCandidateColumn?: boolean;
  receiptShape?: ReturnType<typeof canonicalReceiptShape>;
  receiptReadError?: Error;
  receiptShapeError?: Error;
}): {
  svc: MemoryPurgeService;
  rec: Recorded;
} {
  const rec: Recorded = { executed: [], queried: [], audits: [] };
  const held = opts?.held ?? [];
  const tx = {
    $queryRaw: (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      rec.queried.push(sql);
      if (/SELECT 1 FROM clio_meri_memory_submissions/.test(sql)) {
        if (opts?.receiptReadError) return Promise.reject(opts.receiptReadError);
        return Promise.resolve([]);
      }
      if (/pg_catalog\.pg_attribute/.test(sql)) {
        if (opts?.receiptShapeError) return Promise.reject(opts.receiptShapeError);
        const shape = opts?.receiptShape ?? canonicalReceiptShape();
        if (opts?.receiptCandidateColumn) {
          shape.splice(5, 0, {
            ...receiptRelation, columnName: 'candidate', typeName: 'jsonb',
            typeModifier: -1, notNull: true, hasDefault: false,
          });
        }
        return Promise.resolve(shape);
      }
      if (/legal_hold = true/.test(sql)) return Promise.resolve(held);
      if (/count\(\*\)/.test(sql)) return Promise.resolve([{ n: 0n }]);
      return Promise.resolve([]);
    },
    $executeRaw: (strings: TemplateStringsArray) => {
      rec.executed.push(strings.join('?'));
      return Promise.resolve(1);
    },
    auditLog: {
      create: (a: { data: Record<string, unknown> }) => {
        rec.audits.push(a.data);
        return Promise.resolve({});
      },
    },
  };
  const prisma = {
    withSystem: (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test injection
  const svc = new MemoryPurgeService(prisma as any);
  return { svc, rec };
}

const T = '11111111-1111-1111-1111-111111111111';
const C = '22222222-2222-2222-2222-222222222222';
const actor = { userId: '33333333-3333-3333-3333-333333333333', role: 'user_admin' };

describe('MemoryPurgeService.purgeClient', () => {
  it('dry-run performs ZERO deletes and audits a dry_run action', async () => {
    const { svc, rec } = makeService();
    const result = await svc.purgeClient(T, C, actor, { dryRun: true, reason: 'offboarding' });
    expect(rec.executed).toHaveLength(0);
    expect(result.dryRun).toBe(true);
    expect(rec.audits).toHaveLength(1);
    expect(rec.audits[0]?.action).toBe('memory.purge_client.dry_run');
    expect(result.receiptPayloadDispositionHold).toBe(false);
  });

  it('defaults to dry-run when dryRun is omitted (never delete by accident)', async () => {
    const { svc, rec } = makeService();
    await svc.purgeClient(T, C, actor, { reason: 'offboarding' });
    expect(rec.executed).toHaveLength(0);
  });

  it('execute issues the cross-store deletes and audits a purge action', async () => {
    const { svc, rec } = makeService();
    const result = await svc.purgeClient(T, C, actor, { dryRun: false, reason: 'offboarding' });
    // context_embeddings, memory_edges, memory_items, clio_memory,
    // memory_candidate, client_memory_access = 6 deletes.
    expect(rec.executed).toHaveLength(6);
    expect(result.dryRun).toBe(false);
    expect(rec.audits[0]?.action).toBe('memory.purge_client');
    expect(result.receiptPayloadDispositionHold).toBe(false);
    expect(rec.queried[0]).toMatch(/SELECT 1 FROM clio_meri_memory_submissions/);
    expect(rec.queried[1]).toMatch(/pg_catalog\.pg_attribute/);
  });

  it('reports the legacy receipt hold in dry-run without deleting', async () => {
    const { svc, rec } = makeService({ receiptCandidateColumn: true });
    const result = await svc.purgeClient(T, C, actor, { reason: 'offboarding' });
    expect(result.receiptPayloadDispositionHold).toBe(true);
    expect(rec.executed).toHaveLength(0);
    expect(
      (rec.audits[0]?.before as { receiptPayloadDispositionHold: boolean })
        .receiptPayloadDispositionHold,
    ).toBe(true);
  });

  it('refuses execute before any delete when the legacy receipt column exists', async () => {
    const { svc, rec } = makeService({ receiptCandidateColumn: true });
    await expect(svc.purgeClient(T, C, actor, { dryRun: false, reason: 'offboarding' }))
      .rejects.toThrow(/verified content-free shape/);
    expect(rec.executed).toHaveLength(0);
    expect(rec.audits).toHaveLength(0);
    expect(rec.queried).toHaveLength(2);
  });

  it('keeps the nullable Stage 1 candidate column held', async () => {
    const shape = canonicalReceiptShape();
    shape.splice(5, 0, {
      ...receiptRelation, columnName: 'candidate', typeName: 'jsonb',
      typeModifier: -1, notNull: false, hasDefault: false,
    });
    const { svc, rec } = makeService({ receiptShape: shape });
    await expect(svc.purgeClient(T, C, actor, { dryRun: false, reason: 'offboarding' }))
      .rejects.toThrow(/verified content-free shape/);
    expect(rec.executed).toHaveLength(0);
  });

  it('keeps execution closed on missing or malformed receipt shape readback', async () => {
    for (const opts of [
      { receiptReadError: new Error('receipt table unavailable') },
      { receiptShapeError: new Error('catalog read unavailable') },
      { receiptShape: [] },
      { receiptShape: canonicalReceiptShape().slice(1) },
      { receiptShape: canonicalReceiptShape().map((row, i) =>
        i === 2 ? { ...row, typeModifier: '68' as never } : row) },
    ]) {
      const { svc, rec } = makeService(opts);
      await expect(svc.purgeClient(T, C, actor, { dryRun: false, reason: 'offboarding' }))
        .rejects.toThrow();
      expect(rec.executed).toHaveLength(0);
      expect(rec.audits).toHaveLength(0);
    }
  });

  const noncanonicalShapes: Array<[string, () => ReturnType<typeof canonicalReceiptShape>]> = [
    ['renamed JSONB payload', () => [
      ...canonicalReceiptShape(),
      { ...receiptRelation, columnName: 'legacy_payload', typeName: 'jsonb',
        typeModifier: -1, notNull: false, hasDefault: false },
    ]],
    ['unexpected extra column', () => [
      ...canonicalReceiptShape(),
      { ...receiptRelation, columnName: 'legacy_payload', typeName: 'text',
        typeModifier: -1, notNull: false, hasDefault: false },
    ]],
    ['payload in a known column type', () => canonicalReceiptShape().map((row) =>
      row.columnName === 'candidate_sha256' ? { ...row, typeName: 'jsonb' } : row)],
    ['RLS disabled', () => canonicalReceiptShape().map((row) =>
      ({ ...row, rowSecurityForced: false }))],
  ];
  it.each(noncanonicalShapes)('holds purge for %s despite missing candidate name', async (_label, shape) => {
    const { svc, rec } = makeService({ receiptShape: shape() });
    await expect(svc.purgeClient(T, C, actor, { dryRun: false, reason: 'offboarding' }))
      .rejects.toThrow(/verified content-free shape/);
    expect(rec.executed).toHaveLength(0);
  });

  it('deletes the client candidate payload while leaving the content-free Meri replay receipt', async () => {
    const { svc, rec } = makeService();
    await svc.purgeClient(T, C, actor, { dryRun: false, reason: 'offboarding' });
    expect(rec.executed.find((sql) => /DELETE FROM memory_candidate/.test(sql))).toMatch(/client_id = /);
    expect(rec.executed.join('\n')).not.toContain('DELETE FROM clio_meri_memory_submissions');
  });

  it('every delete is tenant-scoped (no cross-tenant reach)', async () => {
    const { svc, rec } = makeService();
    await svc.purgeClient(T, C, actor, { dryRun: false, reason: 'x' });
    for (const sql of rec.executed) {
      expect(sql).toMatch(/tenant_id = /);
    }
  });

  it('memory_items / edges deletes exclude legal_hold rows', async () => {
    const { svc, rec } = makeService();
    await svc.purgeClient(T, C, actor, { dryRun: false, reason: 'x' });
    const itemsDelete = rec.executed.find((s) => /DELETE FROM memory_items/.test(s));
    expect(itemsDelete).toMatch(/legal_hold = false/);
  });

  it('reports heldBack when legal-held items exist', async () => {
    const { svc } = makeService({ held: [{ id: 'a', slug: 'clio:x' }] });
    const result = await svc.purgeClient(T, C, actor, { dryRun: false, reason: 'x' });
    expect(result.heldBack).toBe(1);
  });
});
