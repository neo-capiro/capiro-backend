import type { ReactNode } from 'react';
import { Alert, Button, Empty, Skeleton } from 'antd';
import { DescriptionPanel } from './DescriptionPanel.js';
import { LineChart } from './charts/index.js';
import type { ProgramElementProfileFinalVm } from './useProgramElementProfileFinal.js';

export function ProgramElementProfileFinalOverview({
  vm,
}: {
  vm: ProgramElementProfileFinalVm;
}) {
  const {
    code,
    navigate,
    detail,
    funding,
    bills,
    billsQuery,
    signals,
    budgetActionsQuery,
    clients,
    clientsQuery,
    people,
    peopleQuery,
    openActions,
    actionCardsQuery,
    raw,
    pdoc,
  } = vm;
  if (!detail) return null;
  const labels = funding.map((point) => `FY${String(point.fy).slice(-2)}`);
  const series = [
    {
      name: 'Current',
      color: 'var(--pef-accent)',
      values: funding.map((point) => point.current.value),
    },
    {
      name: 'Request',
      color: '#8a8780',
      values: funding.map((point) => point.request),
      dash: '5 4',
    },
  ];
  const openActionBoard = () =>
    navigate(`/actions?peCode=${encodeURIComponent(code)}`);

  return (
    <div className="pe-final-profile-grid">
      <div className="pe-final-profile-main">
        <section className="pe-final-panel">
          <div className="pe-final-panel-head">
            <h2>Funding by fiscal year</h2>
            <small>$M · open Funding &amp; movement for detail</small>
          </div>
          <div className="pe-final-overview-chart">
            {funding.length ? (
              <LineChart labels={labels} series={series} height={220} mode="area" />
            ) : (
              <Empty description="No budget-year data has been ingested." />
            )}
          </div>
        </section>

        <section className="pe-final-panel">
          <div className="pe-final-panel-head">
            <h2>Legislative activity</h2>
            <small>
              {billsQuery.isLoading ? 'Loading' : `${bills.length} linked bills`}
            </small>
          </div>
          <div className="pe-final-panel-body flush">
            {billsQuery.isError ? (
              <div style={{ padding: 12 }} data-testid="pe-secondary-failed-recent-activity">
                <Alert
                  type="error"
                  showIcon
                  message="Unable to load linked bills"
                  action={
                    <Button
                      size="small"
                      data-testid="pe-secondary-retry"
                      onClick={() => void billsQuery.refetch()}
                    >
                      Retry
                    </Button>
                  }
                />
              </div>
            ) : billsQuery.isLoading ? (
              <div style={{ padding: 13 }}>
                <Skeleton active paragraph={{ rows: 4 }} />
              </div>
            ) : bills.length ? (
              bills.slice(0, 6).map((bill) => (
                <div className="pe-final-side-item" key={bill.id}>
                  <strong>
                    {bill.billType} {bill.billNumber} · {bill.title}
                  </strong>
                  <small>
                    {bill.latestActionText ?? 'No dated action available'}
                  </small>
                </div>
              ))
            ) : (
              <div style={{ padding: 16 }}>
                <Empty description="No recorded legislative activity for the available coverage." />
              </div>
            )}
          </div>
        </section>

        <section className="pe-final-panel">
          <DescriptionPanel
            description={detail.description}
            source={{
              op5Detail: raw.op5Detail ?? null,
              pDocSourceBookOnly: pdoc?.sourceBook ?? null,
            }}
          />
        </section>
      </div>

      <aside className="pe-final-profile-side">
        <SidePanel
          title="Open actions"
          actionLabel={openActions.length ? 'View all' : undefined}
          onAction={openActionBoard}
          loading={actionCardsQuery.isLoading}
          errored={actionCardsQuery.isError}
          onRetry={() => void actionCardsQuery.refetch()}
          testId="pe-secondary-failed-action-cards"
          empty="No open action cards on this line."
        >
          {openActions.slice(0, 2).map((action) => (
            <button
              className="pe-final-side-item"
              type="button"
              key={action.id}
              onClick={openActionBoard}
            >
              <strong>{action.recommendedAction}</strong>
              <small>
                {action.deadline
                  ? `Due ${new Date(action.deadline).toLocaleDateString()}`
                  : 'No known deadline'}
                {action.clientName ? ` · ${action.clientName}` : ''}
              </small>
            </button>
          ))}
        </SidePanel>

        <SidePanel
          title="Recent signals"
          loading={budgetActionsQuery.isLoading}
          errored={budgetActionsQuery.isError}
          onRetry={() => void budgetActionsQuery.refetch()}
          testId="pe-secondary-failed-actions"
          empty="No normalized budget signals yet."
        >
          {signals.slice(0, 3).map((signal) => (
            <div className="pe-final-side-item" key={signal.id}>
              <strong>
                {signal.stage.replaceAll('_', '-')} {signal.action.replaceAll('_', ' ')}
              </strong>
              <small>{signal.note || 'No additional source note.'}</small>
            </div>
          ))}
        </SidePanel>

        <SidePanel
          title="Linked clients"
          loading={clientsQuery.isLoading}
          errored={clientsQuery.isError}
          onRetry={() => void clientsQuery.refetch()}
          testId="pe-secondary-failed-client-relevance"
          empty="No client relevance links are available."
        >
          {clients.slice(0, 3).map((client) => (
            <div className="pe-final-side-item" key={client.clientId}>
              <strong>{client.clientName}</strong>
              <small>
                {Math.round(client.score * 100)}% relevance · {client.paths.length}{' '}
                evidence path{client.paths.length === 1 ? '' : 's'}
              </small>
            </div>
          ))}
        </SidePanel>

        <SidePanel
          title="Program team"
          loading={peopleQuery.isLoading}
          errored={peopleQuery.isError}
          onRetry={() => void peopleQuery.refetch()}
          testId="pe-secondary-failed-personnel-roster"
          empty="No verified public program-team contacts yet."
        >
          {people.slice(0, 4).map((person) => (
            <div className="pe-final-side-item" key={person.id}>
              <strong>{person.fullName}</strong>
              <small>{person.role ?? person.organization ?? 'Role unavailable'}</small>
            </div>
          ))}
        </SidePanel>
      </aside>
    </div>
  );
}

