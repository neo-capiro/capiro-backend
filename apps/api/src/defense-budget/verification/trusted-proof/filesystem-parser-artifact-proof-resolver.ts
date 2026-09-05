/**
 * Strengthens local/filesystem verification with the exact Phase 3 parser
 * artifact store. The base FilesystemProofResolver proves manifest, source and
 * extraction-artifact bytes; this decorator additionally reads and verifies
 * every contributing parser result before marking parser lineage verified.
 */
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';
import type { ParserRuntimeResultV1 } from '../../parser-router/parser-runtime-contract-v1.js';
import type { ParserArtifactStoreV1 } from '../../parser-router/parser-artifact-store.js';
import {
  resolveContributingRunIdentityV1,
  validateParserRunCoverageV1,
  type ResolvedContributingRunIdentityV1,
} from '../../parser-router/parser-run-identity-v1.js';
import {
  blockingFinding,
  type ProofFindingV1,
  type TrustedParserRunProofV1,
  type TrustedProofResolveInputV1,
  type TrustedProofResolutionV1,
  type TrustedVerificationProofBundleV1,
  type TrustedVerificationProofResolverV1,
} from './trusted-proof-types.js';

function exactPages(ranges: readonly { startPage: number; endPage: number }[]): number[] {
  const pages = new Set<number>();
  for (const range of ranges) {
    for (let page = range.startPage; page <= range.endPage; page += 1) {
      pages.add(page);
    }
  }
  return [...pages].sort((left, right) => left - right);
}

function parserIdentity(
  run: DefenseBudgetExtractionArtifactV1['parserRuns'][number],
): ResolvedContributingRunIdentityV1 {
  return resolveContributingRunIdentityV1(run);
}

function evidencePagesForRun(
  artifact: DefenseBudgetExtractionArtifactV1,
  parserRunId: string,
): number[] {
  return [
    ...new Set(
      artifact.evidence
        .filter((evidence) => evidence.parserRunId === parserRunId && evidence.page != null)
        .map((evidence) => evidence.page!),
    ),
  ].sort((left, right) => left - right);
}

function coversEvidencePages(
  result: ParserRuntimeResultV1,
  evidencePages: readonly number[],
): boolean {
  const succeeded = new Set(result.succeededPages);
  return evidencePages.every((page) => succeeded.has(page));
}

function proofForRun(input: {
  run: DefenseBudgetExtractionArtifactV1['parserRuns'][number];
  existing?: TrustedParserRunProofV1;
  outputLocator?: string;
  proofStatus: TrustedParserRunProofV1['proofStatus'];
}): TrustedParserRunProofV1 {
  return {
    parserRunId: input.run.parserRunId,
    method: input.run.method,
    parserVersion: input.run.parserVersion,
    parserConfigSha256: input.run.parserConfigSha256,
    inputSourceSha256: input.run.inputSourceSha256,
    outputArtifactSha256: input.run.outputArtifactSha256,
    ...(input.existing?.persistedParseJobId
      ? { persistedParseJobId: input.existing.persistedParseJobId }
      : {}),
    ...(input.existing?.providerJobId
      ? { providerJobId: input.existing.providerJobId }
      : input.run.providerJobId
        ? { providerJobId: input.run.providerJobId }
        : {}),
    ...(input.outputLocator
      ? { outputLocator: input.outputLocator }
      : input.existing?.outputLocator
        ? { outputLocator: input.existing.outputLocator }
        : {}),
    proofStatus: input.proofStatus,
  };
}

export class FilesystemParserArtifactProofResolver implements TrustedVerificationProofResolverV1 {
  constructor(
    private readonly delegate: TrustedVerificationProofResolverV1,
    private readonly artifactStore: ParserArtifactStoreV1,
  ) {}

