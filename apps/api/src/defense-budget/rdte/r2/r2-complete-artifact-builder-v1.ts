/** Complete R-2 artifact composition: identity + narrative + funding. */
import {
  ArtifactBuilderV1,
  assertionIdV1,
  evidenceIdV1,
  factIdV1,
  omissionIdV1,
} from '../../contracts/artifact-builders.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  ParserRunV1,
} from '../../contracts/extraction-artifact-v1.js';
import type { R2IdentityExtractionResult } from './r2-identity-extractor-v1.js';
import type { R2NarrativeExtractionResult } from './r2-narrative-extractor-v1.js';

function parserRunForPage(parserRuns: readonly ParserRunV1[], page: number): string {
  const run = parserRuns.find((candidate) =>
    candidate.pageRanges.some((range) => page >= range.startPage && page <= range.endPage),
  );
  if (!run) throw new Error(`R-2 page ${page} has no contributing parser run`);
  return run.parserRunId;
}

/**
 * Replay the funding artifact into one ArtifactBuilder and append the identity
 * and narrative ledgers extracted from the same selected Phase 3 pages.
 */
export function buildCompleteR2Artifact(input: {
  fundingArtifact: DefenseBudgetExtractionArtifactV1;
  parserRuns: readonly ParserRunV1[];
  identities: R2IdentityExtractionResult;
  narrative: R2NarrativeExtractionResult;
}): DefenseBudgetExtractionArtifactV1 {
  if (input.parserRuns.length === 0) {
    throw new Error('R-2 artifact requires exact contributing parser runs');
  }
  const builder = new ArtifactBuilderV1(input.fundingArtifact.source);
  for (const value of input.parserRuns) builder.addParserRun(value);
  for (const value of input.fundingArtifact.evidence) builder.addEvidence(value);
  for (const value of input.fundingArtifact.sourceFacts) builder.addSourceFact(value);
  for (const value of input.fundingArtifact.assertions) builder.addAssertion(value);
  for (const value of input.fundingArtifact.warnings) builder.addWarning(value);
  for (const value of input.fundingArtifact.omissions) builder.addOmission(value);

  for (const identity of input.identities.identities) {
    const parserRunId = parserRunForPage(input.parserRuns, identity.page);
    const evidenceId = evidenceIdV1({
      kind: 'r2_identity',
      peCode: identity.peCode,
      page: identity.page,
      segmentId: identity.segmentId,
    });
    builder.addEvidence({
      evidenceId,
      sourcePdfSha256: input.fundingArtifact.source.sourcePdfSha256,
      parserRunId,
      granularity: 'page_only',
      page: identity.page,
      ...(identity.printedPage ? { printedPage: identity.printedPage } : {}),
      excerpt: identity.title,
    });
    const factId = factIdV1({
      kind: 'r2_identity_fact',
      peCode: identity.peCode,
      page: identity.page,
    });
    builder.addSourceFact({
      factId,
      sourcePath: `r2/pe:${identity.peCode}/identity/page:${identity.page}`,
      category: 'identity',
      requiredForCompleteness: true,
      rawValue: {
        peCode: identity.peCode,
        title: identity.title,
        contextSource: identity.contextSource,
      },
      evidenceIds: [evidenceId],
    });
    builder.addAssertion({
      assertionKind: 'program_element_identity',
      assertionId: assertionIdV1({
        kind: 'r2_identity_assertion',
        peCode: identity.peCode,
        page: identity.page,
      }),
      sourceFactIds: [factId],
      evidenceIds: [evidenceId],
      confidence: identity.contextSource === 'explicit_header' ? 1 : 0.9,
      identity: { lineKind: 'RDTE_PE', peCode: identity.peCode },
      title: identity.title,
      component: input.fundingArtifact.source.component,
      ...(identity.appropriation ? { appropriation: identity.appropriation } : {}),
      ...(identity.budgetActivity ? { budgetActivity: identity.budgetActivity } : {}),
      metadata: {
        exhibit: 'R-2',
        segmentId: identity.segmentId,
        contextSource: identity.contextSource,
        physicalPage: identity.page,
      },
    });
  }

  for (const section of input.narrative.sections) {
    const evidenceIds: string[] = [];
    for (const page of section.pages) {
      const evidenceId = evidenceIdV1({
        kind: 'r2_narrative',
        peCode: section.peCode,
        narrativeType: section.narrativeType,
        sectionLabel: section.sectionLabel,
        page,
      });
      evidenceIds.push(evidenceId);
      builder.addEvidence({
        evidenceId,
        sourcePdfSha256: input.fundingArtifact.source.sourcePdfSha256,
        parserRunId: parserRunForPage(input.parserRuns, page),
        granularity: 'page_only',
        page,
        ...(section.printedPages[0] ? { printedPage: section.printedPages[0] } : {}),
        excerpt: section.text.slice(0, 1000),
      });
    }
    const factId = factIdV1({
      kind: 'r2_narrative_fact',
      peCode: section.peCode,
      narrativeType: section.narrativeType,
      sectionLabel: section.sectionLabel,
      pages: section.pages,
    });
    builder.addSourceFact({
      factId,
      sourcePath: `r2/pe:${section.peCode}/narrative:${section.narrativeType}`,
      category: 'text',
      requiredForCompleteness:
        section.narrativeType === 'mission' || section.narrativeType === 'description',
      rawValue: section.rawText,
      evidenceIds,
    });
    builder.addAssertion({
      assertionKind: 'narrative',
      assertionId: assertionIdV1({
        kind: 'r2_narrative_assertion',
        peCode: section.peCode,
        narrativeType: section.narrativeType,
        sectionLabel: section.sectionLabel,
        pages: section.pages,
      }),
      sourceFactIds: [factId],
      evidenceIds,
      confidence: 1,
      identity: { lineKind: 'RDTE_PE', peCode: section.peCode },
      narrativeType: section.narrativeType,
      text: section.text,
      metadata: {
        exhibit: 'R-2',
        sectionLabel: section.sectionLabel,
        physicalPages: section.pages,
        printedPages: section.printedPages,
      },
    });
  }

  for (const omission of input.identities.omissions) {
    const factId = factIdV1({ kind: 'r2_identity_omission_fact', ...omission });
    builder.addSourceFact({
      factId,
      sourcePath: `r2/identity-omission/page:${omission.page}/segment:${omission.segmentId}`,
      category: 'identity',
      requiredForCompleteness: true,
      rawValue: omission.rawText,
      evidenceIds: [],
    });
    builder.addOmission({
      omissionId: omissionIdV1({ kind: 'r2_identity_omission', ...omission }),
      sourceFactId: factId,
      reason: omission.reason.includes('invalid') ? 'invalid_identity' : 'missing_evidence',
      severity: 'blocking',
      message: `R-2 identity omission on page ${omission.page}: ${omission.reason}`,
    });
  }

  for (const omission of input.narrative.omissions) {
    const factId = factIdV1({ kind: 'r2_narrative_omission_fact', ...omission });
    builder.addSourceFact({
      factId,
      sourcePath: `r2/pe:${omission.peCode}/narrative-omission/page:${omission.page}`,
      category: 'text',
      requiredForCompleteness: true,
      rawValue: omission.rawText,
      evidenceIds: [],
    });
    builder.addOmission({
      omissionId: omissionIdV1({ kind: 'r2_narrative_omission', ...omission }),
      sourceFactId: factId,
      reason: 'missing_value',
      severity: 'blocking',
      message: `R-2 narrative omission for ${omission.peCode} on page ${omission.page}: ${omission.reason}`,
    });
  }

  return builder.finalize();
}
