import {
  communityFundingFindingSummary,
  communityFundingFindingTitle,
  type CommunityFundingMatchDecision,
} from './community-funding-advocacy-match.js';
import type { DiscoveryFinding } from './client-profile-fill-advocacy-discovery.shared.js';
import type { FundingRow } from './client-profile-fill-community-funding-source.js';

type MatchedFunding = Extract<CommunityFundingMatchDecision, { matched: true }>;
interface FindingContext {
  externalKey: string;
  title: string;
  summary: string;
  provenance: NonNullable<FundingRow['provenanceDocs']>;
  primaryUrl: string | null;
}

/** One finding per canonical request; source occurrences remain ordered evidence. */
export function buildCommunityFundingDiscoveryFinding(
  row: FundingRow,
  decision: MatchedFunding,
): DiscoveryFinding {
  const isConfirmed = decision.method === 'confirmed_client_intel_mapping';
  const externalKey = `community_funding:${row.id}`;
  const title = communityFundingFindingTitle({
    chamber: row.chamber,
    requestType: row.requestType,
    fiscalYear: row.fiscalYear,
    recipientName: row.recipientName,
  });
  const summary = communityFundingFindingSummary({
    chamber: row.chamber,
    requestType: row.requestType,
    fiscalYear: row.fiscalYear,
    requesterName: row.requesterName,
    recipientName: row.recipientName,
    projectTitle: row.projectTitle,
    requestedAmountUsd: row.requestedAmountUsd,
    finalAmountUsd: row.finalAmountUsd,
    amountStageRaw: row.amountStageRaw,
    appropriationsAccountRaw: row.appropriationsAccountRaw,
    subcommittee: row.subcommittee,
  });
  const provenance = row.provenanceDocs ?? [];
  const primaryUrl = provenance.find((p) => p.sourceUrl)?.sourceUrl ?? null;
  const context = { externalKey, title, summary, provenance, primaryUrl };
  const proposedValue = buildProposedValue(row, decision, context);
  return {
    externalKey,
    isConfirmed,
    confidence: decision.confidence,
    proposedValue,
    evidence: buildFindingEvidence(row, decision, title, provenance, primaryUrl),
  };
}

function buildProposedValue(row: FundingRow, decision: MatchedFunding, context: FindingContext) {
  return {
    externalKey: context.externalKey,
    recordType: row.requestType === 'cds' ? 'cds_request' : 'cpf_request',
    title: context.title,
    summary: context.summary,
    activityDate: null,
    status: row.amountStageRaw,
    outcome: null,
    sourceType: 'community_funding',
    sourceId: row.id,
    sourceUrl: context.primaryUrl,
    evidenceClass: 'PUBLIC_VERIFIED',
    confidence: decision.confidence,
    metadata: {
      communityFundingRequestId: row.id,
      chamber: row.chamber,
      requestType: row.requestType,
      fiscalYear: row.fiscalYear,
      requesterName: row.requesterName,
      recipientName: row.recipientName,
      recipientNormalized: row.recipientNormalized,
      projectTitle: row.projectTitle,
      projectDescription: row.projectDescription,
      requestedAmountUsd: row.requestedAmountUsd,
      finalAmountUsd: row.finalAmountUsd,
      amountStageRaw: row.amountStageRaw,
      appropriationsAccountRaw: row.appropriationsAccountRaw,
      subcommittee: row.subcommittee,
      state: row.state,
      city: row.city,
      // One finding per canonical request — provenance is attached, never multiplied.
      provenanceCount: context.provenance.length || row.provenanceCount || 0,
      provenance: context.provenance.map((p) => ({
        sourceDocumentId: p.sourceDocumentId,
        sourcePage: p.sourcePage,
        sourceRow: p.sourceRow,
        sourceUrl: p.sourceUrl,
        title: p.title,
      })),
      clientMatch: {
        method: decision.method,
        confidence: decision.confidence,
        similarity: decision.similarity,
        geographyCorroborated: decision.geographyCorroborated,
        matchedRole: 'recipient',
      },
    },
  };
}

function buildFindingEvidence(
  row: FundingRow,
  decision: MatchedFunding,
  title: string,
  provenance: NonNullable<FundingRow['provenanceDocs']>,
  primaryUrl: string | null,
): unknown[] {
  return [
    {
      label: title,
      url: primaryUrl,
      source:
        row.requestType === 'cds'
          ? 'Senate Congressionally Directed Spending (canonical)'
          : 'House Community Project Funding (canonical)',
      metadata: {
        communityFundingRequestId: row.id,
        provenanceCount: provenance.length || row.provenanceCount || 0,
        matchMethod: decision.method,
      },
    },
    ...provenance
      .filter((p) => p.sourceUrl)
      .slice(0, 5)
      .map((p) => ({
        label: p.title ?? `Source row ${p.sourceRow}`,
        url: p.sourceUrl,
        // Evidence-item prose label — must NOT be a snake_case `source: '...'`
        // literal that the finding-source-check contract regex would treat as
        // an addFinding() source value (see FARA_INTEL_MAPPING_SOURCE note).
        source: 'CPF/CDS canonical provenance row',
        metadata: {
          sourceDocumentId: p.sourceDocumentId,
          sourcePage: p.sourcePage,
          sourceRow: p.sourceRow,
        },
      })),
  ];
}
