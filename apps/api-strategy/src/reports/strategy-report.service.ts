import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { VersioningService } from "../strategy/versioning.service.js";
import {
  CLIENT_LOGO_READER,
  type ClientLogoReader,
} from "./client-logo.reader.js";
import { DocxReportRenderer } from "./docx-report.renderer.js";
import type {
  ReportExportDto,
  ReportPreflightDto,
} from "./dto/report-export.dto.js";
import { PptxReportRenderer } from "./pptx-report.renderer.js";
import { normalizeReportOptions } from "./report-policy.js";
import {
  reportReadinessErrors,
  ReportSnapshotService,
} from "./report-snapshot.service.js";
import type { ReportPreflight } from "./report.types.js";

const CONTENT_TYPES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;
const MAX_IN_PROCESS_EXPORTS = 4;
const MAX_RENDERED_REPORT_BYTES = 32 * 1024 * 1024;
export const REPORT_SNAPSHOT_CHANGED = "REPORT_SNAPSHOT_CHANGED";

export interface StrategyReportExportResult {
  bytes: Buffer;
  contentType: string;
  filename: string;
  snapshotHash: string;
  audience: "client" | "internal";
  logoIncluded: boolean;
  /** Release the in-process memory lease after the HTTP response finishes. */
  release: () => void;
}

@Injectable()
export class StrategyReportService {
  private exportTail: Promise<void> = Promise.resolve();
  private pendingExports = 0;

  constructor(
    private readonly snapshots: ReportSnapshotService,
    @Inject(CLIENT_LOGO_READER) private readonly logos: ClientLogoReader,
    private readonly docx: DocxReportRenderer,
    private readonly pptx: PptxReportRenderer,
    private readonly prisma: PrismaService,
    private readonly versioning: VersioningService,
  ) {}

  preflight(
    tenantId: string,
    strategyId: string,
    dto: ReportPreflightDto = {},
  ): Promise<ReportPreflight> {
    return this.snapshots.preflight(
      tenantId,
      strategyId,
      normalizeReportOptions({
        format: dto.format ?? "docx",
        audience: dto.audience ?? "client",
        useClientLogo: dto.useClientLogo,
        includeRoadmap: dto.includeRoadmap,
        includeEvidenceAppendix: dto.includeEvidenceAppendix,
        includeChangeLog: dto.includeChangeLog,
        includeInternalNotes: dto.includeInternalNotes,
        includeAgentHistory: dto.includeAgentHistory,
      }),
    );
  }

  async export(
    tenantId: string,
    actorUserId: string,
    strategyId: string,
    dto: ReportExportDto,
  ): Promise<StrategyReportExportResult> {
    const lease = await this.withExportSlot(() =>
      this.generateExport(tenantId, actorUserId, strategyId, dto),
    );
    return { ...lease.value, release: lease.release };
  }

  private async generateExport(
    tenantId: string,
    actorUserId: string,
    strategyId: string,
    dto: ReportExportDto,
  ): Promise<Omit<StrategyReportExportResult, "release">> {
    const options = normalizeReportOptions(dto);
    const snapshot = await this.snapshots.build(tenantId, strategyId, options);
    assertExpectedSnapshotHash(dto.expectedSnapshotHash, snapshot.snapshotHash);
    if (snapshot.capacityErrors.length > 0) {
      throw new PayloadTooLargeException({
        code: "REPORT_CAPACITY_EXCEEDED",
        message: snapshot.capacityErrors[0]!.message,
        errors: snapshot.capacityErrors,
      });
    }
    const readinessErrors = reportReadinessErrors(snapshot);
    if (readinessErrors.length > 0) {
      throw new BadRequestException({
        code: "REPORT_NOT_READY",
        message: readinessErrors[0]!.message,
        errors: readinessErrors,
      });
    }

    const descriptor = snapshot.client.logo;
    const logo =
      options.useClientLogo && descriptor.supported && descriptor.objectKey
        ? await this.logos.read({
            tenantId,
            clientId: snapshot.client.id,
            objectKey: descriptor.objectKey,
          })
        : null;

    const bytes =
      options.format === "docx"
        ? await this.docx.render(snapshot, logo)
        : await this.pptx.render(snapshot, logo);
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new Error("Executive report renderer returned an empty payload");
    }
    if (bytes.length > MAX_RENDERED_REPORT_BYTES) {
      throw new PayloadTooLargeException(
        "The generated report is too large. Reduce report content and try again.",
      );
    }

