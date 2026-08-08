import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriToolsService } from './meri-tools.service.js';
import { sha256CanonicalAnalysisJson } from './meri-analysis-provenance.js';
import {
  analysisResultsWithoutVisualizations,
  analysisVisualizationCandidatesFromResults,
  sanitizeAnalysisVisualization,
  type AnalysisVisualizationSpec,
} from './meri-analysis-visualization.js';

interface RawAnalysisArtifact {
  title?: unknown;
  kind?: unknown;
  contentType?: unknown;
  metadata?: unknown;
}

export interface RawAnalysisResult {
  tool?: unknown;
  ok?: unknown;
  exitCode?: unknown;
  timedOut?: unknown;
  durationMs?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  results?: unknown;
  chartCount?: unknown;
  artifacts?: unknown;
  warnings?: unknown;
  error?: unknown;
}

export interface AnalysisDatasetSummary {
  name: string;
  rowCount: number;
}

export interface AnalysisArtifactProvenance {
  evidence: 'derived';
  generatedAt: string;
  datasetCount: number;
  rowCount: number;
  datasets: AnalysisDatasetSummary[];
}

const MAX_VISUAL_ARTIFACTS_PER_TURN = 6;
const MAX_ORPHAN_SWEEP_CANDIDATES = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function optionalString(value: unknown, max = 300): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function boundedBase64(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isMeriV3VisualMetadata(value: unknown): boolean {
  return metadataRecord(value).source === 'meri_v3_visual_analysis';
}

function rawAnalysisArtifacts(value: unknown): RawAnalysisArtifact[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is RawAnalysisArtifact => Boolean(item && typeof item === 'object'))
    .slice(0, MAX_VISUAL_ARTIFACTS_PER_TURN);
}

function stringWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 300))
    .slice(0, 10);
}

function summarizeDatasets(value: unknown): AnalysisDatasetSummary[] {
  if (!Array.isArray(value)) return [];
  const summaries: AnalysisDatasetSummary[] = [];
  for (const candidate of value.slice(0, 8)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const raw = candidate as Record<string, unknown>;
    const name = optionalString(raw.name, 60);
    if (!name || !Array.isArray(raw.rows)) continue;
    summaries.push({ name, rowCount: Math.min(raw.rows.length, 5000) });
  }
  return summaries;
}

function datasetSummariesFromMetadata(value: unknown): AnalysisDatasetSummary[] {
  if (!Array.isArray(value)) return [];
  const summaries: AnalysisDatasetSummary[] = [];
  for (const candidate of value.slice(0, 8)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const raw = candidate as Record<string, unknown>;
    const name = optionalString(raw.name, 60);
    const rowCount =
      typeof raw.rowCount === 'number' && Number.isFinite(raw.rowCount)
        ? Math.max(0, Math.min(5000, Math.trunc(raw.rowCount)))
        : null;
    if (name && rowCount !== null) summaries.push({ name, rowCount });
  }
  return summaries;
}

function positiveNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min ? Math.min(max, parsed) : fallback;
}

function boundedArtifactIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new BadRequestException('artifactIds must be an array');
  if (value.length > MAX_VISUAL_ARTIFACTS_PER_TURN) {
    throw new BadRequestException(
      `At most ${MAX_VISUAL_ARTIFACTS_PER_TURN} visual artifacts can be discarded per turn`,
    );
  }
  const ids = value.map((candidate) => (typeof candidate === 'string' ? candidate.trim() : ''));
  if (ids.some((id) => !UUID_RE.test(id))) {
    throw new BadRequestException('artifactIds contains an invalid artifact id');
  }
  return [...new Set(ids)];
}

/**
 * MeriV3's delegated tool bridge returns through apps/api immediately, unlike
 * the legacy in-process chat which persists tool artifacts after the model turn.
 * This service is the V3 persistence boundary for `run_analysis`: it reuses the
 * canonical MeriToolsService computation/audit path, validates the structured
 * visualization contract, persists stable artifact ids, and returns only those
 * ids to the isolated orchestrator. Raw PNG bytes and full visualization rows
 * never travel back to OpenAI.
 */
