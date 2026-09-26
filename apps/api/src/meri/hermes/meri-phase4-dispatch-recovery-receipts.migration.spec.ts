import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(join(
  __dirname,
  '../../../prisma/migrations/20280928070000_meri_phase4_dispatch_recovery_receipts/migration.sql',
), 'utf8');
const recoveryContract = readFileSync(join(
  __dirname,
  'meri-hermes-dispatch-recovery.contract.ts',
), 'utf8');

describe('dormant Phase 4 dispatch recovery receipt persistence', () => {
  it('projects the exact dispatch, worker, attempt, digest, time, and signer identity', () => {
    for (const column of [
      'tenant_id uuid NOT NULL',
      'run_id uuid NOT NULL',
      'request_sha256 char(64) NOT NULL',
      'worker_run_id varchar(120) NOT NULL',
      'worker_audience varchar(64) NOT NULL',
      'worker_ingress_id varchar(128) NOT NULL',
      'worker_generation varchar(128) NOT NULL',
      'worker_credential_id varchar(128) NOT NULL',
      'action varchar(8) NOT NULL',
      'operation_id uuid NOT NULL',
      'attempt_nonce varchar(22) NOT NULL',
      'command_key_id varchar(128) NOT NULL',
      'command_sha256 char(64) NOT NULL',
      'native_request_body_sha256 char(64) NOT NULL',
      'native_response_body_sha256 char(64) NOT NULL',
      'receipt_sha256 char(64) NOT NULL',
      'observation varchar(24) NOT NULL',
      'worker_status varchar(32)',
      'native_http_status smallint NOT NULL',
      'issued_at_epoch_micros bigint NOT NULL',
      'expires_at_epoch_micros bigint NOT NULL',
      'observed_at_epoch_micros bigint NOT NULL',
      'key_id varchar(128) NOT NULL',
      'signature varchar(43) NOT NULL',
    ]) {
      expect(migration).toContain(column);
    }
    expect(migration).toContain("contract_version = 1");
    expect(migration).toContain("receipt_purpose = 'meri-hermes-recovery-receipt'");
    expect(recoveryContract).toContain("export type MeriHermesRecoveryActionV1 = 'status' | 'stop'");
    expect(recoveryContract).toContain('readonly commandSha256: string;');
    expect(recoveryContract).toContain('readonly keyId: string;');
    expect(recoveryContract).toContain('readonly nativeBodySha256: string;');
    expect(recoveryContract).toContain('readonly nativeResponseBodySha256: string;');
  });

  it('links every operation to the complete immutable claimed dispatch identity', () => {
    expect(migration).toContain(
      'ADD CONSTRAINT meri_agent_dispatch_intents_recovery_identity_key UNIQUE',
    );
    expect(migration).toContain(
      'CONSTRAINT meri_phase4_recovery_operation_intent_fk FOREIGN KEY',
    );
    for (const field of [
      'run_id', 'tenant_id', 'request_sha256', 'worker_run_id',
      'worker_audience', 'worker_ingress_id', 'worker_generation',
      'worker_credential_id',
    ]) {
      const composite = migration.slice(
        migration.indexOf('CONSTRAINT meri_phase4_recovery_operation_intent_fk'),
        migration.indexOf('ON UPDATE RESTRICT ON DELETE RESTRICT'),
      );
      expect(composite).toContain(field);
    }
    expect(migration).toContain(
      'CONSTRAINT meri_phase4_recovery_receipt_operation_fk FOREIGN KEY',
    );
  });

  it('anchors operation identity atomically while allowing distinct retry attempts', () => {
    expect(migration).toContain(
      'CONSTRAINT meri_phase4_recovery_operation_pkey PRIMARY KEY (tenant_id, operation_id)',
    );
    expect(migration).toContain(
      'ON CONFLICT (tenant_id, operation_id) DO NOTHING;',
    );
    expect(migration).toContain('FOR SHARE;');
    expect(migration).toContain("RAISE EXCEPTION 'Phase 4 recovery operation replay drift'");
    expect(migration).toContain(
      'CONSTRAINT meri_phase4_recovery_receipt_attempt_key UNIQUE (tenant_id, attempt_nonce)',
    );
    expect(migration).toContain(
      'CONSTRAINT meri_phase4_recovery_receipt_digest_key UNIQUE (tenant_id, receipt_sha256)',
    );
    expect(migration).toContain(
      'CONSTRAINT meri_phase4_recovery_receipt_signature_key UNIQUE (tenant_id, key_id, signature)',
    );
    expect(migration).not.toMatch(
      /UNIQUE\s*\(\s*tenant_id\s*,\s*operation_id\s*\)\s*[,)]/s,
    );
  });

  it('matches the v1 canonical encodings, exclusive window, and normalized observations', () => {
    expect(migration).toContain("attempt_nonce ~ '^[A-Za-z0-9_-]{21}[AQgw]$'");
    expect(migration).toContain("command_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'");
    expect(migration).toContain("key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'");
    expect(migration).toContain(
      "signature ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'",
    );
    expect(migration).toContain(
      'expires_at_epoch_micros - issued_at_epoch_micros <= 60000000',
    );
    expect(migration).toContain('observed_at_epoch_micros >= issued_at_epoch_micros');
    expect(migration).toContain('observed_at_epoch_micros < expires_at_epoch_micros');
    expect(migration).toContain("observation = 'run_nonterminal'");
    expect(migration).toContain("observation = 'run_terminal'");
    expect(migration).toContain("observation = 'stop_accepted' AND action = 'stop'");
    expect(migration).toContain(
      "observation = 'not_found' AND native_http_status = 404 AND worker_status IS NULL",
    );
    expect(migration).toContain(
      "action <> 'status' OR native_request_body_sha256 =\n" +
      "      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'",
    );
  });

  it('forces tenant RLS and rejects updates or deletion of both append-only relations', () => {
    for (const relation of [
      'meri_phase4_dispatch_recovery_operations',
      'meri_phase4_dispatch_recovery_receipts',
    ]) {
      expect(migration).toContain(`ALTER TABLE public.${relation} ENABLE ROW LEVEL SECURITY;`);
      expect(migration).toContain(`ALTER TABLE public.${relation} FORCE ROW LEVEL SECURITY;`);
    }
    expect(migration).toContain('USING (tenant_id = public.current_tenant_id());');
    expect(migration).toContain('CREATE TRIGGER meri_phase4_recovery_operation_append_only');
    expect(migration).toContain('CREATE TRIGGER meri_phase4_recovery_receipt_append_only');
    expect(migration).toContain('BEFORE INSERT OR UPDATE OR DELETE');
    expect(migration).toContain("USING ERRCODE = '55000'");
  });

  it('remains dormant and leaves neither PUBLIC authority nor owner membership behind', () => {
    expect(migration).toContain(
      'FROM PUBLIC, capiro_app, meri_phase4_route_operator;',
    );
    expect(migration).not.toContain(
      'GRANT SELECT ON public.meri_phase4_dispatch_recovery',
    );
    expect(migration).not.toContain(
      'GRANT INSERT ON public.meri_phase4_dispatch_recovery',
    );
    expect(migration).not.toContain(
      'GRANT EXECUTE ON FUNCTION public.meri_phase4_guard_dispatch_recovery',
    );
    expect(migration).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    );
    expect(migration).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE meri_phase4_authority_owner',
    );
    expect(migration).toContain('CREATE FUNCTION public.meri_phase4_recovery_default_acl_probe()');
    expect(migration).toContain('unsafe PostgreSQL PUBLIC routine after Phase 4 recovery migration');
    expect(migration).toContain('REVOKE CREATE ON SCHEMA public FROM meri_phase4_authority_owner;');
    expect(migration).toContain(
      'Phase 4 authority owner membership survived recovery receipt migration',
    );
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
  });
});