  async resolve(input: TrustedProofResolveInputV1): Promise<TrustedProofResolutionV1> {
    const resolution = await this.delegate.resolve(input);
    const candidate = await this.verifyArtifact(
      resolution.artifact,
      resolution.proofBundle,
      resolution.proofFindings,
    );

    const referenceBundles: TrustedVerificationProofBundleV1[] = [];
    const referenceFindings: ProofFindingV1[] = [...resolution.referenceArtifactsFindings];
    for (let index = 0; index < resolution.referenceArtifacts.length; index += 1) {
      const artifact = resolution.referenceArtifacts[index];
      const bundle = resolution.referenceArtifactsProofBundles[index];
      if (!artifact || !bundle) {
        referenceFindings.push(
          blockingFinding(
            'reference_artifact_proof_failed',
            `reference artifact proof bundle missing at index ${index}`,
          ),
        );
        continue;
      }
      const before = referenceFindings.length;
      const verified = await this.verifyArtifact(artifact, bundle, referenceFindings);
      for (let findingIndex = before; findingIndex < referenceFindings.length; findingIndex += 1) {
        const finding = referenceFindings[findingIndex]!;
        finding.artifactId ??= artifact.artifactId;
        finding.sourceDocumentId ??= bundle.sourceDocument.id;
        finding.locator ??= bundle.extractionArtifact.locator;
      }
      referenceBundles.push(verified);
    }

    return {
      ...resolution,
      proofBundle: candidate,
      referenceArtifactsProofBundles: referenceBundles,
      referenceArtifactsFindings: referenceFindings,
    };
  }

