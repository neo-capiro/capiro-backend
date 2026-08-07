import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import {
  BUDGET_BETA_LABEL,
  FUNDING_OPPORTUNITIES_BUDGET_FEATURE,
  budgetContextApiPath,
  type BudgetAccountView,
  type BudgetContextView,
} from './funding-opportunities-api.js';

const { Text } = Typography;

/**
 * Tango budget beta context (P44).
 *
 * ── Federal-account EXECUTION is not Program Element funding ─────────────────
 *
 * This panel shows what an appropriation container obligated and outlayed.
 * Capiro's Program Element surfaces show what a line item was requested,
 * marked and enacted. Those are different grains measured differently, and a
 * reader who puts one number next to the other has learned something false. So
 * the grain is stated in the panel header, the words "Program Element" appear
 * only in the sentence saying this is NOT that, and no figure here is ever
 * summed with one from anywhere else.
 *
 * ── The disclaimer is not a footnote ─────────────────────────────────────────
 *
 * No source-backed key links a SAM.gov notice to a federal account. That
 * sentence renders above the data on every state — including the empty ones —
 * because a reader who meets it only when the panel is empty will read its
 * absence as a link existing.
 *
 * ── Beta means the provider's own doubt is on screen ─────────────────────────
 *
 * Every account carries Tango's own `attribution_status` and
 * `attribution_confidence`. A figure the provider is unsure about renders with
 * that uncertainty attached rather than with the same weight as a confident
 * one.
 *
 * ── A missing figure renders as missing ──────────────────────────────────────
 *
 * Money arrives as exact decimal STRINGS or null. Null renders "Not stated" —
 * never `$0`, never a dash that could read as zero. On a real provider row most
 * of these fields were null while one carried a number.
 */

function money(value: string | null): React.ReactNode {
  if (value == null) {
    return (
      <Tooltip title="The provider stated no figure. This is not zero.">
        <Text type="secondary">Not stated</Text>
      </Tooltip>
    );
  }
  // Formatted from the exact decimal string, never through a float: a
  // nine-figure obligation that loses a cent is a number nobody can reconcile.
  const [whole, cents] = value.split('.');
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return <Text>{`$${grouped}${cents ? `.${cents}` : ''}`}</Text>;
}

function AccountTable({ accounts }: { accounts: BudgetAccountView[] }) {
  return (
    <Table
      size="small"
      pagination={false}
      rowKey={(row) => `${row.federalAccountSymbol}:${row.fiscalYear}`}
      dataSource={accounts}
      columns={[
        {
          title: 'Federal account',
          dataIndex: 'federalAccountSymbol',
          render: (symbol: string, row) => (
            <Space direction="vertical" size={0}>
              <Text strong>{symbol}</Text>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {row.accountTitle}
              </Text>
            </Space>
          ),
        },
        {
          title: 'Agency',
          dataIndex: 'agencyName',
          render: (name: string | null, row) =>
            name ? (
              <Space direction="vertical" size={0}>
                <Text>{name}</Text>
                {row.bureauName ? (
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {row.bureauName}
                  </Text>
                ) : null}
              </Space>
            ) : (
              <Text type="secondary">Not stated</Text>
            ),
        },
        {
          title: 'Account obligated',
          dataIndex: ['money', 'obligatedTotal'],
          render: (_: unknown, row) => money(row.money.obligatedTotal),
        },
        {
          title: 'To this client',
          dataIndex: ['clientFlow', 'contractObligated'],
          render: (_: unknown, row) => (
            <Space direction="vertical" size={0}>
              {money(row.clientFlow?.contractObligated ?? null)}
              {row.clientFlow?.contractCount != null ? (
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {row.clientFlow.contractCount} contract
                  {row.clientFlow.contractCount === 1 ? '' : 's'}
                </Text>
              ) : null}
            </Space>
          ),
        },
        {
          title: 'Provider confidence',
          dataIndex: 'attributionConfidence',
          render: (confidence: string | null, row) => (
            <Space size={4} wrap data-testid="budget-attribution">
              {/* The provider's OWN words, carried verbatim and never mapped to
                  a Capiro confidence vocabulary — two scales with the same
                  labels is how one gets read as the other. */}
              {row.attributionStatus ? <Tag>{row.attributionStatus}</Tag> : null}
              {confidence ? <Tag>{confidence}</Tag> : null}
              {!row.attributionStatus && !confidence ? (
                <Text type="secondary" style={{ fontSize: 11 }}>
                  Not stated
                </Text>
              ) : null}
            </Space>
          ),
        },
      ]}
    />
  );
}

export function OpportunityBudgetContext({ clientId }: { clientId: string | null }) {
  const api = useApi();
  const flag = useIntelFeature(FUNDING_OPPORTUNITIES_BUDGET_FEATURE);
  const enabled = flag.ready && flag.enabled && clientId != null;

  const query = useQuery<BudgetContextView>({
    queryKey: ['funding-opportunity-budget-context', clientId],
    queryFn: async () =>
      (await api.get<BudgetContextView>(budgetContextApiPath(clientId!))).data,
    retry: false,
    enabled,
  });

  if (!flag.ready || !flag.enabled) return null;

  let body: React.ReactNode;
  if (clientId == null) {
    body = (
      <Text type="secondary" style={{ fontSize: 12 }}>
        Not available without a client. Budget context is matched to a client’s own UEI.
      </Text>
    );
  } else if (query.isPending) {
    body = <Text type="secondary">Loading…</Text>;
  } else if (query.isError) {
    body = (
      <Alert
        type="error"
        showIcon
        data-testid="budget-error"
        message="Budget context could not be loaded"
        description="This is a request failure, not a finding about the client’s federal funding."
      />
    );
  } else if (query.data) {
    const data = query.data;
    body = (
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        {/* Above the data, on every state. See the component doc. */}
        <Alert
          type="info"
          showIcon
          data-testid="budget-notice-linkage"
          message={data.noticeLinkage.explanation}
        />
        <Text type="secondary" style={{ fontSize: 11 }} data-testid="budget-grain">
          {data.grain}
        </Text>

        {data.state === 'available' ? (
          data.fiscalYears.map((year) => (
            <div key={year.fiscalYear} data-testid={`budget-fy-${year.fiscalYear}`}>
              <Text type="secondary" className="fo-fact__label">
                Fiscal year {year.fiscalYear}
              </Text>
              <AccountTable accounts={year.accounts} />
            </div>
          ))
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }} data-testid="budget-empty">
            {data.explanation}
          </Text>
        )}

        <Text type="secondary" style={{ fontSize: 11 }} data-testid="budget-source">
          Source: {data.source}. Coverage is partial and the provider labels it beta.
        </Text>
      </Space>
    );
  }

  return (
    <Card
      size="small"
      title={`Federal account execution (${BUDGET_BETA_LABEL})`}
      className="fo-detail__section"
      data-testid="fo-detail-budget-context"
    >
      {body}
    </Card>
  );
}
