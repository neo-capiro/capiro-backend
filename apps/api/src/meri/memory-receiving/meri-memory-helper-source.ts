import { ConflictException, ForbiddenException, GoneException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import type { CoreEd25519Signer } from '../../auth/core-ed25519-signer.js';
import { hasVerifiedToolServiceIdentity } from '../../auth/tool-service-secret.guard.js';
import { canonicalSha256, closed, isSha, sha256Hex, toolPath } from '../../auth/read-delegation/read-delegation.contract.js';
import { assertDelegationFacts, assertToolReservation, readRunFacts } from '../../auth/read-delegation/read-delegation-facts.js';
import {
  assertConsentCurrent, assertDelegatedClientVisible, lockDelegation, readDelegatedMember,
} from '../../auth/read-delegation/read-delegation-request.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { parsePassiveMemoryEligibilityRequest, type PassiveMemoryEligibilityRequest } from './meri-passive-memory-source.js';
import { MEMORY_HELPER_KIND, MEMORY_HELPER_PATH, signMemoryHelperToken, type MemoryHelperClaims } from './meri-memory-helper-token.js';
import { verifyMemoryPageProof, type MemoryPageProofClaims } from './meri-memory-page-proof.js';

type Tx = Prisma.TransactionClient;
const OPERATION = Object.freeze({ id: 'search_memory', version: '0.2.0' });
const CALL_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_BODY_BYTES = 16_384;
const CALLBACK_KEYS = [
  'operation', 'input', 'metadata', 'normalizationContext', 'argumentsSha256', 'requestSha256',
  'binding', 'subject', 'policyRevision', 'sourceIds', 'resultSha256', 'records', 'deadlineMs',
] as const;
const denied = () => new ForbiddenException('Passive memory helper refused');
const changed = () => new ConflictException('Passive memory helper changed');
const expired = () => new GoneException('Passive memory helper expired');

/** Read the database clock again after KMS work and after INSERT. If signing
 * used up the short helper lifetime, throw inside the transaction so the
 * one-per-parent unique slot is rolled back instead of stranded. */
export async function assertMemoryHelperIssueFresh(
  tx: Pick<Tx, '$queryRaw'>,
  expiresAtMs: number,
): Promise<void> {
  const rows = await tx.$queryRaw<{ now_ms: string }[]>`
    SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS now_ms`;
  const dbNowMs = Number(rows[0]?.now_ms);
  if (rows.length !== 1 || !Number.isSafeInteger(dbNowMs) || dbNowMs >= expiresAtMs - 1000) throw expired();
}

/** The one helper issuance request sent to the existing service-only token
 * endpoint after Meri validates the unchanged 0.2 page. A page proof is
 * evidence of Core's prior page, never authority by itself. */
export interface MemoryHelperIssueRequest {
  schemaVersion: 1;
  kind: typeof MEMORY_HELPER_KIND;
  callKey: string;
  method: 'POST';
  path: typeof MEMORY_HELPER_PATH;
  bodySha256: string;
  operation: typeof OPERATION;
  argumentsSha256: string;
  pageBodySha256: string;
  pageRequestSha256: string;
  resultSha256: string;
  recordsSha256: string;
  correlationSha256: string;
  pageProof: string;
  retryOf: null;
}

export function parseMemoryHelperIssueRequest(raw: unknown): MemoryHelperIssueRequest {
  const v = closed(raw, [
    'schemaVersion', 'kind', 'callKey', 'method', 'path', 'bodySha256', 'operation',
    'argumentsSha256', 'pageBodySha256', 'pageRequestSha256', 'resultSha256',
    'recordsSha256', 'correlationSha256', 'pageProof', 'retryOf',
  ], 'memory helper');
  const op = closed(v.operation, ['id', 'version'], 'memory helper operation');
  if (v.schemaVersion !== 1 || v.kind !== MEMORY_HELPER_KIND ||
      typeof v.callKey !== 'string' || !CALL_KEY.test(v.callKey) ||
      v.method !== 'POST' || v.path !== MEMORY_HELPER_PATH ||
      op.id !== OPERATION.id || op.version !== OPERATION.version ||
      ![v.bodySha256, v.argumentsSha256, v.pageBodySha256, v.pageRequestSha256,
        v.resultSha256, v.recordsSha256, v.correlationSha256].every(isSha) ||
      typeof v.pageProof !== 'string' || v.pageProof.length > 8192 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v.pageProof) ||
      v.retryOf !== null) throw denied();
  return v as unknown as MemoryHelperIssueRequest;
}

function requestMatchesProof(t: MemoryHelperIssueRequest, p: MemoryPageProofClaims, delegationId: string): boolean {
  return p.sub === delegationId && t.callKey === p.callKey &&
    t.argumentsSha256 === p.argumentsSha256 && t.pageBodySha256 === p.parentBodySha256 &&
    t.pageRequestSha256 === p.requestSha256 && t.resultSha256 === p.resultSha256 &&
    t.recordsSha256 === p.recordsSha256 && t.correlationSha256 === p.correlationSha256;
}

