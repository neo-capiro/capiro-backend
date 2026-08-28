import { PrismaClient } from '@prisma/client';
import {
  type IngestionReport,
  type Measurement,
  buildReport,
  renderReport,
} from './diag-tango-dibbs-sbir-ingestion.js';

/**
 * DIBBS/SBIR ingestion diagnostic. Same recording-double discipline as
 * `diag-funding-opportunities-makegov.spec.ts` — the property that matters is
 * SELECT-only, so the test asserts the complete SQL list, not one call.
 */

class PrismaDouble {
  readonly sql: string[] = [];
  missing = new Set<string>();

  async $queryRawUnsafe<T>(query: string): Promise<T> {
    this.sql.push(query);
    for (const t of this.missing) {
      if (query.includes(`"${t}"`)) throw new Error(`relation "${t}" does not exist`);
    }
    if (/max\(|min\(/.test(query)) {
      return [{ v: '2026-08-19T00:00:00.000Z' }] as unknown as T;
    }
    return [{ n: 11237 }] as unknown as T;
  }

  async $disconnect(): Promise<void> {}
}

function pd(): { double: PrismaDouble; prisma: PrismaClient } {
  const double = new PrismaDouble();
  return { double, prisma: double as unknown as PrismaClient };
}

describe('buildReport', () => {
  it('issues ONLY read queries — no INSERT, UPDATE, DELETE, or DDL', async () => {
    const { double, prisma } = pd();
    await buildReport(prisma);

    expect(double.sql.length).toBeGreaterThan(5);
    for (const q of double.sql) {
      expect(q.trim().toUpperCase().startsWith('SELECT')).toBe(true);
      expect(q).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT)\b/i);
    }
  });

  it('never calls the provider — no HTTP, no key', async () => {
    // Structural: this script imports only dotenv and PrismaClient. A
    // provider call would need the gateway, and importing it here would be
    // the change this test exists to notice.
    const raw = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'diag-tango-dibbs-sbir-ingestion.ts'),
      'utf8',
    ) as string;

    expect(raw).not.toMatch(/TANGO_API_KEY/);
    expect(raw).not.toMatch(/tango\.client|TangoGateway|TANGO_RESILIENT_GATEWAY/);
    expect(raw).toMatch(/^import \{ config as dotenvConfig \} from 'dotenv';$/m);
    expect(raw).toMatch(/^import \{ PrismaClient \} from '@prisma\/client';$/m);
  });

  it('counts DIBBS RFQ and RFP separately by document_type, never combined', async () => {
    const { double, prisma } = pd();
    await buildReport(prisma);
    expect(double.sql.some((q) => q.includes(`"document_type" = 'rfq'`))).toBe(true);
    expect(double.sql.some((q) => q.includes(`"document_type" = 'rfp'`))).toBe(true);
  });

  it('covers DIBBS counts, DIBBS freshness, SBIR counts, and SBIR freshness', async () => {
    const { prisma } = pd();
    const report = await buildReport(prisma);
    const sections = new Set(report.measurements.map((m) => m.section));
    expect([...sections].some((s) => s.startsWith('DIBBS') && s.includes('row counts'))).toBe(
      true,
    );
    expect([...sections].some((s) => s.startsWith('DIBBS') && s.includes('freshness'))).toBe(
      true,
    );
    expect([...sections].some((s) => s.startsWith('SBIR') && s.includes('row counts'))).toBe(
      true,
    );
    expect([...sections].some((s) => s.startsWith('SBIR') && s.includes('freshness'))).toBe(true);
  });

  it('asserts the checkpoint table holds nothing for these two sources, and says why', async () => {
    const { prisma } = pd();
    const report = await buildReport(prisma);
    const row = report.measurements.find((m) => m.section === 'Checkpoint table (informational)');
    expect(row?.note).toMatch(/neither sync can store one/i);
  });

  it('reports a MISSING table as a FAILURE, never as a silent zero', async () => {
    const { double, prisma } = pd();
    double.missing.add('tango_sbir_topic');

    const report = await buildReport(prisma);
    const row = report.measurements.find((m) => m.label === 'Topics');
    expect(row?.value).toMatchObject({ failed: expect.stringContaining('does not exist') });
    expect(row?.value).not.toBeNull();
  });
});

describe('renderReport', () => {
  const report: IngestionReport = {
    generatedAt: '2026-08-19T00:00:00.000Z',
    measurements: [
      { section: 'DIBBS (P40) — row counts', label: 'RFQ solicitations', value: 11237 },
      { section: 'DIBBS (P40) — row counts', label: 'RFP solicitations', value: 0 },
      { section: 'SBIR/STTR (P42) — row counts', label: 'Topics', value: null },
      {
        section: 'SBIR/STTR (P42) — row counts',
        label: 'Solicitation cycles',
        value: { failed: 'relation does not exist' },
      },
    ] satisfies Measurement[],
  };

  it('prints a FAILED query distinctly from an absent value', () => {
    const text = renderReport(report).join('\n');
    expect(text).toMatch(/Solicitation cycles\s+QUERY FAILED/);
    expect(text).toContain('relation does not exist');
  });

  it('prints a null as an em dash, NOT as zero', () => {
    const lines = renderReport(report).join('\n');
    expect(lines).toMatch(/Topics\s+—/);
    expect(lines).toMatch(/RFP solicitations\s+0/);
  });

  it('warns the reader it cannot know the true catalog size', () => {
    const text = renderReport(report).join('\n');
    expect(text).toContain('has no way to know the true size');
  });
});
