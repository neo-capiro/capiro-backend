/**
 * Document registrar — composes the immutable S3 archive with the idempotent
 * SourceDocument registry so that the archival-before-registration invariant is
 * structurally guaranteed:
 *
 *   1. archive original bytes to the Object-Lock raw bucket (RawArchiveService)
 *   2. ONLY THEN upsert the SourceDocument row, carrying the returned VersionId
 *
 * A SourceDocument row produced here always has a verified archiveVersionId, so it is
 * genuine proof of archival (unlike rows backfilled from committed __data__ artifacts).
 */
import {
  upsertSourceDocument,
  type SourceDocumentClient,
  type UpsertSourceDocumentResult,
} from '../program-element/source-document/source-document-registry.js';
import type { RawArchiveService, ArchiveDescriptor, ArchiveResult } from './raw-archive.service.js';

export interface RegisterDocumentInput {
  /** Stable human key derived from filename/authority, e.g. 'jbook_r2_af_rdte_v1_fy2027'. */
  sourceKey: string;
  fiscalYear: number | null;
  /** pb | hasc | sasc | hac_d | sac_d | conference | enacted | supplemental */
  budgetCycle: string;
  component?: string | null;
  /** r1 | r2 | r2a | r3 | p1 | p40 | op5 | committee_report | conference_report | public_law | other */
  documentType: string;
  title: string;
  /** Source PDF URL when known; else the local filename. */
  sourceUrl: string;
  pageCount?: number | null;
  downloadedAt?: Date | null;
  /** Descriptor for the raw archive key layout + retrieval aliases + manifest. */
  archive: ArchiveDescriptor;
  extractionToolVersion?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RegisterDocumentResult {
  archive: ArchiveResult;
  registry: UpsertSourceDocumentResult;
}

export class DocumentRegistrar {
  constructor(
    private readonly archiveSvc: RawArchiveService,
    private readonly registryClient: SourceDocumentClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async register(input: RegisterDocumentInput): Promise<RegisterDocumentResult> {
    // STEP 1 — archive first. If this throws, no SourceDocument row is written.
    const archive = await this.archiveSvc.archiveOriginal(input.archive);

    // Guard the invariant: we must have a durable object reference before registering.
    if (!archive.key || !archive.bucket) {
      throw new Error('DocumentRegistrar: archive did not return a bucket/key; refusing to register');
    }

    // STEP 2 — register, carrying the verified archive provenance.
    const registry = await upsertSourceDocument(this.registryClient, {
      sourceKey: input.sourceKey,
      sha256: archive.sha256,
      fiscalYear: input.fiscalYear,
      budgetCycle: input.budgetCycle,
      component: input.component ?? null,
      documentType: input.documentType,
      title: input.title,
      sourceUrl: input.sourceUrl,
      byteSize: archive.byteSize,
      pageCount: input.pageCount ?? null,
      downloadedAt: input.downloadedAt ?? null,
      extractionMethod: 'llamaparse',
      extractionToolVersion: input.extractionToolVersion ?? null,
      archiveBucket: archive.bucket,
      archiveS3Key: archive.key,
      archiveVersionId: archive.versionId,
      archiveKmsKeyArn: archive.kmsKeyArn ?? null,
      retainUntil: archive.retainUntil,
      archivedAt: this.clock(),
      metadata: {
        ...input.metadata,
        retrievalKey: archive.retrievalKey,
        manifestKey: archive.manifestKey,
      },
    });

    return { archive, registry };
  }
}
