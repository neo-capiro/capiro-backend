import { describe, expect, it, beforeEach, jest } from '@jest/globals';
import { ConflictException, GoneException, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { canonicalSha256, sha256Hex } from '../../auth/read-delegation/read-delegation.contract.js';
import { hasVerifiedToolServiceIdentity } from '../../auth/tool-service-secret.guard.js';
import { readCoreEd25519KeyConfig } from '../../auth/core-ed25519-key-config.js';
import { assertDelegationFacts, assertToolReservation, readRunFacts } from '../../auth/read-delegation/read-delegation-facts.js';
import {
  assertConsentCurrent, assertDelegatedClientVisible, lockDelegation, meriReadServiceIdentityMatches,
  readDelegatedMember,
} from '../../auth/read-delegation/read-delegation-request.js';
import { checkPassiveMemoryEligibility } from './meri-passive-memory-source.js';
import * as helperSource from './meri-memory-helper-source.js';
import { consumeTaskBoundMemoryHelper } from './meri-memory-helper-receiver.js';
import {
  MEMORY_HELPER_KIND, MEMORY_HELPER_PATH, memoryHelperTokenFromAuthorization,
  signMemoryHelperToken, verifyMemoryHelperToken,
} from './meri-memory-helper-token.js';
import { verifyMemoryPageProof } from './meri-memory-page-proof.js';

jest.mock('../../auth/tool-service-secret.guard.js', () => ({ hasVerifiedToolServiceIdentity: jest.fn() }));
jest.mock('../../auth/core-ed25519-key-config.js', () => ({ readCoreEd25519KeyConfig: jest.fn() }));
jest.mock('../../auth/read-delegation/read-delegation-facts.js', () => ({
  assertDelegationFacts: jest.fn(), assertToolReservation: jest.fn(), readRunFacts: jest.fn(),
}));
jest.mock('../../auth/read-delegation/read-delegation-request.js', () => ({
  assertConsentCurrent: jest.fn(), assertDelegatedClientVisible: jest.fn(), lockDelegation: jest.fn(),
  meriReadServiceIdentityMatches: jest.fn(), readDelegatedMember: jest.fn(),
}));
jest.mock('./meri-passive-memory-source.js', () => ({
  checkPassiveMemoryEligibility: jest.fn(), parsePassiveMemoryEligibilityRequest: jest.fn(),
}));
jest.mock('./meri-memory-helper-token.js', () => ({
  MEMORY_HELPER_KIND: 'memory_eligibility', MEMORY_HELPER_PATH: '/api/clio/tools/search_memory_eligibility',
  memoryHelperTokenFromAuthorization: jest.fn(), signMemoryHelperToken: jest.fn(), verifyMemoryHelperToken: jest.fn(),
}));
jest.mock('./meri-memory-page-proof.js', () => ({ verifyMemoryPageProof: jest.fn() }));

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const clientId = '33333333-3333-4333-8333-333333333333';
const conversationId = '44444444-4444-4444-8444-444444444444';
const runId = '55555555-5555-4555-8555-555555555555';
const attemptId = '66666666-6666-4666-8666-666666666666';
const workerId = '77777777-7777-4777-8777-777777777777';
const delegationId = '99999999-9999-4999-8999-999999999999';
const parentJti = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const helperJti = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const nowMs = 1_792_000_000_000;
const hardMs = nowMs + 30_000;
const pageBodySha256 = 'a'.repeat(64);
const argumentsSha256 = 'b'.repeat(64);
const requestSha256 = 'c'.repeat(64);
const resultSha256 = 'd'.repeat(64);
const recordsSha256 = 'e'.repeat(64);
const binding = { tenantId, actorId, conversationId, runId, attemptId, workerId, writerFence: 2 };
const bindingSha256 = canonicalSha256(binding);
const correlation = { binding, subject: { kind: 'client', clientId }, policyRevision: 'f'.repeat(64) };
const correlationJson = canonicalizeCoreRetainedJson(correlation);
const correlationSha256 = sha256Hex(Buffer.from(correlationJson));
const body = Buffer.from(JSON.stringify({ policyRevision: 'f'.repeat(64) }));
const bodySha256 = sha256Hex(body);
const d = { id: delegationId, tenantId, userId: actorId, clientId, conversationId, runId,
  attemptId, writerFence: 2, policyRevision: 'f'.repeat(64) };
const proof = { sub: delegationId, parentJti, callKey: 'call_1', parentBodySha256: pageBodySha256,
  argumentsSha256, requestSha256, resultSha256, recordsSha256, correlationSha256, bindingSha256,
  deadlineMs: hardMs, policyRevision: d.policyRevision, tenantId, actorId, clientId,
  conversationId, runId, attemptId, writerFence: 2 };
const issueBody = { schemaVersion: 1, kind: MEMORY_HELPER_KIND, callKey: 'call_1', method: 'POST',
  path: MEMORY_HELPER_PATH, bodySha256, operation: { id: 'search_memory', version: '0.2.0' },
  argumentsSha256, pageBodySha256, pageRequestSha256: requestSha256, resultSha256,
  recordsSha256, correlationSha256, pageProof: 'a.b.c', retryOf: null };

function issuerRequest(): Request {
  const path = `/api/clio/application-authority/read-delegations/${delegationId}/tokens`;
  return { method: 'POST', path, originalUrl: path, headers: {} } as Request;
}

function receiverRequest(): Request {
  const headers = { authorization: 'CapiroMeriRead a.b.c', 'content-type': 'application/json',
    'x-meri-read-correlation': Buffer.from(correlationJson).toString('base64url') };
  return { method: 'POST', path: MEMORY_HELPER_PATH, originalUrl: MEMORY_HELPER_PATH, headers,
    header(name: string) { return (headers as Record<string, string>)[name.toLowerCase()]; } } as unknown as Request;
}

function queryText(parts: TemplateStringsArray): string { return Array.from(parts).join('?'); }

/** Models Prisma's transaction commit/rollback, with no SQL execution. The
 * unique slot and consumed flag are durable only when the callback resolves. */
function transactionHarness(clockValues: number[] = []) {
  let helpers = 0;
  let consumed = false;
  let insertAttempts = 0;
  let updateAttempts = 0;
  let rollbacks = 0;
  let parentLive = true;
  let releaseParentLive = true;
  const clock = [...clockValues];
  const withSystem = jest.fn(async (run: (tx: unknown) => Promise<unknown>) => {
    let stagedInsert = 0;
    let stagedConsume = false;
    const tx = {
      $queryRaw: jest.fn(async (parts: TemplateStringsArray) => {
        const sql = queryText(parts);
        if (sql.includes('SELECT tenant_id::text AS tenant_id FROM meri_read_delegations')) return [{ tenant_id: tenantId }];
        if (sql.includes('SELECT tool_tokens, delegation_id::text')) return [{ tool_tokens: 1, delegation_id: delegationId }];
        if (sql.includes('floor(extract(epoch FROM clock_timestamp())')) {
          return [{ now_ms: String(clock.shift() ?? nowMs + 5_000) }];
        }
        if (sql.includes('UPDATE meri_read_tokens SET consumed_at')) {
          updateAttempts += 1;
          if (consumed || stagedConsume || helpers === 0) return [];
          stagedConsume = true;
          return [{ parent_jti: parentJti, parent_body_sha256: pageBodySha256,
            page_arguments_sha256: argumentsSha256, page_request_sha256: requestSha256,
            correlation_sha256: correlationSha256, page_result_sha256: resultSha256,
            records_sha256: recordsSha256, binding_sha256: bindingSha256,
            body_sha256: bodySha256, target_path: MEMORY_HELPER_PATH, token_sha256: '1'.repeat(64) }];
        }
        if (sql.includes('FROM meri_read_tokens h JOIN meri_read_tokens p')) {
          return [{ consumed: consumed || stagedConsume, parent_consumed: true, parent_live: releaseParentLive }];
        }
        if (sql.includes('FROM meri_read_tokens WHERE jti =')) {
          return [{ consumed: true, live: parentLive, body_sha256: pageBodySha256,
            arguments_sha256: argumentsSha256 }];
        }
        throw new Error(`unexpected mocked query: ${sql.slice(0, 100)}`);
      }),
      $executeRaw: jest.fn(async () => {
        insertAttempts += 1;
        if (helpers + stagedInsert > 0) throw Object.assign(new Error('unique helper slot'), { code: 'P2002' });
        stagedInsert += 1;
        return 1;
      }),
    };
    try {
      const result = await run(tx);
      helpers += stagedInsert;
      consumed ||= stagedConsume;
      return result;
    } catch (error) {
      rollbacks += 1;
      throw error;
    }
  });
  return { prisma: { withSystem } as unknown as PrismaService,
    state: () => ({ helpers, consumed, insertAttempts, updateAttempts, rollbacks }),
    revokeParent: () => { parentLive = false; },
    revokeAtRelease: () => { releaseParentLive = false; } };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(hasVerifiedToolServiceIdentity).mockReturnValue(true);
  jest.mocked(meriReadServiceIdentityMatches).mockReturnValue(true);
  jest.mocked(readCoreEd25519KeyConfig).mockReturnValue({} as never);
  jest.mocked(memoryHelperTokenFromAuthorization).mockReturnValue('a.b.c');
  jest.mocked(verifyMemoryHelperToken).mockReturnValue({
    ...proof, iss: 'capiro:test', aud: 'capiro:meri-memory-eligibility:v1', jti: helperJti,
    iat: nowMs / 1000, nbf: nowMs / 1000, exp: nowMs / 1000 + 15,
    kind: MEMORY_HELPER_KIND, method: 'POST', path: MEMORY_HELPER_PATH,
    bodySha256, parentBodySha256: pageBodySha256, requestSha256,
    proofDeadlineMs: hardMs, sub: delegationId,
  } as never);
  jest.mocked(verifyMemoryPageProof).mockReturnValue(proof as never);
  jest.mocked(signMemoryHelperToken).mockResolvedValue({ token: 'a.b.c', jti: helperJti, tokenSha256: '1'.repeat(64) });
  jest.mocked(lockDelegation).mockResolvedValue(d as never);
  jest.mocked(readRunFacts).mockResolvedValue({ dbNowMs: nowMs, admittedBinding: binding } as never);
  jest.mocked(assertDelegationFacts).mockReturnValue(hardMs);
  jest.mocked(assertConsentCurrent).mockResolvedValue(hardMs);
  jest.mocked(assertToolReservation).mockResolvedValue(undefined);
  jest.mocked(readDelegatedMember).mockResolvedValue({ user: { id: actorId, clerkUserId: 'clerk_test' },
    membership: { role: 'standard_user', tenant: { slug: 'test' } } } as never);
  jest.mocked(assertDelegatedClientVisible).mockResolvedValue(undefined);
  jest.mocked(checkPassiveMemoryEligibility).mockResolvedValue({ expiresAtMs: nowMs + 10_000 } as never);
});

