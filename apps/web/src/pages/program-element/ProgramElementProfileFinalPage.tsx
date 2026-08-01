import { Alert, Button, Modal, message } from 'antd';
import {
  ArrowLeftOutlined,
  BellFilled,
  BellOutlined,
  DownloadOutlined,
  LinkOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { PeTrustHeader } from './PeTrustHeader.js';
import { PeAlertEmailControl } from './PeAlertEmailControl.js';
import { PeLoadState } from './PeLoadState.js';
import { ProgramElementDataIssueModal } from './ProgramElementDataIssueModal.js';
import { LinkCrmContactModal } from './LinkCrmContactModal.js';
import { fmtMoneyM, serviceColor } from './charts/index.js';
import { STAGE_LABEL } from './funding-model.js';
import { serviceLabel } from './pe-shared.js';
import { ProgramElementProfileFinalOverview } from './ProgramElementProfileFinalOverview.js';
import { ProgramElementProfileFinalSections } from './ProgramElementProfileFinalSections.js';
import {
  PROGRAM_ELEMENT_PROFILE_SECTIONS,
  useProgramElementProfileFinal,
} from './useProgramElementProfileFinal.js';
import './program-elements-final.css';

export function ProgramElementProfileFinalPage() {
  const vm = useProgramElementProfileFinal();
  const {
    code,
    navigate,
    watch,
    section,
    setActiveSection,
    alertsOpen,
    setAlertsOpen,
    exportOpen,
    setExportOpen,
    dataIssueOpen,
    setDataIssueOpen,
    linkTarget,
    setLinkTarget,
    detailQuery,
    detail,
    latest,
    latestRequest,
    current,
    request,
    deltaPct,
    bills,
    clients,
    openActions,
    historical,
    latestRecordFy,
    lineType,
    signalLabel,
    partial,
    retryFailed,
    exportProfile,
  } = vm;

  if (!code) {
    return <Alert type="warning" showIcon message="Missing Program Element code" />;
  }
  if (detailQuery.isLoading) {
    return <PeLoadState state="loading" peCode={code} />;
  }
  if (detailQuery.isError || !detail) {
    const error = detailQuery.error as {
      response?: { status?: number };
      status?: number;
    };
    const status = error?.response?.status ?? error?.status;
    return (
      <PeLoadState
        state={status === 404 ? 'not_found' : 'failed'}
        peCode={code}
        onRetry={() => void detailQuery.refetch()}
      />
    );
  }
  if (detail.unsupportedSourceFamily) {
    return <PeLoadState state="unsupported" peCode={code} />;
  }

  return (
    <section
      className="pe-watch-page pe-final pe-final-profile"
      data-testid="pe-state-complete"
    >
      <button
        className="pe-final-breadcrumb"
        type="button"
        onClick={() => navigate('/program-elements')}
      >
        <ArrowLeftOutlined /> Program elements <span>›</span>{' '}
        <b>{detail.peCode}</b>
      </button>

      <div className="pe-final-profile-hero">
        <div className="pe-final-profile-top">
          <div>
            <div className="pe-final-profile-badges">
              <span className="code">{detail.peCode}</span>
              <span>{lineType}</span>
              {detail.budgetActivity ? <span>{detail.budgetActivity}</span> : null}
              {signalLabel ? <span className="risk">{signalLabel}</span> : null}
              {historical ? (
                <span>Historical — no FY{detail.currentCycleFy} entry</span>
              ) : null}
            </div>
            <h1 className="pe-final-profile-title">{detail.title}</h1>
            <div className="pe-final-profile-meta">
              <span className="service">
                <i
                  className="pe-final-dot"
                  style={{ background: serviceColor(detail.service) }}
                />
                {serviceLabel(detail.service)}
              </span>
              {detail.appropriationType ? (
                <span>· {detail.appropriationType}</span>
              ) : null}
              <span>· source: {detail.sourceCount ?? 0} verified sources</span>
            </div>
          </div>

          <div className="pe-final-profile-actions">
            <button
              className={`pe-final-btn${
                detail.currentUserIsWatching ? ' monitoring' : ''
              }`}
              type="button"
              disabled={watch.isPending}
              onClick={() =>
                watch.mutate(
                  {
                    peCode: code,
                    watching: !detail.currentUserIsWatching,
                  },
                  {
                    onSuccess: (_result, variables) => {
                      if (variables.watching) {
                        message.success('Program Element added to Portfolio');
                      }
                    },
                  },
                )
              }
            >
              {detail.currentUserIsWatching ? <BellFilled /> : <BellOutlined />}
              {detail.currentUserIsWatching ? 'Monitoring' : 'Monitor'}
            </button>
            <button
              className="pe-final-btn"
              type="button"
              onClick={() => navigate('/clients?section=program-elements')}
            >
              <LinkOutlined />
              {clients[0] ? `Client: ${clients[0].clientName}` : 'Link client'}
            </button>
            <button
              className="pe-final-btn"
              type="button"
              onClick={() => navigate(`/actions?peCode=${encodeURIComponent(code)}`)}
            >
              <PlusOutlined /> New action
            </button>
            <button
              className="pe-final-btn"
              type="button"
              onClick={() => setAlertsOpen(true)}
            >
              Alerts
            </button>
            <div className="pe-final-menu-wrap">
              <button
                className="pe-final-btn"
                type="button"
                aria-expanded={exportOpen}
                onClick={() => setExportOpen((open) => !open)}
              >
                <DownloadOutlined /> Export
              </button>
              {exportOpen ? (
                <div className="pe-final-menu">
                  <button
                    type="button"
                    onClick={() => {
                      exportProfile();
                      setExportOpen(false);
                    }}
                  >
                    <span>
                      <strong>Profile CSV</strong>
                      <small>Identity, funding headline, and coverage fields</small>
                    </span>
                  </button>
                  <button type="button" disabled>
                    <span>
                      <strong>Profile brief PDF</strong>
                      <small>Not supported by the current export handler</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setExportOpen(false);
                      setActiveSection('sources');
                    }}
                  >
                    <span>
                      <strong>Source package</strong>
                      <small>Open Sources &amp; coverage</small>
                    </span>
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="pe-final-profile-kpis">
          <ProfileKpi
            label={`FY${latestRequest?.fy ?? '—'} request`}
            value={request == null ? '—' : fmtMoneyM(request)}
          />
          <ProfileKpi
            label={`FY${latest?.fy ?? '—'} current`}
            value={current == null ? '—' : fmtMoneyM(current)}
            sub={latest ? STAGE_LABEL[latest.current.stage] : undefined}
          />
          <ProfileKpi
            label="Δ vs request"
            value={
              deltaPct == null
                ? '—'
                : `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%`
            }
            tone={
              deltaPct == null
                ? undefined
                : deltaPct < 0
                  ? 'critical'
                  : undefined
            }
          />
          <ProfileKpi
            label="Bills touching"
            value={String(detail.billCount ?? bills.length)}
          />
          <ProfileKpi
            label="Open actions"
            value={String(openActions.length)}
            tone="accent"
          />
        </div>
      </div>

      <div className="pe-final-trust">
        <PeTrustHeader
          peCode={detail.peCode}
          title={detail.title}
          years={detail.years ?? []}
          catalogCurrentCycleFy={detail.currentCycleFy}
          lastSyncedAt={detail.lastSyncedAt}
          sourceCount={detail.sourceCount}
          projectCount={detail.projectCount}
          billCount={detail.billCount ?? bills.length}
          description={detail.description}
          reconciliationConflictCount={
            detail.openReconciliationConflictCount ?? 0
          }
          extraCaveats={
            historical
              ? [
                  `This line's latest budget-year record is FY${latestRecordFy}, before the catalog current cycle FY${detail.currentCycleFy}.`,
                ]
              : []
          }
          onReportDataIssue={() => setDataIssueOpen(true)}
        />
      </div>

      <nav
        className="pe-final-profile-tabs"
        role="tablist"
        aria-label="Program Element profile sections"
      >
        {PROGRAM_ELEMENT_PROFILE_SECTIONS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={section === item.key}
            className={section === item.key ? 'active' : ''}
            onClick={() => setActiveSection(item.key)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {!detail.years?.length ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="Not yet ingested"
          description="The Program Element identity is known, but no budget-year rows have been ingested for this code."
        />
      ) : null}
      {partial ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="Partial data"
          description="One or more secondary panels failed. Loaded sections remain usable; failed sections are marked rather than shown as empty."
          action={
            <Button size="small" onClick={retryFailed}>
              Retry failed panels
            </Button>
          }
        />
      ) : null}

      {section === 'overview' ? (
        <ProgramElementProfileFinalOverview vm={vm} />
      ) : (
        <ProgramElementProfileFinalSections vm={vm} />
      )}

      <Modal
        open={alertsOpen}
        title="Program Element alert settings"
        footer={null}
        onCancel={() => setAlertsOpen(false)}
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          message="Monitored-line email settings"
          description="These settings apply to your monitored Program Elements."
          style={{ marginBottom: 14 }}
        />
        <PeAlertEmailControl />
      </Modal>

      <ProgramElementDataIssueModal
        open={dataIssueOpen}
        peCode={code}
        defaultFy={latest?.fy ?? null}
        onClose={() => setDataIssueOpen(false)}
      />
      <LinkCrmContactModal
        open={linkTarget !== null}
        personId={linkTarget?.id ?? null}
        personName={linkTarget?.name ?? null}
        peCode={code}
        onClose={() => setLinkTarget(null)}
      />
    </section>
  );
}

function ProfileKpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'critical' | 'accent';
}) {
  return (
    <div className={`pe-final-profile-kpi${tone ? ` ${tone}` : ''}`}>
      <small>{label}</small>
      <strong>{value}</strong>
      {sub ? <span>{sub}</span> : null}
    </div>
  );
}
