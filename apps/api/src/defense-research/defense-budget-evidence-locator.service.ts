import { S3Client } from '@aws-sdk/client-s3';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { DefenseEvidenceLocatorDetailsDto, DefenseEvidenceRefDto } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { defenseBudgetExtractionArtifactV1Schema } from '../defense-budget/contracts/extraction-artifact-v1.js';
import { validateDefenseBudgetExtractionArtifactV1 } from '../defense-budget/contracts/extraction-artifact-v1.semantic.js';
import {
  S3ExtractionArtifactStore,
  type ExtractionArtifactStoreV1,
} from '../defense-budget/parser-router/extraction-artifact-store.js';
import { AwsParserArtifactObjectStore } from '../defense-budget/parser-router/s3-parser-artifact-store.js';
import { unavailableLocator } from './defense-evidence-locators.js';

/** Read the already-published exact evidence; this owner never starts a parser. */
@Injectable()
export class DefenseBudgetEvidenceLocatorService implements OnModuleDestroy {
  private client: S3Client | null = null;
  private store: Pick<ExtractionArtifactStoreV1, 'readVerified'> | null = null;
  constructor(private readonly prisma: PrismaService) {}

  onModuleDestroy() {
    this.client?.destroy();
  }

  async read(
    ref: DefenseEvidenceRefDto,
    metadataValue: unknown,
  ): Promise<DefenseEvidenceLocatorDetailsDto> {
    const missing = (reason: string) => unavailableLocator(reason);
    const metadata =
      metadataValue && typeof metadataValue === 'object' && !Array.isArray(metadataValue)
        ? (metadataValue as Record<string, unknown>)
        : {};
    const { artifactId, artifactContentSha256, assertionId, evidenceId } = metadata;
    if (
      !ref.sourceDocumentId ||
      !ref.contentHash ||
      typeof artifactId !== 'string' ||
      typeof assertionId !== 'string' ||
      typeof evidenceId !== 'string' ||
      typeof artifactContentSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(artifactContentSha256)
    )
      return missing('This source row has no exact retained artifact/assertion/evidence identity.');
    const environment = process.env.APP_ENV?.trim() || process.env.CAPIRO_ENVIRONMENT?.trim();
    if (!environment) return missing('The published source environment is unavailable.');
    const active = await this.prisma.defenseBudgetActiveSnapshot.findUnique({
      where: { domain_environment: { domain: 'defense_budget', environment } },
      select: { snapshotId: true },
    });
    if (!active) return missing('There is no active published source snapshot.');
    const row = await this.prisma.defenseBudgetCanonicalRow.findFirst({
      where: {
        snapshotId: active.snapshotId,
        sourceDocumentId: ref.sourceDocumentId,
        sourcePdfSha256: ref.contentHash,
        artifactId,
        artifactContentSha256,
        sourceAssertionId: assertionId,
        evidenceIds: { array_contains: [evidenceId] },
      },
      select: { verificationCandidateId: true, verificationRunId: true },
    });
    if (!row)
      return missing(
        'The exact evidence is not admitted by the current published source snapshot.',
      );
    const candidate = await this.prisma.budgetExtractionCandidateV1.findUnique({
      where: { id: row.verificationCandidateId },
      select: {
        extractionArtifactId: true,
        extractionArtifactSha256: true,
        extractionArtifactLocator: true,
        sourceDocumentId: true,
        sourceSha256: true,
        runs: { where: { id: row.verificationRunId }, select: { decision: true } },
        reviewDecisions: {
          where: { runId: row.verificationRunId },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { decision: true },
        },
      },
    });
    if (
      !candidate ||
      candidate.extractionArtifactId !== artifactId ||
      candidate.sourceDocumentId !== ref.sourceDocumentId ||
      candidate.sourceSha256 !== ref.contentHash ||
      candidate.runs[0]?.decision !== 'PASS' ||
      candidate.reviewDecisions[0]?.decision !== 'accept' ||
      !candidate.extractionArtifactLocator
    )
      return missing('The retained artifact does not have matching qualified source proof.');
    const bucket = process.env.BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_BUCKET?.trim();
    const prefix = (
      process.env.BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_PREFIX?.trim() ||
      'phase10/parser-artifacts'
    ).replace(/^\/+|\/+$/g, '');
    try {
      const locator = new URL(candidate.extractionArtifactLocator);
      if (
        !bucket ||
        locator.protocol !== 's3:' ||
        locator.hostname !== bucket ||
        !locator.pathname.slice(1).startsWith(`${prefix}/`) ||
        !locator.searchParams.get('versionId') ||
        locator.searchParams.get('versionId') === 'null'
      )
        return missing('The configured immutable artifact location is unavailable.');
      if (!this.store) {
        const endpoint = process.env.BUDGET_VERIFICATION_S3_ENDPOINT?.trim();
        this.client = new S3Client({
          region: process.env.AWS_REGION ?? 'us-east-1',
          ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
        });
        this.store = new S3ExtractionArtifactStore(
          bucket,
          prefix,
          new AwsParserArtifactObjectStore(this.client),
          true,
        );
      }
      const bytes = await this.store.readVerified({
        locator: candidate.extractionArtifactLocator,
        expectedByteSha256: candidate.extractionArtifactSha256,
      });
      if (bytes.length > 20 * 1024 * 1024)
        return missing('The retained artifact exceeds the bounded evidence reader.');
      const parsed = defenseBudgetExtractionArtifactV1Schema.safeParse(
        JSON.parse(bytes.toString('utf8')),
      );
      if (!parsed.success)
        return missing('The retained artifact does not match its source contract.');
      const artifact = parsed.data;
      if (
        validateDefenseBudgetExtractionArtifactV1(artifact).some(
          (finding) => finding.severity === 'error',
        )
      )
        return missing('The retained artifact has invalid source or coordinate integrity.');
      const assertion = artifact.assertions.find((item) => item.assertionId === assertionId);
      const evidence = artifact.evidence.find((item) => item.evidenceId === evidenceId);
      if (
        artifact.artifactId !== artifactId ||
        artifact.contentSha256 !== artifactContentSha256 ||
        artifact.source.sourceDocumentId !== ref.sourceDocumentId ||
        artifact.source.sourcePdfSha256 !== ref.contentHash ||
        !assertion?.evidenceIds.includes(evidenceId) ||
        !evidence ||
        evidence.sourcePdfSha256 !== ref.contentHash ||
        (ref.nativeLocator.page !== null && evidence.page !== ref.nativeLocator.page)
      )
        return missing('The retained evidence does not match the exact source assertion and page.');
      const text = (value: string | undefined) => (value && value.length <= 2000 ? value : null);
      const structuredElement =
        evidence.structuredElement &&
        evidence.structuredElement.elementPath.length <= 2000 &&
        (!evidence.structuredElement.elementId ||
          evidence.structuredElement.elementId.length <= 2000)
          ? evidence.structuredElement
          : null;
      const hasDetails = Boolean(
        evidence.boundingBox ||
        evidence.textSpan ||
        structuredElement ||
        text(evidence.tableLabel) ||
        text(evidence.rowLabel) ||
        text(evidence.columnLabel),
      );
      return {
        availability: hasDetails ? 'available' : 'partial',
        reason: hasDetails ? null : 'The retained evidence has document/page granularity only.',
        printedPage: text(evidence.printedPage),
        tableLabel: text(evidence.tableLabel),
        rowLabel: text(evidence.rowLabel),
        columnLabel: text(evidence.columnLabel),
        textSpan: evidence.textSpan ?? null,
        boundingBox: evidence.boundingBox ?? null,
        structuredElement,
        sourceSpanHash: evidence.sourceSpanSha256 ?? null,
      };
    } catch {
      return missing('The immutable source artifact cannot currently be verified.');
    }
  }
}
