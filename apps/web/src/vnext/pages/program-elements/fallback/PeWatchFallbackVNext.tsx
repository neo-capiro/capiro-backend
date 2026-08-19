/**
 * PE watch (line profile) — native vNext port of the canonical read surface
 * served to tenants OTHER than capiro-internal (old-UI purge Phase 3,
 * PE-FALLBACK). Composition mirrors `ProgramElementWatchPage`:
 * profile page + the `?tab=funding` FY drill-down.
 *
 * Phase 3 lesson #2: VNextRouter mounts ABOVE the canonical param routes, so
 * `useParams` is EMPTY here — the PE code is parsed (and decoded) from
 * `location.pathname` via the module's shared `matchPeProfilePath`.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useApi } from '../../../../lib/use-api.js';
import { getProgramElementDetail } from '../../../../pages/program-element/api.js';
import {
  PROGRAM_ELEMENT_PROFILE_SECTIONS,
  useProgramElementProfileFinalCore,
} from '../../../../pages/program-element/useProgramElementProfileFinalCore.js';
import {
  serviceLabel,
} from '../../../../pages/program-element/pe-shared-model.js';
import { fmtMoneyM, serviceColor } from '../../../../pages/program-element/charts/index.js';
import { STAGE_LABEL } from '../../../../pages/program-element/funding-model.js';
import { matchPeProfilePath } from '../pe-routes.js';
import { CapiroModal } from '../../../components/overlays/index.js';
import { useCapiroToast } from '../../../components/feedback/toast.js';
import { CapiroDownloadIcon } from '../../../components/icons/index.js';
import { PeFbBellIcon, PeFbLinkIcon } from './pe-fallback-icons.js';
import { CapiroPlusIcon } from '../../../components/icons/index.js';
import {
  PeFbErrorState,
  PeFbNotice,
  PeFbRetryButton,
  useWatchToggleVNext,
} from './pe-fallback-ui.js';
import { PeLoadStateVNext } from './PeLoadStateVNext.js';
import { PeTrustHeaderVNext } from './PeTrustHeaderVNext.js';
import { PeProfileOverviewVNext } from './PeProfileOverviewVNext.js';
import { PeProfileSectionsVNext } from './PeProfileSectionsVNext.js';
import { PeAlertEmailControlVNext } from './PeAlertEmailControlVNext.js';
import { PeDataIssueModalVNext } from './PeDataIssueModalVNext.js';
import { PeLinkCrmContactModalVNext } from './PeLinkCrmContactModalVNext.js';
import { PeFyDetailDrawerVNext } from './PeFyDetailDrawerVNext.js';
import './pe-fallback.css';

/** The PE code for the current profile URL (vNext mounts above param routes). */
function usePeCodeFromPath(): string {
  const location = useLocation();
  return (matchPeProfilePath(location.pathname) ?? '').toUpperCase();
}

export function PeWatchFallbackVNext() {
  const code = usePeCodeFromPath();
  return (
    <>
      <PeProfileFinalVNext code={code} />
      <PeFyDrilldownVNext code={code} />
    </>
  );
}

