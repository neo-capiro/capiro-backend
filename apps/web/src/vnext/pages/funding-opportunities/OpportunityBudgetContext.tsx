import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import {
  BUDGET_BETA_LABEL,
  FUNDING_OPPORTUNITIES_BUDGET_FEATURE,
  budgetContextApiPath,
  type BudgetAccountView,
  type BudgetContextView,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { FovAlert, FovCard, FovPill } from './fov-ui.js';

/**
 * Tango budget beta context (P44) — vNext port of the canonical panel.
 *
 * Unchanged rules: federal-account EXECUTION is not Program Element funding
 * (the grain is stated, nothing here is ever summed with anything else); the
 * no-linkage disclaimer renders above the data on every state; the provider's
 * own attribution doubt stays on screen; a missing figure renders as missing
 * — never `$0`, never a dash that could read as zero.
 */

function money(value: string | null): ReactNode {
  if (value == null) {
    return (
      <span className="fov-muted" title="The provider stated no figure. This is not zero.">
        Not stated
      </span>
    );
  }
  // Formatted from the exact decimal string, never through a float: a
  // nine-figure obligation that loses a cent is a number nobody can reconcile.
  const [whole, cents] = value.split('.');
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return <span>{`$${grouped}${cents ? `.${cents}` : ''}`}</span>;
}

function AccountTable({ accounts }: { accounts: BudgetAccountView[] }) {
  return (
    <CapiroTableWrap>
      <CapiroTable>
        <CapiroTableHead>
          <tr>
            <CapiroTableHeaderCell>Federal account</CapiroTableHeaderCell>
            <CapiroTableHeaderCell>Agency</CapiroTableHeaderCell>
            <CapiroTableHeaderCell>Account obligated</CapiroTableHeaderCell>
            <CapiroTableHeaderCell>To this client</CapiroTableHeaderCell>
            <CapiroTableHeaderCell>Provider confidence</CapiroTableHeaderCell>
          </tr>
        </CapiroTableHead>
        <CapiroTableBody>
          {accounts.map((row) => (
            <tr key={`${row.federalAccountSymbol}:${row.fiscalYear}`}>
              <CapiroTableCell>
                <div className="fov-stack">
                  <strong>{row.federalAccountSymbol}</strong>
                  <span className="fov-micro">{row.accountTitle}</span>
                </div>
              </CapiroTableCell>
              <CapiroTableCell>
                {row.agencyName ? (
                  <div className="fov-stack">
                    <span>{row.agencyName}</span>
                    {row.bureauName ? <span className="fov-micro">{row.bureauName}</span> : null}
                  </div>
                ) : (
                  <span className="fov-muted">Not stated</span>
                )}
              </CapiroTableCell>
              <CapiroTableCell>{money(row.money.obligatedTotal)}</CapiroTableCell>
              <CapiroTableCell>
                <div className="fov-stack">
                  {money(row.clientFlow?.contractObligated ?? null)}
                  {row.clientFlow?.contractCount != null ? (
                    <span className="fov-micro">
                      {row.clientFlow.contractCount} contract
                      {row.clientFlow.contractCount === 1 ? '' : 's'}
                    </span>
                  ) : null}
                </div>
              </CapiroTableCell>
              <CapiroTableCell>
                <span className="fov-row" data-testid="budget-attribution">
                  {/* The provider's OWN words, carried verbatim and never mapped
                      to a Capiro confidence vocabulary — two scales with the
                      same labels is how one gets read as the other. */}
                  {row.attributionStatus ? <FovPill>{row.attributionStatus}</FovPill> : null}
                  {row.attributionConfidence ? <FovPill>{row.attributionConfidence}</FovPill> : null}
                  {!row.attributionStatus && !row.attributionConfidence ? (
                    <span className="fov-micro">Not stated</span>
                  ) : null}
                </span>
              </CapiroTableCell>
            </tr>
          ))}
        </CapiroTableBody>
      </CapiroTable>
    </CapiroTableWrap>
  );
}

export function OpportunityBudgetContext({ clientId }: { clientId: string | null }) {
  const api = useApi();
  const flag = useIntelFeature(FUNDING_OPPORTUNITIES_BUDGET_FEATURE);
  const enabled = flag.ready && flag.enabled && clientId != null;

  const query = useQuery<BudgetContextView>({
    queryKey: ['funding-opportunity-budget-context', clientId],
    queryFn: async () => (await api.get<BudgetContextView>(budgetContextApiPath(clientId!))).data,
    retry: false,
    enabled,
  });

  if (!flag.ready || !flag.enabled) return null;

  let body: ReactNode;
  if (clientId == null) {
    body = (
      <span className="fov-muted">
        Not available without a client. Budget context is matched to a client’s own UEI.
      </span>
    );
  } else if (query.isPending) {
    body = <span className="fov-muted">Loading…</span>;
  } else if (query.isError) {
    body = (
      <FovAlert
        tone="error"
        testId="budget-error"
        message="Budget context could not be loaded"
        description="This is a request failure, not a finding about the client’s federal funding."
      />
    );
  } else if (query.data) {
    const data = query.data;
    body = (
      <div className="fov-stack fov-stack--10">
        {/* Above the data, on every state. See the component doc. */}
        <FovAlert tone="info" testId="budget-notice-linkage" message={data.noticeLinkage.explanation} />
        <span className="fov-micro" data-testid="budget-grain">
          {data.grain}
        </span>

        {data.state === 'available' ? (
          data.fiscalYears.map((year) => (
            <div key={year.fiscalYear} data-testid={`budget-fy-${year.fiscalYear}`}>
              <span className="fov-fact__label">Fiscal year {year.fiscalYear}</span>
              <AccountTable accounts={year.accounts} />
            </div>
          ))
        ) : (
          <span className="fov-muted" data-testid="budget-empty">
            {data.explanation}
          </span>
        )}

        <span className="fov-micro" data-testid="budget-source">
          Source: {data.source}. Coverage is partial and the provider labels it beta.
        </span>
      </div>
    );
  }

  return (
    <FovCard title={`Federal account execution (${BUDGET_BETA_LABEL})`} testId="fo-detail-budget-context">
      {body}
    </FovCard>
  );
}
