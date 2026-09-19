import { Alert, Button, Card, Skeleton, Space, Tag, Typography } from 'antd';
import { useClientFundingOpportunitiesV2, clientOpportunityDetailPath, deadlineLabel, emptyExplanation, freshnessLabel, opportunityTypeLabel, opportunityValueLabel, pursuingCount, sourceLabel, sumKnown } from '../../../../vnext/adapters/legacy/useClientFundingOpportunitiesV2.js';
import { useIntelFeature } from '../../../../lib/intel-feature-flags.js';
import { FUNDING_OPPORTUNITIES_FEATURE } from '../../../../vnext/adapters/legacy/useClientFundingOpportunitiesV2.js';

const { Text } = Typography;

export function FundingOpportunitiesSection({ clientId }: { clientId: string }) {
  const funding = useClientFundingOpportunitiesV2(clientId);
  const { enabled, ready } = useIntelFeature(FUNDING_OPPORTUNITIES_FEATURE);

  if (!ready || !enabled) return null;

  const response = funding.search.data;
  const href = `/intelligence/opportunities?client=${encodeURIComponent(clientId)}&tab=opportunities`;
  const rows = response?.opportunities ?? [];
  const activeGrants = response ? response.counts.grants : null;
  const activeContracts = response ? response.counts.contracts : null;
  const total = response ? sumKnown(activeGrants, activeContracts) : null;
  const pursuing = funding.pipelineFeature.ready && funding.pipelineFeature.enabled ? pursuingCount(funding.pipeline.data) : null;

  return (
    <section id="funding-opportunities" data-testid="funding-opportunities-section">
      <Card
        size="small"
        title="Funding Opportunities"
        extra={<Button size="small" type="link" href={href}>Open Funding Opportunities →</Button>}
      >
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 10 }}>
          Grants and government contract opportunities this client could pursue. Future competitions, not awarded funding.
        </Text>
        {funding.search.isPending ? <Skeleton active paragraph={{ rows: 3 }} /> : funding.search.isError ? (
          <Alert
            type="error"
            showIcon
            data-testid="fo-client-error"
            message="Funding opportunities could not be loaded"
            description="This is a request failure, not an empty result — no conclusion can be drawn about how many opportunities exist for this client."
            action={<Button size="small" onClick={() => void funding.search.refetch()}>Retry</Button>}
          />
        ) : response ? (
          <>
            <div className="fo-client-summary__kpis" style={{ marginBottom: 10 }}>
              <Mini label="Active opportunities" value={total} />
              <Mini label="Active grants" value={activeGrants} />
              <Mini label="Active contracts" value={activeContracts} />
              <Mini label="Saved" text="Unavailable" />
              <Mini label="Pursuing" value={pursuing} />
              <Mini label="Next deadline" text={deadlineLabel(rows.find((row) => row.deadline)?.deadline ?? null)} />
            </div>
            {rows.length === 0 ? (
              <Alert type="info" showIcon data-testid="fo-client-empty" message="No active matches" description={emptyExplanation(response)} />
            ) : (
              <div className="fo-client-summary__lists">
                {rows.slice(0, 6).map((row) => (
                  <div className="fo-client-summary__row" key={row.id}>
                    <a href={clientOpportunityDetailPath(clientId, row.source, row.sourceRecordId)}>{row.title}</a>
                    <div className="fo-client-summary__meta">
                      {sourceLabel(row.source)} · {opportunityTypeLabel(row.type)} · {deadlineLabel(row.deadline)} · {opportunityValueLabel(row.value, row.valueBasis)}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {response.profileGaps?.items.length ? (
              <Alert
                type="warning"
                showIcon
                message="Improve client matching"
                description={response.profileGaps.items.map((gap) => gap.body).join(' ')}
              />
            ) : null}
            {response.freshness.length ? (
              <div style={{ marginTop: 10 }}>
                <Space size={6} wrap>
                  {response.freshness.map((source) => <Tag key={source.source}>{freshnessLabel(source)}</Tag>)}
                </Space>
              </div>
            ) : null}
          </>
        ) : null}
      </Card>
    </section>
  );
}

function Mini({ label, value, text }: { label: string; value?: number | null; text?: string }) {
  return <div className="fo-client-summary__kpi"><div className="fo-client-summary__label">{label}</div><div className="fo-client-summary__value">{text ?? value ?? '—'}</div></div>;
}
