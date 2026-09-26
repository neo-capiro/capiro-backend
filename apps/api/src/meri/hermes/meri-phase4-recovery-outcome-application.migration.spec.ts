import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(join(
  __dirname,
  '../../../prisma/migrations/20280928100000_meri_phase4_recovery_outcome_application/migration.sql',
), 'utf8');
const normalized = migration.replace(/\s+/g, ' ');

describe('dormant Phase 4 recovery-outcome application authority', () => {
  test('extends the receipt-backed record transaction instead of adding a second commit', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.meri_phase4_record_recovery_outcome(',
    );
    expect(migration).toContain('LANGUAGE plpgsql SECURITY DEFINER');
    expect(migration).toContain('SET search_path = pg_catalog, public');
    expect(migration).toContain('RETURNS TABLE (record_result varchar)');
    expect(migration).not.toMatch(/CREATE\s+(?:PROCEDURE|FUNCTION)\s+public\.meri_phase4_complete_recovery_obligation/i);
  });

  test('binds the displayed outcome to the exact persisted receipt and worker', () => {
    for (const binding of [
      'FROM public.meri_phase4_reservation_recovery_receipts',
      'FROM public.meri_phase4_dispatch_recovery_receipts',
      'r.tenant_id = v_obligation.tenant_id',
      'r.run_id = v_obligation.run_id',
      'r.operation_id = v_obligation.operation_id',
      'r.attempt_nonce = v_obligation.attempt_nonce',
      'r.action = v_obligation.action',
      'r.observation = p_outcome_detail',
      'worker_run_id',
      'worker_status',
      'hermes_run_id',
    ]) expect(migration).toContain(binding);
    expect(migration).toContain('Phase 4 exact reservation receipt is unavailable');
    expect(migration).toContain('Phase 4 exact dispatch receipt is unavailable');
    expect(migration).toContain('receipt_operation_id');
    expect(migration).toContain('receipt_attempt_nonce');
  });

  test('never treats a response digest as recovered completion content', () => {
    expect(migration).toContain('Receipt hashes are provenance, not completion content');
    expect(migration).toMatch(/(?:v_run|v_locked_run)\.output/i);
    expect(migration).not.toMatch(
      /(?:decode|convert_from)\s*\([^;]*native_response_body_sha256/i,
    );
    expect(migration).not.toMatch(
      /(?:output|usage_jsonb|error)\s*=\s*[^,;]*native_response_body_sha256/i,
    );
  });

  test('takes the run consumer lease only through the existing stale-owner fence', () => {
    for (const field of [
      'consumer_id', 'consumer_heartbeat_at', 'updated_at',
      'clock_timestamp()', "interval '60 seconds'",
    ]) expect(migration).toContain(field);
    expect(normalized).toMatch(/consumer_id IS NULL OR .*consumer_id =/i);
    expect(normalized).toMatch(/consumer_heartbeat_at IS NULL .* updated_at/i);
    expect(migration).toContain('Phase 4 recovery run consumer lease is fresh');
    expect(migration).toContain("'phase4-recovery:' || p_owner_id::text");
  });

  test('keeps durable Stop dominant over progress and completed recovery', () => {
    expect(migration).toContain('stop_requested_at IS NOT NULL');
    expect(migration).toContain("status = 'cancelling'");
    expect(migration).toContain("worker_status = 'completed'");
    expect(migration).toContain("finish_reason = 'expired'");
    expect(migration).toContain("v_status := 'cancelled'");
    expect(migration).toContain("v_status := 'expired'");
    expect(migration).toContain('Phase 4 recovered progress lost to durable cancellation');
  });

  test('keeps Stop acknowledgement nonterminal and schedules status proof', () => {
    expect(migration).toContain("p_outcome_detail IN ('run_nonterminal', 'stop_accepted')");
    expect(migration).toContain("p_outcome_kind = 'dispatch_nonterminal'");
    expect(normalized).toContain("'dispatch', 'status', v_obligation.sequence + 1");
    expect(migration).toContain('stop_accepted remains nonterminal');
    expect(migration).not.toMatch(
      /p_outcome_detail\s*=\s*'stop_accepted'[\s\S]{0,400}finished_at\s*=/i,
    );
  });

  test('leaves expiry and sealed admission absence unresolved without proof', () => {
    expect(migration).toContain('expires_at_epoch_micros');
    expect(migration).toContain("p_outcome_kind = 'reservation_sealed_absent'");
    expect(migration).toContain('sealed_absent proves admission absence only');
    expect(migration).toContain('expired recovery remains unresolved');
    expect(migration).not.toMatch(
      /reservation_sealed_absent[\s\S]{0,500}status\s*=\s*'(?:completed|cancelled|failed|interrupted|expired)'/i,
    );
  });

  test('publishes provenance, message, and final event only after one terminal winner', () => {
    for (const fragment of [
      'UPDATE public.meri_agent_runs',
      'RETURNING',
      'INSERT INTO public.clio_messages',
      'INSERT INTO public.meri_agent_run_events',
      "'run.status'",
      "'public'",
      "'final', true",
      'assistant_message_id',
      'output_seq',
      'last_seq = last_seq + 1',
      'p_receipt_operation_id',
      'p_receipt_attempt_nonce',
    ]) expect(migration).toContain(fragment);

    const terminalSection = migration.indexOf(
      '-- Stop wins over a late completed observation.',
    );
    const message = migration.indexOf('INSERT INTO public.clio_messages', terminalSection);
    const terminalClaim = migration.lastIndexOf('UPDATE public.meri_agent_runs', message);
    const event = migration.indexOf('INSERT INTO public.meri_agent_run_events', message);
    expect(terminalSection).toBeGreaterThan(0);
    expect(terminalClaim).toBeGreaterThan(0);
    expect(message).toBeGreaterThan(terminalClaim);
    expect(event).toBeGreaterThan(message);
    expect(migration).toContain('Only the terminal transition winner may publish');
  });

  test('preserves least authority, closes default ACLs, and commits last', () => {
    expect(migration).toContain(
      "current_setting('role', true) IS DISTINCT FROM 'meri_phase4_recovery_operator'",
    );
    expect(migration).toContain(
      'ALTER FUNCTION public.meri_phase4_record_recovery_outcome(',
    );
    expect(migration).toContain('OWNER TO meri_phase4_authority_owner');
    expect(migration).toContain('REVOKE ALL ON FUNCTION');
    expect(migration).toContain('FROM PUBLIC, capiro_app, meri_phase4_route_operator');
    expect(migration).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE meri_phase4_authority_owner',
    );
    expect(migration).toContain('unsafe PUBLIC routine after recovery outcome application');
    expect(migration).toContain('recovery operator retained direct table authority');
    expect(migration).toContain('Phase 4 recovery role membership survived outcome application');
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
  });
});