    const filename = buildReportFilename(
      snapshot.client.name,
      snapshot.strategy.title,
      snapshot.asOf,
      options.format,
      options.audience,
    );

    // The audit row is written only after a complete OOXML payload exists, and
    // before the controller streams it. No report prose, logo bytes, member ids,
    // or object keys enter the audit/outbox payload.
    await this.prisma.withTenantUser(tenantId, actorUserId, async (tx) => {
      const current = await tx.spStrategy.findFirst({
        where: { id: strategyId, archivedAt: null },
        select: { id: true },
      });
      if (!current) throw new NotFoundException("Strategy not found");
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId,
        authorKind: "person",
        action: "strategy.report.exported",
        entityType: "strategy",
        entityId: strategyId,
        strategyId,
        after: {
          format: options.format,
          audience: options.audience,
          snapshotHash: snapshot.snapshotHash,
          versionId: snapshot.version.id,
          filename,
          byteLength: bytes.length,
          clientLogoRequested: options.useClientLogo,
          clientLogoIncluded: Boolean(logo),
          inclusion: snapshot.inclusion,
          content: {
            contextDocuments: snapshot.context.includedDocuments,
            contextFacts: snapshot.context.facts.length,
            narrativeSections: snapshot.context.sections.length,
          },
          sections: {
            roadmap: options.includeRoadmap,
            evidenceAppendix: options.includeEvidenceAppendix,
            changeLog: options.includeChangeLog,
            internalNotes: options.includeInternalNotes,
            agentHistory: options.includeAgentHistory,
          },
        },
      });
    });

    return {
      bytes,
      contentType: CONTENT_TYPES[options.format],
      filename,
      snapshotHash: snapshot.snapshotHash,
      audience: options.audience,
      logoIncluded: Boolean(logo),
    };
  }

  /**
   * OOXML generation and raster validation are memory-heavy. Keep one export
   * active per task and bound the queue so a burst cannot exhaust the 512 MiB
   * report container with concurrent JPEG decoders and packers.
   */
  private async withExportSlot<T>(work: () => Promise<T>): Promise<{
    value: T;
    release: () => void;
  }> {
    if (this.pendingExports >= MAX_IN_PROCESS_EXPORTS) {
      throw new ServiceUnavailableException(
        "Executive report generation is busy. Please retry in a moment.",
      );
    }

    this.pendingExports += 1;
    const previous = this.exportTail;
    let release!: () => void;
    this.exportTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      this.pendingExports -= 1;
      release();
    };
    try {
      return { value: await work(), release: releaseOnce };
    } catch (error) {
      releaseOnce();
      throw error;
    }
  }
}

/** Fail before logo reads, rendering, or audit writes when preflight is stale. */
export function assertExpectedSnapshotHash(
  expectedSnapshotHash: string | undefined,
  currentSnapshotHash: string,
): void {
  if (!expectedSnapshotHash || expectedSnapshotHash === currentSnapshotHash)
    return;
  throw new ConflictException({
    code: REPORT_SNAPSHOT_CHANGED,
    message:
      "The strategy or report settings changed after readiness was checked. Refresh readiness and review the updated report before exporting.",
    expectedSnapshotHash,
    currentSnapshotHash,
  });
}

export function buildReportFilename(
  clientName: string,
  strategyTitle: string,
  asOf: string,
  extension: "docx" | "pptx",
  audience: "client" | "internal",
): string {
  const deliverable =
    extension === "pptx" ? "executive-briefing" : "executive-report";
  const audienceLabel = audience === "client" ? "client" : "internal-working";
  const stem = slug(
    `${clientName}-${strategyTitle}-${deliverable}-${audienceLabel}`,
  );
  return `${stem || `strategy-${deliverable}`}-${asOf}.${extension}`;
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/g, "");
}
