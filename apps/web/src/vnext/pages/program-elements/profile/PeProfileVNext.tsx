/**
 * PeProfileVNext — the five-tab Program Elements line profile, vNext-native.
 *
 * Phase 3 port of ProgramElementV2ProfilePage: header (CURRENT 34px + delta
 * sentence + supporting metrics + Monitor / Create action / Export),
 * SnapshotDiff row, trust strip, and five tabs: Overview · Funding & lifecycle
 * · Legislative · Program structure · Sources & proof.
 *
 * Data: the shared UI-free view-model (useProgramElementProfileFinalCore via
 * usePeProfileVNextVm) — identical endpoints, query keys, derivations and CSV
 * export as the canonical page. The PE code comes from location.pathname
 * (useParams is empty under VNextRouter); tests may pass `peCode` directly.
 */
import { useMemo } from 'react';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroEmptyState } from '../../../components/feedback/index.js';
import { CapiroTabs } from '../../../components/menus/index.js';
import { STAGE_LABEL } from '../../../../pages/program-element/funding-model.js';
import { serviceLabel } from '../../../../pages/program-element/pe-shared-model.js';
import {
  money,
  sgn,
  spct,
} from '../../../../pages/program-element/v2/pe-v2-model.js';
import { usePeProfileVNextVm } from './usePeProfileVNextVm.js';
import { PeProfileOverviewTab } from './PeProfileOverviewTab.js';
import { PeProfileFundingTab } from './PeProfileFundingTab.js';
import { PeProfileLegislativeTab } from './PeProfileLegislativeTab.js';
import { PeProfileStructureTab } from './PeProfileStructureTab.js';
import { PeProfileSourcesTab } from './PeProfileSourcesTab.js';
import { PeProfileDataIssueModal } from './PeProfileDataIssueModal.js';
import {
  PeProfileFailedState,
  PeProfileLoading,
  PeProfileMissingCode,
  PeProfileUnsupportedState,
} from './PeProfileLoadState.js';
import './pe-profile.css';

type V2Tab = 'overview' | 'funding' | 'legislative' | 'structure' | 'sources';

// Tab id/query-key stays `legislative` (route stability — see pe-routes.ts);
// only the displayed label changed, to `Congressional`, matching the Defense
// Budget vNext design doc's profile IA (§2). Content is the same tab.
const TABS: Array<{ id: V2Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'funding', label: 'Funding & lifecycle' },
  { id: 'legislative', label: 'Congressional' },
  { id: 'structure', label: 'Program structure' },
  { id: 'sources', label: 'Sources & proof' },
];

