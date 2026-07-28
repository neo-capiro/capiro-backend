import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Skeleton, Space, Tag, Typography } from 'antd';
import { useApi } from '../../../../lib/use-api.js';
import { useIntelFeature } from '../../../../lib/intel-feature-flags.js';
import {
  FUNDING_OPPORTUNITIES_FEATURE,
  KIND_LABELS,
  SOURCE_LABELS,
  formatDeadline,
  formatFreshness,
  moneyLine,
  type ClientFundingOpportunitySummary,
  type FundingOpportunity,
} from '../../../intelligence/opportunities/funding-opportunities-api.js';
import '../../../intelligence/opportunities/funding-opportunities.css';

const { Text } = Typography;

/**
 * The PERSISTENT Funding Opportunities card on a client's Intelligence tab.
 *
 * ── Why it renders at zero matches ──────────────────────────────────────────
 *
 * A card that disappears when there is nothing to show is indistinguishable from
 * a feature the workspace does not have, and it gives the user nothing to act on.
 * So whenever the feature is available this card renders, and when it is empty it
 * says exactly WHY — "SAM.gov has never synced", "this client has no NAICS
 * codes", "nothing cleared the relevance threshold" — each of which points at a
 * different fix.
 *
 * The one thing that DOES hide it is the feature flag being off for the tenant:
 * that is not an empty state, it is an unavailable feature.
 *
 * ── Its relationship to District Nexus ─────────────────────────────────────
 *
 * This is a separate workflow, deliberately not nested inside District Nexus.
 * Grant and contract opportunities are future pursuits; District Nexus is about
 * money already awarded into a district. A pursuit only ever acquires a district
 * through an explicit, reviewed project-site link.
 */
export function FundingOpportunitiesSection({ clientId }: { clientId: string }) {
  const api = useApi();
  const { enabled, ready } = useIntelFeature(FUNDING_OPPORTUNITIES_FEATURE);

  const summary = useQuery<ClientFundingOpportunitySummary>({
    queryKey: ['client-funding-opportunities', clientId],
    queryFn: async () =>
      (
        await api.get<ClientFundingOpportunitySummary>(
          `/api/intelligence/clients/${clientId}/opportunities/summary`,
        )
      ).data,
    enabled: Boolean(clientId) && ready && enabled,
    staleTime: 2 * 60 * 1000,
    retry: 1,
  });

  // Not an empty state — an unavailable feature. Render nothing rather than an
  // explanation the user can do nothing about.
  if (!ready || !enabled) return null;

  const href = `/intelligence/opportunities?clientId=${encodeURIComponent(clientId)}`;

  return (
    <section id="funding-opportunities" data-testid="funding-opportunities-section">
      <Card
        size="small"
        title="Funding Opportunities"
        extra={
          <Button size="small" type="link" href={href}>
            Open Funding Opportunities →
          </Button>
        }
      >
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 10 }}>
          Grants and government contract opportunities this client could pursue. Future
          competitions, not awarded funding.
        </Text>

        {summary.isPending ? (
          <Skeleton active paragraph={{ rows: 3 }} />
        ) : summary.isError ? (
          <Alert
            type="error"
            showIcon
            data-testid="fo-client-error"
            message="Funding opportunities could not be loaded"
            description="This is a request failure, not an empty result — no conclusion can be drawn about how many opportunities exist for this client."
            action={
              <Button size="small" onClick={() => void summary.refetch()}>
                Retry
              </Button>
            }
          />
        ) : summary.data ? (
          <>
            <div className="fo-kpis" style={{ marginBottom: 10 }}>
              <Mini label="Active grants" value={summary.data.counts.activeGrants} />
              <Mini label="Active contracts" value={summary.data.counts.activeContracts} />
              <Mini label="Saved" value={summary.data.counts.saved} />
              <Mini label="Pursuing" value={summary.data.counts.pursuing} />
              <Mini
                label="Next deadline"
                text={
                  summary.data.nextDeadline
                    ? formatDeadline(summary.data.nextDeadline.responseDeadline, null).text
                    : 'None'
                }
              />
            </div>

            {summary.data.topGrants.length === 0 && summary.data.topContracts.length === 0 ? (
              <Alert
                type="info"
                showIcon
                data-testid="fo-client-empty"
                message="No recommendations yet"
                description={
                  <div>
                    <div>
                      {summary.data.emptyExplanation ??
                        'No opportunity currently clears the relevance threshold for this client.'}
                    </div>
                    {summary.data.missingProfileFields.length > 0 ? (
                      <ul className="fo-gaps">
                        {summary.data.missingProfileFields.map((f) => (
                          <li key={f.field}>
                            {f.href ? <a href={f.href}>{f.label}</a> : f.label} — {f.impact}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                }
              />
            ) : (
              <div className="fo-client-card__lists">
                <div>
                  <div className="fo-client-card__list-title">Top grant matches</div>
                  {summary.data.topGrants.length ? (
                    summary.data.topGrants.map((o) => <MiniOpportunity key={o.id} o={o} />)
                  ) : (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      No grant currently clears the threshold.
                    </Text>
                  )}
                </div>
                <div>
                  <div className="fo-client-card__list-title">Top contract matches</div>
                  {summary.data.topContracts.length ? (
                    summary.data.topContracts.map((o) => <MiniOpportunity key={o.id} o={o} />)
                  ) : (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      No contract opportunity currently clears the threshold.
                    </Text>
                  )}
                </div>
              </div>
            )}

            {summary.data.freshness.length ? (
              <div style={{ marginTop: 10 }}>
                <Space size={6} wrap>
                  {summary.data.freshness.map((f) => (
                    <Tag
                      key={f.verb}
                      color={f.neverSynced ? 'red' : f.lastRunDegraded ? 'orange' : 'default'}
                    >
                      {formatFreshness(f)}
                    </Tag>
                  ))}
                </Space>
              </div>
            ) : null}
          </>
        ) : null}
      </Card>
    </section>
  );
}

function Mini({ label, value, text }: { label: string; value?: number; text?: string }) {
  return (
    <div className="fo-kpi">
      <div className="fo-kpi__label">{label}</div>
      <div className="fo-kpi__value" style={{ fontSize: text ? 14 : 20 }}>
        {text ?? value ?? '—'}
      </div>
    </div>
  );
}

function MiniOpportunity({ o }: { o: FundingOpportunity }) {
  const deadline = formatDeadline(o.responseDeadline, o.responseDeadlineNote);
  const money = moneyLine(o);
  return (
    <div className="fo-mini">
      <div>
        {o.sourceUrl ? (
          <a href={o.sourceUrl} target="_blank" rel="noreferrer">
            {o.title}
          </a>
        ) : (
          o.title
        )}
      </div>
      <div className="fo-mini__meta">
        {SOURCE_LABELS[o.source]} · {KIND_LABELS[o.kind]} · {deadline.text} · {money.label}{' '}
        {money.value} · relevance {o.relevanceScore}
      </div>
    </div>
  );
}
