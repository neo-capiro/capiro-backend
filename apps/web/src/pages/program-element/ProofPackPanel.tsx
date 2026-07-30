import { Card, Empty, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import type { ProgramElementSourceItem } from './types.js';
import { proofFingerprintLabel } from './trust-model.js';

const { Text, Paragraph } = Typography;

export interface ProofPackPanelProps {
  sources: ProgramElementSourceItem[] | null | undefined;
  loading?: boolean;
}

const EXHIBIT_COLOR: Record<string, string> = {
  'R-1': 'blue',
  'R-2': 'cyan',
  'R-2A': 'geekblue',
  'R-3': 'green',
  'P-1': 'purple',
  'P-40': 'purple',
};

/** Open-at-page deep link for a citation. */
export function citationHref(s: Pick<ProgramElementSourceItem, 'sourceUrl' | 'pageNumber'>): string | null {
  if (!s.sourceUrl) return null;
  return s.pageNumber ? `${s.sourceUrl}#page=${s.pageNumber}` : s.sourceUrl;
}

function pageLabel(s: ProgramElementSourceItem): string | null {
  if (!s.pageNumber) return null;
  return s.pageEnd && s.pageEnd !== s.pageNumber ? `pp.${s.pageNumber}–${s.pageEnd}` : `p.${s.pageNumber}`;
}

/**
 * Step 1.2 (§11) + Phase 5 — proof pack: page-level citations with honest
 * fingerprint language. A sha256 tag means the *ingested bytes* match that hash;
 * it is not a claim that a full archival package or page image is attached.
 */
export function ProofPackPanel({ sources, loading = false }: ProofPackPanelProps) {
  if (loading) {
    return (
      <Card title="Sources & evidence">
        <Skeleton active paragraph={{ rows: 4 }} />
      </Card>
    );
  }

  const rows = Array.isArray(sources) ? sources : [];
  if (rows.length === 0) {
    return (
      <Card className="pe-proof-pack-card" title="Sources & evidence">
        <Empty description="No source citations recorded for this PE yet." />
      </Card>
    );
  }

  return (
    <Card className="pe-proof-pack-card" title={`Sources & evidence · ${rows.length}`}>
      <Text type="secondary" style={{ display: 'block', marginBottom: 12, fontSize: 12 }}>
        Page-level citations registered for this PE. &quot;Open at page&quot; jumps to the
        linked exhibit URL when one exists. Content fingerprints (sha256) identify the
        ingested source bytes only — they are not a full archive receipt or page-image pack.
      </Text>
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        {rows.map((s) => {
          const badge = s.exhibitType ?? s.docType;
          const href = citationHref(s);
          const page = pageLabel(s);
          const fp = proofFingerprintLabel(s.sourceDocument?.sha256);
          return (
            <div key={s.id} className="pe-proof-row" style={{ borderBottom: '1px solid #f0f0f0', paddingBottom: 6 }}>
              <Space wrap size={[6, 4]}>
                <Tag color={EXHIBIT_COLOR[badge ?? ''] ?? 'default'}>{badge}</Tag>
                {s.fy ? <Tag>FY{s.fy}</Tag> : null}
                {s.publisher ? <Text type="secondary">{s.publisher}</Text> : null}
                {page ? <Text type="secondary">{page}</Text> : null}
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer">
                    Open at page
                  </a>
                ) : (
                  <Text type="secondary">No openable source URL on this citation</Text>
                )}
                {fp ? (
                  <Tooltip title={fp.title}>
                    <Tag data-testid="pe-proof-fingerprint">{fp.short}</Tag>
                  </Tooltip>
                ) : null}
              </Space>
              {s.sourceDocument?.title ? (
                <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 2 }}>
                  {s.sourceDocument.title}
                  {s.sourceDocument.budgetCycle ? ` · ${s.sourceDocument.budgetCycle}` : ''}
                </Text>
              ) : null}
              {s.snippet ? (
                <Paragraph
                  type="secondary"
                  style={{ margin: '4px 0 0', fontSize: 12 }}
                  ellipsis={{ rows: 2, expandable: true }}
                >
                  {s.snippet}
                </Paragraph>
              ) : null}
            </div>
          );
        })}
      </Space>
    </Card>
  );
}

export default ProofPackPanel;
