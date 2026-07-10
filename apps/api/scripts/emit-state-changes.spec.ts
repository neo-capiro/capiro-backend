import { severityFor, MATERIAL_BILLS_QUERY } from './emit-state-changes.js';

describe('severityFor (emit-state-changes, S5.3)', () => {
  it('rates enacted/vetoed/failed high (exactly as specced)', () => {
    for (const s of ['enacted', 'vetoed', 'failed']) {
      expect(severityFor(s)).toBe('high');
    }
  });
  it('rates mid-process advances medium', () => {
    for (const s of ['passed_chamber', 'to_governor']) {
      expect(severityFor(s)).toBe('medium');
    }
  });
  it('rates everything else info, including dead_by_deadline and veto_overridden', () => {
    expect(severityFor('dead_by_deadline')).toBe('info');
    expect(severityFor('veto_overridden')).toBe('info');
    expect(severityFor('reported')).toBe('info');
  });
});

describe('MATERIAL_BILLS_QUERY (2026-07-10 hot-fix: emit-windowing regression guard)', () => {
  // The core query runs against a live Postgres connection (no unit-test path
  // for the SQL itself), so this pins the windowing COLUMN as a static-text
  // guard against a future accidental revert to the legislative-date column.
  it('windows on status_derived_at (ingestion time), never status_at (legislative event date)', () => {
    expect(MATERIAL_BILLS_QUERY).toMatch(/WHERE\s+status_derived_at\s*>\s*\$1/i);
    expect(MATERIAL_BILLS_QUERY).not.toMatch(/WHERE\s+status_at\s*>\s*\$1/i);
  });
  it('still selects status_at for display/dedupeKey purposes', () => {
    expect(MATERIAL_BILLS_QUERY).toMatch(/status_at AS "statusAt"/);
  });
});