function PeProfileFinalVNext({ code }: { code: string }) {
  const toast = useCapiroToast();
  const watch = useWatchToggleVNext();
  const vm = useProgramElementProfileFinalCore({ peCode: code, watch });
  const {
    navigate,
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
    return <PeFbNotice tone="warning" message="Missing Program Element code" />;
  }
  if (detailQuery.isLoading) {
    return <PeLoadStateVNext state="loading" peCode={code} />;
  }
  if (detailQuery.isError || !detail) {
    const error = detailQuery.error as {
      response?: { status?: number };
      status?: number;
    };
    const status = error?.response?.status ?? error?.status;
    return (
      <PeLoadStateVNext
        state={status === 404 ? 'not_found' : 'failed'}
        peCode={code}
        onRetry={() => void detailQuery.refetch()}
      />
    );
  }
  if (detail.unsupportedSourceFamily) {
    return <PeLoadStateVNext state="unsupported" peCode={code} />;
  }

  return (
    <section
      className="pe-fb-root pe-fb-profile"
      data-testid="pe-state-complete"
    >
      <nav className="pe-fb-breadcrumb" aria-label="Breadcrumb">
        <button type="button" onClick={() => navigate('/program-elements')}>
          Program elements
        </button>
        <span>›</span>
        <b className="mono">{detail.peCode}</b>
      </nav>

      <div className="pe-fb-profile-hero">
        <div className="pe-fb-profile-top">
          <div>
            <div className="pe-fb-profile-badges">
              <span className="code">{detail.peCode}</span>
              <span>{lineType}</span>
              {detail.budgetActivity ? <span>{detail.budgetActivity}</span> : null}
              {signalLabel ? <span className="risk">{signalLabel}</span> : null}
              {historical ? (
                <span>Historical — no FY{detail.currentCycleFy} entry</span>
              ) : null}
            </div>
            <h1 className="pe-fb-profile-title">{detail.title}</h1>
            <div className="pe-fb-profile-meta">
              <span className="service">
                <i
                  className="pe-fb-dot"
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

          <div className="pe-fb-profile-actions">
            <button
              className={`pe-fb-btn pe-fb-monitor${
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
                        toast.success('Program Element added to Portfolio');
                      }
                    },
                  },
                )
              }
            >
              <PeFbBellIcon filled={detail.currentUserIsWatching} />
              {detail.currentUserIsWatching ? 'Monitoring' : 'Monitor'}
            </button>
            <div className="pe-fb-profile-action-row">
              <button
                className="pe-fb-btn"
                type="button"
                onClick={() => navigate('/clients?section=program-elements')}
              >
                <PeFbLinkIcon />
                {clients[0] ? clients[0].clientName : 'Link client'}
              </button>
              <button
                className="pe-fb-btn"
                type="button"
                onClick={() => navigate(`/actions?peCode=${encodeURIComponent(code)}`)}
              >
                <CapiroPlusIcon /> New action
              </button>
            </div>
            <div className="pe-fb-profile-action-row">
              <button
                className="pe-fb-btn"
                type="button"
                onClick={() => setAlertsOpen(true)}
              >
                Alerts
              </button>
              <div className="pe-fb-menu-wrap">
                <button
                  className="pe-fb-btn"
                  type="button"
                  aria-expanded={exportOpen}
                  onClick={() => setExportOpen((open) => !open)}
                >
                  <CapiroDownloadIcon /> Export
                </button>
                {exportOpen ? (
                  <div className="pe-fb-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
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
                    <button type="button" role="menuitem" disabled>
                      <span>
                        <strong>Profile brief PDF</strong>
                        <small>Not supported by the current export handler</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setExportOpen(false);
                        setActiveSection('sources');
                      }}
                    >
                      <span>
                        <strong>Source package</strong>
                        <small>Open Sources & coverage</small>
                      </span>
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <div className="pe-fb-profile-kpis">
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

      <div className="pe-fb-trust">
        <PeTrustHeaderVNext
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
        className="pe-fb-profile-tabs"
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
        <PeFbNotice
          tone="info"
          style={{ marginBottom: 12 }}
          message="Not yet ingested"
          description="The Program Element identity is known, but no budget-year rows have been ingested for this code."
        />
      ) : null}
      {partial ? (
        <PeFbNotice
          tone="warning"
          style={{ marginBottom: 12 }}
          message="Partial data"
          description="One or more secondary panels failed. Loaded sections remain usable; failed sections are marked rather than shown as empty."
          action={<PeFbRetryButton onClick={retryFailed} testId="pe-state-retry" />}
        />
      ) : null}

      {section === 'overview' ? (
        <PeProfileOverviewVNext vm={vm} />
      ) : (
        <PeProfileSectionsVNext vm={vm} />
      )}

      <CapiroModal
        open={alertsOpen}
        title="Program Element alert settings"
        onClose={() => setAlertsOpen(false)}
      >
        <PeFbNotice
          tone="info"
          message="Monitored-line email settings"
          description="These settings apply to your monitored Program Elements."
          style={{ marginBottom: 14 }}
        />
        <PeAlertEmailControlVNext />
      </CapiroModal>

      <PeDataIssueModalVNext
        open={dataIssueOpen}
        peCode={code}
        defaultFy={latest?.fy ?? null}
        onClose={() => setDataIssueOpen(false)}
      />
      <PeLinkCrmContactModalVNext
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
    <div className={`pe-fb-profile-kpi${tone ? ` ${tone}` : ''}`}>
      <small>{label}</small>
      <strong>{value}</strong>
      {sub ? <span>{sub}</span> : null}
    </div>
  );
}

/* ── FY drill-down (canonical ProgramElementFyDrilldown, pathname-parsed) ──── */

function readFy(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function PeFyDrilldownVNext({ code }: { code: string }) {
  const api = useApi();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlFy = readFy(searchParams.get('fy'));
  const [selectedFy, setSelectedFy] = useState<number | null>(urlFy);
  const [open, setOpen] = useState(urlFy != null);
  const detailQuery = useQuery({
    queryKey: ['program-element-detail', code],
    queryFn: () => getProgramElementDetail(api, code),
    enabled: code.length > 0,
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (urlFy == null) return;
    setSelectedFy(urlFy);
    setOpen(true);
  }, [urlFy]);

  if (searchParams.get('tab') !== 'funding' || !detailQuery.data?.years?.length) {
    return null;
  }

  const selectFy = (fy: number) => {
    setSelectedFy(fy);
    setOpen(true);
    const params = new URLSearchParams(searchParams);
    params.set('fy', String(fy));
    setSearchParams(params, { replace: true });
  };
  const close = () => {
    setOpen(false);
    const params = new URLSearchParams(searchParams);
    params.delete('fy');
    setSearchParams(params, { replace: true });
  };

  return (
    <div className="pe-fb-root pe-fb-drilldown" style={{ maxWidth: 1240, marginTop: 12 }}>
      <section className="pe-fb-panel">
        <div className="pe-fb-panel-head">
          <h3>Fiscal-year detail</h3>
          <small>Existing source and linked-record drill-down</small>
        </div>
        <div className="pe-fb-panel-body">
          <div className="pe-fb-facets" style={{ marginTop: 0 }}>
            {detailQuery.data.years
              .slice()
              .sort((left, right) => right.fy - left.fy)
              .map((year) => (
                <button
                  className={`pe-fb-facet${selectedFy === year.fy ? ' active' : ''}`}
                  key={year.fy}
                  type="button"
                  onClick={() => selectFy(year.fy)}
                >
                  FY{year.fy}
                </button>
              ))}
          </div>
        </div>
      </section>
      <PeFyDetailDrawerVNext
        open={open}
        onClose={close}
        peCode={code}
        selectedFy={selectedFy}
        timeline={detailQuery.data.years}
      />
    </div>
  );
}
