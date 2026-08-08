/**
 * Program Elements v2 — line profile.
 * Header (CURRENT 34px + delta sentence + supporting metrics + Monitor /
 * Create action / Export), SnapshotDiff row, trust strip, and five tabs:
 * Overview · Funding & lifecycle · Legislative · Program structure ·
 * Sources & proof. capiro-internal only (gated at the route).
 */
import { useMemo, useState } from 'react';
import { Alert, Skeleton } from 'antd';
import { PeLoadState } from './PeLoadState.js';
import { ProgramElementDataIssueModal } from './ProgramElementDataIssueModal.js';
import { STAGE_LABEL } from './funding-model.js';
import { serviceLabel } from './pe-shared.js';
import { useProgramElementProfileFinal } from './useProgramElementProfileFinal.js';
import {
  money,
  sgn,
  spct,
} from './v2/pe-v2-model.js';
import { PeV2OverviewTab } from './v2/PeV2OverviewTab.js';
import { PeV2FundingTab } from './v2/PeV2FundingTab.js';
import { PeV2LegislativeTab } from './v2/PeV2LegislativeTab.js';
import { PeV2StructureTab } from './v2/PeV2StructureTab.js';
import { PeV2SourcesTab } from './v2/PeV2SourcesTab.js';
import './v2/pe-v2.css';

type V2Tab = 'overview' | 'funding' | 'legislative' | 'structure' | 'sources';

const TABS: Array<{ key: V2Tab; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'funding', label: 'Funding & lifecycle' },
  { key: 'legislative', label: 'Legislative' },
  { key: 'structure', label: 'Program structure' },
  { key: 'sources', label: 'Sources & proof' },
];

