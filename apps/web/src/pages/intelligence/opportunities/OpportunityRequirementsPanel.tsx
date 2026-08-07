import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import {
  FUNDING_OPPORTUNITIES_DOCUMENTS_FEATURE,
  REQUIREMENT_TYPE_LABELS,
  requirementsApiPath,
  type OpportunityRequirementsResponse,
} from './funding-opportunities-api.js';

const { Paragraph, Text } = Typography;

/**
 * Requirements extracted from a solicitation's own documents (P31).
 *
 * ── The rule this panel exists to keep ───────────────────────────────────────
 *
 * NO REQUIREMENT WITHOUT A CITATION. Every row shows the verbatim excerpt it
 * came from and the document it came from. There is no "summary of
 * requirements" mode and no way to render a statement without its evidence,
 * because a compliance list nobody can check against the source is worse than
 * no list: it invites a team to build a proposal against Capiro's paraphrase.
 *
 * ── An empty panel says WHICH kind of empty ──────────────────────────────────
 *
 * Four causes, and only the last is a fact about the solicitation:
 *
 *   flag off              the workspace has not enabled document analysis.
 *   no documents archived nothing has been fetched to read.
 *   no text available     the documents are archived but unread — and the WHY
 *                         comes from P30 (`not_entitled` is a billing fact,
 *                         `not_provided` means a scanned file with no text
 *                         layer). Carried through verbatim rather than
 *                         re-summarised.
 *   text read, none found the documents were read and no requirement of a kind
 *                         Capiro extracts was found.
 *
 * "This solicitation has no requirements" is never true, and none of the four
 * sentences below says it.
 *
 * ── Candidate, not truth ─────────────────────────────────────────────────────
 *
 * Every row carries what produced it and its review state. A model's assertion
 * renders as a candidate awaiting review; a human's acceptance renders as
 * accepted, by name. The two are never the same badge.
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

  const body = () => {
    if (!flag.ready) return <Skeleton active paragraph={{ rows: 3 }} />;
    if (!flag.enabled) {
      return (
        <Text type="secondary" style={{ fontSize: 12 }} data-testid="fo-requirements-not-enabled">
          Document analysis is not enabled for this workspace. This says nothing about what this
          solicitation requires — its documents have not been read.
        </Text>
      );
    }
    if (query.isPending) return <Skeleton active paragraph={{ rows: 4 }} />;
    if (query.isError) {
      return (
        <Alert
          type="error"
          showIcon
          data-testid="fo-requirements-error"
          message="Requirements failed to load"
          description="This is a request failure, not an empty requirement list. Nothing can be concluded about what the solicitation requires."
        />
      );
    }

    const data = query.data;
    if (data.requirements.length === 0) {
      return (
        <div data-testid={`fo-requirements-${data.coverage}`}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {data.coverageExplanation}
          </Text>
          {data.documentTextStatus.length > 0 ? (
            <ul className="fo-gaps" data-testid="fo-requirements-text-status">
              {data.documentTextStatus.map((d) => (
                <li key={`${d.fileName ?? 'document'}:${d.status}`}>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {d.fileName ?? 'Document'} — {d.explanation}
                  </Text>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      );
    }

    return (
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        {data.requirements.map((requirement) => (
          <div key={requirement.id} data-testid={`fo-requirement-${requirement.id}`}>
            <Space size={6} wrap>
              <Tag color="blue">
                {REQUIREMENT_TYPE_LABELS[requirement.requirementType] ?? requirement.requirementType}
              </Tag>
              {/*
                Candidate and accepted are never the same badge. A model's
                assertion is not a team's conclusion.
              */}
              {requirement.reviewStatus === 'accepted' ? (
                <Tag color="green">Accepted by review</Tag>
              ) : requirement.reviewStatus === 'rejected' ? (
                <Tag>Rejected by review</Tag>
              ) : (
                <Tooltip title="Extracted automatically and not yet reviewed. Treat it as a lead to verify, not as a compliance requirement.">
                  <Tag color="orange">Candidate — unreviewed</Tag>
                </Tooltip>
              )}
              <Tooltip title="How good the evidence is, NOT a probability that the requirement is real.">
                <Tag>Confidence: {requirement.confidence}</Tag>
              </Tooltip>
              {requirement.supersededAt ? (
                <Tooltip title="The document changed after this was extracted. The quote below may no longer appear in the current version.">
                  <Tag color="red">Document changed since</Tag>
                </Tooltip>
              ) : null}
            </Space>
            <div>
              <Text>{requirement.statement}</Text>
            </div>
            {/*
              THE CITATION. Never optional, never collapsed behind a toggle: a
              statement a reader cannot check against the source invites them to
              build a proposal against Capiro's paraphrase.
            */}
            <blockquote className="fo-requirement__evidence">
              <Text type="secondary" style={{ fontSize: 12 }}>
                “{requirement.sourceExcerpt}”
              </Text>
              <div>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {requirement.fileName ?? 'Source document'}
                  {requirement.sourcePage != null ? `, page ${requirement.sourcePage}` : ''} ·
                  characters {requirement.excerptStart}–{requirement.excerptEnd} · extracted by{' '}
                  {requirement.extractionMethod === 'human'
                    ? 'a person'
                    : requirement.extractionModel}
                </Text>
              </div>
            </blockquote>
          </div>
        ))}
        <Paragraph type="secondary" style={{ fontSize: 11, marginBottom: 0 }}>
          Every requirement above quotes the document it came from. Nothing here is a summary: a
          compliance list nobody can check against the source is worse than no list.
        </Paragraph>
      </Space>
    );
  };

  return (
    <Card
      size="small"
      title="Requirements"
      className="fo-detail__section"
      data-testid="fo-detail-requirements"
    >
      {body()}
    </Card>
  );
}
