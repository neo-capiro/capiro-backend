/**
 * SourceDocument proof resolver.
 *
 * Uses the real Prisma model and current source-document registry to load
 * by exact `sourceDocumentId`, compare stored SHA to actual source PDF SHA,
 * and reject a source-document row whose SHA differs from the artifact/source
 * bytes.
 *
 * Does not infer a SourceDocument by filename when an ID was requested.
 */
import type {
  SourceDocumentRow,
  SourceDocumentClient,
} from '../../../program-element/source-document/source-document-registry.js';
import type {
  TrustedSourceDocumentProofV1,
  ProofFindingV1,
} from './trusted-proof-types.js';
import { blockingFinding } from './trusted-proof-types.js';

export interface SourceDocumentProofResolverInput {
  sourceDocumentId: string;
  /** SHA of actual source bytes (from filesystem or archive resolver). */
  actualSourcePdfSha256: string;
  /** SHA asserted by the artifact. */
  artifactSourcePdfSha256: string;
  /** Fiscal year from the manifest, for comparison. */
  fiscalYear?: number;
  /** Source key from the manifest, for comparison. */
  sourceKey?: string;
}

export interface SourceDocumentProofResolverResult {
  sourceDocument: TrustedSourceDocumentProofV1;
  findings: ProofFindingV1[];
  row: SourceDocumentRow | null;
}

/**
 * Resolve source-document proof from the real Prisma model.
 * Unit tests use a fake `SourceDocumentClient`; production uses the real
 * PrismaService.
 */
export class SourceDocumentProofResolver {
  constructor(private readonly client: SourceDocumentClient) {}

  async resolve(
    input: SourceDocumentProofResolverInput,
  ): Promise<SourceDocumentProofResolverResult> {
    const findings: ProofFindingV1[] = [];

    // Load by exact sourceDocumentId
    const row = await this.client.sourceDocument.findFirst({
      where: { id: input.sourceDocumentId },
    });

    if (!row) {
      findings.push(
        blockingFinding(
          'source_document_not_found',
          `SourceDocument ${input.sourceDocumentId} not found`,
        ),
      );
      return {
        sourceDocument: {
          id: input.sourceDocumentId,
          sourceKey: input.sourceKey ?? '',
          sourceSha256: input.artifactSourcePdfSha256,
        },
        findings,
        row: null,
      };
    }

    // Compare stored SHA to actual source PDF SHA
    const storedSha = row.sha256;
    if (storedSha && storedSha !== input.actualSourcePdfSha256) {
      findings.push(
        blockingFinding(
          'source_sha_mismatch',
          `SourceDocument SHA ${storedSha} does not match actual source PDF SHA ${input.actualSourcePdfSha256}`,
        ),
      );
    }

    // Compare artifact source SHA
    if (input.artifactSourcePdfSha256 !== input.actualSourcePdfSha256) {
      findings.push(
        blockingFinding(
          'artifact_source_sha_mismatch',
          `artifact source SHA ${input.artifactSourcePdfSha256} does not match actual source PDF SHA ${input.actualSourcePdfSha256}`,
        ),
      );
    }

    // Compare fiscal year, source key where stored
    if (input.fiscalYear != null && row.fiscalYear != null && row.fiscalYear !== input.fiscalYear) {
      findings.push(
        blockingFinding(
          'source_sha_mismatch',
          `SourceDocument fiscal year ${row.fiscalYear} does not match manifest fiscal year ${input.fiscalYear}`,
        ),
      );
    }

    const sourceDocument: TrustedSourceDocumentProofV1 = {
      id: row.id,
      sourceKey: row.sourceKey,
      sourceSha256: storedSha ?? input.actualSourcePdfSha256,
      sourceUrl: (row.sourceUrl as string | undefined) ?? undefined,
      artifactPath: (row.artifactPath as string | undefined) ?? undefined,
      fiscalYear: (row.fiscalYear as number | undefined) ?? undefined,
      budgetCycle: (row.budgetCycle as string | undefined) ?? undefined,
      component: (row.component as string | undefined) ?? undefined,
      documentType: (row.documentType as string | undefined) ?? undefined,
      extractionMethod: (row.extractionMethod as string | undefined) ?? undefined,
      extractionToolVersion: (row.extractionToolVersion as string | undefined) ?? undefined,
      metadata: (row.metadata as Record<string, unknown> | undefined) as Record<string, import('../../contracts/canonical-json.js').JsonValue> | undefined,
    };

    return { sourceDocument, findings, row };
  }
}