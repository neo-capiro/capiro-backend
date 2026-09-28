import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { readDurableResearchStepReceipts } from './meri-research-durable-step.js';
import {
  openDurableResearchResult,
  RESEARCH_SAFE_READ_ARTIFACT_KIND,
  researchJsonSha256,
} from './meri-research-durable-result.js';
import { readResearchHandoff } from './meri-research-handoff.js';
import { researchMetadata } from './meri-research-run-state.js';

const SUPPORTED_OWNER_TOOLS = new Set(['search_memory', 'read_client_documents']);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rows(value: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(value.records)
    ? value.records.map(record).filter((row): row is Record<string, unknown> => Boolean(row))
    : [];
}

function memoryProof(value: unknown): string[] | null {
  const root = record(value);
  if (!root || root.tool !== 'search_memory') return null;
  const proofs: string[] = [];
  for (const row of rows(root)) {
    const payload = record(row.payload);
    const provenance = record(row.provenance);
    const content = record(payload?.content);
    const recordId = typeof row.recordId === 'string' ? row.recordId : null;
    const version = typeof provenance?.sourceVersion === 'string' ? provenance.sourceVersion : null;
    const contentHash =
      typeof content?.hash === 'string'
        ? content.hash
        : typeof provenance?.contentHash === 'string'
          ? provenance.contentHash
          : null;
    if (!recordId || (!version && !contentHash)) return null;
    proofs.push(
      researchJsonSha256({
        recordId,
        updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
        version,
        contentHash,
        clientId: typeof payload?.clientId === 'string' ? payload.clientId : null,
      }),
    );
  }
  return proofs.sort();
}

function documentProof(value: unknown): string[] | null {
  const root = record(value);
  if (!root || root.tool !== 'read_client_documents') return null;
  const document = record(root.document);
  if (
    !document ||
    typeof document.id !== 'string' ||
    typeof document.contentHash !== 'string'
  ) {
    // Listings carry no owner content version and therefore cannot authorize replay.
    return null;
  }
  const proofs = rows(root).map((row) => {
    const provenance = record(row.provenance);
    return researchJsonSha256({
      recordId: row.recordId,
      documentId: document.id,
      contentHash: document.contentHash,
      sectionHash: provenance?.sectionHash,
      section: provenance?.section,
      characterStart: provenance?.characterStart,
      characterEnd: provenance?.characterEnd,
    });
  });
  return [
    researchJsonSha256({
      documentId: document.id,
      contentHash: document.contentHash,
      clientId: root.clientId,
    }),
    ...proofs,
  ].sort();
}

export function supportsDurableOwnerReauthorization(tool: string): boolean {
  return SUPPORTED_OWNER_TOOLS.has(tool);
}

/** Compare only current owner identity/version evidence, never old coverage flags. */
export function currentOwnerResultAuthorizesReplay(
  tool: string,
  savedResult: unknown,
  currentResult: unknown,
): boolean {
  const project = tool === 'search_memory'
    ? memoryProof
    : tool === 'read_client_documents'
      ? documentProof
      : null;
  if (!project) return false;
  const saved = project(savedResult);
  const current = project(currentResult);
  return Boolean(saved && current && researchJsonSha256(saved) === researchJsonSha256(current));
}

export const RESEARCH_REPORT_BODY_WITHHELD =
  'Research report content is unavailable because current source authorization could not be confirmed. Reopen the research session to refresh or rerun the report.';

export interface ResearchReportReadScope {
  sessionId: string;
  /** Omit only before the report artifact has been persisted. */
  toolsUsed?: string[];
  conversationId?: string;
  clientId?: string | null;
  reportArtifactId?: string;
}

interface CurrentOwnerTools {
  execute(
    ctx: TenantContext,
    tool: never,
    input: Record<string, unknown>,
  ): Promise<unknown>;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : null;
}

/**
 * Reauthorize every durable owner read inherited by a report before releasing
 * its body. This seam is shared by research publication/export and ordinary
 * conversation reads so neither service needs to inject the other.
 */
