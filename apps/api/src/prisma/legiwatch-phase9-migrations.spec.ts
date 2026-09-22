import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = [
  '20261123040000_legiwatch_phase9_hardening_cutover',
  '20261123041000_legiwatch_phase9_observation_disposition',
  '20261123042000_legiwatch_phase9_observation_disposition_trigger',
  '20261123043000_legiwatch_phase9_runtime_and_evidence',
  '20261123044000_legiwatch_phase9_shadow_schedules',
  '20261123045000_legiwatch_phase9_audit_scope',
  '20261123045100_legiwatch_phase9_audit_scope_trigger',
  '20261123045200_legiwatch_phase9_safe_observation_timestamp',
  '20280920070000_legiwatch_florida_runtime_jobs',
] as const;

function migration(name: (typeof MIGRATIONS)[number]): string {
  return readFileSync(join(__dirname, '../../prisma/migrations', name, 'migration.sql'), 'utf8');
}

function allSql(): string {
  return MIGRATIONS.map(migration).join('\n');
}

function code(value = allSql()): string {
  return value.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n\r]*/g, '');
}

function shellCode(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

describe('LegiWatch Phase 9 migrations and activation contract', () => {
  it('creates global operational evidence without tenant/client/watchlist fields', () => {
    const sql = code();
    for (const table of [
      'legiwatch_runtime_heartbeat',
      'legiwatch_cutover_run',
      'legiwatch_event_audit',
      'legiwatch_cutover_state',
      'legiwatch_verification_evidence',
    ]) {
      const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS "${table}"`);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = sql.indexOf('\n);', start);
      const tableBody = sql.slice(start, end);
      expect(tableBody).not.toContain('"tenant_id"');
      expect(tableBody).not.toContain('"client_id"');
      expect(tableBody).not.toContain('"watchlist');
    }
  });

  it('seeds a dark fail-closed singleton', () => {
    const sql = code();
    expect(sql).toContain("'global', 'SHADOW', false, false, true, false, 3, 168, 0");
    expect(sql).toContain("production_default = false OR phase = 'CUTOVER'");
    expect(sql).toContain("kill_switch_engaged = true OR phase = 'CUTOVER'");
    expect(sql).toContain("capture_all_public_events = false OR phase = 'CUTOVER'");
    expect(sql).toContain('LegiWatch cutover state cannot be deleted');
  });

  it('does not allow a NONE-evidence run to pass', () => {
    expect(code()).toContain("NOT (status = 'PASS' AND evidence_source = 'NONE')");
  });

  it('registers the complete required runtime matrix dark', () => {
    const sql = code(migration('20261123043000_legiwatch_phase9_runtime_and_evidence'));
    for (const key of [
      'central-discovery',
      'committee-enrichment',
      'committee-updates',
      'source-probe',
      'coverage-audit',
      'stream-preflight',
      'capture-worker',
      'archive-reconciliation',
      'intelligence-worker',
      'parallel-comparison',
      'metrics',
    ]) {
      expect(sql).toContain(`'${key}'`);
    }
    expect(sql.match(/'disabled', false, false/g)?.length).toBe(11);
  });

  it('registers Florida calendar and archive runtime jobs dark with bounded cadences', () => {
    const migrationName = '20280920070000_legiwatch_florida_runtime_jobs';
    const sql = code(migration(migrationName));
    expect(
      migrationName.localeCompare('20280920060000_florida_directory_pdf_enrichment'),
    ).toBeGreaterThan(0);
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "legiwatch_runtime_heartbeat_type_check"');
    for (const jobType of [
      'central_discovery',
      'committee_enrichment',
      'committee_updates',
      'source_probe',
      'coverage_audit',
      'stream_preflight',
      'capture_worker',
      'archive_reconciliation',
      'intelligence_worker',
      'relevance_worker',
      'parallel_comparison',
      'metrics',
      'hearing_media_worker',
      'hearing_delivery_worker',
      'notification_drain',
      'florida_calendar',
      'florida_archive',
    ]) {
      expect(sql).toContain(`'${jobType}'`);
    }
    expect(sql).toContain(
      "'florida-calendar', 'florida_calendar', 'disabled', false, false,  600, 1800",
    );
    expect(sql).toContain(
      "'florida-archive',  'florida_archive',  'disabled', false, false, 1800, 5400",
    );
    expect(sql).not.toMatch(/enabled[^\n]*true/i);
    expect(sql.trim()).toMatch(/COMMIT;\s*$/);
  });

  it('makes observation disposition explicit and auto-aligns canonical links', () => {
    const sql = code();
    expect(sql).toContain("'PENDING', 'RECONCILED', 'CONFLICT', 'IGNORED_INVALID'");
    expect(sql).toContain("NEW.reconciliation_status = 'RECONCILED'");
    expect(sql).toContain('NEW.reconciliation_reason_code');
    expect(sql).toContain("'CANONICAL_HEARING_LINKED'");
    expect(sql).toContain("reconciliation_status = 'PENDING'");
  });

  it('persists run/body/observation/event blockers without weakening scope checks', () => {
    const sql = code();
    expect(sql).toContain("audit_scope IN ('RUN', 'BODY', 'OBSERVATION', 'EVENT')");
    expect(sql).toContain("WHEN NEW.hearing_id IS NOT NULL THEN 'EVENT'");
    expect(sql).toContain("WHEN NEW.observation_id IS NOT NULL THEN 'OBSERVATION'");
    expect(sql).toContain("WHEN NEW.committee_system_code IS NOT NULL THEN 'BODY'");
    expect(sql).toContain("ELSE 'RUN'");
  });

  it('sanitizes malformed public timestamps instead of aborting the full audit', () => {
    const sql = code(migration('20261123045200_legiwatch_phase9_safe_observation_timestamp'));
    expect(sql).toContain('CREATE OR REPLACE FUNCTION legiwatch_try_timestamptz');
    expect(sql).toContain('WHEN invalid_datetime_format OR datetime_field_overflow');
    expect(sql).toContain("source_metadata #- '{event,startsAt}'");
    expect(sql).toContain('hearing_source_observation_starts_at_valid_check');
  });

  it('does not modify canonical transcript content or weaken RLS', () => {
    const sql = code();
    expect(sql).not.toMatch(/UPDATE\s+"public_hearing_transcript_segment"/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+"public_hearing_transcript_segment"/i);
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    expect(sql).not.toMatch(/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i);
  });

  it('revokes PUBLIC execute on all Phase 9 SECURITY DEFINER helpers', () => {
    const sql = code();
    for (const fn of [
      'enforce_legiwatch_cutover_transition()',
      'prevent_legiwatch_cutover_state_delete()',
      'align_hearing_observation_disposition()',
      'derive_legiwatch_event_audit_scope()',
      'sanitize_hearing_observation_timestamp()',
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`);
    }
  });

  it('keeps infrastructure registration dark and excludes cutover automation', () => {
    const script = readFileSync(
      join(__dirname, '../../../../scripts/activate-legiwatch-phase9.sh'),
      'utf8',
    );
    const executable = shellCode(script);
    expect(executable).toContain('events put-rule');
    expect(executable).toContain('--state DISABLED');
    expect(script).toContain('CONFIRM=CREATE_LEGIWATCH_PHASE9_DARK');
    expect(script).toContain('CONFIRM=ENABLE_LEGIWATCH_PHASE9_SHADOW');
    expect(executable).not.toContain('LEGIWATCH_ALLOW_PRODUCTION_CUTOVER=true');
    expect(executable).not.toMatch(/\baws\b[^\n]*\bcloudformation\b/i);
    expect(executable).not.toMatch(/enable.*capture.all/i);
  });
});
