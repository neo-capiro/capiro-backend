import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(join(
  __dirname,
  '../../../prisma/migrations/20280928050000_meri_phase4_route_operator/migration.sql',
), 'utf8');
const bindingV2Migration = readFileSync(join(
  __dirname,
  '../../../prisma/migrations/20280928060000_meri_phase4_source_qualified_binding_v2/migration.sql',
), 'utf8');
const verifier = readFileSync(join(__dirname, 'meri-hermes-dispatch-current-authority.verifier.ts'), 'utf8');
const operator = readFileSync(join(__dirname, 'meri-phase4-route-operator.ts'), 'utf8');

describe('dormant Phase 4 route operator database boundary', () => {
  it('creates only the passwordless operator LOGIN and leaves source roles for reviewed qualification', () => {
    expect(migration).toContain(
      'CREATE ROLE meri_phase4_route_operator LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB',
    );
    expect(migration).not.toContain('CREATE ROLE meri_phase4_route_attestor');
    expect(migration).toContain('A later independently reviewed\n-- qualification operation');
    expect(migration).toContain('NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5');
    expect(migration).toContain('pg_has_role(\'capiro_app\', \'meri_phase4_authority_owner\', \'member\')');
    expect(migration).toContain('REVOKE meri_phase4_authority_owner FROM');
  });

  it('fails closed on inherited PUBLIC authority before provisioning the LOGIN', () => {
    const gate = migration.indexOf('unsafe PostgreSQL PUBLIC privilege baseline');
    const login = migration.indexOf('CREATE ROLE meri_phase4_route_operator LOGIN');
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(login);
    expect(migration).toContain("x.grantee = 0 AND x.privilege_type = 'EXECUTE'");
    expect(migration).toContain("c.relkind IN ('r','p','v','m','f','S')");
    expect(migration).toContain("ext.extname IN ('pgcrypto', 'uuid-ossp', 'vector', 'pg_trgm', 'citext')");
  });

  it('closes future PUBLIC routine defaults and proves a post-create routine is private', () => {
    const defaultGate = migration.indexOf(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    );
    const login = migration.indexOf('CREATE ROLE meri_phase4_route_operator LOGIN');
    expect(defaultGate).toBeGreaterThanOrEqual(0);
    expect(defaultGate).toBeLessThan(login);
    expect(migration).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE meri_phase4_authority_owner',
    );
    expect(migration).toContain('CREATE FUNCTION public.meri_phase4_default_acl_probe()');
    expect(migration).toContain("p.oid = 'public.meri_phase4_default_acl_probe()'::regprocedure");
    expect(migration).toContain('DROP FUNCTION public.meri_phase4_default_acl_probe();');
    expect(migration).toContain('unsafe PostgreSQL PUBLIC routine after Phase 4 migration');
  });

  it('derives one-command route grants from live database authority and stores no nonce', () => {
    expect(migration).toContain('CREATE TABLE public.meri_phase4_route_operator_grants');
    expect(migration).toContain('nonce_sha256 char(64) NOT NULL');
    expect(migration).not.toMatch(/\n\s*grant_nonce\s+char\(64\)\s+NOT NULL/i);
    expect(migration).toContain('raw_nonce := public.gen_random_bytes(32);');
    expect(migration).toContain("session_user <> 'capiro_app'");
    expect(migration).toContain("m.role::text = 'capiro_admin'");
    expect(migration).toContain("m.status::text = 'active'");
    expect(migration).toContain('i.ended_at IS NULL AND i.expires_at > clock_timestamp()');
    expect(migration).toContain("t.status::text = 'active'");
    expect(migration).toContain('CREATE TRIGGER meri_phase4_route_grant_append_only');
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.meri_phase4_issue_route_operator_grant(',
    );
    expect(operator).toContain('MeriPhase4RouteOperatorGrantIssuerV1');
    expect(operator).toContain('grantOperation');
  });

  it('serializes impersonation lifecycle changes before a route can recheck live authority', () => {
    expect(migration).toContain(
      'CREATE FUNCTION public.meri_phase4_fence_impersonation_session() RETURNS trigger',
    );
    expect(migration).toContain(
      'CREATE TRIGGER meri_phase4_impersonation_session_fence\n' +
      '  BEFORE INSERT OR UPDATE OR DELETE ON public.impersonation_sessions',
    );
    expect(migration).toContain("RAISE EXCEPTION 'authority fence missing for impersonation lifecycle'");
    expect(migration).toContain(
      'ALTER FUNCTION public.meri_phase4_fence_impersonation_session()\n' +
      '  OWNER TO meri_phase4_authority_owner;',
    );
  });

  it('keeps route/binding/receipt data out of capiro_app DML and uses FORCE RLS append-only rows', () => {
    expect(migration).toContain('FROM capiro_app;\nGRANT SELECT ON public.meri_phase4_worker_routes TO capiro_app;');
    expect(migration).toContain('ALTER TABLE public.meri_phase4_worker_route_receipts FORCE ROW LEVEL SECURITY;');
    expect(migration).toContain('CREATE TRIGGER meri_phase4_route_receipt_append_only');
    expect(migration).toContain('CREATE TRIGGER meri_phase4_binding_source_immutable');
    expect(migration).toContain('CONSTRAINT meri_phase4_route_receipt_request_key UNIQUE (tenant_id, request_id)');
    expect(migration).toContain(
      'CONSTRAINT meri_phase4_binding_source_fk FOREIGN KEY (source_id, attested_by_role)',
    );
    expect(migration).toContain('cannot bind existing Phase 4 routes without external attestation');
    expect(migration).not.toMatch(/INSERT\s+INTO\s+public\.meri_phase4_worker_binding_sources/i);
  });

  it('binds each qualified source to one authenticated database role', () => {
    expect(migration).toContain(
      'CONSTRAINT meri_phase4_binding_source_role_key UNIQUE (producer_role)',
    );
    expect(migration).toContain(
      'WHERE s.source_id = p_source_id AND s.producer_role = session_user FOR SHARE',
    );
    expect(migration).toContain(
      'WHERE b.binding_id = p_binding_id AND b.tenant_id = p_tenant_id\n' +
      '      AND b.source_id = p_source_id FOR UPDATE',
    );
    expect(migration).toContain(
      "p_binding_id::text, p_source_id, p_revocation_id::text, session_user",
    );
    expect(migration).not.toMatch(/TO\s+meri_phase4_route_attestor/i);
  });

  it('pins versioned canonical digests and database-clock windows in every route mutation', () => {
    const digestDomains = migration.match(/'capiro\.meri\.phase4\.route-command\/v1'/g) ?? [];
    expect(digestDomains).toHaveLength(4);
    expect(migration).toContain('p_request_digest::text !~ \'^[0-9a-f]{64}$\'');
    expect(migration).toContain('p_not_after - p_not_before > 2592000000000');
    expect(migration).toContain('closed_at_epoch_micros IS NULL OR enabled = false');
    expect(migration).toContain('floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint');
    expect(migration).toContain("'capiro.meri.phase4.worker-binding/v1'");
  });

  it('requires active exact binding authority at claim time and never treats close as ingress proof', () => {
    expect(verifier).toContain('meri_phase4_lock_worker_route_bound');
    expect(verifier).toContain('meri_phase4_lock_worker_binding_v2');
    expect(verifier).toContain('binding.active !== true');
    expect(verifier).toContain('binding.not_before_epoch_micros <= now');
    expect(verifier).toContain('now < binding.not_after_epoch_micros');
    expect(operator).toContain('ingressClosureProven: false');
    expect(operator).toContain('workerTerminationProven: false');
    expect(operator).toContain('recoverReceipt(');
  });

  it('makes complete source-qualified v2 metadata all-or-none and rejects legacy rows', () => {
    expect(bindingV2Migration).toContain('CONSTRAINT meri_phase4_binding_v2_all_or_none');
    expect(bindingV2Migration).toContain(
      'binding_version IS NOT NULL AND binding_version = 2',
    );
    for (const field of [
      'worker_image_digest', 'worker_build_id', 'worker_catalog_digest_algorithm',
      'worker_catalog_digest', 'applied_tool_view_digest_algorithm',
      'meri_catalog_version', 'meri_catalog_digest', 'capability_mapping_version',
      'capability_mapping_digest', 'tool_view_protocol',
      'claim_attestation_protocol', 'attestation_credential_id',
    ]) {
      expect(bindingV2Migration).toContain(field);
      expect(bindingV2Migration).toContain(`${field} IS NOT NULL`);
    }
    expect(bindingV2Migration).toContain('b.binding_version = 2');
    expect(bindingV2Migration).toContain(
      'attestation_credential_id = worker_credential_id',
    );
    expect(bindingV2Migration).toContain(
      'REVOKE ALL ON FUNCTION public.meri_phase4_lock_worker_binding(',
    );
    expect(verifier).not.toMatch(/meri_phase4_lock_worker_binding\(/);
  });

  it('applies v2 DDL and privilege cutover atomically with no surviving owner membership', () => {
    expect(migration).toContain(
      'REVOKE CREATE ON SCHEMA public FROM meri_phase4_authority_owner',
    );
    expect(bindingV2Migration.trimStart().indexOf('BEGIN;')).toBeLessThan(
      bindingV2Migration.indexOf('ALTER TABLE public.meri_phase4_worker_bindings'),
    );
    expect(bindingV2Migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    const alter = bindingV2Migration.indexOf('ALTER TABLE public.meri_phase4_worker_bindings');
    const grant = bindingV2Migration.indexOf(
      "EXECUTE format('GRANT meri_phase4_authority_owner TO %I', current_user)",
    );
    const revoke = bindingV2Migration.lastIndexOf(
      "EXECUTE format('REVOKE meri_phase4_authority_owner FROM %I', current_user)",
    );
    expect(bindingV2Migration).toContain(
      'Phase 4 binding v2 migration executor cannot acquire owner authority',
    );
    expect(bindingV2Migration).toContain('m.grantor = current_user::regrole');
    expect(grant).toBeGreaterThanOrEqual(0);
    expect(grant).toBeLessThan(alter);
    const schemaGrant = bindingV2Migration.indexOf(
      'GRANT CREATE ON SCHEMA public TO meri_phase4_authority_owner',
    );
    const schemaRevoke = bindingV2Migration.lastIndexOf(
      'REVOKE CREATE ON SCHEMA public FROM meri_phase4_authority_owner',
    );
    expect(schemaGrant).toBeGreaterThan(grant);
    expect(schemaGrant).toBeLessThan(alter);
    expect(schemaRevoke).toBeGreaterThan(alter);
    expect(revoke).toBeGreaterThan(alter);
    expect(bindingV2Migration).toContain(
      'Phase 4 authority owner membership survived binding v2 migration',
    );
    expect(bindingV2Migration).toContain(
      'Phase 4 authority owner retained schema CREATE after binding v2 migration',
    );
  });

  it('keeps v2 attestation source-role-only and uses exact versioned protocol values', () => {
    expect(bindingV2Migration).toContain(
      'WHERE s.source_id = p_source_id AND s.producer_role = session_user FOR SHARE',
    );
    expect(bindingV2Migration).toContain("'capiro.meri.phase4.worker-binding/v2'");
    expect(bindingV2Migration).toContain("'capiro.meri.phase4.worker-catalog/v1'");
    expect(bindingV2Migration).toContain("'capiro.meri.phase4.applied-tool-view/v1'");
    expect(bindingV2Migration).toContain(
      "'capiro.meri.phase4.claim-tool-view-attestation/v1'",
    );
    expect(bindingV2Migration).toContain(
      'FROM PUBLIC, capiro_app, meri_phase4_route_operator;',
    );
    expect(bindingV2Migration).not.toContain(
      'GRANT EXECUTE ON FUNCTION public.meri_phase4_attest_worker_binding_v2',
    );
  });

  it('replays exact route receipts before contention and rechecks after the fence', () => {
    for (const name of [
      'meri_phase4_route_provision_disabled',
      'meri_phase4_route_enable',
      'meri_phase4_route_close',
      'meri_phase4_route_rotate_cas',
    ]) {
      const start = migration.indexOf(`CREATE FUNCTION public.${name}(`);
      const end = migration.indexOf('\nCREATE FUNCTION public.', start + 1);
      const body = migration.slice(start, end === -1 ? undefined : end);
      const fence = body.indexOf('PERFORM public.meri_phase4_lock_route_fence_exclusive');
      const replay = 'SELECT * INTO prior FROM public.meri_phase4_worker_route_receipts';
      const firstReplay = body.indexOf(replay);
      const secondReplay = body.indexOf(replay, firstReplay + replay.length);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(firstReplay).toBeGreaterThanOrEqual(0);
      expect(firstReplay).toBeLessThan(fence);
      expect(secondReplay).toBeGreaterThan(fence);
      expect(body.indexOf('actual_digest :=')).toBeLessThan(firstReplay);
      expect(body.indexOf('meri_phase4_authorize_route_grant')).toBeLessThan(firstReplay);
      expect(body.indexOf('meri_phase4_authorize_route_grant',
        body.indexOf('meri_phase4_authorize_route_grant') + 1)).toBeGreaterThan(secondReplay);
      expect(body).toContain('p_request_digest,true');
      expect((body.match(/Phase 4 route idempotency key reused with different command/g) ?? []))
        .toHaveLength(2);
    }
  });

  it('recovers exact binding attest/revoke replays on both sides of the fence', () => {
    const attestStart = migration.indexOf(
      'CREATE FUNCTION public.meri_phase4_attest_worker_binding(',
    );
    const revokeStart = migration.indexOf(
      'CREATE FUNCTION public.meri_phase4_revoke_worker_binding(',
    );
    const boundStart = migration.indexOf(
      'CREATE FUNCTION public.meri_phase4_lock_worker_route_bound(',
    );
    const attest = migration.slice(attestStart, revokeStart);
    const revoke = migration.slice(revokeStart, boundStart);
    const attestFence = attest.indexOf('PERFORM public.meri_phase4_lock_route_fence_exclusive');
    const revokeFence = revoke.indexOf('PERFORM public.meri_phase4_lock_route_fence_exclusive');
    const attestReplay = 'SELECT * INTO existing FROM public.meri_phase4_worker_bindings';
    const revokeReplay = 'SELECT * INTO binding_row FROM public.meri_phase4_worker_bindings';
    expect(attest.indexOf(attestReplay)).toBeLessThan(attestFence);
    expect(attest.indexOf(attestReplay, attest.indexOf(attestReplay) + 1))
      .toBeGreaterThan(attestFence);
    expect(attest.indexOf('meri_phase4_assert_route_scope')).toBeGreaterThan(attestFence);
    expect(revoke.indexOf(revokeReplay)).toBeLessThan(revokeFence);
    expect(revoke.indexOf(revokeReplay, revoke.indexOf(revokeReplay) + 1))
      .toBeGreaterThan(revokeFence);
  });

  it('removes capiro_app and PUBLIC access to the predecessor unbound route helper', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.meri_phase4_lock_worker_route(\n' +
      '  uuid,varchar,text,text,text,text\n' +
      ') FROM PUBLIC, capiro_app;',
    );
    expect(verifier).not.toMatch(/meri_phase4_lock_worker_route\(/);
    expect(verifier).toContain('meri_phase4_lock_worker_route_bound(');
  });
});
