import { ReportCardService } from './report-card.service.js';
import { reportFiscalYear } from './report-card-format.js';

jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('./insight-generator.service.js', () => ({ InsightGeneratorService: class {} }));

const TENANT = '10000000-0000-4000-8000-000000000001';
const CLIENT = '20000000-0000-4000-8000-000000000002';

function harness() {
  const tx = {
    $queryRaw: jest.fn(),
    client: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: CLIENT, name: 'L3 Harris', sectorTag: 'Defense' }),
    },
    clientIntelMapping: { findFirst: jest.fn().mockResolvedValue(null) },
    meeting: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    outreachRecord: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    engagementTask: { count: jest.fn().mockResolvedValue(0) },
    meetingDebrief: { count: jest.fn().mockResolvedValue(0) },
    mailThread: { count: jest.fn().mockResolvedValue(0) },
    clientSubmissionHistory: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const prisma = {
    withTenant: jest.fn((_tenant, fn) => fn(tx)),
    tenant: { findFirst: jest.fn().mockResolvedValue({ name: 'Firm', logoS3Key: null }) },
    $queryRaw: jest.fn(),
  };
  const insight = {
    generateFreeText: jest.fn().mockResolvedValue('Verify records before drawing conclusions.'),
  };
  const service = new ReportCardService(prisma as any, insight as any);
  return { service, prisma, tx, insight };
}

