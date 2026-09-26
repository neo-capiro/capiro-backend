import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const migrationsDir = join(__dirname, '../../../prisma/migrations');
const migration = readFileSync(join(
  migrationsDir,
  '20280928110000_meri_phase4_broker_effect_receipts/migration.sql',
), 'utf8');
const compact = migration.replace(/\s+/g, ' ');

describe('Phase 4 broker-effect receipt migration', () => {
  test('is the 443rd migration and remains a dormant no-login package', () => {
    const migrations = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(migrations).toHaveLength(449);
    expect(migrations.at(-7)).toBe('20280928110000_meri_phase4_broker_effect_receipts');
    expect(compact).toContain(
      'CREATE ROLE meri_phase4_broker_effect_operator NOLOGIN NOSUPERUSER NOCREATEDB',
    );
    expect(compact).toContain(
      'CREATE ROLE meri_phase4_broker_signer_owner NOLOGIN NOSUPERUSER NOCREATEDB',
    );
    expect(migration).not.toMatch(/CREATE ROLE\s+meri_phase4_broker_effect_operator\s+LOGIN/i);
    expect(migration).not.toMatch(/GRANT\s+meri_phase4_broker_effect_operator\s+TO\s+capiro_app/i);
  });

  test('anchors immutable operation, signature-attestation, and signed receipt identity', () => {
    expect(compact).toContain(
      'CREATE TABLE public.meri_phase4_broker_effect_signature_attestations',
    );
    expect(compact).toContain(
      'CREATE TABLE public.meri_phase4_broker_effect_operations',
    );
    expect(compact).toContain(
      'CREATE TABLE public.meri_phase4_broker_effect_receipts',
    );
    expect(compact).toContain('operation_id uuid PRIMARY KEY');
    expect(compact).toContain(
      'CONSTRAINT meri_p4_broker_effect_receipt_operation_key UNIQUE (operation_id)',
    );
    expect(compact).toContain(
      'CONSTRAINT meri_p4_broker_effect_receipt_operation_fk FOREIGN KEY',
    );
    expect(compact).toContain(
      'CONSTRAINT meri_p4_broker_effect_receipt_signature_fk FOREIGN KEY',
    );
    for (const table of [
      'meri_phase4_broker_effect_signature_attestations',
      'meri_phase4_broker_effect_operations',
      'meri_phase4_broker_effect_receipts',
    ]) {
      expect(compact).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(compact).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(compact).toContain('CREATE TRIGGER meri_p4_broker_signature_append_only');
    expect(compact).toContain('CREATE TRIGGER meri_p4_broker_operation_append_only');
    expect(compact).toContain('CREATE TRIGGER meri_p4_broker_receipt_append_only');
    expect(compact).toContain("RAISE EXCEPTION 'Phase 4 broker-effect evidence is append-only'");
  });

  test('accepts only effect identity and counts, then derives the result and receipt in PostgreSQL', () => {
    expect(compact).toContain(
      'CREATE FUNCTION public.meri_phase4_record_turn_effect( p_tenant_id uuid, p_run_id uuid, p_worker_run_id varchar, p_dispatch_request_sha256 char(64), p_scope_id varchar, p_operation_id uuid, p_canonical_request_sha256 char(64), p_user_chars integer, p_assistant_chars integer, p_effect_disposition varchar )',
    );
    const header = compact.match(
      /CREATE FUNCTION public\.meri_phase4_record_turn_effect\((.*?)\) RETURNS TABLE/,
    )?.[1] ?? '';
    expect(header).not.toMatch(/receipt|result|signature|signer|key_id/i);
    expect(compact).toContain("p_effect_disposition NOT IN ('attempt', 'effect_unknown')");
    expect(compact).toContain(
      "'capiro.meri.phase4.broker-effect-request/v1', p_tenant_id::text",
    );
    expect(compact).toContain(
      "RAISE EXCEPTION 'Phase 4 record-turn canonical request mismatch' USING ERRCODE = '23505'",
    );
    expect(compact).toContain("'capiro.meri.phase4.broker-effect-receipt-claims/v1'");
    expect(compact).toContain("verification_method = 'external-ed25519-v1'");
  });

  test('serializes exact retries and rejects operation identity drift before another effect', () => {
    expect(compact).toContain(
      'PERFORM pg_catalog.pg_advisory_xact_lock( pg_catalog.hashtextextended(p_operation_id::text, 0) )',
    );
    expect(compact).toContain(
      'FROM public.meri_phase4_broker_effect_operations o WHERE o.operation_id = p_operation_id FOR UPDATE',
    );
    expect(compact).toContain(
      "RAISE EXCEPTION 'Phase 4 record-turn operation replay drift' USING ERRCODE = '23505'",
    );
    expect(compact).toContain(
      'FROM public.meri_phase4_broker_effect_receipts r WHERE r.operation_id = p_operation_id FOR SHARE',
    );
    expect(compact).toContain('receipt_id := v_existing_receipt.receipt_id');
    expect(compact).toContain('receipt_sha256 := v_existing_receipt.receipt_sha256');
    expect(compact).toContain('RETURN NEXT; RETURN;');
  });

  test('holds the run, Stop, current-authority, route, and worker identity fences', () => {
    expect(compact).toContain(
      'FROM public.meri_phase4_authority_fences f WHERE f.tenant_id = p_tenant_id FOR SHARE',
    );
    expect(compact).toContain(
      'FROM public.meri_agent_runs r WHERE r.tenant_id = p_tenant_id AND r.id = p_run_id FOR UPDATE',
    );
    expect(compact).toContain('FROM public.meri_agent_dispatch_intents i');
    expect(compact).toContain('FROM public.meri_execution_scopes s');
    expect(compact).toContain('FROM public.meri_phase4_worker_routes r');
    expect(compact).toContain('FROM public.meri_phase4_worker_bindings b');
    expect(compact).toContain("v_intent.grant_version = 'g2:' || v_fence.revision::text");
    expect(compact).toContain('v_intent.worker_run_id = p_worker_run_id');
    expect(compact).toContain('v_intent.request_sha256 = p_dispatch_request_sha256');
    expect(compact).toContain('v_binding.revoked_at_epoch_micros IS NULL');
    expect(compact).toContain('v_route.enabled = true');
    expect(compact).toContain("v_detail := 'authority_closed'");
    expect(compact).toContain("v_detail := 'stop_requested'");
    expect(compact).toContain("v_detail := 'run_terminal'");
    expect(compact).toContain("v_detail := 'tool_denied'");
    expect(compact).toContain("v_detail := 'tool_budget_exhausted'");
  });

  test('commits one budget increment, internal event, and signed receipt in one routine', () => {
    expect(compact).toContain(
      'SET broker_calls = r.broker_calls + 1, last_seq = r.last_seq + 1',
    );
    expect(compact).toContain(
      "r.stop_requested_at IS NULL AND r.status NOT IN ('cancelling', 'completed', 'cancelled', 'failed', 'interrupted', 'expired')",
    );
    expect(compact).toContain('INSERT INTO public.meri_agent_run_events');
    expect(compact).toContain("'providerSyncTurn', true");
    expect(compact).toContain("'brokerEffectOperationId', p_operation_id");
    expect(compact).toContain('INSERT INTO public.meri_phase4_broker_effect_receipts');
    expect(compact).toContain(
      "v_result := 'committed'; v_detail := 'recorded'",
    );
    expect(compact).toContain(
      "v_result := 'denied_before_effect'; v_detail := 'stop_requested'",
    );
  });

  test('uses DB time, an exclusive attestation window, and bounded durable retention', () => {
    expect(compact).toContain(
      'v_now bigint := floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint',
    );
    expect(compact).toContain(
      'a.verified_at_epoch_micros <= v_now AND a.expires_at_epoch_micros > v_now',
    );
    expect(compact).toContain('v_now + 7776000000000');
    expect(compact).toContain('coalesce(v_intent.retain_until_epoch_micros, 0)');
    expect(compact).toContain('v_retain > v_now + 31536000000000');
    expect(compact).toContain('retain_until_epoch_micros := v_existing_receipt.retain_until_epoch_micros');
  });

  test('leaves only operator EXECUTE and rejects inherited PUBLIC routine exposure', () => {
    expect(compact).toContain(
      'REVOKE ALL ON TABLE public.meri_phase4_broker_effect_signature_attestations, public.meri_phase4_broker_effect_operations, public.meri_phase4_broker_effect_receipts FROM PUBLIC, capiro_app, meri_phase4_route_operator, meri_phase4_recovery_operator, meri_phase4_broker_effect_operator',
    );
    expect(compact).toContain(
      'GRANT EXECUTE ON FUNCTION public.meri_phase4_record_turn_effect( uuid,uuid,varchar,char,varchar,uuid,char,integer,integer,varchar ) TO meri_phase4_broker_effect_operator',
    );
    expect(compact).toContain(
      "ALTER DEFAULT PRIVILEGES FOR ROLE meri_phase4_authority_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC",
    );
    expect(compact).toContain("RAISE EXCEPTION 'new broker-effect routines inherit PUBLIC EXECUTE'");
    expect(compact).toContain("RAISE EXCEPTION 'broker-effect operator retained direct table authority'");
    expect(compact).toContain("RAISE EXCEPTION 'Phase 4 broker-effect role membership survived migration'");
    expect(compact.trimEnd().endsWith('COMMIT;')).toBe(true);
  });
});
