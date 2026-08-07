import { useQuery } from '@tanstack/react-query';
import { Alert, Card, List, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import {
  FUNDING_OPPORTUNITIES_RISK_FEATURE,
  riskContextApiPath,
  type ExclusionViewData,
  type ProtestViewData,
  type RiskContextView,
} from './funding-opportunities-api.js';

const { Text } = Typography;

/**
 * Protest and exclusion risk context (P45).
 *
 * ── Everything here is an observation with a date and a source ───────────────
 *
 * No sentence on this panel says a client may or may not bid, that a
 * procurement is invalid, or what anyone should do about a compliance flag. An
 * active exclusion routes to review; it does not decide, and the panel says who
 * decides instead.
 *
 * ── Four exclusion states, styled apart ──────────────────────────────────────
 *
 * `active`, `expired`, `unverified` and `none_observed` render with different
 * colours and different sentences. Collapsing `unverified` into either
 * neighbour is the one that would hurt: a flag Capiro has not re-checked in
 * over a month is neither a current finding nor a clean record, and rendering
 * it as either is a claim.
 *
 * ── The absence caveat is not a footnote ─────────────────────────────────────
 *
 * "Absence of exclusion evidence is not evidence of good standing" renders on
 * every state, and it matters most on the clean one — that is precisely where a
 * reader is tempted to conclude the opposite.
 */

const EXCLUSION_COLORS: Record<ExclusionViewData['state'], string> = {
  active: 'red',
  expired: 'default',
  unverified: 'orange',
  none_observed: 'default',
};

const EXCLUSION_LABELS: Record<ExclusionViewData['state'], string> = {
  active: 'Exclusion observed — active',
  expired: 'Exclusion observed — ended',
  unverified: 'Exclusion observed — not re-checked recently',
  none_observed: 'No exclusion observed',
};

function ProtestTable({ protests }: { protests: ProtestViewData[] }) {
  return (
    <Table
      size="small"
      pagination={false}
      rowKey={(row) => row.caseNumber ?? `${row.filedDate}-${row.agencyName}`}
      dataSource={protests}
      columns={[
        {
          title: 'Case',
          dataIndex: 'caseNumber',
          render: (caseNumber: string | null, row) => (
            <Space direction="vertical" size={0}>
              {row.sourceUrl ? (
                <a href={row.sourceUrl} target="_blank" rel="noreferrer">
                  {caseNumber ?? 'View docket'}
                </a>
              ) : (
                <Text>{caseNumber ?? 'Not stated'}</Text>
              )}
              {/* The forum, never normalized away: GAO and the Court of Federal
                  Claims use the same outcome words for different events. */}
              {row.sourceSystem ? (
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {row.sourceSystem.toUpperCase()}
                </Text>
              ) : null}
            </Space>
          ),
        },
        {
          title: 'Outcome',
          dataIndex: 'outcome',
          render: (outcome: string | null, row) =>
            outcome ? (
              <Tooltip title={row.outcomeCaveat}>
                <Tag data-testid="protest-outcome">{outcome}</Tag>
              </Tooltip>
            ) : (
              // Null is open or unstated. Never rendered as a loss.
              <Text type="secondary" data-testid="protest-outcome-open">
                Open or not stated
              </Text>
            ),
        },
        {
          title: 'Filed',
          dataIndex: 'filedDate',
          render: (d: string | null) => d ?? <Text type="secondary">Not stated</Text>,
        },
        {
          title: 'Decided',
          dataIndex: 'decisionDate',
          render: (d: string | null) => d ?? <Text type="secondary">Not stated</Text>,
        },
        {
          title: 'Agency',
          dataIndex: 'agencyName',
          render: (a: string | null) => a ?? <Text type="secondary">Not stated</Text>,
        },
      ]}
    />
  );
}

export function OpportunityRiskPanel({ clientId }: { clientId: string | null }) {
  const api = useApi();
  const flag = useIntelFeature(FUNDING_OPPORTUNITIES_RISK_FEATURE);
  const enabled = flag.ready && flag.enabled && clientId != null;

  const query = useQuery<RiskContextView>({
    queryKey: ['funding-opportunity-risk', clientId],
    queryFn: async () => (await api.get<RiskContextView>(riskContextApiPath(clientId!))).data,
    retry: false,
    enabled,
  });

  if (!flag.ready || !flag.enabled) return null;

  let body: React.ReactNode;
  if (clientId == null) {
    body = (
      <Text type="secondary" style={{ fontSize: 12 }}>
        Not available without a client. Risk evidence is matched to a client’s own UEI.
      </Text>
    );
  } else if (query.isPending) {
    body = <Text type="secondary">Loading…</Text>;
  } else if (query.isError) {
    body = (
      <Alert
        type="error"
        showIcon
        data-testid="risk-error"
        message="Risk context could not be loaded"
        description="This is a request failure. Nothing can be concluded from it about this client."
      />
    );
  } else if (query.data) {
    const data = query.data;
    body = (
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        {data.recommendationHint ? (
          <Alert
            type="warning"
            showIcon
            data-testid="risk-hint"
            message="Needs review"
            description={data.recommendationHint.reason}
          />
        ) : null}

        <div data-testid="risk-exclusion">
          <Text type="secondary" className="fo-fact__label">
            Exclusion
          </Text>
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            <Space size={6} wrap>
              <Tag color={EXCLUSION_COLORS[data.exclusion.state]}>
                {EXCLUSION_LABELS[data.exclusion.state]}
              </Tag>
              {data.exclusion.observedAt ? (
                <Text type="secondary" style={{ fontSize: 11 }}>
                  Observed {data.exclusion.observedAt.slice(0, 10)}
                </Text>
              ) : null}
            </Space>
            <Text style={{ fontSize: 12 }}>{data.exclusion.explanation}</Text>
            {data.exclusion.sourceUrl ? (
              <a href={data.exclusion.sourceUrl} target="_blank" rel="noreferrer">
                Provider record
              </a>
            ) : null}
          </Space>
        </div>

        <div data-testid="risk-protests">
          <Text type="secondary" className="fo-fact__label">
            Protests naming this client
          </Text>
          {data.protests.length > 0 ? (
            <ProtestTable protests={data.protests} />
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              Capiro has observed no protest naming this client’s UEI. This is not a statement that
              none exists.
            </Text>
          )}
        </div>

        {/* On every state, including the clean one — where it matters most. */}
        <List
          size="small"
          data-testid="risk-caveats"
          dataSource={data.caveats}
          renderItem={(caveat) => (
            <List.Item>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {caveat}
              </Text>
            </List.Item>
          )}
        />
      </Space>
    );
  }

  return (
    <Card
      size="small"
      title="Procurement risk"
      className="fo-detail__section"
      data-testid="fo-detail-risk"
    >
      {body}
    </Card>
  );
}
