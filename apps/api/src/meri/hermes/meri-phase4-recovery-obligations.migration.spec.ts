import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(join(
  __dirname,
  '../../../prisma/migrations/20280928090000_meri_phase4_recovery_obligations/migration.sql',
), 'utf8');
const repository = readFileSync(join(
  __dirname, 'meri-hermes-phase4-recovery-obligation.repository.ts',
), 'utf8');
const claimRoutine = migration.slice(
  migration.indexOf('CREATE FUNCTION public.meri_phase4_claim_recovery_obligations('),
  migration.indexOf('CREATE FUNCTION public.meri_phase4_record_recovery_outcome('),
);

describe('dormant Phase 4 recovery-obligation database authority', () => {
  test('matches the fixed repository routine contract', () => {
    expect(repository).toContain('public.meri_phase4_claim_recovery_obligations(');
    expect(repository).toContain('public.meri_phase4_record_recovery_outcome(');
    expect(migration).toContain(
      'CREATE FUNCTION public.meri_phase4_claim_recovery_obligations(',
    );
    expect(migration).toContain(
      'CREATE FUNCTION public.meri_phase4_record_recovery_outcome(',
    );
    for (const field of [
      'obligation_id uuid', 'tenant_id uuid', 'run_id uuid',
      'obligation_kind varchar', 'action varchar', 'operation_id uuid',
      'attempt_nonce varchar', 'claim_token uuid', 'native_body_bytes bytea',
    ]) expect(migration).toContain(field);
    expect(migration).toContain('RETURNS TABLE (record_result varchar)');
  });

  test('creates an unusable least-authority caller role and no membership edge', () => {
    expect(migration).toContain(
      'CREATE ROLE meri_phase4_recovery_operator NOLOGIN NOSUPERUSER NOCREATEDB',
    );
    expect(migration).toContain('NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS');
    expect(migration).toContain(
      "current_setting('role', true) IS DISTINCT FROM 'meri_phase4_recovery_operator'",
    );
    expect(migration).toContain(
      'FROM PUBLIC, capiro_app, meri_phase4_route_operator, meri_phase4_recovery_operator;',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION\n  public.meri_phase4_claim_recovery_obligations',
    );
    expect(migration).not.toContain('CREATE ROLE meri_phase4_recovery_operator LOGIN');
    expect(migration).not.toMatch(/GRANT meri_phase4_recovery_operator TO/i);
    expect(migration).toContain('Phase 4 recovery role membership survived obligation migration');
  });

  test('keeps identity immutable and admits only exact reservation/status/Stop bytes', () => {
    expect(migration).toContain('obligation_id = operation_id');
    expect(migration).toContain("attempt_nonce ~ '^[A-Za-z0-9_-]{21}[AQgw]$'");
    expect(migration).toContain("obligation_kind = 'reservation' AND action IS NULL");
    expect(migration).toContain("obligation_kind = 'dispatch' AND action = 'status'");
    expect(migration).toContain("obligation_kind = 'dispatch' AND action = 'stop'");
    expect(migration).toContain("encode(native_body_bytes, 'hex') = '7b7d'");
    expect(migration).toContain('Phase 4 recovery obligation identity is immutable');
    expect(migration).toContain('Phase 4 recovery obligations cannot be deleted');
  });

  test('claims a bounded cross-replica lease with database time and skip locked', () => {
    expect(migration).toContain(
      'floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint',
    );
    expect(migration).toContain('p_limit < 1 OR p_limit > 100');
    expect(migration).toContain('p_lease_micros < 1000000');
    expect(migration).toContain('p_lease_micros > 300000000');
    expect(migration).toContain('FOR UPDATE SKIP LOCKED');
    expect(migration).toContain('claim_expires_at_epoch_micros <= v_now');
    expect(migration).toContain('attempt_count = o.attempt_count + 1');
    expect(migration).toContain('claim_token = gen_random_uuid()');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX meri_phase4_recovery_obligation_active_key',
    );
  });

  test('discovers only bounded reservation, Stop, and status work', () => {
    expect(migration).toContain("i.state = 'prepared' AND i.worker_run_id IS NULL");
    expect(migration).toContain('v_now >= i.delivery_not_after_epoch_micros');
    expect(migration).toContain('v_now < i.reconciliation_not_after_epoch_micros');
    expect(migration).toContain('v_now < i.retain_until_epoch_micros');
    expect(migration).toContain("r.stop_requested_at IS NOT NULL OR r.status = 'cancelling'");
    expect(migration).toContain("r.stop_requested_at IS NULL");
    expect(migration).toContain("r.status NOT IN ('completed', 'cancelled', 'failed'");
    expect(migration).toContain("convert_to('{}', 'UTF8')");
    expect(claimRoutine.match(/INSERT INTO public\.meri_phase4_recovery_obligations/g))
      .toHaveLength(1);
    expect(claimRoutine).toContain('WITH discovered AS MATERIALIZED');
    expect(claimRoutine).toContain('ORDER BY d.priority, d.tenant_id, d.run_id');
    expect(claimRoutine).toContain('LIMIT p_limit');
  });

  test('preserves stable retry identity and supports exact commit-unknown replay', () => {
    expect(migration).toContain("SET state = 'pending', claim_owner = NULL");
    expect(migration).toContain('claim_token = NULL');
    expect(migration).toContain(
      'v_obligation.last_outcome_kind IS NOT DISTINCT FROM p_outcome_kind',
    );
    expect(migration).toContain(
      'v_obligation.claim_token IS DISTINCT FROM p_claim_token',
    );
    expect(migration).toContain("record_result := 'replayed'");
    expect(migration).toContain(
      'next_attempt_at_epoch_micros = least(o.expires_at_epoch_micros, v_now + v_delay)',
    );
    expect(migration).not.toMatch(/SET\s+operation_id\s*=/i);
    expect(migration).not.toMatch(/SET\s+attempt_nonce\s*=/i);
  });

  test('fences status claims and callbacks after durable cancellation', () => {
    expect(claimRoutine).toContain('WITH status_to_fence AS');
    expect(claimRoutine).toContain('FOR UPDATE OF o SKIP LOCKED');
    expect(claimRoutine).toContain("stop_work.action = 'stop'");
    expect(claimRoutine).toContain("accepted_stop.last_outcome_detail = 'stop_accepted'");
    expect(migration).toContain(
      'Phase 4 recovery status lost to durable cancellation',
    );
  });

  test('completes only after the exact persisted signed receipt exists', () => {
    expect(migration).toContain(
      'FROM public.meri_phase4_reservation_recovery_receipts r',
    );
    expect(migration).toContain(
      'FROM public.meri_phase4_dispatch_recovery_receipts r',
    );
    for (const binding of [
      'r.tenant_id = v_obligation.tenant_id',
      'r.run_id = v_obligation.run_id',
      'r.operation_id = p_receipt_operation_id',
      'r.attempt_nonce = p_receipt_attempt_nonce',
    ]) expect(migration).toContain(binding);
    expect(migration).toContain("r.action = v_obligation.action");
    expect(migration).toContain('Phase 4 recovery verified receipt is unavailable');
    expect(migration).toContain("SET state = 'completed', claim_owner = NULL");
    expect(migration).toContain("p_outcome_kind = 'dispatch_nonterminal'");
    expect(migration).toContain("'dispatch', 'status', v_obligation.sequence + 1");
  });

  test('forces RLS and leaves no table, schema-create, or PUBLIC routine authority', () => {
    expect(migration).toContain(
      'ALTER TABLE public.meri_phase4_recovery_obligations FORCE ROW LEVEL SECURITY;',
    );
    expect(migration).toContain("USING (current_user = 'meri_phase4_authority_owner')");
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.meri_phase4_recovery_obligations',
    );
    expect(migration).toContain(
      'REVOKE CREATE ON SCHEMA public FROM meri_phase4_recovery_operator;',
    );
    expect(migration).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE meri_phase4_authority_owner',
    );
    expect(migration).toContain('unsafe PUBLIC routine after recovery-obligation migration');
    expect(migration).toContain('recovery operator retained direct table authority');
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
  });
});
