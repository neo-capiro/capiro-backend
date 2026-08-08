import { PrismaClient } from '@prisma/client';
import {
  type CanaryReport,
  type Measurement,
  buildReport,
  parseArgs,
  renderReport,
} from './diag-funding-opportunities-makegov.js';

/**
 * Funding Opportunities P49 — canary diagnostic.
 *
 * The Prisma client is doubled by a RECORDING fake, because the single most
 * important property of this script is that it is SELECT-only. Asserting on
 * the complete list of SQL it issued is the only way to prove that; a mock
 * that answered per-call would let a stray write through unnoticed.
 */

class PrismaDouble {
  readonly sql: string[] = [];
  /** Tables to pretend do not exist, to exercise the missing-table path. */
  missing = new Set<string>();

  async $queryRawUnsafe<T>(query: string): Promise<T> {
    this.sql.push(query);
    for (const t of this.missing) {
      if (query.includes(`"${t}"`)) throw new Error(`relation "${t}" does not exist`);
    }
    if (/max\(|min\(/.test(query)) {
      return [{ v: '2026-08-08T00:00:00.000Z' }] as unknown as T;
    }
    return [{ n: 7 }] as unknown as T;
  }

  async $disconnect(): Promise<void> {}
}

function pd(): { double: PrismaDouble; prisma: PrismaClient } {
  const double = new PrismaDouble();
  return { double, prisma: double as unknown as PrismaClient };
}

describe('parseArgs', () => {
  it('defaults to all tenants, text output, a 7-day window', () => {
    expect(parseArgs([])).toEqual({ tenantId: null, json: false, windowDays: 7 });
  });

  it('reads a tenant filter', () => {
    expect(parseArgs(['--tenant=abc']).tenantId).toBe('abc');
  });

  it('reads --json', () => {
    expect(parseArgs(['--json']).json).toBe(true);
  });

  it('reads a custom window', () => {
    expect(parseArgs(['--window-days=30']).windowDays).toBe(30);
  });

  it.each([
    ['a non-numeric window', '--window-days=lots'],
    ['a zero window', '--window-days=0'],
    ['a negative window', '--window-days=-3'],
  ])('falls back to 7 on %s', (_l, arg) => {
    expect(parseArgs([arg]).windowDays).toBe(7);
  });
});

describe('buildReport', () => {
  it('issues ONLY read queries — no INSERT, UPDATE, DELETE, or DDL', async () => {
    // This is the assertion that makes the script safe to hand to whoever is
    // reviewing a canary. It checks the COMPLETE list, not one method.
    const { double, prisma } = pd();
    await buildReport(prisma, parseArgs([]));

    expect(double.sql.length).toBeGreaterThan(10);
    for (const q of double.sql) {
      expect(q.trim().toUpperCase().startsWith('SELECT')).toBe(true);
      expect(q).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT)\b/i);
    }
  });

  it('never calls the provider — no HTTP, no key', async () => {
    // Structural: the module imports only dotenv and PrismaClient. A provider
    // call would need the gateway, and importing it here would be the change
    // this test exists to notice.
    //
    // COMMENTS ARE STRIPPED FIRST, and that is not incidental. The first
    // version of this test failed against its own subject, because that file's
    // header says "`TANGO_API_KEY` is deliberately not read" — prose explaining
    // the very property being asserted. The same trap is already recorded in
    // this repo: PR #815's added comment contained the word "real" and
    // false-matched `canonical-promotion-schema-v1.spec.ts`'s `\bREAL\b`
    // no-floating-point check. A source-scanning gate must read CODE.
    const raw = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'diag-funding-opportunities-makegov.ts'),
      'utf8',
    ) as string;
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    expect(code).not.toMatch(/TANGO_API_KEY/);
    expect(code).not.toMatch(/tango\.client|TangoGateway|TANGO_RESILIENT_GATEWAY/);
    // And prove the stripper actually did something, so a future regex change
    // that silently strips everything cannot make this pass vacuously.
    expect(raw).toMatch(/TANGO_API_KEY/);
    expect(code.length).toBeLessThan(raw.length);
  });

  it('covers every section P49 asks for', async () => {
    const { prisma } = pd();
    const report = await buildReport(prisma, parseArgs([]));
    const sections = new Set(report.measurements.map((m) => m.section));

    expect([...sections].some((s) => s.startsWith('Freshness'))).toBe(true);
    expect(sections.has('Counts')).toBe(true);
    expect(sections.has('Linkage')).toBe(true);
    expect(sections.has('Conflicts')).toBe(true);
    expect(sections.has('Missing enrichment')).toBe(true);
    expect([...sections].some((s) => s.startsWith('API usage'))).toBe(true);
    expect([...sections].some((s) => s.startsWith('Alert quietness'))).toBe(true);
    expect(sections.has('Event queue health')).toBe(true);
  });

  it('reports a MISSING table as null rather than aborting the whole report', async () => {
    // A table whose migration has not been applied is a real, reportable canary
    // state. Crashing would hide every other measurement behind it.
    const { double, prisma } = pd();
    double.missing.add('tango_event_alert');

    const report = await buildReport(prisma, parseArgs([]));
    const alerts = report.measurements.find((m) => m.label === 'client alerts (P48)');
    expect(alerts?.value).toBeNull();
    // …and the rest of the report still arrived.
    expect(report.measurements.length).toBeGreaterThan(10);
  });

  it('honours the window in the usage and alert queries', async () => {
    const { double, prisma } = pd();
    await buildReport(prisma, parseArgs(['--window-days=30']));
    expect(double.sql.some((q) => q.includes("interval '30 days'"))).toBe(true);
    expect(double.sql.some((q) => q.includes("interval '7 days'"))).toBe(false);
  });

  it('records the tenant scope honestly when none is given', async () => {
    const { prisma } = pd();
    const report = await buildReport(prisma, parseArgs([]));
    expect(report.tenantScope).toContain('all tenants');
    expect(report.tenantScope).toContain('not tenant-scoped');
  });
});

describe('renderReport', () => {
  const report: CanaryReport = {
    generatedAt: '2026-08-08T00:00:00.000Z',
    tenantScope: 'all tenants',
    windowDays: 7,
    measurements: [
      { section: 'Counts', label: 'notices', value: 12 },
      { section: 'Counts', label: 'alerts', value: 0 },
      { section: 'Counts', label: 'absent table', value: null },
    ] satisfies Measurement[],
  };

  it('prints a null as an em dash, NOT as zero', () => {
    // The distinction this whole program is built on: "the source stated
    // nothing" is not "the source stated zero".
    const lines = renderReport(report).join('\n');
    expect(lines).toMatch(/absent table\s+—/);
    expect(lines).toMatch(/alerts\s+0/);
  });

  it('groups by section without repeating the heading', () => {
    const lines = renderReport(report);
    expect(lines.filter((l) => l.startsWith('── Counts')).length).toBe(1);
  });

  it('states NO verdict — no PASS, no FAIL, no green banner', () => {
    // A canary that prints PASS is a canary that gets waved through.
    const text = renderReport(report).join('\n');
    expect(text).not.toMatch(/\bPASS\b|\bFAIL\b|\bOK\b|✅|❌/);
    expect(text).toContain('states no verdict');
  });

  it('points the reader at the runbook that holds the judgement', () => {
    expect(renderReport(report).join('\n')).toContain('funding-opportunities-makegov-canary.md');
  });
});
