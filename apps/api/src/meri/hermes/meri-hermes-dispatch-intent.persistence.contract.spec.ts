import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const apiRoot = join(__dirname, '..', '..', '..');
const schema = readFileSync(join(apiRoot, 'prisma', 'schema.prisma'), 'utf8');
const migration = readFileSync(join(
  apiRoot,
  'prisma',
  'migrations',
  '20280928010000_meri_phase4_no_copy_dispatch_intents',
  'migration.sql',
), 'utf8');
const bindingMigration = readFileSync(join(
  apiRoot,
  'prisma',
  'migrations',
  '20280928030000_meri_phase4_message_assembly_binding',
  'migration.sql',
), 'utf8');
const currentAuthorityMigration = readFileSync(join(
  apiRoot, 'prisma', 'migrations',
  '20280928040000_meri_phase4_current_authority', 'migration.sql',
), 'utf8');
const repository = readFileSync(join(__dirname, 'meri-hermes-dispatch-intent.repository.ts'), 'utf8');
const claimBoundary = readFileSync(join(__dirname, 'meri-hermes-dispatch-claim-boundary.ts'), 'utf8');
const currentAuthority = readFileSync(join(
  __dirname, 'meri-hermes-dispatch-current-authority.verifier.ts',
), 'utf8');
const moduleSource = readFileSync(join(__dirname, '..', 'meri.module.ts'), 'utf8');
const adapterSource = readFileSync(join(__dirname, 'meri-hermes-runtime.adapter.ts'), 'utf8');
const controllerSource = readFileSync(join(__dirname, 'meri-hermes.controller.ts'), 'utf8');
const runtimeClientSource = readFileSync(join(__dirname, 'meri-hermes-runtime.client.ts'), 'utf8');
const workerOverlaySource = readFileSync(join(
  apiRoot, '..', '..', 'docker', 'hermes-worker', 'overlay', 'apply_overlay.py',
), 'utf8');

