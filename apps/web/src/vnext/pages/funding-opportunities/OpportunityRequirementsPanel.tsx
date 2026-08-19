import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import {
  FUNDING_OPPORTUNITIES_DOCUMENTS_FEATURE,
  REQUIREMENT_TYPE_LABELS,
  requirementsApiPath,
  type OpportunityRequirementsResponse,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { FovAlert, FovCard, FovPill, FovSkeletonRows } from './fov-ui.js';

/**
 * Requirements extracted from a solicitation's own documents (P31) — vNext
 * port of the canonical panel.
 *
 * Unchanged rules: NO REQUIREMENT WITHOUT A CITATION (the verbatim excerpt is
 * never optional and never collapsed behind a toggle); an empty panel says
 * WHICH kind of empty (flag off / nothing archived / no text / read and none
 * found); candidate and accepted are never the same badge.
 */
export function OpportunityRequirementsPanel({
  source,
  sourceRecordId,
}: {
  source: string;
  sourceRecordId: string;
}) {
  const api = useApi();
  const flag = useIntelFeature(FUNDING_OPPORTUNITIES_DOCUMENTS_FEATURE);

  const query = useQuery<OpportunityRequirementsResponse>({
    queryKey: ['funding-opportunity-requirements', source, sourceRecordId],
    queryFn: async () =>
      (await api.get<OpportunityRequirementsResponse>(requirementsApiPath(source, sourceRecordId)))
        .data,
    retry: false,
    enabled: flag.ready && flag.enabled,
  });

  const body = (): ReactNode => {
    if (!flag.ready) return <FovSkeletonRows rows={3} />;
    if (!flag.enabled) {
      return (
        <span className="fov-muted" data-testid="fo-requirements-not-enabled">
          Document analysis is not enabled for this workspace. This says nothing about what this
          solicitation requires — its documents have not been read.
        </span>
      );
    }
    if (query.isPending) return <FovSkeletonRows rows={4} />;
    if (query.isError) {
      return (
        <FovAlert
          tone="error"
          testId="fo-requirements-error"
          message="Requirements failed to load"
          description="This is a request failure, not an empty requirement list. Nothing can be concluded about what the solicitation requires."
        />
      );
    }

    const data = query.data;
    if (data.requirements.length === 0) {
      return (
        <div data-testid={`fo-requirements-${data.coverage}`}>
          <span className="fov-muted">{data.coverageExplanation}</span>
          {data.documentTextStatus.length > 0 ? (
            <ul className="fov-gaps" data-testid="fo-requirements-text-status">
              {data.documentTextStatus.map((d) => (
                <li key={`${d.fileName ?? 'document'}:${d.status}`}>
                  <span className="fov-micro">
                    {d.fileName ?? 'Document'} — {d.explanation}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      );
    }

    return (
      <div className="fov-stack fov-stack--10">
        {data.requirements.map((requirement) => (
          <div key={requirement.id} data-testid={`fo-requirement-${requirement.id}`}>
            <span className="fov-row">
              <FovPill tone="blue">
                {REQUIREMENT_TYPE_LABELS[requirement.requirementType] ?? requirement.requirementType}
              </FovPill>
              {/* Candidate and accepted are never the same badge. A model's
                  assertion is not a team's conclusion. */}
              {requirement.reviewStatus === 'accepted' ? (
                <FovPill tone="green">Accepted by review</FovPill>
              ) : requirement.reviewStatus === 'rejected' ? (
                <FovPill>Rejected by review</FovPill>
              ) : (
                <FovPill
                  tone="orange"
                  title="Extracted automatically and not yet reviewed. Treat it as a lead to verify, not as a compliance requirement."
                >
                  Candidate — unreviewed
                </FovPill>
              )}
              <FovPill title="How good the evidence is, NOT a probability that the requirement is real.">
                Confidence: {requirement.confidence}
              </FovPill>
              {requirement.supersededAt ? (
                <FovPill
                  tone="red"
                  title="The document changed after this was extracted. The quote below may no longer appear in the current version."
                >
                  Document changed since
                </FovPill>
              ) : null}
            </span>
            <div>
              <span>{requirement.statement}</span>
            </div>
            {/* THE CITATION. Never optional, never collapsed behind a toggle. */}
            <blockquote className="fov-requirement__evidence">
              <span className="fov-muted">“{requirement.sourceExcerpt}”</span>
              <div>
                <span className="fov-micro">
                  {requirement.fileName ?? 'Source document'}
                  {requirement.sourcePage != null ? `, page ${requirement.sourcePage}` : ''} ·
                  characters {requirement.excerptStart}–{requirement.excerptEnd} · extracted by{' '}
                  {requirement.extractionMethod === 'human'
                    ? 'a person'
                    : requirement.extractionModel}
                </span>
              </div>
            </blockquote>
          </div>
        ))}
        <p className="fov-micro" style={{ margin: 0 }}>
          Every requirement above quotes the document it came from. Nothing here is a summary: a
          compliance list nobody can check against the source is worse than no list.
        </p>
      </div>
    );
  };

  return (
    <FovCard title="Requirements" testId="fo-detail-requirements">
      {body()}
    </FovCard>
  );
}
