import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMeriHermesAuthorityContentionV2 } from './meri-hermes-predispatch-transaction.js';

const here = __dirname;
const exactRequest = readFileSync(join(here, 'meri-hermes-exact-dispatch-request.ts'), 'utf8');
const transaction = readFileSync(join(here, 'meri-hermes-predispatch-transaction.ts'), 'utf8');
const authority = readFileSync(join(here, 'meri-hermes-predispatch-current-authority.verifier.ts'), 'utf8');
const intentRepository = readFileSync(join(here, 'meri-hermes-dispatch-intent.repository.ts'), 'utf8');
const activeClient = readFileSync(join(here, 'meri-hermes-runtime.client.ts'), 'utf8');
const activeAdapter = readFileSync(join(here, 'meri-hermes-runtime.adapter.ts'), 'utf8');
const meriModule = readFileSync(join(here, '..', 'meri.module.ts'), 'utf8');

describe('Phase 4 dormant exact pre-dispatch transaction source contract', () => {
  test('recognizes direct and Prisma-wrapped NOWAIT rollback, not commit ambiguity', () => {
    expect(isMeriHermesAuthorityContentionV2({ code: '55P03' })).toBe(true);
    expect(isMeriHermesAuthorityContentionV2({ code: 'P2010',
      meta: { code: '55P03', message: 'could not obtain lock on row' } })).toBe(true);
    expect(isMeriHermesAuthorityContentionV2({ code: 'P2010',
      meta: { code: '40P01' } })).toBe(false);
    expect(isMeriHermesAuthorityContentionV2(new Error('55P03 in unrelated text'))).toBe(false);
  });
  test('builds one private serialization and returns only defensive exact-byte copies', () => {
    expect(exactRequest).toContain('const serialized = JSON.stringify(body)');
    expect(exactRequest).toContain('readonly #bodyBytes: Buffer');
    expect(exactRequest).toContain('Uint8Array.from(this.#bodyBytes)');
    expect(exactRequest).toContain('createMeriDispatchRequestIdentityV2');
    expect(exactRequest).toContain('sourceMessage:');
    expect(exactRequest).toContain('readonly sessionId: string | null');
    expect(exactRequest).not.toMatch(/fetch\(|axios|HttpService/);
  });

  test('places message, run/event, reservation, generations and intent under one transaction', () => {
    expect(transaction).toContain("'dispatch.prepare'");
    expect(transaction).toContain('pg_advisory_xact_lock');
    expect(transaction).toContain('FOR UPDATE');
    expect(transaction).toContain('INSERT INTO meri_agent_budget_periods');
    expect(transaction).toContain('INSERT INTO meri_agent_run_reservations');
    expect(transaction).toContain('tx.clioMessage.create');
    expect(authority).toContain('tx.meriExecutionScope.create');
    expect(authority).toContain('tx.meriExecutionScope.update');
    expect(authority).not.toContain('tx.meriExecutionScope.upsert');
    expect(transaction).toContain('this.authority.deriveAndSyncScope(tx');
    expect(transaction).toContain('Phase 4 pre-dispatch authority verifier is required');
    expect(transaction).toContain('tx.meriAgentRun.create');
    expect(transaction).toContain('tx.meriAgentRunEvent.create');
    expect(transaction).toContain('this.intents.prepareInTransaction(tx, identity)');
    expect(transaction).toContain("kind: 'UNKNOWN'");
    expect(transaction).toContain('launchAuthorized: false');
  });

  test('accepts no caller authority and persists a detached authority-generated envelope/context', () => {
    const inputContract = transaction.slice(
      transaction.indexOf('export interface MeriHermesPreDispatchPrepareInputV2'),
      transaction.indexOf('export type MeriHermesPreDispatchPrepareResultV2'),
    );
    expect(inputContract).not.toContain('envelope');
    expect(inputContract).not.toContain('actorContext');
    expect(inputContract).toContain('authenticatedPrincipal');
    expect(inputContract).toContain('intent: Readonly<MeriHermesPreDispatchIntentV2>');
    expect(inputContract).not.toContain('request: MeriHermesExactDispatchRequestV2');
    expect(transaction).toContain('envelope: MeriHermesAuthorizationEnvelope');
    expect(transaction).toContain('actorContext: TenantContext');
    expect(transaction).toContain('meriDispatchCanonicalJsonSnapshot(authority)');
    expect(transaction).toContain('validSet(toolPolicy.allow)');
    expect(transaction).toContain('sorted(toolPolicy.allow) && sorted(toolPolicy.deny)');
    expect(transaction).toContain('authority.metadata.catalogDigest === identity.catalogDigest');
    expect(transaction).toContain('authority.metadata.retainUntilEpochMicros === identity.retainUntilEpochMicros');
    expect(transaction).toContain('isDeepStrictEqual(actualBody, expectedBody)');
    expect(transaction).toContain('matchesMeriDispatchReceivedRequestV2');
  });

  test('locks the real nested Hermes session epoch and remains dormant', () => {
    expect(transaction).toContain("metadata_jsonb #>> '{hermes,sessionEpoch}'");
    expect(transaction).toContain("metadata_jsonb #>> '{hermes,sessionId}'");
    expect(intentRepository).toContain("metadata_jsonb #>> '{hermes,sessionEpoch}'");
    expect(transaction.indexOf('this.intents.resolveReplayInTransaction'))
      .toBeLessThan(transaction.indexOf("metadata_jsonb #>> '{hermes,sessionEpoch}'"));
    expect(transaction).toContain('WITH authoritative_clock AS');
    expect(transaction).toContain('dbNowEpochMicros < claim');
    expect(transaction).toContain('delivery <= expiresMicros');
    expect(transaction).toContain('authority.metadata.workerCredentialNotAfterEpochMicros');
    expect(transaction).toContain('meriDispatchSourceMessageSha256V2');
    expect(transaction).toContain('MeriHermesPreDispatchAuthorityDecisionV2');
    expect(transaction).toContain('envelope: MeriHermesAuthorizationEnvelope');
    expect(transaction).toContain('actorContext: TenantContext');
    expect(transaction).toContain('const snapshot = this.snapshotAtEntry(input)');
    expect(transaction).toContain('meriDispatchCanonicalJsonSnapshot(authority)');
    expect(transaction.indexOf('const clocks = await tx.$queryRaw<DbClockRow[]>'))
      .toBeGreaterThan(transaction.indexOf('this.authority.deriveAndSyncScope(tx'));
    expect(transaction.indexOf('pg_advisory_xact_lock(hashtext(${intent.runId}))'))
      .toBeLessThan(transaction.indexOf('this.intents.resolveReplayInTransaction'));
    expect(transaction.indexOf('meri_phase4_try_lock_authority_fence_exclusive'))
      .toBeLessThan(transaction.indexOf("metadata_jsonb #>> '{hermes,sessionEpoch}'"));
    expect(transaction).toContain("if (!period) throw new RollbackPreDispatch");
    expect(transaction).toContain("this.rejected('authority_contention')");
    expect(transaction).toContain('scopeRow.tenant_id !== intent.tenantId');
    expect(transaction).toContain("scopeRow.principal_type !== 'user'");
    expect(transaction).toContain('scopeRow.principal_id !== intent.actorId');
    expect(transaction).toContain("scopeRow.kind !== 'private'");
    expect(transaction).toContain('scopeRow.authorization_version !== authority.metadata.authorizationVersion');
    expect(activeClient).not.toContain('MeriHermesExactDispatchRequestV2');
    expect(activeAdapter).not.toContain('MeriHermesPreDispatchTransactionV2');
    expect(meriModule).not.toContain('MeriHermesPreDispatchTransactionV2');
    expect(transaction).not.toMatch(/fetch\(|axios|HttpService/);
  });
});
