import { describe, expect, jest, test } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ConferenceReportParserService,
  conferenceReportSource,
  parseExtractedRows,
  parseReportText,
  type ConferenceMarkRecord,
} from './conference-report-parser.service.js';

// Jest runs with cwd = apps/api; fixtures live under scripts/__fixtures__.
const fixturesDir = path.resolve(process.cwd(), 'scripts/__fixtures__');

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8'));
}

describe('conferenceReportSource', () => {
  test('builds conference / public_law + fy tag', () => {
    expect(conferenceReportSource('conference', 2027)).toBe('conference_report_fy27');
    expect(conferenceReportSource('public_law', 2027)).toBe('public_law_fy27');
  });
});

describe('parseExtractedRows — fixture matches golden', () => {
  test('HRPT-119-NDAA-CONFERENCE-sample rows parse to the golden records', () => {
    const fixture = readJson('HRPT-119-NDAA-CONFERENCE-sample.rows.json') as {
      fy: number;
      rows: Record<string, unknown>[];
    };
    const golden = readJson('HRPT-119-NDAA-CONFERENCE-sample.golden.json') as {
      records: ConferenceMarkRecord[];
    };

    const parsed = parseExtractedRows(fixture.rows as never, { fy: fixture.fy });
    expect(parsed).toEqual(golden.records);
  });
});

describe('parseReportText — extracts conference table rows', () => {
  test('PE rows with request + authorized mark parse; prose ignored', () => {
    const text = [
      'NDAA FY2027 Conference Report — Joint Explanatory Statement',
      'PE Code   Request   Conference Authorized',
      '0603270A  125,000   145,000   Conference agreement increase',
      '0101221N  50,000    58,000    Conference plus-up',
      'The conferees note PE 0604201A in narrative; not a table row.',
    ].join('\n');

    const recs = parseReportText(text, { fy: 2027 });
    expect(recs.map((r) => r.peCode).sort()).toEqual(['0101221N', '0603270A']);
    expect(recs.find((r) => r.peCode === '0603270A')!.mark).toBe(145000);
  });
});

interface CapturedYear {
  record: {
    peCode: string;
    fy: number;
    conference?: unknown;
    ndaaConference?: unknown;
    enacted?: unknown;
    request?: unknown;
  };
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
  const svc = new ConferenceReportParserService(writer as any);
  return { svc, writer, upserts, quarantines };
}

const goldenRecords = (
  readJson('HRPT-119-NDAA-CONFERENCE-sample.golden.json') as { records: ConferenceMarkRecord[] }
).records;

describe('ConferenceReportParserService.load', () => {
  test('conference stage → ndaaConference field + conference_report source, quarantines bad pe_code', async () => {
    const { svc, upserts, quarantines } = makeService();
    const result = await svc.load(goldenRecords, 'conference', 2027);

    expect(result.upserted).toBe(4);
    expect(result.quarantined).toBe(1);
    expect(quarantines[0]?.source).toBe('conference_report_fy27');

    for (const u of upserts) {
      expect(u.source).toBe('conference_report_fy27');
      // The NDAA conference report writes the authorization-track ndaaConference field,
      // NOT the appropriations `conference` field (which stays reserved/unpopulated).
      expect(u.record.ndaaConference).toBeDefined();
      expect(u.record.conference).toBeUndefined();
      expect(u.record.enacted).toBeUndefined();
    }
    // Artifact value 145000 (full dollars) is normalized to 0.145 ($0.145M) at the boundary.
    expect(upserts.find((u) => u.record.peCode === '0603270A')!.record.ndaaConference).toBe(0.145);
  });

  test('public_law stage → enacted field + public_law source', async () => {
    const { svc, upserts } = makeService();
    await svc.load(goldenRecords, 'public_law', 2027);
    const ew = upserts.find((u) => u.record.peCode === '0603270A')!;
    expect(ew.source).toBe('public_law_fy27');
    expect(ew.record.enacted).toBe(0.145);
    expect(ew.record.conference).toBeUndefined();
  });

  test('reports changed count from writer deltas (drives IntelligenceChange)', async () => {
    const { svc } = makeService({ changedPeCodes: ['0603270A'] });
    const result = await svc.load(goldenRecords, 'conference', 2027);
    expect(result.changed).toBe(1);
  });

  test('idempotent — second load with no writer deltas reports 0 changed', async () => {
    const { svc } = makeService({ changedPeCodes: [] });
    const result = await svc.load(goldenRecords, 'public_law', 2027);
    expect(result.upserted).toBe(4);
    expect(result.changed).toBe(0);
  });
});
