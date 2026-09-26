import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../../..');
const migration = readFileSync(join(
  ROOT,
  'apps/api/prisma/migrations/20280928020000_meri_phase6_capability_shadow_ledger/migration.sql',
), 'utf8');
const repository = readFileSync(join(
  ROOT,
  'apps/api/src/meri/jev/meri-capability-shadow-ledger.repository.ts',
), 'utf8');
const appendBoundary = readFileSync(join(
  ROOT,
  'packages/meriv2-core/src/jev/evaluation/capability-shadow-append-boundary.ts',
), 'utf8');

describe('dormant capability-shadow ledger persistence contract', () => {
  it('owns exact sink-generation idempotency and an immutable linear chain', () => {
    expect(migration).toContain('UNIQUE ("audience", "endpoint_id", "idempotency_key")');
    expect(migration).toContain('FOR UPDATE;');
    expect(migration).toContain('v_existing.request_digest IS DISTINCT FROM p_request_digest');
    expect(migration).toContain('v_appended_at < p_processing_not_before');
    expect(migration).toContain('v_appended_at >= p_processing_not_after');
    expect(migration).toContain("'replayed'::TEXT");
    expect(migration).toContain('v_previous_digest := v_head.last_ledger_entry_digest');
    expect(migration).toContain('meri_phase6_capability_shadow_entry_immutable_trigger');
    expect(migration).toContain('BEFORE UPDATE OR DELETE');
    expect(migration).toContain('9007199254740991::BIGINT');
  });

  it('leaves lookup and append unreachable by the shared application role', () => {
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('tenant_id = current_tenant_id()');
    expect(migration).not.toContain('rls_bypass() OR tenant_id = current_tenant_id()');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = pg_catalog');
    expect(migration).toContain('REVOKE ALL ON TABLE "meri_capability_shadow_ledger_heads" FROM capiro_app');
    expect(migration).toContain('REVOKE ALL ON TABLE "meri_capability_shadow_ledger_entries" FROM capiro_app');
    expect(migration).toContain('REVOKE ALL ON FUNCTION lookup_meri_capability_shadow_entry_v1');
    expect(migration).toContain('REVOKE ALL ON FUNCTION append_meri_capability_shadow_entry_v1');
    expect(migration).not.toMatch(/GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE|EXECUTE)[^;]*(?:ledger|capability_shadow)[^;]*TO capiro_app/i);
  });

  it('persists no body, raw identifier, credential, signature, or key material', () => {
    const table = migration.slice(
      migration.indexOf('CREATE TABLE "meri_capability_shadow_ledger_entries"'),
      migration.indexOf('CREATE INDEX "meri_capability_shadow_ledger_tenant_time_idx"'),
    );
    expect(table).not.toMatch(/prompt|response|body|tool_argument|evaluation_unit|credential|signature|public_key|private_key|secret/i);
    expect(table).toContain('"tenant_pseudonym_hash" CHAR(64) NOT NULL');
    expect(table).toContain('"request_digest" CHAR(64) NOT NULL');
  });

  it('separates historical lookup from current-key append authorization', () => {
    expect(appendBoundary).toContain('const replayLookupOnlyBrand: unique symbol');
    expect(appendBoundary).toContain('const currentAppendAuthorizedBrand: unique symbol');
    expect(appendBoundary).toContain('Object.defineProperty(verified, replayLookupOnlyBrand');
    expect(appendBoundary).toContain('Object.defineProperty(verified, currentAppendAuthorizedBrand');
    expect(appendBoundary).toContain('enumerable: false');
    expect(repository).toContain('verifyCapabilityShadowAuthenticatedAppendRequestBytesForReplay(');
    expect(repository).toContain('lookup_meri_capability_shadow_entry_v1(');
    expect(repository).toContain('verifyCapabilityShadowAuthenticatedAppendRequestBytes(');
    expect(repository.indexOf('lookup_meri_capability_shadow_entry_v1('))
      .toBeLessThan(repository.indexOf('const current = verifyCapabilityShadowAuthenticatedAppendRequestBytes('));
    expect(repository).toContain('historicalEvent.tenantPseudonymHash !== input.authorizedTenantPseudonymHash');
    expect(repository).toContain('replayCapability: VerifiedCapabilityShadowReplayLookupRequest');
    expect(repository).toContain('appendCapability: VerifiedCapabilityShadowCurrentAppendAuthorizedRequest');
    expect(repository).toContain('processing.notAfter)');
    expect(repository).toContain('current.producerAuthorizationKeyNotAfter');
    expect(repository).toContain('trustedProcessingWindow');
    expect(repository).not.toContain('trustedTime.maxFutureSkewMs');
    expect(repository).toContain('capabilityShadowLedgerEntryDigest(entry)');
    expect(repository).toContain('this.prisma.withTenant(input.tenantId');
    expect(repository).toContain('CapabilityShadowAppendCommitUnconfirmedError(error)');
    expect(repository).not.toMatch(/@Injectable|Controller|Module\s*\(/);
  });
});
