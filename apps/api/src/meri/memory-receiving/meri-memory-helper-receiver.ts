import { ConflictException, ForbiddenException, GoneException, HttpException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { TENANT_HEADER, type TenantContext, type TenantRole } from '@capiro/shared';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { readCoreEd25519KeyConfig } from '../../auth/core-ed25519-key-config.js';
import { canonicalSha256, sha256Hex, toolPath } from '../../auth/read-delegation/read-delegation.contract.js';
import { assertDelegationFacts, assertToolReservation, readRunFacts } from '../../auth/read-delegation/read-delegation-facts.js';
import {
  assertConsentCurrent, assertDelegatedClientVisible, lockDelegation, meriReadServiceIdentityMatches,
  readDelegatedMember,
} from '../../auth/read-delegation/read-delegation-request.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { checkPassiveMemoryEligibility } from './meri-passive-memory-source.js';
import { assertMemoryHelperCallback } from './meri-memory-helper-source.js';
import {
  MEMORY_HELPER_KIND, MEMORY_HELPER_PATH, memoryHelperTokenFromAuthorization,
  verifyMemoryHelperToken, type MemoryHelperClaims,
} from './meri-memory-helper-token.js';

type Tx = Prisma.TransactionClient;
const OPERATION = Object.freeze({ id: 'search_memory', version: '0.2.0' });
const denied = () => new ForbiddenException('Passive memory helper refused');
const changed = () => new ConflictException('Passive memory helper changed');
const expired = () => new GoneException('Passive memory helper expired');

interface StoredHelper {
  parent_jti: string;
  parent_body_sha256: string;
  page_arguments_sha256: string;
  page_request_sha256: string;
  correlation_sha256: string;
  page_result_sha256: string;
  records_sha256: string;
  binding_sha256: string;
  body_sha256: string;
  target_path: string;
  token_sha256: string;
}

function exactTarget(req: Request): boolean {
  const original = req.originalUrl ?? req.url ?? '';
  return req.method === 'POST' && req.path === original && !original.includes('?') && !original.includes('#') &&
    (original.startsWith('/api/') ? original : `/api${original}`) === MEMORY_HELPER_PATH;
}

function assertCorrelationHeader(req: Request, digest: string): void {
  const header = req.headers['x-meri-read-correlation'];
  if (typeof header !== 'string' || header.length > 11_000 || !/^[A-Za-z0-9_-]+$/.test(header)) throw denied();
  const bytes = Buffer.from(header, 'base64url');
  if (bytes.length > 8192 || bytes.toString('base64url') !== header ||
      !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) throw denied();
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')) as unknown; } catch { throw denied(); }
  if (canonicalizeCoreRetainedJson(value) !== bytes.toString('utf8') || sha256Hex(bytes) !== digest) throw denied();
}

async function assertMemoryHelperReleasable(
  prisma: PrismaService,
  claims: MemoryHelperClaims,
  ctx: TenantContext,
  expiresAtMs: number,
): Promise<void> {
  await prisma.withSystem(async (tx: Tx) => {
    const d = await lockDelegation(tx, claims.tenantId, claims.sub, 'share');
    if (!d || d.userId !== ctx.userId || d.clientId !== claims.clientId ||
        d.runId !== claims.runId || d.attemptId !== claims.attemptId || d.writerFence !== claims.writerFence) throw changed();
    const facts = await readRunFacts(tx, d.tenantId, d.runId);
    const hard = Math.min(assertDelegationFacts(facts, d, { operation: OPERATION }), await assertConsentCurrent(tx, d),
      claims.exp * 1000, expiresAtMs);
    if (facts.dbNowMs >= hard || !facts.admittedBinding ||
        canonicalSha256(facts.admittedBinding) !== claims.bindingSha256) throw expired();
    await assertToolReservation(tx, d.runId, claims.callKey, OPERATION, claims.argumentsSha256);
    const member = await readDelegatedMember(tx, d);
    if (member.user.id !== ctx.userId || member.user.clerkUserId !== ctx.clerkUserId) throw changed();
    await assertDelegatedClientVisible(tx, d.tenantId, member.user.clerkUserId, d.clientId);
    const rows = await tx.$queryRaw<{ consumed: boolean; parent_consumed: boolean; parent_live: boolean }[]>`
      SELECT h.consumed_at IS NOT NULL AS consumed,
             p.consumed_at IS NOT NULL AS parent_consumed,
             p.expires_at > clock_timestamp() AND p.superseded_at IS NULL AS parent_live
        FROM meri_read_tokens h JOIN meri_read_tokens p ON p.jti = h.parent_jti
       WHERE h.jti = ${claims.jti}::uuid AND h.tenant_id = ${d.tenantId}::uuid
         AND h.delegation_id = ${d.id}::uuid AND h.run_id = ${d.runId}::uuid
         AND h.call_key = ${claims.callKey} AND h.kind = ${MEMORY_HELPER_KIND}
         AND p.kind = 'tool' AND p.target_path = ${toolPath(OPERATION.id)} LIMIT 2`;
    if (rows.length !== 1 || rows[0]!.consumed !== true || rows[0]!.parent_consumed !== true ||
        rows[0]!.parent_live !== true) throw changed();
  }, { timeoutMs: 5000 });
}

/** Unmounted source receiver. A future HTTP owner must capture exact helper
 * body bytes separately from the ordinary CapiroMeriRead raw-body middleware,
 * then pass the actual Request and verified service identity to this function.
 * It remains closed unless activation is explicitly qualified. */
export async function consumeTaskBoundMemoryHelper(
  prisma: PrismaService,
  req: Request,
  rawBody: Buffer,
  env: NodeJS.ProcessEnv,
  activation: Readonly<{ enabled: boolean; now?: () => number }>,
) {
  if (!activation?.enabled) throw new ServiceUnavailableException('Passive memory helper unavailable');
  const now = activation.now ?? Date.now;
  if (!exactTarget(req) || !meriReadServiceIdentityMatches(req, env) ||
      req.header('x-capiro-impersonate-tenant') !== undefined || req.header(TENANT_HEADER) !== undefined ||
      !Buffer.isBuffer(rawBody) || rawBody.length < 1 || rawBody.length > 16_384 ||
      !Buffer.from(rawBody.toString('utf8'), 'utf8').equals(rawBody)) throw denied();
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:;\s*charset=(?:utf-8|utf8))?$/i.test(contentType) ||
      req.headers['content-encoding'] !== undefined) throw denied();
  let config: ReturnType<typeof readCoreEd25519KeyConfig>;
  try { config = readCoreEd25519KeyConfig(env, 'MERI_READ_DELEGATION_SIGNER'); } catch { config = null; }
  if (!config) throw new ServiceUnavailableException('Passive memory helper unavailable');
  const token = memoryHelperTokenFromAuthorization(req.headers.authorization);
  const claims = token ? verifyMemoryHelperToken(token, config, now()) : null;
  if (!token || !claims) throw new UnauthorizedException('Passive memory helper credential refused');
  assertCorrelationHeader(req, claims.correlationSha256);
  if (sha256Hex(rawBody) !== claims.bodySha256) throw denied();
  let raw: unknown;
  try { raw = JSON.parse(rawBody.toString('utf8')) as unknown; } catch { throw denied(); }
  try {
    const admitted = await prisma.withSystem(async (tx: Tx) => {
      const d = await lockDelegation(tx, claims.tenantId, claims.sub, 'share');
      if (!d || d.id !== claims.sub || d.tenantId !== claims.tenantId || d.userId !== claims.actorId ||
          d.clientId !== claims.clientId || d.conversationId !== claims.conversationId ||
          d.runId !== claims.runId || d.attemptId !== claims.attemptId || d.writerFence !== claims.writerFence) throw changed();
      const used = await tx.$queryRaw<StoredHelper[]>`
        UPDATE meri_read_tokens SET consumed_at = clock_timestamp()
         WHERE jti = ${claims.jti}::uuid AND token_sha256 = ${sha256Hex(Buffer.from(token, 'ascii'))}
           AND tenant_id = ${d.tenantId}::uuid AND delegation_id = ${d.id}::uuid AND run_id = ${d.runId}::uuid
           AND call_key = ${claims.callKey} AND kind = ${MEMORY_HELPER_KIND}
           AND consumed_at IS NULL AND superseded_at IS NULL AND expires_at > clock_timestamp()
        RETURNING parent_jti::text AS parent_jti, parent_body_sha256::text AS parent_body_sha256,
          page_arguments_sha256::text AS page_arguments_sha256, page_request_sha256::text AS page_request_sha256,
          correlation_sha256::text AS correlation_sha256, page_result_sha256::text AS page_result_sha256,
          records_sha256::text AS records_sha256, binding_sha256::text AS binding_sha256,
          body_sha256::text AS body_sha256, target_path, token_sha256::text AS token_sha256`;
      if (used.length !== 1 || used[0]!.target_path !== MEMORY_HELPER_PATH) throw changed();
      const facts = await readRunFacts(tx, d.tenantId, d.runId);
      const hard = Math.min(assertDelegationFacts(facts, d, { operation: OPERATION }),
        await assertConsentCurrent(tx, d), claims.exp * 1000);
      if (facts.dbNowMs >= hard || !facts.admittedBinding ||
          canonicalSha256(facts.admittedBinding) !== claims.bindingSha256 || d.policyRevision !== (raw as Record<string, unknown>)?.policyRevision)
        throw changed();
      await assertToolReservation(tx, d.runId, claims.callKey, OPERATION, claims.argumentsSha256);
      const parent = await tx.$queryRaw<{ consumed: boolean; live: boolean; body_sha256: string; arguments_sha256: string }[]>`
        SELECT consumed_at IS NOT NULL AS consumed, expires_at > clock_timestamp() AS live,
               body_sha256::text AS body_sha256, arguments_sha256::text AS arguments_sha256
          FROM meri_read_tokens WHERE jti = ${claims.parentJti}::uuid AND tenant_id = ${d.tenantId}::uuid
            AND delegation_id = ${d.id}::uuid AND run_id = ${d.runId}::uuid AND call_key = ${claims.callKey}
            AND kind = 'tool' AND target_method = 'POST' AND target_path = ${toolPath(OPERATION.id)}
            AND superseded_at IS NULL FOR SHARE`;
      if (parent.length !== 1 || parent[0]!.consumed !== true || parent[0]!.live !== true ||
          parent[0]!.body_sha256 !== claims.parentBodySha256 ||
          parent[0]!.arguments_sha256 !== claims.argumentsSha256) throw changed();
      const member = await readDelegatedMember(tx, d);
      await assertDelegatedClientVisible(tx, d.tenantId, member.user.clerkUserId, d.clientId);
      const ctx: TenantContext = {
        tenantId: d.tenantId, tenantSlug: member.membership.tenant.slug,
        userId: member.user.id, clerkUserId: member.user.clerkUserId,
        role: member.membership.role as TenantRole,
      };
      const callback = assertMemoryHelperCallback(ctx, raw, rawBody, claims, used[0]!, facts.dbNowMs);
      return { ctx, callback };
    }, { timeoutMs: 5000 });
    const receipt = await checkPassiveMemoryEligibility(prisma, admitted.ctx, admitted.callback, now);
    // The final Meri dispatcher narrows to the returned receipt expiry. It
    // must not outlive the helper credential that admitted this exact body.
    const expiresAtMs = Math.min(receipt.expiresAtMs, claims.exp * 1000);
    await assertMemoryHelperReleasable(prisma, claims, admitted.ctx, expiresAtMs);
    if (now() >= expiresAtMs) throw expired();
    return { ...receipt, expiresAtMs };
  } catch (error) {
    if (error instanceof HttpException) throw error;
    throw new ServiceUnavailableException('Passive memory helper unavailable');
  }
}