describe('grant-free passive memory helper transactions', () => {
  it('refuses a signing delay before INSERT and leaves the unique slot empty', async () => {
    const h = transactionHarness([nowMs + 14_100]);
    await expect(helperSource.issueMemoryHelperToken(h.prisma, {} as never, issuerRequest(), delegationId,
      issueBody, { enabled: true })).rejects.toBeInstanceOf(GoneException);
    expect(h.state()).toMatchObject({ helpers: 0, insertAttempts: 0, rollbacks: 1 });
  });

  it('rolls back an INSERT when the second database clock passes the release margin', async () => {
    const h = transactionHarness([nowMs + 5_000, nowMs + 14_100]);
    await expect(helperSource.issueMemoryHelperToken(h.prisma, {} as never, issuerRequest(), delegationId,
      issueBody, { enabled: true })).rejects.toBeInstanceOf(GoneException);
    expect(h.state()).toMatchObject({ helpers: 0, insertAttempts: 1, rollbacks: 1 });
  });

  it('cannot reissue after the unique one-helper slot is committed', async () => {
    const h = transactionHarness();
    await expect(helperSource.issueMemoryHelperToken(h.prisma, {} as never, issuerRequest(), delegationId,
      issueBody, { enabled: true })).resolves.toMatchObject({ schemaVersion: 1, token: 'a.b.c' });
    await expect(helperSource.issueMemoryHelperToken(h.prisma, {} as never, issuerRequest(), delegationId,
      issueBody, { enabled: true })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(h.state()).toMatchObject({ helpers: 1, insertAttempts: 2, rollbacks: 1 });
  });

  it('consumes the helper once; replay has no eligible JTI row', async () => {
    const h = transactionHarness();
    await helperSource.issueMemoryHelperToken(h.prisma, {} as never, issuerRequest(), delegationId,
      issueBody, { enabled: true });
    const callback = jest.spyOn(helperSource, 'assertMemoryHelperCallback').mockReturnValue({} as never);
    try {
      await expect(consumeTaskBoundMemoryHelper(h.prisma, receiverRequest(), body, {},
        { enabled: true, now: () => nowMs })).resolves.toMatchObject({ expiresAtMs: nowMs + 10_000 });
      await expect(consumeTaskBoundMemoryHelper(h.prisma, receiverRequest(), body, {},
        { enabled: true, now: () => nowMs })).rejects.toBeInstanceOf(ConflictException);
      expect(h.state()).toMatchObject({ helpers: 1, consumed: true, updateAttempts: 2 });
      expect(checkPassiveMemoryEligibility).toHaveBeenCalledTimes(1);
    } finally { callback.mockRestore(); }
  });

  it('rolls back consumption if the parent is revoked before callback admission', async () => {
    const h = transactionHarness();
    await helperSource.issueMemoryHelperToken(h.prisma, {} as never, issuerRequest(), delegationId,
      issueBody, { enabled: true });
    h.revokeParent();
    await expect(consumeTaskBoundMemoryHelper(h.prisma, receiverRequest(), body, {},
      { enabled: true, now: () => nowMs })).rejects.toBeInstanceOf(ConflictException);
    expect(h.state()).toMatchObject({ helpers: 1, consumed: false, updateAttempts: 1, rollbacks: 1 });
    expect(checkPassiveMemoryEligibility).not.toHaveBeenCalled();
  });

  it('blocks release when parent authority is revoked after consumption', async () => {
    const h = transactionHarness();
    await helperSource.issueMemoryHelperToken(h.prisma, {} as never, issuerRequest(), delegationId,
      issueBody, { enabled: true });
    h.revokeAtRelease();
    const callback = jest.spyOn(helperSource, 'assertMemoryHelperCallback').mockReturnValue({} as never);
    try {
      await expect(consumeTaskBoundMemoryHelper(h.prisma, receiverRequest(), body, {},
        { enabled: true, now: () => nowMs })).rejects.toBeInstanceOf(ConflictException);
      expect(h.state()).toMatchObject({ helpers: 1, consumed: true, updateAttempts: 1, rollbacks: 1 });
      expect(checkPassiveMemoryEligibility).toHaveBeenCalledTimes(1);
    } finally { callback.mockRestore(); }
  });
});
