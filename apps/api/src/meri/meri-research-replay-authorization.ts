import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
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
import {
  canonicalMailOwnerProof,
  canonicalMailReauthorization,
} from './meri-research-mail-proof.js';
import { readResearchRun, researchMetadata } from './meri-research-run-state.js';
import {
  publicResearchSourceTool,
  readResearchReportProvenance,
  reportBodySha256,
  reportReceiptManifestSha256,
  sameResearchReportProvenance,
} from './meri-report-provenance.js';
import { debriefOwnerProof } from './meri-research-debrief-proof.js';

const SUPPORTED_OWNER_TOOLS = new Set([
  'search_memory',
  'read_client_documents',
  'query_debriefs',
  'list_emails',
  'search_emails',
  'get_email_thread',
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rows(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  const projected = value.map(record);
  return projected.every((row): row is Record<string, unknown> => Boolean(row))
    ? projected
    : null;
}

function healthyCompleteMemoryOwnerProof(root: Record<string, unknown>): boolean {
  const coverage = record(root.coverage);
  const sources = rows(coverage?.sources);
  const owner = sources?.find((source) => source.domain === 'institutional_knowledge');
  return Boolean(
    coverage?.complete === true &&
      coverage.paginationComplete === true &&
      owner?.sourceStatus === 'healthy' &&
      owner.coverageComplete === true &&
      owner.paginationComplete === true &&
      owner.truncated === false,
  );
}

function memoryProof(value: unknown): string[] | null {
  const root = record(value);
  if (!root || root.tool !== 'search_memory') return null;
  const records = rows(root.records);
  const results = rows(root.results);
  if (!records || !results || records.length !== results.length) return null;
  if (records.length === 0) {
    // Empty replay is meaningful only when the canonical owner says its search
    // completed successfully. An absent projection or an unowned empty array is
    // not authority for a previously non-empty result.
    return root.contentStatus === 'empty' && healthyCompleteMemoryOwnerProof(root)
      ? [researchJsonSha256({ owner: 'institutional_knowledge', outcome: 'empty' })]
      : null;
  }
  if (!['available', 'metadata_only'].includes(String(root.contentStatus))) return null;
  const proofs: string[] = [];
  for (const [index, row] of records.entries()) {
    const payload = record(row.payload);
    const provenance = record(row.provenance);
    const content = record(payload?.content);
    const recordId = typeof row.recordId === 'string' ? row.recordId : null;
    const result = results[index];
    const resultId =
      typeof result?.memoryItemId === 'string'
        ? result.memoryItemId
        : typeof result?.id === 'string'
          ? result.id
          : null;
    const version = typeof provenance?.sourceVersion === 'string' ? provenance.sourceVersion : null;
    const contentHash =
      typeof content?.hash === 'string'
        ? content.hash
        : typeof provenance?.contentHash === 'string'
          ? provenance.contentHash
          : null;
    if (!recordId || resultId !== recordId || (!version && !contentHash)) return null;
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
  const records = rows(root.records);
  if (!records) return null;
  const proofs = records.map((row) => {
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

/** Exact current-owner input; mail may pin a server-owned implicit asOf. */
export function currentOwnerReauthorizationInput(
  tool: string,
  originalInput: Record<string, unknown>,
  savedResult: unknown,
): Record<string, unknown> | null {
  if (!supportsDurableOwnerReauthorization(tool)) return null;
  if (!['list_emails', 'search_emails', 'get_email_thread'].includes(tool)) return originalInput;
  return canonicalMailReauthorization(tool, originalInput, savedResult)?.executeInput ?? null;
}

/**
 * Resolve canonical mail evidence and bind every non-null requested/returned
 * client to the current research scope and actor's current ethical-wall access.
 * Null-client personal mail deliberately contributes no client requirement.
 */
export async function currentMailSourceScopeAuthorization(input: {
  tx: Prisma.TransactionClient;
  ctx: TenantContext;
  sessionClientId: string | null;
  tool: string;
  originalInput: Record<string, unknown>;
  savedResult: unknown;
}) {
  const authorization = canonicalMailReauthorization(
    input.tool,
    input.originalInput,
    input.savedResult,
  );
  if (!authorization) return null;
  const evidenceClientIds = new Set([
    ...(authorization.requestedClientId ? [authorization.requestedClientId] : []),
    ...authorization.returnedClientIds,
  ]);
  for (const clientId of evidenceClientIds) {
    if (input.sessionClientId && clientId !== input.sessionClientId) return null;
    if (!(await clientMemoryAllowed(input.tx, input.ctx.tenantId, input.ctx.userId, clientId)))
      return null;
  }
  return authorization;
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
      : tool === 'query_debriefs'
        ? debriefOwnerProof
        : ['list_emails', 'search_emails', 'get_email_thread'].includes(tool)
          ? (value: unknown) => canonicalMailOwnerProof(tool, value)
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
  conversationId?: string;
  clientId?: string | null;
  reportArtifactId?: string;
  /** Producer-only path before the report artifact exists. Public reads never supply declarations. */
  publication?: {
    runId: string;
    leaseEpoch: number;
    toolsUsed: string[];
    producerInputSha256: string;
    producerInputMode: 'source_free' | 'covered_inputs' | 'unsupported_private_inputs';
    clientContextSha256: string | null;
  };
}

interface CurrentOwnerTools {
  execute(
    ctx: TenantContext,
    tool: never,
    input: Record<string, unknown>,
  ): Promise<unknown>;
}

function stringArray(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    !value.every(
      (item) => typeof item === 'string' && item.length > 0 && item.trim() === item,
    )
  )
    return null;
  return new Set(value).size === value.length ? value : null;
}

function sameStringSet(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function canonicalClientContext(value: {
  name: string;
  description: string | null;
  productDescription: string | null;
}): string {
  const parts = [`Client: ${value.name}`];
  if (value.description) parts.push(`Description: ${value.description}`);
  if (value.productDescription) parts.push(`Product/service: ${value.productDescription}`);
  return parts.join('\n');
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

      const metadata = researchMetadata(session.metadata);
      const rawReceipts = metadata.durableStepReceipts;
      const allReceipts = readDurableResearchStepReceipts(session.metadata);
      if (
        rawReceipts !== undefined &&
        (!Array.isArray(rawReceipts) || rawReceipts.length !== allReceipts.length)
      )
        throw new ConflictException('A research source authorization proof is unavailable.');

      const storedRun = readResearchRun(session.metadata);
      let toolsUsed: string[];
      let runId: string;
      let leaseEpoch: number;
      let clientContextSha256: string | null;
      if (scope.publication) {
        const declared = stringArray(scope.publication.toolsUsed);
        if (
          !declared ||
          declared.some((tool) => !publicResearchSourceTool(tool)) ||
          !/^[a-f0-9]{64}$/.test(scope.publication.producerInputSha256) ||
          !['source_free', 'covered_inputs'].includes(scope.publication.producerInputMode) ||
          !(scope.publication.clientContextSha256 === null ||
            /^[a-f0-9]{64}$/.test(scope.publication.clientContextSha256)) ||
          (scope.publication.producerInputMode === 'source_free' &&
            (declared.length > 0 || scope.publication.clientContextSha256 !== null)) ||
          !storedRun ||
          storedRun.status !== 'running' ||
          storedRun.id !== scope.publication.runId ||
          storedRun.leaseEpoch !== scope.publication.leaseEpoch ||
          session.reportArtifactId
        ) {
          throw new ConflictException('The research report producer proof is unavailable.');
        }
        toolsUsed = declared;
        runId = scope.publication.runId;
        leaseEpoch = scope.publication.leaseEpoch;
        clientContextSha256 = scope.publication.clientContextSha256;
      } else {
        const artifactId = scope.reportArtifactId ?? session.reportArtifactId;
        if (!artifactId || session.reportArtifactId !== artifactId)
          throw new ConflictException('The research report identity changed.');
        const report = await tx.clioArtifact.findFirst({
          where: {
            id: artifactId,
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            clientId: session.clientId,
            conversationId,
            kind: 'research_report',
          },
          select: { id: true, messageId: true, bodyText: true, metadata: true },
        });
        const artifactProof = readResearchReportProvenance(report?.metadata);
        const sessionProof = readResearchReportProvenance(session.metadata);
        const reportMetadata = researchMetadata(report?.metadata);
        const declaredTools = stringArray(reportMetadata.toolsUsed);
        if (
          !report ||
          !artifactProof ||
          !sessionProof ||
          !sameResearchReportProvenance(artifactProof, sessionProof) ||
          artifactProof.artifactId !== report.id ||
          artifactProof.messageId !== (report.messageId ?? null) ||
          artifactProof.sessionId !== session.id ||
          artifactProof.tenantId !== ctx.tenantId ||
          artifactProof.userId !== ctx.userId ||
          artifactProof.clientId !== session.clientId ||
          artifactProof.conversationId !== conversationId ||
          reportMetadata.researchSessionId !== session.id ||
          !declaredTools ||
          !sameStringSet(declaredTools, artifactProof.toolsUsed) ||
          reportBodySha256(report.bodyText ?? '') !== artifactProof.bodySha256 ||
          !storedRun ||
          storedRun.status !== 'complete' ||
          storedRun.id !== artifactProof.runId ||
          storedRun.leaseEpoch !== artifactProof.leaseEpoch
        ) {
          throw new ConflictException('The research report producer proof is unavailable.');
        }
        toolsUsed = artifactProof.toolsUsed;
        runId = artifactProof.runId;
        leaseEpoch = artifactProof.leaseEpoch;
        clientContextSha256 = artifactProof.clientContextSha256;
        if (
          reportReceiptManifestSha256(allReceipts, { id: runId, leaseEpoch }, toolsUsed) !==
          artifactProof.receiptManifestSha256
        ) {
          throw new ConflictException('The research report receipt manifest changed.');
        }
      }

      const toolSet = new Set(toolsUsed);
      const completedReceipts = allReceipts.filter(
        (receipt) =>
          receipt.status === 'complete' &&
          receipt.version === 2 &&
          toolSet.has(receipt.tool),
      );
      if (toolSet.size === 0 && completedReceipts.length > 0)
        throw new ConflictException('The research report source declaration is incomplete.');
      if (completedReceipts.some((receipt) => !toolSet.has(receipt.tool)))
        throw new ConflictException('The research report source declaration is incomplete.');

      const receipts = completedReceipts.filter(
        (receipt) =>
          receipt.version === 2 && toolSet.has(receipt.tool),
      );
      for (const tool of toolSet) {
        if (!receipts.some((receipt) => receipt.tool === tool))
          throw new ConflictException('A research source authorization proof is unavailable.');
      }

      if (clientContextSha256) {
        const client = session.clientId
          ? await tx.client.findFirst({
              where: { id: session.clientId, tenantId: ctx.tenantId },
              select: { name: true, description: true, productDescription: true },
            })
          : null;
        if (!client || reportBodySha256(canonicalClientContext(client)) !== clientContextSha256)
          throw new ConflictException('A research producer input version changed.');
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
        const mailAuthorization = ['list_emails', 'search_emails', 'get_email_thread'].includes(
          envelope.tool,
        )
          ? await currentMailSourceScopeAuthorization({
              tx,
              ctx,
              sessionClientId: session.clientId,
              tool: envelope.tool,
              originalInput: envelope.input,
              savedResult: envelope.result,
            })
          : null;
        if (
          ['list_emails', 'search_emails', 'get_email_thread'].includes(envelope.tool) &&
          !mailAuthorization
        ) {
          throw new ConflictException('A research source authorization proof is unavailable.');
        }
        envelopes.push({ envelope, mailAuthorization });
      }
      return { envelopes, sessionId: session.id };
    });

  const loaded = await load();
  for (const authorized of loaded.envelopes) {
    const { envelope, mailAuthorization } = authorized;
    let currentResult: unknown;
    try {
      currentResult = await tools.execute(
        ctx,
        envelope.tool as never,
        mailAuthorization?.executeInput ?? envelope.input,
      );
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