describe('Phase 4 no-copy dispatch persistence contract', () => {
  test('keeps current authority dormant and tenant-fenced without app writes', () => {
    for (const source of [moduleSource, adapterSource, controllerSource,
      runtimeClientSource, workerOverlaySource]) {
      expect(source).not.toContain('MeriHermesDispatchDbCurrentAuthorityVerifierV2');
      expect(source).not.toContain('meri-hermes-dispatch-current-authority.verifier');
    }
    expect(currentAuthorityMigration).toContain('CREATE ROLE meri_phase4_authority_owner');
    expect(currentAuthorityMigration).toContain(
      'NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
    );
    expect(currentAuthorityMigration).toMatch(/\bBEGIN;[\s\S]*\bCOMMIT;/);
    expect(currentAuthorityMigration).toContain('FORCE ROW LEVEL SECURITY');
    expect(currentAuthorityMigration).toContain('FOR SHARE');
    expect(currentAuthorityMigration).toContain('CREATE TRIGGER meri_phase4_client_access_fence');
    expect(currentAuthorityMigration).toContain('CREATE TRIGGER meri_phase4_worker_route_fence');
    expect(currentAuthorityMigration).toContain(
      'CREATE TRIGGER meri_phase4_tenant_fence AFTER UPDATE OF status, slug OR DELETE',
    );
    expect(currentAuthorityMigration).toContain(
      'CREATE TRIGGER meri_phase4_user_identity_fence',
    );
    expect(currentAuthorityMigration).toContain(
      'BEFORE UPDATE OF clerk_user_id OR DELETE ON public.users',
    );
    expect(currentAuthorityMigration).toContain(
      'SELECT DISTINCT m.tenant_id FROM public.tenant_memberships m',
    );
    expect(currentAuthorityMigration).toContain('WHERE m.user_id = OLD.id ORDER BY m.tenant_id');
    expect(currentAuthorityMigration).toContain(
      'CREATE POLICY meri_phase4_membership_owner_user_fence ON public.tenant_memberships',
    );
    expect(currentAuthorityMigration).toContain(
      'GRANT SELECT (tenant_id, user_id) ON public.tenant_memberships',
    );
    expect(currentAuthorityMigration).toMatch(
      /GRANT SELECT \(tenant_id, user_id\) ON public\.tenant_memberships\s+TO meri_phase4_authority_owner;/,
    );
    expect(currentAuthorityMigration).not.toMatch(
      /GRANT SELECT \(tenant_id, user_id\) ON public\.tenant_memberships\s+TO capiro_app;/,
    );
    expect(currentAuthorityMigration).toContain(
      'CREATE TRIGGER meri_phase4_scope_insert_lock BEFORE INSERT',
    );
    expect(currentAuthorityMigration).toContain('WHERE f.tenant_id = NEW.tenant_id FOR UPDATE');
    expect(currentAuthorityMigration.indexOf('CREATE TRIGGER meri_phase4_scope_insert_lock'))
      .toBeLessThan(currentAuthorityMigration.indexOf('CREATE TRIGGER meri_phase4_scope_fence'));
    expect(currentAuthorityMigration).toContain('REVOKE ALL ON TABLE public.meri_phase4_authority_fences');
    expect(currentAuthorityMigration).toContain('GRANT EXECUTE ON FUNCTION public.meri_phase4_lock_authority_fence');
    expect(currentAuthorityMigration).toContain(
      'CREATE FUNCTION public.meri_phase4_try_lock_authority_fence_exclusive(p_tenant_id uuid)',
    );
    expect(currentAuthorityMigration).toContain('WHERE f.tenant_id = p_tenant_id FOR UPDATE NOWAIT');
    expect(currentAuthorityMigration).toContain(
      'public.meri_phase4_try_lock_authority_fence_exclusive(uuid)',
    );
    expect(currentAuthorityMigration).toContain("RAISE EXCEPTION 'authority tenant mismatch'");
    expect(currentAuthorityMigration).toContain(
      'public.meri_phase4_lock_scope_insert_fence(),',
    );
    expect(currentAuthorityMigration).toContain(
      'public.meri_phase4_fence_user_identity(),',
    );
    expect(repository).toContain('meri_phase4_lock_authority_fence');
    expect(currentAuthority).toContain('meri_phase4_lock_worker_route');
    expect(currentAuthority).toContain('identity.scopeId');
  });

  test('bumps each affected fence once in UUID order for opposite cross-tenant moves', () => {
    const bumpFunction = currentAuthorityMigration.split(
      'CREATE FUNCTION public.meri_phase4_bump_authority_fence() RETURNS trigger',
    )[1]?.split('CREATE FUNCTION public.meri_phase4_lock_scope_insert_fence() RETURNS trigger')[0];
    expect(bumpFunction).toBeDefined();
    expect(bumpFunction).toContain('SELECT DISTINCT affected.tenant_id');
    expect(bumpFunction).toContain(
      'FROM (VALUES (old_tenant), (new_tenant)) AS affected(tenant_id)',
    );
    expect(bumpFunction).toContain('WHERE affected.tenant_id IS NOT NULL');
    expect(bumpFunction).toContain('ORDER BY affected.tenant_id');
    expect(bumpFunction).toContain('WHERE tenant_id = affected_tenant');
    expect(bumpFunction).not.toContain('WHERE tenant_id = old_tenant');
    expect(bumpFunction).not.toContain('WHERE tenant_id = new_tenant');
  });

  test('models every exact-request identity field without body or credential material', () => {
    expect(schema).toContain('model MeriAgentDispatchIntent');
    for (const column of [
      'identity_version', 'worker_ingress_id', 'worker_generation', 'worker_credential_id',
      'authorization_version', 'authorization_policy_version', 'grant_version',
      'session_header_key_id', 'body_length_bytes', 'body_sha256',
      'session_header_hmac_sha256', 'request_sha256',
    ]) expect(migration).toContain(`"${column}"`);
    expect(migration).not.toMatch(/"body_bytes"|"session_key"|"bearer"|"hmac_key"/);
    expect(migration).not.toMatch(/FOREIGN KEY|REFERENCES\s+"(?:meri_agent_runs|clio_messages|tenants)"/);
  });

  test('adds immutable source-message and request-assembly digests without inventing a backfill', () => {
    expect(schema).toContain('sourceMessageSha256');
    expect(schema).toContain('requestAssemblySha256');
    expect(bindingMigration).toContain('IF EXISTS (SELECT 1 FROM "meri_agent_dispatch_intents" LIMIT 1)');
    expect(bindingMigration).toContain('ADD COLUMN "source_message_sha256" CHAR(64) NOT NULL');
    expect(bindingMigration).toContain('ADD COLUMN "request_assembly_sha256" CHAR(64) NOT NULL');
    expect(bindingMigration).toContain('dispatch message/assembly binding is immutable');
    expect(bindingMigration).toContain('GRANT INSERT (source_message_sha256, request_assembly_sha256)');
    expect(repository).toContain('meriDispatchSourceMessageSha256V2');
    expect(bindingMigration).toContain('identity_version = 2');
    expect(bindingMigration).toContain('DROP CONSTRAINT "meri_agent_dispatch_intents_identity_shape_check"');
    expect(bindingMigration).toContain('dispatch v1 rows require explicit reconciliation');
    expect(bindingMigration).toContain('dispatch v2 freshness window is closed');
  });

  test('uses signed BIGINT cutoffs, DB-clock outcomes, and only the three durable states', () => {
    for (const cutoff of [
      'claim_not_after_epoch_micros', 'delivery_not_after_epoch_micros',
      'worker_credential_not_after_epoch_micros', 'reconciliation_not_after_epoch_micros',
      'retain_until_epoch_micros',
    ]) expect(migration).toMatch(new RegExp(`"${cutoff}" BIGINT NOT NULL`));
    expect(migration).toContain('"conversation_epoch" BIGINT NOT NULL');
    expect(migration).toContain('"body_length_bytes" BIGINT NOT NULL');
    expect(migration).toContain('"conversation_epoch" <= 9007199254740991::BIGINT');
    expect(migration).toContain('"body_length_bytes" <= 9007199254740991::BIGINT');
    expect(migration).toContain('+ 86400000000::BIGINT');
    expect(migration).toContain('extract(epoch FROM clock_timestamp()) * 1000000');
    expect(migration).toContain("OLD.state = 'prepared' AND NEW.state = 'claimed'");
    expect(migration).toContain("OLD.state = 'prepared' AND NEW.state = 'sealed_absent'");
    expect(migration).toContain('db_now_epoch_micros >= OLD.claim_not_after_epoch_micros');
    expect(migration).toContain('db_now_epoch_micros <= OLD.reconciliation_not_after_epoch_micros');
    expect(migration).not.toMatch(/"state"\s*=\s*'UNKNOWN'/);
    expect(migration).toContain('dispatch intent state transition is forbidden');
  });

  test('preserves identity/tombstones, forces tenant RLS, and withholds destructive privileges', () => {
    expect(migration).toContain('dispatch intent identity is immutable');
    expect(migration).toContain('dispatch intent deletion is disabled');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('tenant_id = current_tenant_id()');
    expect(migration).toContain('REVOKE ALL ON TABLE "meri_agent_dispatch_intents" FROM PUBLIC');
    expect(migration).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER');
    expect(migration.indexOf('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))
      .toBeLessThan(migration.indexOf('GRANT INSERT ('));
    expect(migration).not.toMatch(/GRANT\s+(?:[^;]*,\s*)?DELETE\b/);
    expect(migration).toContain('"tombstoned_at_epoch_micros" >= "retain_until_epoch_micros"');
  });

  test('keeps the repository dormant and makes replay status-only', () => {
    expect(moduleSource).not.toContain('MeriHermesDispatchIntentRepository');
    expect(adapterSource).not.toContain('MeriHermesDispatchIntentRepository');
    expect(repository).toContain("kind: 'status_only'");
    expect(repository).toContain("reason: 'commit_unconfirmed'");
    expect(repository).toContain('prepareInTransaction');
    expect(repository).toContain('UPDATE meri_agent_runs');
    expect(repository).toContain('SET hermes_run_id = ${input.workerRunId}');
    expect(repository).not.toMatch(/runtime\.createRun|fetch\(|axios|HttpService/);
  });

  test('keeps the claim boundary dormant and enforces authentication before status', () => {
    for (const source of [moduleSource, adapterSource, controllerSource,
      runtimeClientSource, workerOverlaySource]) {
      expect(source).not.toContain('MeriHermesDispatchClaimBoundaryV2');
      expect(source).not.toContain('meri-hermes-dispatch-claim-boundary');
    }
    expect(repository.indexOf('await authenticate(tx')).toBeLessThan(
      repository.indexOf("if (row.state === 'claimed')"),
    );
    expect(repository.indexOf('await authenticate(tx')).toBeLessThan(
      repository.indexOf('identity.requestSha256 !== input.requestSha256'),
    );
    expect(repository).toContain('Object.freeze(identity)');
    expect(repository).toContain('verifyTransition(tx, this.lockedContext');
    expect(repository.match(/clock_timestamp\(\)/g)).toHaveLength(7);
    expect(claimBoundary.indexOf('#serviceSecretMatches')).toBeLessThan(
      claimBoundary.indexOf('this.#repository.claim('),
    );
    expect(claimBoundary).toContain('Uint8Array.from(input.bodyBytes)');
    expect(claimBoundary).toContain('verifyMeriDispatchGateBearerV1');
    expect(claimBoundary).toContain('matchesMeriDispatchReceivedRequestV2');
    expect(claimBoundary).not.toMatch(/@Controller|@Injectable|fetch\(|axios|HttpService|process\.env/);
  });
});