@Injectable()
export class MeriV3VisualAnalysisService {
  private readonly logger = new Logger(MeriV3VisualAnalysisService.name);
  private readonly lastOrphanSweep = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tools: MeriToolsService,
  ) {}

  /** The same env + tenant gate that controls whether run_analysis is offered. */
  isAvailable(tenantId: string): Promise<boolean> {
    return this.tools.analysisSandboxEnabled(tenantId);
  }

  async run(ctx: TenantContext, input: Record<string, unknown>) {
    const startedAt = Date.now();
    const conversationId = optionalString(input.conversationId, 80);
    if (!conversationId) throw new BadRequestException('conversationId is required');

    // Immediate discard handles the normal assurance-hold path. This bounded,
    // opportunistic sweep is a second line of storage hygiene for a process
    // crash/network failure between persistence and discard/linking.
    await this.cleanupOrphanedArtifacts(ctx).catch(() => {
      this.logger.warn(
        JSON.stringify({
          event: 'meriv3.visual_analysis_orphan_cleanup',
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          outcome: 'failed_safely',
        }),
      );
    });

    const conversation = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioConversation.findFirst({
        where: {
          id: conversationId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          archivedAt: null,
        },
        select: { id: true, clientId: true },
      }),
    );
    if (!conversation) throw new NotFoundException('Meri conversation not found');

    const requestedClientId = optionalString(input.clientId, 80);
    if (requestedClientId && requestedClientId !== conversation.clientId) {
      throw new BadRequestException(
        'Analysis clientId does not match the Meri conversation client',
      );
    }

    const datasets = summarizeDatasets(input.datasets);
    const datasetRows = datasets.reduce((sum, dataset) => sum + dataset.rowCount, 0);
    const raw = (await this.tools.executeFromAuthenticatedUser(ctx, 'run_analysis', {
      code: input.code,
      datasets: input.datasets,
      purpose: input.purpose,
    })) as RawAnalysisResult;

    if (!raw || typeof raw !== 'object') return raw;
    if (raw.ok === false || raw.error) {
      this.logRun({
        ctx,
        conversationId,
        outcome: 'sandbox_failed',
        datasetCount: datasets.length,
        datasetRows,
        chartTypes: [],
        interactiveCount: 0,
        imageCount: 0,
        warningCount: stringWarnings(raw.warnings).length,
        durationMs: Date.now() - startedAt,
      });
      return raw;
    }

    const visualCandidates = analysisVisualizationCandidatesFromResults(raw.results);
    const visualsByIndex = visualCandidates.map(sanitizeAnalysisVisualization);
    const images = rawAnalysisArtifacts(raw.artifacts);
    const visualWarnings = stringWarnings(raw.warnings);
    const count = Math.min(
      MAX_VISUAL_ARTIFACTS_PER_TURN,
      Math.max(visualCandidates.length, images.length),
    );

    for (let index = 0; index < count; index += 1) {
      const candidatePresent = index < visualCandidates.length;
      const visual = visualsByIndex[index] ?? null;
      const image = images[index] ?? null;
      if (candidatePresent && !visual) {
        visualWarnings.push(
          `Visualization ${index + 1} was rejected because its chart type, field mapping, or numeric data was invalid.`,
        );
      }
      if (visual && !image) {
        visualWarnings.push(`Visualization ${index + 1} has no canonical PNG fallback.`);
      }
      if (image && !visual) {
        visualWarnings.push(
          `Chart image ${index + 1} has no valid interactive specification and will render as a static fallback.`,
        );
      }
    }

    const {
      artifacts: _rawArtifacts,
      results: _rawResults,
      warnings: _rawWarnings,
      ...safeRaw
    } = raw;
    const modelFacingResults = analysisResultsWithoutVisualizations(raw.results);
    if (!count) {
      this.logRun({
        ctx,
        conversationId,
        outcome: 'analysis_without_visual',
        datasetCount: datasets.length,
        datasetRows,
        chartTypes: [],
        interactiveCount: 0,
        imageCount: 0,
        warningCount: visualWarnings.length,
        durationMs: Date.now() - startedAt,
      });
      return {
        ...safeRaw,
        results: modelFacingResults,
        artifacts: [],
        chartCount: 0,
        ...(visualWarnings.length ? { visualWarnings } : {}),
      };
    }

    const purpose = optionalString(input.purpose, 500);
    const resultSha256 = sha256CanonicalAnalysisJson(modelFacingResults);
    const persisted = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const out: Array<{
        id: string;
        title: string;
        kind: 'analysis_chart';
        persisted: true;
        chartType: string | null;
        visualizationAvailable: boolean;
        imageAvailable: boolean;
      }> = [];
      for (let index = 0; index < count; index += 1) {
        const visual = visualsByIndex[index] ?? null;
        const image = images[index] ?? null;
        const rawMeta = metadataRecord(image?.metadata);
        const imageBase64 = boundedBase64(rawMeta.imageBase64, 3 * 1024 * 1024);
        const filename = optionalString(rawMeta.filename, 160);
        const codeSha256 = optionalString(rawMeta.codeSha256, 80);
        if (!visual && !imageBase64) continue;

        const title =
          visual?.title ?? optionalString(image?.title, 140) ?? `Analysis visual ${index + 1}`;
        const metadata: Record<string, unknown> = {
          source: 'meri_v3_visual_analysis',
          tool: 'run_analysis',
          evidence: 'derived',
          resultSha256,
          ...(purpose ? { purpose } : {}),
          ...(datasets.length ? { datasets } : {}),
          ...(filename ? { filename } : {}),
          ...(codeSha256 ? { codeSha256 } : {}),
          ...(imageBase64 ? { imageBase64 } : {}),
          ...(visual
            ? {
                visualization: visual,
                visualizationSha256: sha256CanonicalAnalysisJson(visual),
              }
            : {}),
        };
        const artifact = await tx.clioArtifact.create({
          data: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            clientId: conversation.clientId,
            conversationId,
            title,
            kind: 'analysis_chart',
            contentType: imageBase64 ? 'image/png' : 'application/vnd.capiro.analysis-visual+json',
            bodyText: '',
            metadata: metadata as Prisma.InputJsonValue,
          },
          select: { id: true, title: true },
        });
        out.push({
          id: artifact.id,
          title: artifact.title,
          kind: 'analysis_chart',
          persisted: true,
          chartType: visual?.chartType ?? null,
          visualizationAvailable: Boolean(visual),
          imageAvailable: Boolean(imageBase64),
        });
      }
      return out;
    });

    this.logRun({
      ctx,
      conversationId,
      outcome: 'visuals_persisted',
      datasetCount: datasets.length,
      datasetRows,
      chartTypes: persisted
        .map((artifact) => artifact.chartType)
        .filter((type): type is string => Boolean(type)),
      interactiveCount: persisted.filter((artifact) => artifact.visualizationAvailable).length,
      imageCount: persisted.filter((artifact) => artifact.imageAvailable).length,
      warningCount: visualWarnings.length,
      durationMs: Date.now() - startedAt,
    });

    return {
      ...safeRaw,
      results: modelFacingResults,
      artifacts: persisted,
      chartCount: persisted.length,
      visualSummary: persisted.map((artifact) => ({
        title: artifact.title,
        chartType: artifact.chartType,
        interactive: artifact.visualizationAvailable,
        exportImage: artifact.imageAvailable,
      })),
      ...(visualWarnings.length ? { visualWarnings } : {}),
    };
  }

  async getArtifact(
    ctx: TenantContext,
    id: string,
  ): Promise<{
    id: string;
    title: string;
    visualization: AnalysisVisualizationSpec | null;
    imageAvailable: boolean;
    provenance: AnalysisArtifactProvenance;
  } | null> {
    const artifact = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioArtifact.findFirst({
        where: {
          id,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          kind: 'analysis_chart',
        },
        select: { id: true, title: true, metadata: true, createdAt: true },
      }),
    );
    if (!artifact) return null;
    const metadata = metadataRecord(artifact.metadata);
    const visualization = sanitizeAnalysisVisualization(metadata.visualization);
    const imageAvailable =
      typeof metadata.imageBase64 === 'string' && metadata.imageBase64.length > 0;
    if (!visualization && !imageAvailable) return null;
    const datasets = datasetSummariesFromMetadata(metadata.datasets);
    return {
      id: artifact.id,
      title: artifact.title,
      visualization,
      imageAvailable,
      provenance: {
        evidence: 'derived',
        generatedAt: artifact.createdAt.toISOString(),
        datasetCount: datasets.length,
        rowCount: datasets.reduce((sum, dataset) => sum + dataset.rowCount, 0),
        datasets,
      },
    };
  }

  async getArtifactImage(
    ctx: TenantContext,
    id: string,
  ): Promise<{ buffer: Buffer; contentType: string } | null> {
    const artifact = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioArtifact.findFirst({
        where: {
          id,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          kind: 'analysis_chart',
        },
        select: { contentType: true, metadata: true },
      }),
    );
    if (!artifact) return null;
    const imageBase64 = boundedBase64(
      metadataRecord(artifact.metadata).imageBase64,
      3 * 1024 * 1024,
    );
    if (!imageBase64) return null;
    return {
      buffer: Buffer.from(imageBase64, 'base64'),
      contentType: artifact.contentType === 'image/png' ? artifact.contentType : 'image/png',
    };
  }

  /**
   * Delete only visual artifacts from the current governed turn that the final
   * assurance decision did not release. This is stronger than waiting for TTL:
   * held visuals are removed immediately and the opportunistic sweep below is
   * only crash/network-failure recovery.
   */
  async discardUnreleasedArtifacts(ctx: TenantContext, value: unknown): Promise<number> {
    const ids = boundedArtifactIds(value);
    if (!ids.length) return 0;
    const candidates = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioArtifact.findMany({
        where: {
          id: { in: ids },
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          kind: 'analysis_chart',
          messageId: null,
        },
        select: { id: true, metadata: true },
      }),
    );
    const eligible = candidates
      .filter((artifact) => isMeriV3VisualMetadata(artifact.metadata))
      .map((artifact) => artifact.id);
    if (!eligible.length) return 0;
    const deleted = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioArtifact.deleteMany({
        where: {
          id: { in: eligible },
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          kind: 'analysis_chart',
          messageId: null,
        },
      }),
    );
    if (deleted.count > 0) {
      this.logger.log(
        JSON.stringify({
          event: 'meriv3.visual_analysis_discard',
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          outcome: 'deleted',
          count: deleted.count,
        }),
      );
    }
    return deleted.count;
  }

  /**
   * Bounded fallback cleanup for a process crash or failed discard/link call.
   * It first reads at most 100 old unlinked candidates, then checks the source
   * marker in application memory before issuing a second user-scoped delete.
   */
  async cleanupOrphanedArtifacts(ctx: TenantContext, now = new Date()): Promise<number> {
    const key = `${ctx.tenantId}:${ctx.userId}`;
    const intervalMs =
      positiveNumber(process.env.MERIV3_ANALYSIS_ORPHAN_SWEEP_MINUTES, 60, 1, 24 * 60) * 60_000;
    const previous = this.lastOrphanSweep.get(key) ?? 0;
    if (now.getTime() - previous < intervalMs) return 0;

    const retentionMs =
      positiveNumber(process.env.MERIV3_ANALYSIS_ORPHAN_RETENTION_HOURS, 24, 1, 30 * 24) *
      3_600_000;
    const cutoff = new Date(now.getTime() - retentionMs);
    const candidates = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioArtifact.findMany({
        where: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          kind: 'analysis_chart',
          messageId: null,
          createdAt: { lt: cutoff },
        },
        orderBy: { createdAt: 'asc' },
        take: MAX_ORPHAN_SWEEP_CANDIDATES,
        select: { id: true, metadata: true },
      }),
    );
    const eligible = candidates
      .filter((artifact) => isMeriV3VisualMetadata(artifact.metadata))
      .map((artifact) => artifact.id);
    const deleted = eligible.length
      ? await this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.clioArtifact.deleteMany({
            where: {
              id: { in: eligible },
              tenantId: ctx.tenantId,
              userId: ctx.userId,
              kind: 'analysis_chart',
              messageId: null,
            },
          }),
        )
      : { count: 0 };
    this.lastOrphanSweep.set(key, now.getTime());
    if (deleted.count > 0) {
      this.logger.log(
        JSON.stringify({
          event: 'meriv3.visual_analysis_orphan_cleanup',
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          outcome: 'deleted',
          count: deleted.count,
          retentionHours: retentionMs / 3_600_000,
        }),
      );
    }
    return deleted.count;
  }

  private logRun(input: {
    ctx: TenantContext;
    conversationId: string;
    outcome: 'sandbox_failed' | 'analysis_without_visual' | 'visuals_persisted';
    datasetCount: number;
    datasetRows: number;
    chartTypes: string[];
    interactiveCount: number;
    imageCount: number;
    warningCount: number;
    durationMs: number;
  }): void {
    // Metadata only: no prompt, Python code, dataset name/body, chart rows,
    // artifact bytes, client name, or hidden reasoning enters operational logs.
    this.logger.log(
      JSON.stringify({
        event: 'meriv3.visual_analysis',
        tenantId: input.ctx.tenantId,
        userId: input.ctx.userId,
        conversationId: input.conversationId,
        outcome: input.outcome,
        datasetCount: input.datasetCount,
        datasetRows: input.datasetRows,
        chartTypes: input.chartTypes,
        interactiveCount: input.interactiveCount,
        imageCount: input.imageCount,
        warningCount: input.warningCount,
        durationMs: input.durationMs,
      }),
    );
  }
}
