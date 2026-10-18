import { ConflictException, ForbiddenException, GoneException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import type { CoreEd25519Signer } from '../../auth/core-ed25519-signer.js';
import { canonicalSha256, isSha, sha256Hex, toolPath } from '../../auth/read-delegation/read-delegation.contract.js';
import { assertDelegationFacts, assertToolReservation, readRunFacts } from '../../auth/read-delegation/read-delegation-facts.js';
import {
  assertConsentCurrent, assertDelegatedClientVisible, assertMeriReadDelegationReleasable,
  lockDelegation, meriReadDelegationOf, readDelegatedMember, type MeriReadDelegationGrant,
} from '../../auth/read-delegation/read-delegation-request.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { TaskBoundPassiveMemoryPage } from './meri-memory-signed-page-source.js';
import { signMemoryPageProof, type MemoryPageProofClaims } from './meri-memory-page-proof.js';

type Tx = Prisma.TransactionClient;
const OPERATION = Object.freeze({ id: 'search_memory', version: '0.2.0' });
const denied = () => new ForbiddenException('Passive memory page proof refused');
const changed = () => new ConflictException('Passive memory page proof changed');
const expired = () => new GoneException('Passive memory page proof expired');

/** Source-only continuation of the already consumed page token. The response
 * body remains the exact unwrapped 0.2 result; its opaque proof is an HTTP
 * header, never independent authority or a model-visible tool result. */
export async function issueMemoryPageProof(
  prisma: PrismaService,
  signer: CoreEd25519Signer,
  parentRequest: Request,
  page: TaskBoundPassiveMemoryPage,
  grant: MeriReadDelegationGrant,
  activation: Readonly<{ enabled: boolean; now?: () => number }>,
): Promise<{ result: unknown; pageProof: string }> {
  if (!activation?.enabled) throw new ServiceUnavailableException('Passive memory page proof unavailable');
  if (!signer || !page || !grant || meriReadDelegationOf(parentRequest) !== grant ||
      grant.kind !== 'tool' || grant.operation?.id !== OPERATION.id || grant.operation.version !== OPERATION.version ||
      !isSha(grant.bodySha256) || !isSha(grant.correlationSha256)) throw denied();
  const pins = page.eligibility;
  if (pins.parentTokenJti !== grant.jti || pins.parentBodySha256 !== grant.bodySha256 ||
      pins.argumentsSha256 !== grant.argumentsSha256 || pins.callKey !== grant.callKey ||
      pins.clientId !== grant.clientId || pins.resultSha256 !== sha256Hex(canonicalizeCoreRetainedJson(page.result))) throw denied();
  try {
    const signed = await prisma.withSystem(async (tx: Tx) => {
      const d = await lockDelegation(tx, grant.tenantId, grant.delegationId, 'share');
      if (!d || d.userId !== grant.actorId || d.clientId !== grant.clientId || d.runId !== grant.runId ||
          d.conversationId !== grant.conversationId || d.attemptId !== grant.binding.attemptId ||
          d.writerFence !== grant.binding.writerFence || d.policyRevision !== grant.policyRevision) throw changed();
      const facts = await readRunFacts(tx, d.tenantId, d.runId);
      const hard = Math.min(assertDelegationFacts(facts, d, { operation: OPERATION }),
        await assertConsentCurrent(tx, d), grant.hardExpiryMs, pins.hardExpiryMs);
      if (!facts.admittedBinding || canonicalSha256(facts.admittedBinding) !== canonicalSha256(grant.admittedBinding)) throw changed();
      await assertToolReservation(tx, d.runId, grant.callKey, OPERATION, pins.argumentsSha256);
      const member = await readDelegatedMember(tx, d);
      if (member.user.id !== grant.actorId) throw changed();
      await assertDelegatedClientVisible(tx, d.tenantId, member.user.clerkUserId, d.clientId);
      const parent = await tx.$queryRaw<{ consumed: boolean; live: boolean; body_sha256: string; arguments_sha256: string }[]>`
        SELECT consumed_at IS NOT NULL AS consumed, expires_at > clock_timestamp() AS live,
               body_sha256::text AS body_sha256, arguments_sha256::text AS arguments_sha256
          FROM meri_read_tokens WHERE jti = ${grant.jti}::uuid AND tenant_id = ${d.tenantId}::uuid
            AND delegation_id = ${d.id}::uuid AND run_id = ${d.runId}::uuid AND call_key = ${grant.callKey}
            AND kind = 'tool' AND target_method = 'POST' AND target_path = ${toolPath(OPERATION.id)}
            AND superseded_at IS NULL FOR SHARE`;
      if (parent.length !== 1 || parent[0]!.consumed !== true || parent[0]!.live !== true ||
          parent[0]!.body_sha256 !== grant.bodySha256 || parent[0]!.arguments_sha256 !== pins.argumentsSha256) throw changed();
      const iat = Math.floor(facts.dbNowMs / 1000);
      const exp = Math.min(iat + 30, Math.floor(hard / 1000));
      if (exp <= iat + 1 || facts.dbNowMs >= exp * 1000) throw expired();
      const claims: Omit<MemoryPageProofClaims, 'iss' | 'aud' | 'jti'> = {
        sub: d.id, iat, nbf: iat, exp, parentJti: grant.jti, callKey: grant.callKey,
        parentBodySha256: grant.bodySha256!, argumentsSha256: pins.argumentsSha256,
        requestSha256: pins.requestSha256, correlationSha256: grant.correlationSha256!,
        resultSha256: pins.resultSha256, recordsSha256: canonicalSha256(pins.records),
        bindingSha256: canonicalSha256(facts.admittedBinding), policyRevision: d.policyRevision,
        tenantId: d.tenantId, actorId: d.userId, clientId: d.clientId,
        conversationId: d.conversationId, runId: d.runId, attemptId: d.attemptId,
        writerFence: d.writerFence, deadlineMs: exp * 1000,
      };
      return { pageProof: await signMemoryPageProof(signer, claims, AbortSignal.timeout(3000)), expiresAtMs: exp * 1000 };
    }, { timeoutMs: 5000 });
    await assertMeriReadDelegationReleasable(prisma, parentRequest);
    if ((activation.now ?? Date.now)() >= signed.expiresAtMs) throw expired();
    return { result: page.result, pageProof: signed.pageProof };
  } catch (error) {
    if (error instanceof HttpException) throw error;
    throw new ServiceUnavailableException('Passive memory page proof unavailable');
  }
}
