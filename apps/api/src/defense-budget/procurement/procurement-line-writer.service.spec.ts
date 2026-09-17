import { ProcurementLineWriterService } from './procurement-line-writer.service.js';
import { composeLine68, line68Artifacts } from './procurement-line-canonical-v1.fixtures.js';

const ENV = 'DEFENSE_BUDGET_PROCUREMENT_CANONICAL_WRITES';

/**
 * In-memory Prisma double covering exactly the delegates the writer may touch.
 * Deliberately has NO programElement* delegate: any attempt to reclassify a BLIN
 * as a PE would throw "Cannot read properties of undefined".
 */
function createHarness() {
  const lines = new Map<string, Record<string, any>>();
  const years = new Map<string, Record<string, any>>();
  const sources = new Map<string, Record<string, any>>();
  let nextId = 1;
  const calls: string[] = [];

  const lineKey = (w: any) => `${w.appropriationCode}::${w.lineItemNumber}`;
  const yearKey = (w: any) => `${w.lineId}::${w.fy}::${w.sublineKey}`;
  const sourceKey = (w: any) => `${w.lineId}::${w.sourceSpanHash}`;
  const byId = (map: Map<string, Record<string, any>>, id: string) =>
    [...map.values()].find((r) => r.id === id);

  const tx: any = {
    procurementLine: {
      findUnique: jest.fn(async ({ where }: any) => {
        calls.push('procurementLine.findUnique');
        return lines.get(lineKey(where.appropriationCode_lineItemNumber)) ?? null;
      }),
      create: jest.fn(async ({ data }: any) => {
        calls.push('procurementLine.create');
        const row = { id: `line-${nextId++}`, ...data };
        lines.set(lineKey(data), row);
        return { id: row.id };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        calls.push('procurementLine.update');
        const row = byId(lines, where.id)!;
        Object.assign(row, data);
        return { id: row.id };
      }),
    },
    procurementLineYear: {
      findUnique: jest.fn(async ({ where }: any) => {
        calls.push('procurementLineYear.findUnique');
        return years.get(yearKey(where.lineId_fy_sublineKey)) ?? null;
      }),
      create: jest.fn(async ({ data }: any) => {
        calls.push('procurementLineYear.create');
        const row = { id: `year-${nextId++}`, ...data };
        years.set(yearKey(data), row);
        return { id: row.id };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        calls.push('procurementLineYear.update');
        const row = byId(years, where.id)!;
        Object.assign(row, data);
        return { id: row.id };
      }),
    },
    procurementLineSource: {
      findUnique: jest.fn(async ({ where }: any) => {
        calls.push('procurementLineSource.findUnique');
        return sources.get(sourceKey(where.lineId_sourceSpanHash)) ?? null;
      }),
      create: jest.fn(async ({ data }: any) => {
        calls.push('procurementLineSource.create');
        const row = { id: `src-${nextId++}`, ...data };
        sources.set(sourceKey(data), row);
        return { id: row.id };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        calls.push('procurementLineSource.update');
        const row = byId(sources, where.id)!;
        Object.assign(row, data);
        return { id: row.id };
      }),
    },
  };
  const root: any = {
    ...tx,
    $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  const service = new ProcurementLineWriterService(root);
  return { service, root, tx, lines, years, sources, calls };
}

describe('ProcurementLineWriterService', () => {
  const originalEnv = process.env[ENV];
  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = originalEnv;
  });

  test('flag unset: returns a dry-run summary and makes NO Prisma call of any kind', async () => {
    delete process.env[ENV];
    const h = createHarness();
    const artifacts = line68Artifacts();
    const summary = await h.service.write({ artifacts, report: composeLine68(artifacts) });

    expect(summary.mode).toBe('dry_run');
    expect(summary.gateEnabled).toBe(false);
    expect(summary.decision).toBe('PASS');
    expect(summary.wouldWrite).toEqual({ lines: 1, years: 3, yearValues: 3, sources: 6 });
    expect(summary.written).toBeUndefined();
    expect(summary.skipped).toEqual([]);
    expect(summary.lineKeys).toEqual(['0300D::0204WARSYS']);
    expect(h.calls).toEqual([]);
    expect(h.root.$transaction).not.toHaveBeenCalled();
    expect(h.lines.size + h.years.size + h.sources.size).toBe(0);
  });

  test('flag set but options.dryRun: still touches nothing', async () => {
    process.env[ENV] = '1';
    const h = createHarness();
    const artifacts = line68Artifacts();
    const summary = await h.service.write({ artifacts, report: composeLine68(artifacts) }, { dryRun: true });
    expect(summary.mode).toBe('dry_run');
    expect(summary.gateEnabled).toBe(true);
    expect(h.calls).toEqual([]);
  });

  test('flag set + PASS: writes line, per-FY rows with exact $M strings, and a citation per value per exhibit', async () => {
    process.env[ENV] = '1';
    const h = createHarness();
    const artifacts = line68Artifacts();
    const now = new Date('2026-09-17T12:00:00Z');
    const summary = await h.service.write({ artifacts, report: composeLine68(artifacts) }, { now: () => now });

    expect(summary.mode).toBe('write');
    expect(summary.written).toEqual({
      lines: { inserted: 1, updated: 0 },
      years: { inserted: 3, updated: 0 },
      sources: { inserted: 6, updated: 0 },
      yearValues: 3,
    });
    expect(h.root.$transaction).toHaveBeenCalledTimes(1);

    const line = [...h.lines.values()][0]!;
    expect(line).toMatchObject({
      appropriationCode: '0300D',
      lineItemNumber: '0204WARSYS',
      title: 'Warrior Systems <$5M',
      appropriationTitle: 'Procurement, Defense-Wide',
      component: 'SOCOM',
      p1LineNumber: 68,
      relatedPeCode: '1160431BB',
    });
    expect(line.raw).toMatchObject({ identityNaturalKey: expect.stringContaining('PROCUREMENT_BLIN:SOCOM:0300D') });

    const fy27 = [...h.years.values()].find((y) => y.fy === 2027)!;
    expect(fy27.lineId).toBe(line.id);
    expect(fy27.sublineKey).toBe('');
    expect(fy27.request).toBe('511.016'); // exact decimal string, never a float
    expect(fy27.p1LineNumber).toBe(68);
    expect(fy27.lastSyncedAt).toBe(now);
    // Per-field merge: fields this run did not assert are absent, not nulled.
    expect('enacted' in fy27).toBe(false);

    const fy27Sources = [...h.sources.values()].filter((s) => s.yearId === fy27.id);
    expect(fy27Sources.map((s) => s.exhibitType).sort()).toEqual(['P-1', 'P-40']);
    const p1 = fy27Sources.find((s) => s.exhibitType === 'P-1')!;
    expect(p1).toMatchObject({
      lineId: line.id,
      docType: 'P',
      fy: 2027,
      pageNumber: 12,
      publisher: 'DoD Comptroller',
      sourceDocumentId: '11111111-1111-4111-8111-111111111111',
      extractorVersion: 'deterministic_pdfplumber:1.2.3',
      observedAt: now,
    });
    expect(p1.sourceUrl).toContain('FY2027_p1.pdf');
    expect(p1.snippet).toContain('0204WARSYS');
    expect(p1.metadata).toMatchObject({ field: 'request', valueMillions: '511.016', assertionId: 'p1_req_2027' });
  });

  test('idempotent: an identical second run inserts nothing and duplicates no source', async () => {
    process.env[ENV] = '1';
    const h = createHarness();
    const artifacts = line68Artifacts();
    const report = composeLine68(artifacts);
    await h.service.write({ artifacts, report });
    const before = { lines: h.lines.size, years: h.years.size, sources: h.sources.size };

    const second = await h.service.write({ artifacts, report });
    expect(second.written).toEqual({
      lines: { inserted: 0, updated: 1 },
      years: { inserted: 0, updated: 3 },
      sources: { inserted: 0, updated: 6 },
      yearValues: 3,
    });
    expect({ lines: h.lines.size, years: h.years.size, sources: h.sources.size }).toEqual(before);
    expect(h.tx.procurementLineSource.create).toHaveBeenCalledTimes(6);
  });

  test('re-run with a new field merges onto the existing year row without clobbering the old value', async () => {
    process.env[ENV] = '1';
    const h = createHarness();
    const artifacts = line68Artifacts();
    await h.service.write({ artifacts, report: composeLine68(artifacts) });

    // A later HAC-D mark for FY2027 arriving via another PASS family.
    const later = line68Artifacts();
    for (const list of [later.p1Artifacts, later.p40Artifacts]) {
      for (const artifact of list) {
        for (const a of artifact.assertions) {
          if (a.assertionKind === 'funding') {
            (a as any).field = 'hacDMark';
            (a as any).money = { originalValue: '500', originalUnit: 'millions', valueMillions: '500' };
          }
        }
      }
    }
    await h.service.write({ artifacts: later, report: composeLine68(later) });
    const fy27 = [...h.years.values()].find((y) => y.fy === 2027)!;
    expect(fy27.request).toBe('511.016');
    expect(fy27.hacDMark).toBe('500');
    expect(h.years.size).toBe(3);
  });

  test('family REVIEW: nothing written, every value counted as review with the family reason', async () => {
    process.env[ENV] = '1';
    const h = createHarness();
    const artifacts = line68Artifacts({ p40Fy2026: '372.991' });
    const summary = await h.service.write({ artifacts, report: composeLine68(artifacts) });

    expect(summary.mode).toBe('write');
    expect(summary.decision).toBe('REVIEW');
    expect(summary.written).toEqual({
      lines: { inserted: 0, updated: 0 },
      years: { inserted: 0, updated: 0 },
      sources: { inserted: 0, updated: 0 },
      yearValues: 0,
    });
    expect(summary.counts.review).toBe(6);
    expect(summary.skipped).toEqual([expect.objectContaining({ scope: 'family', decision: 'REVIEW' })]);
    expect(h.lines.size).toBe(0);
    expect(h.tx.procurementLine.create).not.toHaveBeenCalled();
  });

  test('family REJECT: nothing written', async () => {
    process.env[ENV] = '1';
    const h = createHarness();
    const artifacts = line68Artifacts({ omitP1: true });
    const summary = await h.service.write({ artifacts, report: composeLine68(artifacts) });
    expect(summary.decision).toBe('REJECT');
    expect(summary.counts.reject).toBe(3);
    expect(h.lines.size + h.years.size + h.sources.size).toBe(0);
  });

  test('scope=identity: REJECT-skips the mismatched line with its finding, writes the clean one', async () => {
    process.env[ENV] = '1';
    const h = createHarness();
    const artifacts = line68Artifacts({ p40Fy2026: '372.991', withLine69: true });
    const summary = await h.service.write({ artifacts, report: composeLine68(artifacts), scope: 'identity' });

    expect(summary.written?.lines).toEqual({ inserted: 1, updated: 0 });
    expect([...h.lines.values()].map((l) => l.lineItemNumber)).toEqual(['0206CMR']);
    const rejected = summary.skipped.filter((s) => s.decision === 'REJECT');
    expect(rejected).toHaveLength(6);
    expect(rejected[0]!.reason).toMatch(/p1_p40_funding_mismatch/);
  });

  test('never writes a PE and never touches a value without a citation', async () => {
    process.env[ENV] = '1';
    const h = createHarness();
    const artifacts = line68Artifacts({ withRdtePeAssertion: true, missingPageFy: 2025 });
    const report = composeLine68(artifacts);
    // Composer stays PASS here (a stray PE funding row is not a procurement finding).
    expect(report.verification.decision).toBe('VERIFICATION_PASSED');

    const summary = await h.service.write({ artifacts, report });
    expect(summary.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ assertionId: 'p40_pe_leak', decision: 'UNSUPPORTED' }),
        expect.objectContaining({ assertionId: 'p1_req_2025', decision: 'REVIEW', reason: expect.stringContaining('no page provenance') }),
      ]),
    );
    // FY2025 still lands via the P-40 citation; FY2025 has exactly ONE source (P-40).
    const fy25 = [...h.years.values()].find((y) => y.fy === 2025)!;
    expect(fy25.request).toBe('406.637');
    expect([...h.sources.values()].filter((s) => s.yearId === fy25.id).map((s) => s.exhibitType)).toEqual(['P-40']);
    // The harness has no programElement delegate; reaching one would have thrown.
    expect(h.calls.every((c) => c.startsWith('procurementLine'))).toBe(true);
  });

  test('works without a root $transaction (plain client), like the PE writer', async () => {
    process.env[ENV] = '1';
    const h = createHarness();
    delete h.root.$transaction;
    const service = new ProcurementLineWriterService(h.root);
    const artifacts = line68Artifacts();
    const summary = await service.write({ artifacts, report: composeLine68(artifacts) });
    expect(summary.written?.lines).toEqual({ inserted: 1, updated: 0 });
    expect(h.sources.size).toBe(6);
  });
});