describe('report-card source definitions', () => {
  it('uses the same UTC date range in the report and AI context', async () => {
    const previousZone = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    jest.useFakeTimers({ now: new Date('2026-09-08T00:00:00.000Z') });
    try {
      const { service, tx, insight } = harness();
      tx.$queryRaw.mockResolvedValueOnce([{ enabled: true }]).mockResolvedValueOnce([{ count: 0 }]);
      const data = await service.generateReportCard(CLIENT, TENANT);
      const range = 'Jun 10, 2026 – Sep 8, 2026';
      expect(data.period.label).toBe(`Trailing 90 days (${range})`);
      expect(insight.generateFreeText.mock.calls[0]![0]).toContain(`(${range})`);
    } finally {
      jest.useRealTimers();
      if (previousZone === undefined) delete process.env.TZ;
      else process.env.TZ = previousZone;
    }
  });

  it.each([true, false])(
    'reads curated membership from the active tracker when tracker_v2=%s',
    async (enabled) => {
      const { service, prisma, tx } = harness();
      tx.$queryRaw.mockResolvedValueOnce([{ enabled }]).mockResolvedValueOnce([{ count: 3 }]);
      const result = await (service as any).getTrackedBillsCount(CLIENT, TENANT);
      expect(result.count).toBe(3);
      const [sql, tenant, client] = tx.$queryRaw.mock.calls[1]!;
      expect(sql.join('?')).toContain(enabled ? 'FROM intel_tracked_bill' : 'FROM tracked_bill');
      expect([tenant, client]).toEqual([TENANT, CLIENT]);
      expect(prisma.withTenant).toHaveBeenCalledWith(TENANT, expect.any(Function));
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    },
  );

  it('reports an unavailable tracker without substituting a legacy count or zero', async () => {
    const { service, tx } = harness();
    tx.$queryRaw
      .mockResolvedValueOnce([{ enabled: true }])
      .mockRejectedValueOnce(new Error('source down'));
    expect(await (service as any).getTrackedBillsCount(CLIENT, TENANT)).toEqual({
      count: null,
      coverage: expect.stringContaining('Unavailable'),
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('binds tenant/client ids as TEXT against intel_* tables and UUID against legacy tracked_bill', async () => {
    // intel_feature_flag.tenant_id and intel_tracked_bill.tenant_id/client_id are
    // TEXT (RLS compares current_tenant_id()::text); legacy tracked_bill ids are
    // UUID. A ::uuid bind on a TEXT column is PG 42883 and wrongly marked the
    // board Unavailable on the v2 rail. The tagged-template mock joins the raw
    // strings with '?' for each bound value, so `${x}::uuid` renders as
    // "?::uuid" in the joined text.
    const { service, tx } = harness();
    const joined = () => tx.$queryRaw.mock.calls.map((c) => (c[0] as string[]).join('?'));

    // v2 rail: NO ::uuid cast anywhere (flag read + intel_tracked_bill count).
    tx.$queryRaw.mockResolvedValueOnce([{ enabled: true }]).mockResolvedValueOnce([{ count: 5 }]);
    await (service as any).getTrackedBillsCount(CLIENT, TENANT);
    const [flagSql, intelSql] = joined();
    expect(flagSql).toContain('FROM intel_feature_flag');
    expect(flagSql).not.toContain('::uuid');
    expect(intelSql).toContain('FROM intel_tracked_bill');
    expect(intelSql).not.toContain('::uuid');

    // legacy rail: both ids ARE ::uuid-cast against tracked_bill.
    tx.$queryRaw.mockClear();
    tx.$queryRaw.mockResolvedValueOnce([{ enabled: false }]).mockResolvedValueOnce([{ count: 2 }]);
    await (service as any).getTrackedBillsCount(CLIENT, TENANT);
    const [, legacySql] = joined();
    expect(legacySql).toContain('FROM tracked_bill');
    expect(legacySql).toContain('?::uuid');
  });

  it('qualifies broad issue-code overlap as organization records across the corpus', async () => {
    const { service, tx, prisma } = harness();
    tx.clientIntelMapping.findFirst.mockResolvedValue({ externalId: '42' });
    prisma.$queryRaw
      .mockResolvedValueOnce([{ issue_codes: ['DEF'] }])
      .mockResolvedValueOnce([{ count: '22215' }]);
    const result = await (service as any).getRelatedOrganizationCount(CLIENT, TENANT);
    expect(result).toEqual({
      count: 22215,
      coverage: expect.stringContaining('Not verified competitors'),
    });
    expect(result.coverage).toContain('across all available years');
    expect(prisma.$queryRaw.mock.calls[1]![0].join('?')).toContain('COUNT(DISTINCT id)');
  });

  it('preserves unknown financial coverage without confirmed mappings', async () => {
    const { service, prisma } = harness();
    const result = await (service as any).getLobbyRoi(CLIENT, TENANT);
    expect(result.lobbySpend).toBeNull();
    expect(result.contractWins).toBeNull();
    expect(result.lobbyingCoverage).toContain('no confirmed LDA');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('reports a confirmed zero as zero and describes the actual financial source window', async () => {
    const { service, tx, prisma } = harness();
    tx.clientIntelMapping.findFirst.mockImplementation(({ where }) =>
      Promise.resolve({ externalId: where.source === 'lda' ? '42' : CLIENT }),
    );
    prisma.$queryRaw
      .mockResolvedValueOnce([{ total: 0, filings: 2, first_year: 2021, last_year: 2026 }])
      .mockResolvedValueOnce([{ total: 0 }]);
    const result = await (service as any).getLobbyRoi(CLIENT, TENANT);
    expect(result.lobbySpend).toBe(0);
    expect(result.contractWins).toBe(0);
    expect(result.lobbyingCoverage).toContain('2021–2026');
    expect(result.lobbyingCoverage).toContain('amendments may overlap');
    expect(result.contractingCoverage).toContain('reporting window is not supplied');
  });

  it('bounds recorded activity and gives the LLM explicit coverage and inference constraints', async () => {
    const { service, tx, insight } = harness();
    tx.$queryRaw.mockResolvedValueOnce([{ enabled: true }]).mockResolvedValueOnce([{ count: 3 }]);
    tx.clientSubmissionHistory.findMany.mockResolvedValue([
      {
        title: 'Request',
        fiscalYear: 'FY27',
        outcomeType: 'under_review',
        capability: null,
        notes: null,
      },
    ]);
    const data = await service.generateReportCard(CLIENT, TENANT);
    expect(data.intelligence.billsTracked).toBe(3);
    expect(data.intelligence.relatedOrganizationCount).toBeNull();
    const query = tx.meeting.findMany.mock.calls[0]![0];
    expect(query.where.startsAt).toEqual({ gte: data.period.start, lte: data.period.end });
    expect(query.where.status.notIn).toContain('cancelled');
    const prompt = insight.generateFreeText.mock.calls[0]![0];
    expect(prompt).toContain('BILLS TRACKED: 3');
    expect(prompt).not.toContain('COMPETITOR COUNT');
    expect(prompt).toContain(
      'Zero recorded activity is not evidence of no engagement or diminished influence',
    );
    expect(prompt).toContain('Unavailable metrics are unknown, not zero');
    expect(prompt).toContain('Request (FY27): Under review');
    expect(prompt).not.toContain('FYFY');
    expect(prompt).toContain('COMPLETED TASK RECORDS UPDATED THIS PERIOD: 0');
    expect(prompt).not.toContain('TASKS COMPLETED:');
  });
});

describe('report fiscal years', () => {
  it.each([
    ['FY27', 'FY27'],
    ['FY2027', 'FY2027'],
    ['2027', 'FY2027'],
    ['27', 'FY27'],
    ['FYFY27', 'FY27'],
    ['', 'Fiscal year not set'],
  ])('formats %s as %s', (value, expected) => {
    expect(reportFiscalYear(value)).toBe(expected);
  });
});
