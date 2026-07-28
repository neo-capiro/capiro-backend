import { describe, expect, test } from '@jest/globals';
import {
  computeDrift,
  extractAppliedJson,
  formatReport,
  groupRepoMigrations,
  hasDrift,
  parseArgs,
  successfulNames,
  type AppliedRow,
} from './verify-migrations.js';

const ok = (name: string): AppliedRow => ({
  migration_name: name,
  finished_at: '2026-07-27T10:57:23.361Z',
  rolled_back_at: null,
});
const rolledBack = (name: string): AppliedRow => ({
  migration_name: name,
  finished_at: null,
  rolled_back_at: '2026-07-27T10:00:00.000Z',
});
const unfinished = (name: string): AppliedRow => ({
  migration_name: name,
  finished_at: null,
  rolled_back_at: null,
});

describe('parseArgs', () => {
  test('requires an explicit mode — neither flag is the default', () => {
    const o = parseArgs(['node', 'script']);
    expect(o.live).toBe(false);
    expect(o.appliedFile).toBeNull();
  });

  test('--live and --applied select the two sources', () => {
    expect(parseArgs(['node', 's', '--live']).live).toBe(true);
    expect(parseArgs(['node', 's', '--applied=dump.json']).appliedFile).toBe('dump.json');
  });

  test('defaults target the READ-ONLY diag task, never a migrate task def', () => {
    const o = parseArgs(['node', 's', '--live']);
    expect(o.taskDefinition).toBe('capiro-dev-api-diag');
    expect(o.taskDefinition).not.toMatch(/migrate/);
    expect(o.cluster).toBe('capiro-dev');
  });

  test('--service scopes to one tree', () => {
    expect(parseArgs(['node', 's', '--live', '--service=intel-api']).service).toBe('intel-api');
    // An empty value must mean "all", not a tree literally named ''.
    expect(parseArgs(['node', 's', '--live', '--service=']).service).toBeNull();
  });
});

describe('successfulNames', () => {
  test('a migration counts as applied only when it finished and was not rolled back', () => {
    const rows = [ok('a'), rolledBack('b'), unfinished('c')];
    expect([...successfulNames(rows)].sort()).toEqual(['a']);
  });

  test('the auto-resolve pattern is not drift: rolled-back rows PLUS a successful one', () => {
    // Both entrypoints mark a stuck migration rolled_back_at = NOW() and let
    // Prisma re-apply it, writing a fresh row. capiro-dev has 20 such rows
    // across 10 names. A naive "any rolled_back_at ⇒ fail" check breaks here.
    const rows = [
      rolledBack('20260525213000_kg_views'),
      rolledBack('20260525213000_kg_views'),
      rolledBack('20260525213000_kg_views'),
      rolledBack('20260525213000_kg_views'),
      rolledBack('20260525213000_kg_views'),
      ok('20260525213000_kg_views'),
    ];
    expect(successfulNames(rows).has('20260525213000_kg_views')).toBe(true);
    const repo = new Map([['api', ['20260525213000_kg_views']]]);
    expect(hasDrift(computeDrift(repo, rows))).toBe(false);
  });
});

describe('groupRepoMigrations', () => {
  test('groups by service and keeps the full directory name', () => {
    const grouped = groupRepoMigrations([
      'apps/api/prisma/migrations/20260803010000_a/migration.sql',
      'apps/intel-api/prisma/migrations/20260803020000_b/migration.sql',
      'apps/workspace/prisma/migrations/20260101000000_c/migration.sql',
    ]);
    expect([...grouped.keys()].sort()).toEqual(['api', 'intel-api', 'workspace']);
    expect(grouped.get('intel-api')).toEqual(['20260803020000_b']);
  });

  test('two directories may share a timestamp — key on the full name, never the prefix', () => {
    // apps/api really does carry both of these at 20260804010000.
    const grouped = groupRepoMigrations([
      'apps/api/prisma/migrations/20260804010000_engagement_artifact_lifecycle/migration.sql',
      'apps/api/prisma/migrations/20260804010000_engagement_attachment_supersede/migration.sql',
    ]);
    expect(grouped.get('api')).toHaveLength(2);
  });

  test('tolerates Windows separators and blank lines from git ls-files', () => {
    const grouped = groupRepoMigrations([
      'apps\\api\\prisma\\migrations\\20260803010000_a\\migration.sql',
      '',
      '  ',
    ]);
    expect(grouped.get('api')).toEqual(['20260803010000_a']);
  });
});