export async function assertCurrentResearchReportSourcesAuthorized(input: {
  prisma: PrismaService;
  tools: CurrentOwnerTools;
  ctx: TenantContext;
  scope: ResearchReportReadScope;
}): Promise<void> {
  const { prisma, tools, ctx, scope } = input;
  const load = async () =>
    prisma.withTenant(ctx.tenantId, async (tx) => {
      const session = await tx.clioResearchSession.findFirst({
        where: { id: scope.sessionId, tenantId: ctx.tenantId, userId: ctx.userId },
      });
      if (!session) throw new NotFoundException('Research session not found');
      if (scope.clientId !== undefined && session.clientId !== scope.clientId)
        throw new NotFoundException('Research session not found');
      if (
        session.clientId &&
        !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, session.clientId))
      )
        throw new NotFoundException('Research session not found');

      const handoff = readResearchHandoff(session.metadata);
      const backing = researchMetadata(session.metadata).backingConversationId;
      const conversationId =
        handoff?.conversationId ?? (typeof backing === 'string' ? backing : null);
      if (
        handoff?.clientId !== undefined &&
        handoff.clientId !== session.clientId
      )
        throw new BadRequestException(
          'The originating conversation is no longer available in this client scope',
        );
      if (!conversationId || (scope.conversationId && scope.conversationId !== conversationId))
        throw new BadRequestException(
          'The originating conversation is no longer available in this client scope',
        );
      const conversation = await tx.clioConversation.findFirst({
        where: {
          id: conversationId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientId: session.clientId,
          archivedAt: null,
        },
        select: { id: true },
      });
      if (!conversation)
        throw new BadRequestException(
          'The originating conversation is no longer available in this client scope',
        );

      let toolsUsed = scope.toolsUsed ?? null;
      if (scope.reportArtifactId && session.reportArtifactId !== scope.reportArtifactId)
        throw new ConflictException('The research report identity changed.');
      if (!toolsUsed) {
        if (!session.reportArtifactId)
          throw new ConflictException('The research report authorization proof is unavailable.');
        const report = await tx.clioArtifact.findFirst({
          where: {
            id: session.reportArtifactId,
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            clientId: session.clientId,
            conversationId,
            kind: 'research_report',
          },
          select: { metadata: true },
        });
        if (!report)
          throw new ConflictException('The research report authorization proof is unavailable.');
        const reportMetadata = researchMetadata(report.metadata);
        if (reportMetadata.researchSessionId !== session.id)
          throw new ConflictException('The research report identity changed.');
        toolsUsed = stringArray(reportMetadata.toolsUsed);
      }
      if (!toolsUsed)
        throw new ConflictException('The research report authorization proof is unavailable.');

      const toolSet = new Set(toolsUsed);
      const receipts = readDurableResearchStepReceipts(session.metadata).filter(
        (receipt) =>
          receipt.version === 2 && receipt.status === 'complete' && toolSet.has(receipt.tool),
      );
      for (const tool of toolsUsed.filter(supportsDurableOwnerReauthorization)) {
        if (!receipts.some((receipt) => receipt.tool === tool))
          throw new ConflictException('A research source authorization proof is unavailable.');
      }

      const envelopes = [];
      for (const receipt of receipts) {
        if (!supportsDurableOwnerReauthorization(receipt.tool))
          throw new ConflictException('A research source cannot be currently authorized.');
        const artifact = await tx.clioArtifact.findFirst({
          where: {
            id: receipt.resultRef,
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            clientId: session.clientId,
            conversationId,
            kind: RESEARCH_SAFE_READ_ARTIFACT_KIND,
          },
          select: { bodyText: true },
        });
        let envelope;
        try {
          envelope = openDurableResearchResult(artifact?.bodyText, receipt.resultBodySha256!);
        } catch {
          throw new ConflictException('A research source is no longer available.');
        }
        if (
          envelope.executionId !== receipt.executionId ||
          envelope.providerCallId !== receipt.providerCallId ||
          envelope.runId !== receipt.runId ||
          envelope.leaseEpoch !== receipt.leaseEpoch ||
          envelope.tool !== receipt.tool ||
          envelope.toolVersion !== receipt.toolVersion ||
          envelope.inputSha256 !== receipt.inputSha256 ||
          envelope.resultSha256 !== receipt.resultSha256
        )
          throw new ConflictException('A research source identity changed.');
        envelopes.push(envelope);
      }
      return { envelopes, sessionId: session.id };
    });

  const loaded = await load();
  for (const envelope of loaded.envelopes) {
    let currentResult: unknown;
    try {
      currentResult = await tools.execute(ctx, envelope.tool as never, envelope.input);
    } catch {
      throw new ConflictException('A research source is no longer authorized.');
    }
    if (!currentOwnerResultAuthorizesReplay(envelope.tool, envelope.result, currentResult))
      throw new ConflictException('A research source version changed.');
  }
  // Close the owner-read race: scope, report identity, and current client /
  // conversation authorization must still hold after the owner calls complete.
  await load();
}