/** Unmounted grant-free issuer: inserts exactly one child row in the existing
 * `meri_read_tokens` table. It requires the 100000 additive migration, but no
 * new application table privilege and no increment to the ordinary tool slot. */
export async function issueMemoryHelperToken(
  prisma: PrismaService,
  signer: CoreEd25519Signer,
  req: Request,
  delegationId: string,
  raw: unknown,
  activation: Readonly<{ enabled: boolean }>,
): Promise<{ schemaVersion: 1; token: string; expiresAtMs: number }> {
  if (!activation?.enabled) throw new ServiceUnavailableException('Passive memory helper unavailable');
  // A proof alone never substitutes for the existing verified service marker.
  const target = `/api/clio/application-authority/read-delegations/${delegationId}/tokens`;
  if (!signer || !hasVerifiedToolServiceIdentity(req) || req.headers.authorization !== undefined ||
      req.method !== 'POST' || req.originalUrl !== req.path ||
      (req.originalUrl.startsWith('/api/') ? req.originalUrl : `/api${req.originalUrl}`) !== target)
    throw denied();
  const t = parseMemoryHelperIssueRequest(raw);
  try {
    return await prisma.withSystem(async (tx: Tx) => {
      const found = await tx.$queryRaw<{ tenant_id: string }[]>`
        SELECT tenant_id::text AS tenant_id FROM meri_read_delegations WHERE id = ${delegationId}::uuid FOR UPDATE`;
      if (found.length !== 1) throw changed();
      const d = await lockDelegation(tx, found[0]!.tenant_id, delegationId, 'share');
      if (!d) throw changed();
      const facts = await readRunFacts(tx, d.tenantId, d.runId);
      const proof = verifyMemoryPageProof(t.pageProof, signer, facts.dbNowMs);
      if (!proof || !requestMatchesProof(t, proof, delegationId) ||
          proof.tenantId !== d.tenantId || proof.actorId !== d.userId || proof.clientId !== d.clientId ||
          proof.conversationId !== d.conversationId || proof.runId !== d.runId ||
          proof.attemptId !== d.attemptId || proof.writerFence !== d.writerFence ||
          proof.policyRevision !== d.policyRevision) throw denied();
      const hard = Math.min(assertDelegationFacts(facts, d, { operation: OPERATION }),
        await assertConsentCurrent(tx, d), proof.deadlineMs);
      if (!facts.admittedBinding || canonicalSha256(facts.admittedBinding) !== proof.bindingSha256 ||
          facts.dbNowMs >= hard) throw changed();
      await assertToolReservation(tx, d.runId, t.callKey, OPERATION, t.argumentsSha256);
      const member = await readDelegatedMember(tx, d);
      await assertDelegatedClientVisible(tx, d.tenantId, member.user.clerkUserId, d.clientId);
      const parent = await tx.$queryRaw<{ consumed: boolean; live: boolean; body_sha256: string; arguments_sha256: string }[]>`
        SELECT consumed_at IS NOT NULL AS consumed, expires_at > clock_timestamp() AS live,
               body_sha256::text AS body_sha256, arguments_sha256::text AS arguments_sha256
          FROM meri_read_tokens WHERE jti = ${proof.parentJti}::uuid AND tenant_id = ${d.tenantId}::uuid
            AND delegation_id = ${d.id}::uuid AND run_id = ${d.runId}::uuid AND call_key = ${t.callKey}
            AND kind = 'tool' AND target_method = 'POST' AND target_path = ${toolPath(OPERATION.id)}
            AND superseded_at IS NULL FOR SHARE`;
      if (parent.length !== 1 || parent[0]!.consumed !== true || parent[0]!.live !== true ||
          parent[0]!.body_sha256 !== proof.parentBodySha256 ||
          parent[0]!.arguments_sha256 !== proof.argumentsSha256) throw changed();
      const slot = await tx.$queryRaw<{ tool_tokens: number; delegation_id: string }[]>`
        SELECT tool_tokens, delegation_id::text AS delegation_id FROM meri_read_delegation_slots
         WHERE run_id = ${d.runId}::uuid AND call_key = ${t.callKey} FOR UPDATE`;
      if (slot.length !== 1 || Number(slot[0]!.tool_tokens) !== 1 || slot[0]!.delegation_id !== d.id) throw changed();
      const iat = Math.floor(facts.dbNowMs / 1000);
      const exp = Math.min(iat + 15, Math.floor(hard / 1000));
      if (exp <= iat + 1 || facts.dbNowMs >= exp * 1000) throw expired();
      const claims: Omit<MemoryHelperClaims, 'iss' | 'aud' | 'jti'> = {
        sub: d.id, iat, nbf: iat, exp, kind: MEMORY_HELPER_KIND,
        parentJti: proof.parentJti, callKey: t.callKey, method: 'POST', path: MEMORY_HELPER_PATH,
        bodySha256: t.bodySha256, parentBodySha256: proof.parentBodySha256,
        argumentsSha256: t.argumentsSha256, requestSha256: t.pageRequestSha256,
        correlationSha256: t.correlationSha256, resultSha256: t.resultSha256,
        recordsSha256: t.recordsSha256, bindingSha256: proof.bindingSha256,
        proofDeadlineMs: proof.deadlineMs,
        tenantId: d.tenantId, actorId: d.userId, clientId: d.clientId,
        conversationId: d.conversationId, runId: d.runId, attemptId: d.attemptId, writerFence: d.writerFence,
      };
      const signed = await signMemoryHelperToken(signer, claims, AbortSignal.timeout(3000));
      await assertMemoryHelperIssueFresh(tx, exp * 1000);
      await tx.$executeRaw`
        INSERT INTO meri_read_tokens (jti, token_sha256, tenant_id, delegation_id, run_id, call_key,
          kind, target_method, target_path, body_sha256, arguments_sha256, request_digest, issued_at, expires_at,
          parent_jti, parent_body_sha256, page_arguments_sha256, page_request_sha256,
          correlation_sha256, page_result_sha256, records_sha256, binding_sha256)
        VALUES (${signed.jti}::uuid, ${signed.tokenSha256}, ${d.tenantId}::uuid, ${d.id}::uuid,
          ${d.runId}::uuid, ${t.callKey}, ${MEMORY_HELPER_KIND}, 'POST', ${MEMORY_HELPER_PATH},
          ${t.bodySha256}, NULL, ${canonicalSha256({ parentJti: proof.parentJti, bodySha256: t.bodySha256 })},
          ${new Date(iat * 1000)}, ${new Date(exp * 1000)},
          ${proof.parentJti}::uuid, ${proof.parentBodySha256}, ${t.argumentsSha256},
          ${t.pageRequestSha256}, ${t.correlationSha256}, ${t.resultSha256},
          ${t.recordsSha256}, ${proof.bindingSha256})`;
      await assertMemoryHelperIssueFresh(tx, exp * 1000);
      return { schemaVersion: 1 as const, token: signed.token, expiresAtMs: exp * 1000 };
    }, { timeoutMs: 5000 });
  } catch (error) {
    if (error instanceof HttpException) throw error;
    throw new ServiceUnavailableException('Passive memory helper unavailable');
  }
}

