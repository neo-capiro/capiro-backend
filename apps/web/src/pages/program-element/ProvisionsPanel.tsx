import { Card, Empty, Skeleton, Space, Tag, Typography } from 'antd';
import type { ProvisionItem } from './types.js';

const { Text, Paragraph } = Typography;

export interface ProvisionsPanelProps {
  provisions: ProvisionItem[] | null | undefined;
  loading?: boolean;
}

const COMMITTEE_LABEL: Record<string, string> = {
  hasc: 'HASC',
  sasc: 'SASC',
  hac_d: 'HAC-D',
  sac_d: 'SAC-D',
  conference: 'Conference',
};

const ACTION_TYPE_LABEL: Record<string, string> = {
  directs_briefing: 'Directs briefing',
  directs_report: 'Directs report',
  adds: 'Adds',
  cuts: 'Cuts',
  transfers: 'Transfers',
  restricts: 'Restricts',
  encourages: 'Encourages',
  expresses_concern: 'Expresses concern',
};

const ACTION_TYPE_COLOR: Record<string, string> = {
  directs_briefing: 'blue',
  directs_report: 'blue',
  adds: 'green',
  cuts: 'red',
  transfers: 'gold',
  restricts: 'volcano',
  encourages: 'cyan',
  expresses_concern: 'orange',
};

/** Human label for a committee code (falls back to the raw value). */
export function committeeLabel(committee: string): string {
  return COMMITTEE_LABEL[committee] ?? committee.toUpperCase();
}

/** Human label for an actionType (or "—" when null/unknown). */
export function actionTypeLabel(actionType: string | null): string {
  if (!actionType) return '—';
  return ACTION_TYPE_LABEL[actionType] ?? actionType;
}

/** Tag color for an actionType (defaults to antd's default tag). */
export function actionTypeColor(actionType: string | null): string {
  if (!actionType) return 'default';
  return ACTION_TYPE_COLOR[actionType] ?? 'default';
}

/** Open-at-page deep link for a provision (sourceUrl + #page= when present). */
function provisionHref(p: ProvisionItem): string | null {
  if (!p.sourceUrl) return null;
  return p.pageStart ? `${p.sourceUrl}#page=${p.pageStart}` : p.sourceUrl;
}

/**
 * Step 2.4 — PE profile "Congressional activity" panel. Renders extracted
 * committee report-language provisions touching this PE: the committee
 * (HASC/SASC/HAC-D/SAC-D/Conference), the directive class (adds/cuts/directs a
 * briefing, etc.), the heading, the (clamped, expandable) language, the fiscal
 * year, and a page deep-link into the source report. Accepted provisions render
 * plainly; candidate provisions carry a "Candidate — review" badge so unreviewed
 * extractions are never implied to be confirmed. Guards against non-array data
 * with Array.isArray. Honest empty state.
 */
export function ProvisionsPanel({ provisions, loading = false }: ProvisionsPanelProps) {
  if (loading) {
    return (
      <Card title="Congressional activity">
        <Skeleton active paragraph={{ rows: 3 }} />
      </Card>
    );
  }

  const rows = Array.isArray(provisions) ? provisions : [];

  if (rows.length === 0) {
    return (
      <Card className="pe-provisions-card" title="Congressional activity">
        <Empty description="No congressional report language linked to this PE yet — populated once report provisions are extracted." />
      </Card>
    );
  }

  return (
    <Card className="pe-provisions-card" title={`Congressional activity · ${rows.length}`}>
      <Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 12 }}>
        Report language from the defense authorization and appropriations committees that touches
                this Program Element — what each committee directed, added, cut, or flagged, with a deep
                link into the report page. Candidate rows are machine-extracted and await review.
                Program-level matches name a broader program (not this PE code alone) and carry an
                attribution caveat so they are never quoted as exclusive to this PE.
      </Paragraph>

      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        {rows.map((p) => {
          const href = provisionHref(p);
          return (
            <div
              key={p.id}
              style={{ borderBottom: '1px solid #f0f0f0', paddingBottom: 8 }}
            >
              <Space wrap size={[6, 4]} style={{ marginBottom: 4 }}>
                <Tag color="geekblue">{committeeLabel(p.committee)}</Tag>
                <Tag color={actionTypeColor(p.actionType)}>{actionTypeLabel(p.actionType)}</Tag>
                <Tag>FY{p.fy}</Tag>
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer">
                    {p.pageStart ? `p. ${p.pageStart}` : 'Open source'}
                  </a>
                ) : null}
                {p.reviewStatus === 'candidate' ? (
                                  <Tag color="gold">Candidate — review</Tag>
                                ) : null}
                                {p.matchScope === 'program_level' ? (
                                  <Tag color="purple" data-testid="pe-provision-program-scope">
                                    Program-level match
                                  </Tag>
                                ) : p.matchScope === 'pe_specific' ? (
                                  <Tag data-testid="pe-provision-pe-scope">PE-specific</Tag>
                                ) : null}
                              </Space>
                              {p.attributionCaveat ? (
                                              <Paragraph
                                                type="secondary"
                                                style={{ margin: '4px 0 0', fontSize: 12, color: '#a26913' }}
                                                data-testid="pe-provision-attribution-caveat"
                                              >
                                                {p.attributionCaveat}
                                              </Paragraph>
                                            ) : null}
                              <div>
                                <Text strong>{p.heading}</Text>
                              </div>
              {p.text ? (
                <Paragraph
                  type="secondary"
                  style={{ margin: '2px 0 0', fontSize: 13 }}
                  ellipsis={{ rows: 3, expandable: true }}
                >
                  {p.text}
                </Paragraph>
              ) : null}
            </div>
          );
        })}
      </Space>
    </Card>
  );
}

export default ProvisionsPanel;