export function ProgramElementV2ProfilePage() {
  const vm = useProgramElementProfileFinal();
  const {
    code,
    navigate,
    watch,
    section,
    setActiveSection,
    dataIssueOpen,
    setDataIssueOpen,
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
    lineType,
    exportProfile,
    deltasQuery,
  } = vm;

  const [localTab, setLocalTab] = useState<V2Tab | null>(null);
  const tab: V2Tab = useMemo(() => {
    if (localTab) return localTab;
    return section === 'ecosystem' ? 'overview' : (section as V2Tab);
  }, [localTab, section]);

  const goTab = (t: V2Tab) => {
    setLocalTab(t);
    setActiveSection(t);
  };

  const latestDelta = deltasQuery.data?.data?.[0];
  const deltaSentence = useMemo(() => {
    if (current == null || request == null) return null;
    const d = current - request;
    if (d === 0) return 'No change from the FY27 request';
    return `${sgn(d)} · ${spct(deltaPct)} vs FY${latest?.fy ?? latestRequest?.fy ?? ''} request`;
  }, [current, request, deltaPct, latest, latestRequest]);

  if (!code) {
    return <Alert type="warning" showIcon message="Missing Program Element code" />;
  }
  if (detailQuery.isLoading) {
    return (
      <div className="pe-v2" style={{ padding: 24 }}>
        <Skeleton active paragraph={{ rows: 10 }} />
      </div>
    );
  }
  if (detailQuery.isError || !detail) {
    const error = detailQuery.error as { response?: { status?: number }; status?: number };
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

  const deltaDollar = current != null && request != null ? current - request : null;
  const conflict = (detail.openReconciliationConflictCount ?? 0) > 0;
  const verified = !conflict && (detail.sourceCount ?? 0) > 0;

  return (
    <div className="pe-v2" data-testid="pe-v2-profile">
      {/* Header */}
      <div className="pe-v2-prof-head">
        <div style={{ flex: '1 1 300px', minWidth: 270 }}>
          <div className="pe-v2-eyebrow-quiet" style={{ fontSize: 12, letterSpacing: '0.07em' }}>
            {detail.peCode}
          </div>
          <div className="pe-v2-prof-title">{detail.title}</div>
          <div style={{ fontSize: 13, color: 'var(--pev2-secondary)', marginTop: 6 }}>
            {detail.appropriationType ?? ''}
            {detail.service ? `, ${serviceLabel(detail.service)}` : ''}
            {detail.budgetActivity ? ` · ${detail.budgetActivity}` : ''}
            {historical ? ' · Historical' : ''}
          </div>
        </div>

        <div style={{ flex: 'none', display: 'flex', alignItems: 'flex-end', gap: 24, flexWrap: 'wrap' }}>
          <div style={{ flex: 'none' }}>
            <div className="pe-v2-eyebrow" style={{ letterSpacing: '0.1em' }}>
              Current
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 11, marginTop: 1 }}>
              <span
                className="pe-v2-prof-current"
                style={{ color: current == null ? 'var(--pev2-warning)' : 'var(--pev2-ink)' }}
              >
                {current == null ? 'NO POSITION' : money(current)}
              </span>
              <span
                className="pe-v2-mono"
                style={{
                  fontSize: 12.5,
                  letterSpacing: '0.06em',
                  fontWeight: 600,
                  color: 'var(--pev2-ink)',
                  paddingBottom: 3,
                }}
              >
                {latest ? STAGE_LABEL[latest.current.stage].toUpperCase() : '—'}
              </span>
            </div>
            {deltaSentence ? (
              <div
                style={{
                  fontSize: 13.5,
                  fontWeight: 600,
                  marginTop: 7,
                  whiteSpace: 'nowrap',
                  color:
                    deltaDollar == null
                      ? 'var(--pev2-warning)'
                      : deltaDollar > 0
                        ? 'var(--pev2-success)'
                        : deltaDollar < 0
                          ? 'var(--pev2-ink)'
                          : 'var(--pev2-secondary)',
                }}
              >
                {deltaSentence}
              </div>
            ) : null}
          </div>
          <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--pev2-hairline)', flex: 'none' }} />
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24, flexWrap: 'wrap', paddingBottom: 3 }}>
            <div>
              <div className="pe-v2-eyebrow" style={{ letterSpacing: '0.09em' }}>
                FY{latestRequest?.fy ?? latest?.fy ?? '—'} request
              </div>
              <div className="pe-v2-prof-support" style={{ color: 'var(--pev2-tertiary)' }}>
                {request == null ? '—' : money(request)}
              </div>
            </div>
            <button type="button" onClick={() => goTab('overview')} style={{ cursor: 'pointer', textAlign: 'left' }}>
              <div className="pe-v2-eyebrow" style={{ letterSpacing: '0.09em' }}>
                Clients affected
              </div>
              <div
                className="pe-v2-prof-support"
                style={{ color: clients.length ? 'var(--pev2-ink)' : 'var(--pev2-quiet)' }}
              >
                {clients.length || '—'}
              </div>
            </button>
            <button type="button" onClick={() => goTab('sources')} style={{ cursor: 'pointer', textAlign: 'left' }}>
              <div className="pe-v2-eyebrow" style={{ letterSpacing: '0.09em' }}>
                Verification
              </div>
              <div
                className="pe-v2-prof-support"
                style={{ color: conflict ? 'var(--pev2-warning)' : verified ? 'var(--pev2-success)' : 'var(--pev2-quiet)' }}
              >
                {conflict ? 'Conflict' : verified ? 'Passed' : 'Pending'}
              </div>
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flex: 'none', paddingBottom: 3 }}>
          <button
            type="button"
            className="pe-v2-btn"
            disabled={watch.isPending}
            onClick={() =>
              watch.mutate({ peCode: code, watching: !detail.currentUserIsWatching })
            }
          >
            {detail.currentUserIsWatching ? '■ Monitored' : 'Monitor'}
          </button>
          <button
            type="button"
            className="pe-v2-btn pe-v2-btn-primary"
            onClick={() => navigate(`/actions?peCode=${encodeURIComponent(code)}`)}
          >
            Create action
          </button>
          <button type="button" className="pe-v2-quiet-link" onClick={() => exportProfile()}>
            Export
          </button>
        </div>
      </div>

      {/* SnapshotDiff row — directly under the header (refinement §01) */}
      <button
        type="button"
        className={`pe-v2-snaprow${latestDelta ? ' material' : ''}${conflict ? ' conflict' : ''}`}
        style={{ width: '100%', textAlign: 'left', cursor: latestDelta ? 'pointer' : 'default' }}
        onClick={() => latestDelta && goTab('funding')}
      >
        <span className="pe-v2-eyebrow" style={{ letterSpacing: '0.09em', flex: 'none' }}>
          Snapshot · FY{latest?.fy ?? latestRequest?.fy ?? '—'}
        </span>
        <span style={{ width: 1, height: 15, background: 'var(--pev2-border)', flex: 'none' }} />
        {latestDelta ? (
          <>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 11, flex: 1, minWidth: 260, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: '#121722' }}>
                {latestDelta.deltaType.replaceAll('_', ' ')}
                {latestDelta.amountFrom != null && latestDelta.amountTo != null
                  ? ` · ${money(Number(latestDelta.amountFrom))} → ${money(Number(latestDelta.amountTo))}`
                  : ''}
              </span>
              {latestDelta.deltaAbs != null ? (
                <span
                  className="pe-v2-mono"
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    color: Number(latestDelta.deltaAbs) > 0 ? 'var(--pev2-success)' : 'var(--pev2-ink)',
                  }}
                >
                  {sgn(Number(latestDelta.deltaAbs))} vs request
                </span>
              ) : null}
            </span>
            <span className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.06em', flex: 'none' }}>
              Change ledger →
            </span>
          </>
        ) : (
          <span className="pe-v2-mono" style={{ fontSize: 11.5, letterSpacing: '0.06em', color: 'var(--pev2-quiet)', flex: 1 }}>
            No material change in the active snapshot
          </span>
        )}
      </button>

      {/* Trust strip — four provenance facts + quiet links (refinement §01) */}
      <div className="pe-v2-trust">
        {(
          [
            ['ACTIVE SNAPSHOT', latest ? `FY${latest.fy}` : '—', true],
            ['SOURCE COVERAGE', `${detail.sourceCount ?? 0} verified source${detail.sourceCount === 1 ? '' : 's'}`, false],
            [
              'DATA STATUS',
              conflict
                ? `${detail.openReconciliationConflictCount} blocking conflict${detail.openReconciliationConflictCount === 1 ? '' : 's'}`
                : 'No blocking conflicts',
              false,
            ],
            ['ACTIVATED', new Date(detail.lastSyncedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), true],
          ] as const
        ).map(([k, v, monoFont], i) => (
          <div key={k} className="pe-v2-trust-cell" style={i === 0 ? { paddingLeft: 24 } : undefined}>
            <div className="pe-v2-eyebrow-quiet">{k}</div>
            <div
              style={
                monoFont
                  ? { fontFamily: 'var(--pev2-mono)', fontSize: 12, color: 'var(--pev2-ink-2)', marginTop: 4, whiteSpace: 'nowrap' }
                  : { fontSize: 13, color: 'var(--pev2-body)', marginTop: 4, whiteSpace: 'nowrap' }
              }
            >
              {v}
            </div>
          </div>
        ))}
        <div style={{ flex: 1, minWidth: 12 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flex: 'none' }}>
          <button type="button" className="pe-v2-quiet-link ink" onClick={() => goTab('sources')}>
            View coverage
          </button>
          <button type="button" className="pe-v2-quiet-link" onClick={() => setDataIssueOpen(true)}>
            Report issue
          </button>
        </div>
      </div>

      {/* Tabs */}
      <nav className="pe-v2-tabs" role="tablist" aria-label="Program Element profile sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`pe-v2-tab${tab === t.key ? ' active' : ''}`}
            onClick={() => goTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {!detail.years?.length ? (
        <div style={{ padding: '20px 24px 0' }}>
          <Alert
            type="info"
            showIcon
            message="Not yet ingested"
            description="The Program Element identity is known, but no budget-year rows have been ingested for this code."
          />
        </div>
      ) : null}

      {tab === 'overview' ? <PeV2OverviewTab vm={vm} /> : null}
      {tab === 'funding' ? <PeV2FundingTab vm={vm} /> : null}
      {tab === 'legislative' ? <PeV2LegislativeTab vm={vm} /> : null}
      {tab === 'structure' ? <PeV2StructureTab vm={vm} /> : null}
      {tab === 'sources' ? <PeV2SourcesTab vm={vm} /> : null}

      <ProgramElementDataIssueModal
        open={dataIssueOpen}
        peCode={code}
        defaultFy={latest?.fy ?? null}
        onClose={() => setDataIssueOpen(false)}
      />
    </div>
  );
}