/** Pure callback pin check; the receiver first consumes the JTI and rechecks
 * parent and original authority in the same transaction. */
export function assertMemoryHelperCallback(
  ctx: Pick<TenantContext, 'tenantId' | 'userId'>,
  raw: unknown,
  rawBody: Buffer,
  claims: MemoryHelperClaims,
  stored: Readonly<{ parent_jti: string; parent_body_sha256: string; page_arguments_sha256: string;
    page_request_sha256: string; correlation_sha256: string; page_result_sha256: string;
    records_sha256: string; binding_sha256: string; body_sha256: string }>,
  nowMs: number,
): PassiveMemoryEligibilityRequest {
  if (!Buffer.isBuffer(rawBody) || rawBody.length < 1 || rawBody.length > MAX_BODY_BYTES ||
      sha256Hex(rawBody) !== claims.bodySha256 || claims.bodySha256 !== stored.body_sha256 ||
      claims.parentJti !== stored.parent_jti || claims.parentBodySha256 !== stored.parent_body_sha256 ||
      claims.argumentsSha256 !== stored.page_arguments_sha256 || claims.requestSha256 !== stored.page_request_sha256 ||
      claims.correlationSha256 !== stored.correlation_sha256 || claims.resultSha256 !== stored.page_result_sha256 ||
      claims.recordsSha256 !== stored.records_sha256 || claims.bindingSha256 !== stored.binding_sha256) throw denied();
  const request = parsePassiveMemoryEligibilityRequest(raw, ctx, nowMs);
  if (rawBody.toString('utf8') !== JSON.stringify(raw) ||
      !raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).join(',') !== CALLBACK_KEYS.join(',') ||
      request.input.clientId !== claims.clientId || request.binding.runId !== claims.runId ||
      request.binding.conversationId !== claims.conversationId || request.binding.attemptId !== claims.attemptId ||
      request.binding.writerFence !== claims.writerFence ||
      request.argumentsSha256 !== claims.argumentsSha256 || request.requestSha256 !== claims.requestSha256 ||
      request.resultSha256 !== claims.resultSha256 || canonicalSha256(request.records) !== claims.recordsSha256 ||
      canonicalSha256(request.binding) !== claims.bindingSha256 ||
      canonicalSha256({ binding: request.binding, subject: request.subject,
        policyRevision: request.policyRevision, normalizationContext: request.normalizationContext }) !== claims.correlationSha256 ||
      request.deadlineMs > claims.proofDeadlineMs || request.deadlineMs <= nowMs) throw denied();
  return request;
}