function SidePanel({
  title,
  actionLabel,
  onAction,
  loading,
  errored,
  onRetry,
  testId,
  empty,
  children,
}: {
  title: string;
  actionLabel?: string;
  onAction?: () => void;
  loading: boolean;
  errored: boolean;
  onRetry: () => void;
  testId: string;
  empty: string;
  children: ReactNode;
}) {
  const hasChildren = Array.isArray(children)
    ? children.length > 0
    : Boolean(children);
  return (
    <section className="pe-final-panel">
      <div className="pe-final-panel-head">
        <h2>{title}</h2>
        {actionLabel ? (
          <button
            type="button"
            style={{
              marginLeft: 'auto',
              border: 0,
              background: 'transparent',
              color: 'var(--pef-accent)',
              fontSize: 10.5,
              cursor: 'pointer',
            }}
            onClick={onAction}
          >
            {actionLabel}
          </button>
        ) : null}
      </div>
      <div className="pe-final-panel-body flush">
        {loading ? (
          <div style={{ padding: 13 }}>
            <Skeleton active paragraph={{ rows: 2 }} />
          </div>
        ) : errored ? (
          <div data-testid={testId} style={{ padding: 12 }}>
            <Alert
              type="error"
              showIcon
              message={`Unable to load ${title.toLowerCase()}`}
              action={
                <Button
                  size="small"
                  data-testid="pe-secondary-retry"
                  onClick={onRetry}
                >
                  Retry
                </Button>
              }
            />
          </div>
        ) : hasChildren ? (
          children
        ) : (
          <div
            style={{
              padding: 13,
              color: 'var(--pef-ink-3)',
              fontSize: 11,
            }}
          >
            {empty}
          </div>
        )}
      </div>
    </section>
  );
}
