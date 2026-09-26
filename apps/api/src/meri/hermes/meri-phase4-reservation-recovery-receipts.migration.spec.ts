import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(join(
  __dirname,
  '../../../prisma/migrations/20280928080000_meri_phase4_reservation_recovery_receipts/migration.sql',
), 'utf8');
const repository = readFileSync(join(
  __dirname, 'meri-hermes-reservation-recovery.repository.ts',
), 'utf8');
const intentRepository = readFileSync(join(
  __dirname, 'meri-hermes-dispatch-intent.repository.ts',
), 'utf8');

describe('dormant Phase 4 reservation recovery receipt authority', () => {
  test('anchors exact intent, route, cutoff, outcome, signer, and receipt digests', () => {
    for (const field of [
      'tenant_id uuid NOT NULL', 'operation_id uuid NOT NULL',
      'run_id uuid NOT NULL', 'request_sha256 char(64) NOT NULL',
      'idempotency_key varchar(200) NOT NULL', 'worker_audience varchar(64) NOT NULL',
      'worker_ingress_id varchar(128) NOT NULL',
      'worker_generation varchar(128) NOT NULL',
      'worker_credential_id varchar(128) NOT NULL',
      'delivery_not_before_epoch_micros bigint NOT NULL',
      'retain_until_epoch_micros bigint NOT NULL', 'outcome varchar(16) NOT NULL',
      'worker_run_id varchar(120)', 'sealed_at_epoch_micros bigint',
      'attempt_nonce varchar(22) NOT NULL', 'command_key_id varchar(128) NOT NULL',
      'command_sha256 char(64) NOT NULL',
      'native_request_body_sha256 char(64) NOT NULL',
      'native_response_body_sha256 char(64) NOT NULL',
      'receipt_sha256 char(64) NOT NULL', 'key_id varchar(128) NOT NULL',
      'signature varchar(43) NOT NULL',
    ]) expect(migration).toContain(field);
    expect(migration).toContain("receipt_purpose = 'meri-hermes-reservation-receipt'");
    expect(migration).toContain(
      'ADD CONSTRAINT meri_agent_dispatch_intents_reservation_identity_key UNIQUE',
    );
    expect(migration).toContain('CONSTRAINT meri_phase4_reservation_operation_intent_fk');
    expect(migration).toContain('CONSTRAINT meri_phase4_reservation_receipt_operation_fk');
  });

  test('makes reservation and authenticated absence mutually exclusive durable outcomes', () => {
    expect(migration).toContain("outcome = 'reserved'");
    expect(migration).toContain("outcome = 'sealed_absent'");
    expect(migration).toContain('sealed_at_epoch_micros >= delivery_not_before_epoch_micros');
    expect(migration).toContain('sealed_at_epoch_micros <= observed_at_epoch_micros');
    expect(migration).toContain('sealed_at_epoch_micros < retain_until_epoch_micros');
    expect(migration).toContain('native_http_status = 200');
    expect(migration).toContain(
      "native_request_body_sha256 =\n      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'",
    );
  });

  test('uses one append-only operation provenance anchor and idempotent receipt fences', () => {
    expect(migration).toContain(
      'PRIMARY KEY (tenant_id, operation_id)',
    );
    expect(migration).toContain(
      'UNIQUE (tenant_id, receipt_sha256)',
    );
    expect(migration).toContain(
      'UNIQUE (tenant_id, attempt_nonce)',
    );
    expect(migration).toContain(
      'UNIQUE (tenant_id, key_id, signature)',
    );
    expect(migration).toContain('Phase 4 reservation receipt operation drift');
    expect(migration).toContain('BEFORE INSERT OR UPDATE OR DELETE');
  });

  test('opens late claim or early absence only for the exact privileged operation anchor', () => {
    expect(migration).toContain(
      "current_user = 'meri_phase4_authority_owner'",
    );
    expect(migration).toContain(
      "OLD.state = 'prepared' AND NEW.state IN ('claimed', 'sealed_absent')",
    );
    for (const exactField of [
      'o.request_sha256 = OLD.request_sha256',
      'o.idempotency_key = OLD.idempotency_key',
      'o.worker_ingress_id = OLD.worker_ingress_id',
      'o.worker_generation = OLD.worker_generation',
      'o.worker_credential_id = OLD.worker_credential_id',
      'o.delivery_not_before_epoch_micros = OLD.delivery_not_after_epoch_micros',
      'o.retain_until_epoch_micros = OLD.retain_until_epoch_micros',
      'o.worker_run_id IS NOT DISTINCT FROM NEW.worker_run_id',
    ]) expect(migration).toContain(exactField);
    expect(migration).toContain(
      'db_now_epoch_micros < OLD.delivery_not_after_epoch_micros',
    );
    expect(migration).toContain(
      'db_now_epoch_micros >= OLD.reconciliation_not_after_epoch_micros',
    );
    expect(migration).toContain(
      'reservation recovery transition is closed or malformed',
    );
  });

  test('serializes commit in fence, source, intent, then DB-clock order', () => {
    const fence = repository.indexOf('meri_phase4_lock_authority_fence');
    const source = repository.indexOf('const sources = await lockSource');
    const intent = repository.indexOf('const intents = await tx.query<IntentRow>');
    const clock = repository.indexOf('AS db_now_epoch_micros');
    expect(fence).toBeGreaterThan(0);
    expect(fence).toBeLessThan(source);
    expect(source).toBeLessThan(intent);
    expect(intent).toBeLessThan(clock);
    expect(repository).toContain('>= $4::bigint');
    expect(repository).toContain('< $5::bigint');
    expect(repository).toContain('ordinary claimed/sealed intent can');
    expect(intentRepository).not.toContain('async sealAbsent(');
  });

  test('locks immutable source rows without granting their mutation privileges', () => {
    expect(repository).toContain(
      'public.meri_phase4_lock_reservation_recovery_source($1::uuid, $2::uuid)',
    );
    expect(migration).toContain(
      'CREATE FUNCTION public.meri_phase4_lock_reservation_recovery_source',
    );
    expect(migration).toContain('LANGUAGE plpgsql SECURITY DEFINER');
    expect(migration).toContain(
      "current_setting('role', true) IS DISTINCT FROM 'meri_phase4_authority_owner'",
    );
    expect(migration).toContain('FOR UPDATE OF r, s, c, m;');
    expect(migration).not.toContain(
      'GRANT UPDATE ON TABLE public.meri_execution_scopes',
    );
    expect(migration).not.toContain(
      'GRANT UPDATE ON TABLE public.clio_conversations',
    );
    expect(migration).not.toContain(
      'GRANT UPDATE ON TABLE public.clio_messages',
    );
  });

  test('keeps the owner NOLOGIN path narrow and leaves no app or PUBLIC writer', () => {
    expect(migration).toContain(
      'FROM PUBLIC, capiro_app, meri_phase4_route_operator;',
    );
    expect(migration).not.toContain(
      'GRANT INSERT ON TABLE public.meri_phase4_reservation',
    );
    expect(migration).not.toContain(
      'GRANT EXECUTE ON FUNCTION public.meri_phase4_guard_reservation',
    );
    expect(migration).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE meri_phase4_authority_owner',
    );
    expect(migration).toContain('unsafe PUBLIC routine after reservation migration');
    expect(migration).toContain(
      'Phase 4 authority owner membership survived reservation migration',
    );
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
  });
});
