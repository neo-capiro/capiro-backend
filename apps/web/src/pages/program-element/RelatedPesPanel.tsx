import { Card, Empty, Skeleton, Tag, Tooltip, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import type { ProgramElementRelatedResponse } from './types.js';
import { PeSecondaryFailed } from './PeSecondaryFailed.js';

const { Text } = Typography;

export interface RelatedPesPanelProps {
  related: ProgramElementRelatedResponse | null | undefined;
  loading?: boolean;
  errored?: boolean;
  onRetry?: () => void;
}

// Similarity → color band. Kept conservative: these are suggestions, so we don't
// imply certainty with green unless the missions are genuinely close.
function similarityColor(similarity: number): string {
  if (similarity >= 0.85) return 'green';
  if (similarity >= 0.78) return 'gold';
  return 'default';
}

export function RelatedPesPanel({ related, loading = false, errored = false, onRetry }: RelatedPesPanelProps) {
  const navigate = useNavigate();

  if (loading) {
    return (
      <Card title="Related program elements">
        <Skeleton active paragraph={{ rows: 3 }} />
      </Card>
    );
  }

  if (errored) {
    return (
      <PeSecondaryFailed label="related program elements" testId="pe-secondary-failed-related" onRetry={onRetry} />
    );
  }


  const rows = related?.related ?? [];

  if (rows.length === 0) {
    return (
      <Card className="pe-related-card" title="Related program elements">
        <Empty
          description={
            related?.todo ??
            'No related program elements yet — similarity suggestions appear once mission embeddings are generated.'
          }
        />
      </Card>
    );
  }

  return (
    <Card
      className="pe-related-card"
      title="Related program elements"
      extra={
        <Tooltip title="PEs whose mission text is semantically similar to this one. These are suggestions based on description similarity — not a documented funding or program relationship.">
          <Text type="secondary">Suggested · by mission similarity</Text>
        </Tooltip>
      }
    >
      <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
        Suggestions only — PEs with similar mission descriptions. Not a documented
        program or funding link; use as a starting point for related-program research.
      </Text>
      <div className="pe-scroll-5">
        <div className="pe-related-list">
          {rows.map((pe) => (
            <button
              type="button"
              key={pe.peCode}
              className="pe-related-row"
              onClick={() => navigate(`/program-elements/${encodeURIComponent(pe.peCode)}`)}
            >
              <span className="pe-related-ident">
                <span className="pe-related-code">{pe.peCode}</span>
                {pe.service ? <span className="pe-related-service">{pe.service}</span> : null}
              </span>
              <span className="pe-related-title">{pe.title}</span>
              <Tag color={similarityColor(pe.similarity)} className="pe-related-score">
                {Math.round(pe.similarity * 100)}% similar
              </Tag>
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
}