export function PeProfileVNext({ peCode }: { peCode?: string }) {
  const vm = usePeProfileVNextVm(peCode);
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
    clients,
    historical,
    exportProfile,
    deltasQuery,
  } = vm;

  const tab: V2Tab = useMemo(() => {
    return section === 'ecosystem' ? 'overview' : (section as V2Tab);
  }, [section]);

  const goTab = (t: V2Tab) => {
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
    return (
      <div className="pe-profile-vnext" data-testid="pe-vnext-profile">
        <PeProfileMissingCode />
      </div>
    );
  }
  if (detailQuery.isLoading) {
    return (
      <div className="pe-profile-vnext" data-testid="pe-vnext-profile">
        <PeProfileLoading />
      </div>
    );
  }
  if (detailQuery.isError || !detail) {
    const error = detailQuery.error as { response?: { status?: number }; status?: number };
    const status = error?.response?.status ?? error?.status;
    return (
      <div className="pe-profile-vnext" data-testid="pe-vnext-profile">
        <PeProfileFailedState
          state={status === 404 ? 'not_found' : 'failed'}
          peCode={code}
          onRetry={() => void detailQuery.refetch()}
        />
      </div>
    );
  }
  if (detail.unsupportedSourceFamily) {
    return (
      <div className="pe-profile-vnext" data-testid="pe-vnext-profile">
        <PeProfileUnsupportedState />
      </div>
    );
  }

  const deltaDollar = current != null && request != null ? current - request : null;
  const conflict = (detail.openReconciliationConflictCount ?? 0) > 0;
  const verified = !conflict && (detail.sourceCount ?? 0) > 0;

  return (
    <div className="pe-profile-vnext" data-testid="pe-vnext-profile">
      {/* Header */}
      <div className="pe-pf-head">
        <div style={{ flex: '1 1 300px', minWidth: 270 }}>
          <div className="pe-pf-eyebrow-quiet" style={{ fontSize: 12, letterSpacing: '0.07em' }}>
            {detail.peCode}
          </div>
          <div className="pe-pf-title">{detail.title}</div>
          <div className="pe-pf-meta">
            {detail.appropriationType ?? ''}
            {detail.service ? `, ${serviceLabel(detail.service)}` : ''}
            {detail.budgetActivity ? ` · ${detail.budgetActivity}` : ''}
            {historical ? ' · Historical' : ''}
          </div>
        </div>

        <div style={{ flex: 'none', display: 'flex', alignItems: 'flex-end', gap: 24, flexWrap: 'wrap' }}>
          <div style={{ flex: 'none' }}>
            <div className="pe-pf-eyebrow" style={{ letterSpacing: '0.1em' }}>
              Current
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 11, marginTop: 1 }}>
              <span
                className="pe-pf-current"
                style={{ color: current == null ? 'var(--pepf-warning)' : 'var(--pepf-ink)' }}
              >
                {current == null ? 'NO POSITION' : money(current)}
              </span>
              <span
                className="pe-pf-mono"
                style={{
                  fontSize: 12.5,
                  letterSpacing: '0.06em',
                  fontWeight: 600,
                  color: 'var(--pepf-ink)',
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
                      ? 'var(--pepf-warning)'
                      : deltaDollar > 0
                        ? 'var(--pepf-success)'
                        : deltaDollar < 0
                          ? 'var(--pepf-ink)'
                          : 'var(--pepf-secondary)',
                }}
              >
                {deltaSentence}
              </div>
            ) : null}
          </div>
          <span className="pe-pf-vsep" />
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24, flexWrap: 'wrap', paddingBottom: 3 }}>
            <div>
              <div className="pe-pf-eyebrow" style={{ letterSpacing: '0.09em' }}>
                FY{latestRequest?.fy ?? latest?.fy ?? '—'} request
              </div>
              <div className="pe-pf-support" style={{ color: 'var(--pepf-secondary)' }}>
                {request == null ? '—' : money(request)}
              </div>
            </div>
            <button type="button" className="pe-pf-stat-btn" onClick={() => goTab('overview')}>
              <div className="pe-pf-eyebrow" style={{ letterSpacing: '0.09em' }}>
                Clients affected
              </div>
              <div
                className="pe-pf-support"
                style={{ color: clients.length ? 'var(--pepf-ink)' : 'var(--pepf-quiet)' }}
              >
                {clients.length || '—'}
              </div>
            </button>
            <button type="button" className="pe-pf-stat-btn" onClick={() => goTab('sources')}>
              <div className="pe-pf-eyebrow" style={{ letterSpacing: '0.09em' }}>
                Verification
              </div>
              <div
                className="pe-pf-support"
                style={{ color: conflict ? 'var(--pepf-warning)' : verified ? 'var(--pepf-success)' : 'var(--pepf-quiet)' }}
              >
                {conflict ? 'Conflict' : verified ? 'Passed' : 'Pending'}
              </div>
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flex: 'none', paddingBottom: 3 }}>
          <CapiroButton
            disabled={watch.isPending}
            onClick={() =>
              watch.mutate({ peCode: code, watching: !detail.currentUserIsWatching })
            }
          >
            {detail.currentUserIsWatching ? '■ Monitored' : 'Monitor'}
          </CapiroButton>
          <CapiroButton variant="primary" onClick={() => navigate(`/actions?peCode=${encodeURIComponent(code)}`)}>
            Create action
          </CapiroButton>
          <button type="button" className="pe-pf-quiet-link" onClick={() => exportProfile()}>
            Export
          </button>
        </div>
      </div>

      {/* SnapshotDiff row — directly under the header */}
      <button
        type="button"
        className={`pe-pf-snaprow${latestDelta ? ' material' : ''}${conflict ? ' conflict' : ''}`}
        style={{ cursor: latestDelta ? 'pointer' : 'default' }}
        onClick={() => latestDelta && goTab('funding')}
      >
        <span className="pe-pf-eyebrow" style={{ letterSpacing: '0.09em', flex: 'none' }}>
          Snapshot · FY{latest?.fy ?? latestRequest?.fy ?? '—'}
        </span>
        <span style={{ width: 1, height: 15, background: 'var(--pepf-border)', flex: 'none' }} />
        {latestDelta ? (
          <>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 11, flex: 1, minWidth: 260, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--pepf-heading)' }}>
                {latestDelta.deltaType.replaceAll('_', ' ')}
                {latestDelta.amountFrom != null && latestDelta.amountTo != null
                  ? ` · ${money(Number(latestDelta.amountFrom))} → ${money(Number(latestDelta.amountTo))}`
                  : ''}
              </span>
              {latestDelta.deltaAbs != null ? (
                <span
                  className="pe-pf-mono"
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    color: Number(latestDelta.deltaAbs) > 0 ? 'var(--pepf-success)' : 'var(--pepf-ink)',
                  }}
                >
                  {sgn(Number(latestDelta.deltaAbs))} vs request
                </span>
              ) : null}
            </span>
            <span className="pe-pf-eyebrow-quiet" style={{ letterSpacing: '0.06em', flex: 'none' }}>
              Change ledger →
            </span>
          </>
        ) : (
          <span className="pe-pf-mono" style={{ fontSize: 11.5, letterSpacing: '0.06em', color: 'var(--pepf-quiet)', flex: 1 }}>
            No material change in the active snapshot
          </span>
        )}
      </button>

      {/* Trust strip — four provenance facts + quiet links */}
      <div className="pe-pf-trust">
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
        ).map(([k, v, monoFont]) => (
          <div key={k} className="pe-pf-trust-cell">
            <div className="pe-pf-eyebrow-quiet">{k}</div>
            <div
              style={
                monoFont
                  ? { fontFamily: 'var(--pepf-mono)', fontSize: 12, color: 'var(--pepf-heading)', marginTop: 4, whiteSpace: 'nowrap' }
                  : { fontSize: 13, color: 'var(--pepf-body)', marginTop: 4, whiteSpace: 'nowrap' }
              }
            >
              {v}
            </div>
          </div>
        ))}
        <div style={{ flex: 1, minWidth: 12 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flex: 'none' }}>
          <button type="button" className="pe-pf-quiet-link ink" onClick={() => goTab('sources')}>
            View coverage
          </button>
          <button type="button" className="pe-pf-quiet-link" onClick={() => setDataIssueOpen(true)}>
            Report issue
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="pe-pf-tabband">
        <CapiroTabs
          items={TABS}
          activeId={tab}
          onChange={(id) => goTab(id as V2Tab)}
          label="Program Element profile sections"
        />
      </div>

      {!detail.years?.length ? (
        <div style={{ padding: '20px 24px 0' }}>
          <CapiroEmptyState
            title="Not yet ingested"
            description="The Program Element identity is known, but no budget-year rows have been ingested for this code."
          />
        </div>
      ) : null}

      {tab === 'overview' ? <PeProfileOverviewTab vm={vm} /> : null}
      {tab === 'funding' ? <PeProfileFundingTab vm={vm} /> : null}
      {tab === 'legislative' ? <PeProfileLegislativeTab vm={vm} /> : null}
      {tab === 'structure' ? <PeProfileStructureTab vm={vm} /> : null}
      {tab === 'sources' ? <PeProfileSourcesTab vm={vm} /> : null}

      <PeProfileDataIssueModal
        open={dataIssueOpen}
        peCode={code}
        defaultFy={latest?.fy ?? null}
        onClose={() => setDataIssueOpen(false)}
      />
    </div>
  );
}
