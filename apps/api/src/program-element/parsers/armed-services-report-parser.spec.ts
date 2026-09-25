import { describe, expect, jest, test } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ArmedServicesReportParserService,
  parseAmount,
  parseExtractedRows,
  parseReportText,
  reportSource,
  type ArmedServicesMarkRecord,
} from './armed-services-report-parser.service.js';

// Jest runs with cwd = apps/api; fixtures live under scripts/__fixtures__.
const fixturesDir = path.resolve(process.cwd(), 'scripts/__fixtures__');

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8'));
}

describe('parseAmount', () => {
  test('parses plain, comma, dollar, decimal, parenthesized-negative', () => {
    expect(parseAmount('150,000')).toBe(150000);
    expect(parseAmount('$80,000')).toBe(80000);
    expect(parseAmount('12.5')).toBe(12.5);
    expect(parseAmount('(500)')).toBe(-500);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount(42)).toBe(42);
  });
});

describe('reportSource', () => {
  test('builds chamber + fy tag', () => {
    expect(reportSource('HASC', 2027)).toBe('hasc_report_fy27');
    expect(reportSource('SASC', 2027)).toBe('sasc_report_fy27');
  });
});

describe('parseExtractedRows — fixture matches golden', () => {
  test('HRPT-119-NDAA-sample rows parse to the golden records', () => {
    const fixture = readJson('HRPT-119-NDAA-sample.rows.json') as {
      fy: number;
      rows: Record<string, unknown>[];
    };
    const golden = readJson('HRPT-119-NDAA-sample.golden.json') as {
      records: ArmedServicesMarkRecord[];
    };

    const parsed = parseExtractedRows(fixture.rows as never, { fy: fixture.fy });
    expect(parsed).toEqual(golden.records);
  });

  test('converts declared thousands and millions to dollars while preserving legacy dollars', () => {
    const parsed = parseExtractedRows(
      [
        {
          peCode: '0601102A',
          request: 215322,
          requestUnit: 'thousands',
          mark: 225.322,
          markUnit: 'millions',
        },
        { peCode: '0601103A', mark: 83102000 },
      ],
      { fy: 2027 },
    );

    expect(parsed[0]).toMatchObject({ request: 215322000, mark: 225322000 });
    expect(parsed[1]).toMatchObject({ request: null, mark: 83102000 });
  });

  test('fails closed for an undeclared money unit', () => {
    expect(() =>
      parseExtractedRows([{ peCode: '0601102A', mark: 225322, markUnit: 'hundreds' }] as never, {
        fy: 2027,
      }),
    ).toThrow('Unsupported committee-report money unit: hundreds');
  });
});

describe('parseReportText — extracts table rows from report text', () => {
  test('"PE 0603270A ... 150,000" table lines yield mark records', () => {
    const text = [
      'House Armed Services Committee FY2027',
      'PE Code   Request   Committee Mark   Explanation',
      '0603270A  125,000   150,000   Electronic warfare development increase',
      '0603250F  80,000    80,000    No change',
      'This narrative mentions PE 0604201A in prose and should NOT be a row.',
    ].join('\n');

    const recs = parseReportText(text, { fy: 2027 });
    expect(recs.map((r) => r.peCode).sort()).toEqual(['0603250F', '0603270A']);
    const ew = recs.find((r) => r.peCode === '0603270A')!;
    expect(ew.request).toBe(125000);
    expect(ew.mark).toBe(150000);
    expect(ew.fy).toBe(2027);
  });
});

interface CapturedYear {
  record: { peCode: string; fy: number; hascMark?: unknown; sascMark?: unknown; request?: unknown };
  source: string;
}

function makeService(opts?: { changedPeCodes?: string[] }) {
  const upserts: CapturedYear[] = [];
  const quarantines: Array<{ reason: string; source: string }> = [];
  const changed = new Set(opts?.changedPeCodes ?? []);

  const writer = {
    upsertProgramElement: jest.fn(async (record: { peCode: string }) => ({
      inserted: true,
      pe_code: record.peCode,
    })),
    upsertProgramElementYear: jest.fn(async (record: CapturedYear['record'], source: string) => {
      upserts.push({ record, source });
      return { inserted: true, changed: changed.has(record.peCode) };
    }),
    quarantine: jest.fn(async (_raw: unknown, reason: string, source: string) => {
      quarantines.push({ reason, source });
    }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test injection
  const svc = new ArmedServicesReportParserService(writer as any);
  return { svc, writer, upserts, quarantines };
}

const goldenRecords = (
  readJson('HRPT-119-NDAA-sample.golden.json') as { records: ArmedServicesMarkRecord[] }
).records;

describe('ArmedServicesReportParserService.load', () => {
  test('calls writer with the correct source + mark field, quarantines bad pe_code', async () => {
    const { svc, upserts, quarantines } = makeService();
    const result = await svc.load(goldenRecords, 'HASC', 2027);

    // 4 valid PEs upserted, 1 (BADCODE99) quarantined.
    expect(result.upserted).toBe(4);
    expect(result.quarantined).toBe(1);
    expect(quarantines[0]?.source).toBe('hasc_report_fy27');

    // Writer called with hasc_report_fy27 + hascMark set (not sascMark).
    for (const u of upserts) {
      expect(u.source).toBe('hasc_report_fy27');
      expect(u.record.hascMark).toBeDefined();
      expect(u.record.sascMark).toBeUndefined();
    }
    const ew = upserts.find((u) => u.record.peCode === '0603270A')!;
    // Artifact value 150000 (full dollars) is normalized to 0.15 ($0.15M) at the boundary.
    expect(ew.record.hascMark).toBe(0.15);
  });

  test('SASC routes to sascMark + sasc source', async () => {
    const { svc, upserts } = makeService();
    await svc.load(goldenRecords, 'SASC', 2027);
    const ew = upserts.find((u) => u.record.peCode === '0603270A')!;
    expect(ew.source).toBe('sasc_report_fy27');
    expect(ew.record.sascMark).toBe(0.15);
    expect(ew.record.hascMark).toBeUndefined();
  });

  test('reports changed count from writer deltas (drives IntelligenceChange)', async () => {
    const { svc } = makeService({ changedPeCodes: ['0603270A', '0604201A'] });
    const result = await svc.load(goldenRecords, 'HASC', 2027);
    // The writer emits IntelligenceChange internally on changed rows; we surface the count.
    expect(result.changed).toBe(2);
  });

  test('idempotent — a second load with no writer deltas reports 0 changed', async () => {
    const { svc } = makeService({ changedPeCodes: [] });
    const result = await svc.load(goldenRecords, 'HASC', 2027);
    expect(result.upserted).toBe(4);
    expect(result.changed).toBe(0);
  });
});