  private async verifyArtifact(
    artifact: DefenseBudgetExtractionArtifactV1,
    bundle: TrustedVerificationProofBundleV1,
    findings: ProofFindingV1[],
  ): Promise<TrustedVerificationProofBundleV1> {
    const existingById = new Map(bundle.parserRuns.map((proof) => [proof.parserRunId, proof]));
    const parserRuns: TrustedParserRunProofV1[] = [];

    for (const run of artifact.parserRuns) {
      const existing = existingById.get(run.parserRunId);
      /* Evidence coverage only (pages this run contributed *selected*
       * evidence for in the composed output) -- never run identity. See
       * `parserIdentity` below for the canonical requestedPages-based
       * identity used for the independent-persistence lookup. */
      const evidenceCoveragePages = exactPages(run.pageRanges);
      const evidencePages = evidencePagesForRun(artifact, run.parserRunId);

      /* A structured/manual companion is itself the independently hashed
       * extraction artifact. It has no Phase 3 parser-cache envelope. Bind it
       * directly to the artifact content/byte proof and retain manual review
       * policy rather than fabricating a local parser job. */
      if (run.method === 'native_structured' || run.method === 'manual') {
        const outputMatches =
          run.outputArtifactSha256 === bundle.extractionArtifact.contentSha256 ||
          run.outputArtifactSha256 === bundle.extractionArtifact.byteSha256;
        const inputMatches = run.inputSourceSha256 === bundle.sourceDocument.sourceSha256;
        const pageCoverageValid = evidencePages.every((page) => evidenceCoveragePages.includes(page));
        const verified = outputMatches && inputMatches && pageCoverageValid;
        if (!verified) {
          findings.push(
            blockingFinding(
              !outputMatches
                ? 'parse_output_sha_mismatch'
                : !inputMatches
                  ? 'parse_input_sha_mismatch'
                  : 'parse_page_coverage_incomplete',
              `structured/manual parser proof failed for ${run.parserRunId}`,
            ),
          );
        }
        parserRuns.push(
          proofForRun({
            run,
            ...(existing ? { existing } : {}),
            outputLocator: bundle.extractionArtifact.locator,
            proofStatus: verified ? 'verified' : 'mismatch',
          }),
        );
        continue;
      }

      if (evidenceCoveragePages.length === 0) {
        findings.push(
          blockingFinding(
            'parse_page_coverage_incomplete',
            `parser run ${run.parserRunId} declares no exact page coverage`,
          ),
        );
        parserRuns.push(
          proofForRun({
            run,
            ...(existing ? { existing } : {}),
            proofStatus: 'missing',
          }),
        );
        continue;
      }

      /* Phase 10B-25: resolve the canonical requestedPages-based identity
       * BEFORE any lookup. A legacy artifact predating `requestedPages`
       * cannot be safely resolved (there is no way to recover the original
       * requested-page set from evidence alone -- a legitimately blank page
       * leaves no trace) and must fail closed rather than fall through to a
       * lookup that could spuriously match. */
      const identity = parserIdentity(run);
      if (identity.status !== 'ok') {
        findings.push(
          blockingFinding(
            'parser_run_identity_legacy_unsupported',
            `parser run ${run.parserRunId} has no requestedPages recorded and cannot be resolved to a canonical identity (legacy artifact predating Phase 10B-25)`,
          ),
        );
        parserRuns.push(
          proofForRun({
            run,
            ...(existing ? { existing } : {}),
            proofStatus: 'missing',
          }),
        );
        continue;
      }

      /* Prove the run's own succeeded/failed coverage evidence is
       * internally consistent BEFORE trusting it or using the identity to
       * look up an independently persisted result: no overlap between
       * succeeded/failed, the union accounts for every requested page, and
       * every failure carries a typed code. This is what actually catches
       * the coverage-evidence corruption/tamper cases -- an inconsistent
       * run must never resolve to `verified`. */
      const coverage = validateParserRunCoverageV1({
        requestedPages: run.requestedPages ?? [],
        succeededPages: run.succeededPages ?? [],
        failedPages: run.failedPages ?? [],
      });
      if (!coverage.ok) {
        findings.push(
          blockingFinding(
            'parser_run_coverage_inconsistent',
            `parser run ${run.parserRunId} coverage evidence is inconsistent: ${coverage.findings.join('; ')}`,
          ),
        );
        parserRuns.push(
          proofForRun({
            run,
            ...(existing ? { existing } : {}),
            proofStatus: 'mismatch',
          }),
        );
        continue;
      }

      const descriptor = await this.artifactStore.findExact(identity.identity);
      if (!descriptor) {
        findings.push(
          blockingFinding(
            'parse_output_missing',
            `no independently persisted parser result exists for ${run.parserRunId}`,
          ),
        );
        parserRuns.push(
          proofForRun({
            run,
            ...(existing ? { existing } : {}),
            proofStatus: 'missing',
          }),
        );
        continue;
      }

      try {
        const result = await this.artifactStore.readVerified(descriptor);
        if (result.contentSha256 !== run.outputArtifactSha256) {
          findings.push(
            blockingFinding(
              'parse_output_sha_mismatch',
              `parser run ${run.parserRunId} declares ${run.outputArtifactSha256} but persisted result is ${result.contentSha256}`,
            ),
          );
          parserRuns.push(
            proofForRun({
              run,
              ...(existing ? { existing } : {}),
              outputLocator: descriptor.resultLocator,
              proofStatus: 'mismatch',
            }),
          );
          continue;
        }
        if (!coversEvidencePages(result, evidencePages)) {
          findings.push(
            blockingFinding(
              'parse_page_coverage_incomplete',
              `persisted parser result ${run.parserRunId} does not cover evidence pages ${evidencePages.join(', ')}`,
            ),
          );
          parserRuns.push(
            proofForRun({
              run,
              ...(existing ? { existing } : {}),
              outputLocator: descriptor.resultLocator,
              proofStatus: 'mismatch',
            }),
          );
          continue;
        }
        parserRuns.push(
          proofForRun({
            run,
            ...(existing ? { existing } : {}),
            outputLocator: descriptor.resultLocator,
            proofStatus: 'verified',
          }),
        );
      } catch (error) {
        findings.push(
          blockingFinding(
            'parse_output_sha_mismatch',
            `parser result proof failed for ${run.parserRunId}: ${(error as Error).message}`,
          ),
        );
        parserRuns.push(
          proofForRun({
            run,
            ...(existing ? { existing } : {}),
            outputLocator: descriptor.resultLocator,
            proofStatus: 'mismatch',
          }),
        );
      }
    }

    return { ...bundle, parserRuns };
  }
}
