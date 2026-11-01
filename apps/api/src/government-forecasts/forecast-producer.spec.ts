import {
  persistForecastSnapshot,
  recordForecastCheckFailure,
  type ForecastCandidate,
} from './forecast-producer.js';
import { createHash } from 'node:crypto';
import { contentHash } from './forecast-contract.js';
const sourceXml = '<synthetic-source />';
const sha256 = createHash('sha256').update(sourceXml).digest('hex');

const candidate = (): ForecastCandidate => ({
  sourceKey: '0000-AA00:proposed_rule',
  rin: '0000-AA00',
  title: 'Synthetic proposal',
  eventType: 'proposed_rule',
  period: { precision: 'month', raw: '11/00/2026', year: 2026, month: 11 },
  status: 'published',
  confidence: 'not_supplied',
  source: { edition: '202510', url: 'https://www.reginfo.gov/public/', issuedAt: null, sha256 },
});
const metadata = {
  sha256,
  sourceXml,
  edition: '202510',
  observedAt: new Date('2026-10-31T00:00:00Z'),
};
function port() {
  const queries: string[] = [];
  const writes: { sql: string; values: unknown[] }[] = [];
  const tx = {
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      writes.push({ sql: strings.join('?'), values });
      return 1;
    }),
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      queries.push(sql);
      if (sql.includes('RETURNING id')) return [{ id: 1n }];
      if (sql.includes('FOR UPDATE'))
        return [
          { current_revision: 0, content_hash: null, observed_at: null, status: 'published' },
        ];
      return [];
    }),
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    $executeRaw: tx.$executeRaw,
  };
  return { prisma: prisma as never, tx, queries, writes };
}
describe('forecast producer state transitions', () => {
  it('commits a first revision and observation, without event timestamp or confirmed-event write', async () => {
    const p = port();
    expect(
      await persistForecastSnapshot(
        p.prisma,
        { candidates: [candidate()], withdrawnRins: [], rejected: [] },
        metadata,
      ),
    ).toMatchObject({ accepted: 1, replay: false });
    const revision = p.writes.find((x) =>
      x.sql.includes('INSERT INTO government_forecast_revision'),
    )!;
    const saved = JSON.parse(revision.values[2] as string);
    expect(saved.period).toEqual(candidate().period);
    expect(saved.source.rin).toBe('0000-AA00');
    expect(saved).not.toHaveProperty('startsAt');
    expect(p.writes.some((x) => x.sql.includes('government_forecast_observation'))).toBe(true);
  });
  it('refuses duplicate or cross-snapshot candidates before database access', async () => {
    const p = port();
    await expect(
      persistForecastSnapshot(
        p.prisma,
        { candidates: [candidate(), candidate()], withdrawnRins: [], rejected: [] },
        metadata,
      ),
    ).rejects.toThrow('duplicate');
    await expect(
      persistForecastSnapshot(
        p.prisma,
        {
          candidates: [
            { ...candidate(), source: { ...candidate().source, sha256: 'b'.repeat(64) } },
          ],
          withdrawnRins: [],
          rejected: [],
        },
        metadata,
      ),
    ).rejects.toThrow('mismatch');
    expect((p.prisma as any).$transaction).not.toHaveBeenCalled();
  });
  it('reconciles the original successful snapshot without adding another revision or check', async () => {
    const p = port();
    p.tx.$queryRaw.mockResolvedValueOnce([
      { id: 5n, accepted_count: 2, rejected_count: 1 },
    ] as never);
    expect(
      await persistForecastSnapshot(
        p.prisma,
        { candidates: [], withdrawnRins: [], rejected: [] },
        metadata,
      ),
    ).toEqual({ checkId: '5', accepted: 2, rejected: 1, replay: true });
    expect(p.writes).toHaveLength(1); // advisory lock only
  });
  it('refuses an older edition/observation rather than reverting current history', async () => {
    const p = port();
    p.tx.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { edition: '202610', attempted_at: new Date('2026-10-31T01:00:00Z') },
      ] as never);
    await expect(
      persistForecastSnapshot(
        p.prisma,
        { candidates: [], withdrawnRins: [], rejected: [] },
        metadata,
      ),
    ).rejects.toThrow('Out-of-order');
    expect(p.writes).toHaveLength(1);
  });
  it('omission does not update or withdraw existing records', async () => {
    const p = port();
    await persistForecastSnapshot(
      p.prisma,
      { candidates: [], withdrawnRins: [], rejected: [] },
      metadata,
    );
    expect(p.writes.some((x) => x.sql.includes('UPDATE government_forecast SET'))).toBe(false);
  });
  it('failed check cannot refresh source evidence or change history', async () => {
    const p = port();
    await recordForecastCheckFailure(p.prisma, metadata.observedAt);
    expect(p.writes).toHaveLength(1);
    expect(p.writes[0].sql).toContain("'failed'");
    expect(p.writes[0].sql).not.toContain('UPDATE');
  });
  it.each(['withdrawn', 'source_completed'])(
    'holds a new projection against a %s identity',
    async (status) => {
      const p = port();
      p.tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
        const sql = strings.join('?');
        if (sql.includes('RETURNING id')) return [{ id: 1n }] as never;
        if (sql.includes('FOR UPDATE'))
          return [
            { current_revision: 3, content_hash: 'old', observed_at: metadata.observedAt, status },
          ] as never;
        return [];
      });
      const result = await persistForecastSnapshot(
        p.prisma,
        { candidates: [candidate()], withdrawnRins: [], rejected: [] },
        metadata,
      );
      expect(result).toMatchObject({ accepted: 0, rejected: 1 });
      expect(p.writes.some((x) => x.sql.includes('INSERT INTO government_forecast_revision'))).toBe(
        false,
      );
      expect(p.writes.some((x) => x.sql.includes('UPDATE government_forecast SET'))).toBe(false);
    },
  );
  it('unchanged content records an observation without inventing another revision', async () => {
    const p = port(),
      c = candidate();
    const hash = contentHash({ ...c, source: { ...c.source, rin: c.rin } });
    p.tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('RETURNING id')) return [{ id: 1n }] as never;
      if (sql.includes('FOR UPDATE'))
        return [
          {
            current_revision: 4,
            content_hash: hash,
            observed_at: metadata.observedAt,
            status: 'published',
          },
        ] as never;
      return [];
    });
    await persistForecastSnapshot(
      p.prisma,
      { candidates: [c], withdrawnRins: [], rejected: [] },
      metadata,
    );
    expect(p.writes.some((x) => x.sql.includes('INSERT INTO government_forecast_revision'))).toBe(
      false,
    );
    expect(p.writes.find((x) => x.sql.includes('government_forecast_observation'))?.values[2]).toBe(
      4,
    );
  });
  it('wrong-edition/all-rejected snapshots do not publish an authoritative empty success', async () => {
    const p = port();
    for (const snapshot of [
      { candidates: [candidate()], withdrawnRins: [], rejected: [{ reason: 'edition_mismatch' }] },
      { candidates: [], withdrawnRins: [], rejected: [{ reason: 'ambiguous' }] },
    ])
      await expect(persistForecastSnapshot(p.prisma, snapshot, metadata)).rejects.toThrow(
        'Unqualified',
      );
    expect((p.prisma as any).$transaction).not.toHaveBeenCalled();
  });
  it('first-observed terminal evidence prevents creation of a later forecast with the same identity', async () => {
    const p = port();
    p.tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('RETURNING id')) return [{ id: 1n }] as never;
      if (sql.includes('FROM government_forecast_terminal'))
        return [{ source_key: candidate().sourceKey }] as never;
      return [];
    });
    expect(
      await persistForecastSnapshot(
        p.prisma,
        { candidates: [candidate()], withdrawnRins: [], rejected: [] },
        metadata,
      ),
    ).toMatchObject({ accepted: 0, rejected: 1 });
    expect(p.writes.some((x) => x.sql.includes('INSERT INTO government_forecast(id'))).toBe(false);
  });
  it('retains first-observed completion before withdrawal even without a forecast head', async () => {
    const p = port(),
      c = candidate();
    await persistForecastSnapshot(
      p.prisma,
      {
        candidates: [],
        rejected: [],
        completedMilestones: [
          {
            sourceKey: c.sourceKey,
            rin: c.rin,
            source: c.source,
            action: 'NPRM',
            rawDate: '08/20/2026',
          },
        ],
        withdrawnRins: [
          { rin: c.rin, source: c.source, action: 'Withdrawn', rawDate: '09/01/2026' },
        ],
      },
      metadata,
    );
    const terminal = p.writes.filter((x) =>
      x.sql.includes('INSERT INTO government_forecast_terminal'),
    );
    expect(terminal).toHaveLength(3);
    expect(terminal[0].sql).toContain("'source_completed'");
    expect(terminal[1].sql).toContain("'withdrawn'");
    expect(terminal.every((x) => x.sql.includes('ON CONFLICT (source_key) DO NOTHING'))).toBe(true);
  });
});
