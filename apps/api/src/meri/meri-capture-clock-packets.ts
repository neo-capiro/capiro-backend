import { isDeepStrictEqual } from 'node:util';
import type { TenantContext } from '@capiro/shared';
import {
  meriCaptureClockExecutionBlockers,
  verifyMeriCaptureEvidenceReceipt,
  type MeriCaptureClockApiJoin,
  type MeriCaptureCompilerPacket,
  type MeriContextPacketSummary,
  type MeriServerReadonlyCapturePolicy,
  type SignedMeriCaptureEvidenceReceipt,
} from '@capiro/meriv2-core';
import type { PrismaService } from '../prisma/prisma.service.js';

/** Private final API owner: no caller route, arbitrary IDs or inferred policy proof. */
export async function readMeriCaptureClockPackets(args: {
  prisma: PrismaService;
  ctx: TenantContext;
  policy: MeriServerReadonlyCapturePolicy;
  orchestrator: SignedMeriCaptureEvidenceReceipt;
  initialPacket: MeriContextPacketSummary | null;
  secret?: string;
}): Promise<MeriCaptureClockApiJoin | null> {
  if (!args.policy.semanticClock) return null;
  try {
    const { policy, ctx, initialPacket } = args;
    const turnId = policy.turnId;
    const receipt = verifyMeriCaptureEvidenceReceipt(
      args.orchestrator,
      policy,
      args.secret ?? process.env.INTERNAL_SERVICE_SECRET,
    );
    if (
      policy.syntheticReadBudget ||
      policy.fixtureVersion !== 'meri-live-v1-2026-09-26.1' ||
      !['01', '14', '20', '72'].includes(policy.caseId ?? '') ||
      !turnId ||
      ctx.tenantId !== policy.tenantId ||
      ctx.userId !== policy.actorUserId ||
      receipt.semanticClock?.apiJoin !== 'PENDING' ||
      receipt.semanticClock.api ||
      meriCaptureClockExecutionBlockers(receipt).length ||
      !initialPacket?.packetId ||
      initialPacket.persisted !== true ||
      !initialPacket.clockUse
    )
      return null;
    const tools = receipt.semanticClock.invocations!.flatMap((row) => row.packets);
    const expected: MeriCaptureCompilerPacket[] = [
      {
        packetId: initialPacket.packetId,
        persisted: true,
        clockUse: initialPacket.clockUse,
      },
      ...tools,
    ];
    const ids = expected.map((row) => row.packetId);
    if (
      ids.length > 100 ||
      new Set(ids).size !== ids.length ||
      ids.some(
        (id) =>
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id),
      )
    )
      return null;
    return await args.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      // Census all packets claiming this capture identity, plus same-conversation
      // packets since admission. Do not hide foreign-client or shadow extras by
      // filtering them out of the read; validate every row below.
      const rows = await tx.contextPacket.findMany({
        where: {
          tenantId: policy.tenantId,
          OR: [
            { id: { in: ids } },
            { ref: { path: ['capturePolicyId'], equals: policy.policyId } },
            { ref: { path: ['captureRequestId'], equals: policy.requestId } },
            { ref: { path: ['captureTurnId'], equals: turnId } },
            {
              AND: [
                { ref: { path: ['conversationId'], equals: policy.conversationId } },
                { createdAt: { gte: new Date(policy.issuedAt) } },
              ],
            },
          ],
        },
        take: 101,
        select: {
          id: true,
          tenantId: true,
          effectiveTenantId: true,
          userId: true,
          actorUserId: true,
          clientId: true,
          surface: true,
          ref: true,
          modelPolicy: true,
          packetVersion: true,
          traceId: true,
          createdAt: true,
        },
      });
      if (
        rows.length !== expected.length ||
        new Set(rows.map((row) => row.id)).size !== rows.length
      )
        return null;
      const actual: MeriCaptureCompilerPacket[] = [];
      for (const [index, wanted] of expected.entries()) {
        const row = rows.find((value) => value.id === wanted.packetId);
        const ref = row?.ref as Record<string, unknown> | undefined;
        const use = (row?.modelPolicy as Record<string, unknown> | undefined)
          ?.contextCompilerClockUse;
        const initial = index === 0;
        const expectedClient = initial ? (initialPacket.clientId ?? null) : policy.clientId;
        // Case20 may compile its general PE context without selected-client
        // steering. This is the actual API runtime scope, never a caller choice.
        const generalPe = initial && policy.caseId === '20' && expectedClient === null;
        if (
          !row ||
          row.tenantId !== policy.tenantId ||
          row.effectiveTenantId !== policy.tenantId ||
          row.userId !== policy.actorUserId ||
          row.surface !== 'chat' ||
          row.clientId !== expectedClient ||
          (!generalPe && row.clientId !== policy.clientId) ||
          ![1, 2].includes(row.packetVersion) ||
          (row.packetVersion === 2 && row.actorUserId !== policy.actorUserId) ||
          ref?.conversationId !== policy.conversationId ||
          ref.operationId !== 'meri.chat' ||
          ref.subjectScope !== (row.clientId ? 'client' : 'general') ||
          !isDeepStrictEqual(use, wanted.clockUse) ||
          wanted.clockUse.instant !== policy.semanticClock!.instant ||
          wanted.clockUse.timeZone !== policy.semanticClock!.timeZone ||
          !['used', 'not_run'].includes(wanted.clockUse.scoring) ||
          !Number.isFinite(Date.parse(wanted.clockUse.eligibilityAt)) ||
          Date.parse(wanted.clockUse.eligibilityAt) < policy.issuedAt ||
          Date.parse(wanted.clockUse.eligibilityAt) > receipt.completedAt ||
          row.createdAt.getTime() < policy.issuedAt ||
          row.createdAt.getTime() > Date.now()
        )
          return null;
        if (initial) {
          if (ref.tool || ref.capturePolicyId || ref.captureRequestId || ref.captureTurnId)
            return null;
        } else if (
          ref.tool !== 'search_memory' ||
          ref.capturePolicyId !== policy.policyId ||
          ref.captureRequestId !== policy.requestId ||
          ref.captureTurnId !== turnId ||
          (row.packetVersion === 2 && row.traceId !== policy.traceId)
        )
          return null;
        actual.push({
          packetId: row.id,
          persisted: true,
          clockUse: structuredClone(use) as MeriCaptureCompilerPacket['clockUse'],
        });
      }
      if (policy.expiresAt <= Date.now()) return null;
      return { initial: actual[0]!, tools: actual.slice(1), relativeToolWindows: 'NOT_APPLICABLE' };
    });
  } catch {
    // Failure retains a signed BLOCKED receipt; no DB diagnostic or inferred
    // success escapes into evidence or the answer.
    return null;
  }
}