describe('computeDrift', () => {
  test('every repo migration present and successful ⇒ no drift', () => {
    const repo = new Map([['intel-api', ['m1', 'm2']]]);
    const reports = computeDrift(repo, [ok('m1'), ok('m2')]);
    expect(reports[0]!.missing).toEqual([]);
    expect(reports[0]!.appliedCount).toBe(2);
    expect(hasDrift(reports)).toBe(false);
  });

  test('this is the F0 case: code merged, image deployed, migration never applied', () => {
    const repo = new Map([
      ['intel-api', ['20260803010000_intel_tracked_bill_board_indexes', '20260803020000_intel_feedback_reason_matched_tags']],
    ]);
    const reports = computeDrift(repo, []);
    expect(hasDrift(reports)).toBe(true);
    expect(reports[0]!.missing.map((m) => m.reason)).toEqual(['absent', 'absent']);
  });

  test('a name whose rows are ALL rolled back is drift, and says why', () => {
    const repo = new Map([['api', ['stuck']]]);
    const reports = computeDrift(repo, [rolledBack('stuck'), rolledBack('stuck')]);
    expect(reports[0]!.missing).toEqual([{ name: 'stuck', reason: 'never-succeeded' }]);
  });

  test('an unfinished (in-flight or crashed) migration is drift too', () => {
    const repo = new Map([['api', ['halfway']]]);
    expect(computeDrift(repo, [unfinished('halfway')])[0]!.missing).toEqual([
      { name: 'halfway', reason: 'never-succeeded' },
    ]);
  });

  test('extra rows from OTHER service trees are not drift', () => {
    // All five trees share one _prisma_migrations table, so the check must be
    // one-directional. Set equality would fail every run.
    const repo = new Map([['intel-api', ['i1']]]);
    const reports = computeDrift(repo, [ok('i1'), ok('a1'), ok('a2'), ok('20260524010000_add_program_element')]);
    expect(hasDrift(reports)).toBe(false);
  });

  test('services are reported independently and deterministically', () => {
    const repo = new Map([
      ['intel-api', ['i1']],
      ['api', ['a1']],
    ]);
    const reports = computeDrift(repo, [ok('a1')]);
    expect(reports.map((r) => r.service)).toEqual(['api', 'intel-api']);
    expect(reports[0]!.missing).toEqual([]);
    expect(reports[1]!.missing).toEqual([{ name: 'i1', reason: 'absent' }]);
  });
});

describe('formatReport', () => {
  test('a clean run names the tree count and does not say DRIFT', () => {
    const out = formatReport(computeDrift(new Map([['api', ['m1']]]), [ok('m1')]));
    expect(out).toContain('OK');
    expect(out).not.toContain('DRIFT');
    expect(out).toContain('No drift');
  });

  test('a drifted run names the migration and the consequence', () => {
    const out = formatReport(computeDrift(new Map([['intel-api', ['m1']]]), []));
    expect(out).toContain('DRIFT');
    expect(out).toContain('m1');
    expect(out).toContain('never run against this database');
    expect(out).toContain('may reference columns, indexes or tables that do not exist');
  });
});

describe('extractAppliedJson', () => {
  test('pulls the delimited payload out of surrounding task-log noise', () => {
    const log = [
      'Starting Capiro API',
      'GATEV_MIGRATIONS_BEGIN',
      '[{"migration_name":"m1","finished_at":"2026-07-27T10:57:23.361Z","rolled_back_at":null}]',
      'GATEV_MIGRATIONS_END',
      'some trailing line',
    ].join('\n');
    expect(extractAppliedJson(log)).toEqual([
      { migration_name: 'm1', finished_at: '2026-07-27T10:57:23.361Z', rolled_back_at: null },
    ]);
  });

  test('tolerates a UTF-8 BOM from a Windows-captured artifact', () => {
    const log = '﻿GATEV_MIGRATIONS_BEGIN\n[{"migration_name":"m1","finished_at":"x","rolled_back_at":null}]\nGATEV_MIGRATIONS_END';
    expect(extractAppliedJson(log)).toHaveLength(1);
  });

  test('a failed task must throw, never be read as "zero migrations applied"', () => {
    // Silently returning [] would report every migration as drifted, which is
    // alarming but survivable. The real hazard is the reverse — so fail loudly.
    expect(() => extractAppliedJson('GATEV_ERR connection refused')).toThrow(/markers/);
  });
});
