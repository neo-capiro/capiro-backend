import { PeDossierNarrative } from './PeDossierNarrative.js';
/**
 * Program Elements vNext profile — Overview tab.
 * Native port of PeV2OverviewTab: funding-by-FY bars (enacted ink / request
 * comparison / FYDP dashed) · WHAT CHANGED card with fact strip · Legislative
 * activity · right rail (Client impact + Open actions + Relevant bills).
 * Same data derivations from the shared profile view-model; presentation on
 * the vNext token layer.
 */
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroSkeleton } from '../../../components/feedback/index.js';
import type { ProgramElementProfileFinalVm } from '../../../../pages/program-element/useProgramElementProfileFinalCore.js';
import { STAGE_LABEL } from '../../../../pages/program-element/funding-model.js';
import {
  historySeries,
  money,
  sgn,
  spct,
} from '../../../../pages/program-element/v2/pe-v2-model.js';
import { EvMark, PfCard } from './pe-profile-primitives.js';

export function PeProfileOverviewTab({ vm }: { vm: ProgramElementProfileFinalVm }) {
  const {
    detail,
    funding,
    latest,
    current,
    request,
    deltaPct,
    bills,
    clients,
    openActions,
    provisionsQuery,
    budgetActionsQuery,
    navigate,
    setActiveSection,
  } = vm;

  const hist = historySeries(detail!, funding);
  const maxBar = Math.max(...hist.map((h) => h.value), 1);
  const deltaDollar = current != null && request != null ? current - request : null;

  const provisions = provisionsQuery.data ?? [];
  const signals = budgetActionsQuery.data ?? [];

  return (
    <div
      style={{
        padding: '20px 24px 28px',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 20,
        alignItems: 'flex-start',
      }}
    >
      {/* Main column */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0, flex: '1 1 520px' }}>
        <PeDossierNarrative peCode={detail!.peCode} description={detail?.description ?? null} />
        {/* Funding by fiscal year */}
        <PfCard
          inkTop
          title="Funding by fiscal year"
          right={
            <div
              className="pe-pf-mono"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                fontSize: 11,
                letterSpacing: '0.05em',
                color: 'var(--pepf-secondary)',
                flexWrap: 'wrap',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 9, height: 9, background: 'var(--pepf-dark)', display: 'block' }} /> ENACTED / CURRENT
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 9, height: 9, background: 'var(--pepf-comparison)', display: 'block' }} /> REQUEST
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 9, height: 9, border: '1px dashed var(--pepf-border-strong)', display: 'block' }} /> FYDP OUTLOOK
              </span>
            </div>
          }
        >
          <div style={{ padding: '22px 18px 14px' }}>
            {hist.length === 0 ? (
              <div className="pe-pf-empty">No fiscal-year funding has been ingested for this line.</div>
            ) : (
              <>
                <div className="pe-pf-bars" role="img" aria-label="Funding by fiscal year bar chart">
                  {hist.map((h) => (
                    <div key={h.fy} className="pe-pf-bars-col">
                      <div
                        className="pe-pf-mono"
                        style={{
                          fontSize: 11,
                          color: 'var(--pepf-heading)',
                          textAlign: 'center',
                          marginBottom: 6,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {money(h.value)}
                      </div>
                      <div
                        style={{
                          height: Math.round(22 + (h.value / maxBar) * 104),
                          width: '66%',
                          margin: '0 auto',
                          borderRadius: '3px 3px 0 0',
                          ...(h.kind === 'enacted' || h.kind === 'current'
                            ? { background: 'var(--pepf-dark)' }
                            : h.kind === 'request'
                              ? { background: 'var(--pepf-comparison)' }
                              : { border: '1px dashed var(--pepf-border-strong)', background: 'transparent' }),
                        }}
                      />
                    </div>
                  ))}
                </div>
                <div
                  style={{
                    display: 'flex',
                    gap: 12,
                    marginTop: 8,
                    borderTop: '1px solid var(--pepf-border)',
                    paddingTop: 8,
                  }}
                >
                  {hist.map((h) => (
                    <div
                      key={h.fy}
                      className="pe-pf-mono"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 10.5,
                        letterSpacing: '0.03em',
                        color: 'var(--pepf-secondary)',
                        textAlign: 'center',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {h.fy}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </PfCard>

        {/* What changed */}
        <div className="pe-pf-card pe-pf-card-inktop" style={{ borderColor: 'var(--pepf-border-strong)', padding: '17px 20px 19px' }}>
          <div className="pe-pf-eyebrow" style={{ letterSpacing: '0.1em' }}>
            What changed
          </div>
          <div style={{ fontSize: 17, lineHeight: 1.5, color: 'var(--pepf-heading)', marginTop: 9, maxWidth: 760 }}>
            {signals[0]?.note ??
              detail?.fundingSummary ??
              'Re-checked against the active snapshot; no material change on this line.'}
          </div>
          <div
            style={{
              display: 'flex',
              gap: 30,
              marginTop: 16,
              paddingTop: 14,
              borderTop: '1px solid var(--pepf-hairline)',
              flexWrap: 'wrap',
              alignItems: 'flex-end',
            }}
          >
            {(
              [
                ['STAGE', latest ? STAGE_LABEL[latest.current.stage] : '—'],
                ['AMOUNT', deltaDollar == null ? 'Not asserted' : deltaDollar === 0 ? 'No change' : sgn(deltaDollar)],
                ['PERCENT', deltaPct == null ? '—' : spct(deltaPct)],
                ['EVIDENCE', `${detail?.sourceCount ?? 0} source${detail?.sourceCount === 1 ? '' : 's'}`],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <div className="pe-pf-eyebrow-quiet" style={{ letterSpacing: '0.08em' }}>
                  {k}
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--pepf-ink)', marginTop: 5 }}>{v}</div>
              </div>
            ))}
            <div style={{ flex: 1, minWidth: 8 }} />
            <CapiroButton size="compact" onClick={() => setActiveSection('funding')}>
              Open evidence
            </CapiroButton>
          </div>
        </div>

        {/* Legislative activity */}
        <PfCard
          title="Legislative activity"
          right={
            <button type="button" className="pe-pf-quiet-link ink" onClick={() => setActiveSection('legislative')}>
              All legislative detail →
            </button>
          }
        >
          {provisionsQuery.isLoading ? (
            <div style={{ padding: 18, display: 'grid', gap: 10 }}>
              <CapiroSkeleton height={14} />
              <CapiroSkeleton height={14} width="72%" />
            </div>
          ) : provisions.length === 0 ? (
            <div className="pe-pf-empty" style={{ padding: '22px 18px' }}>
              No committee has acted on this line in the active cycle. Nothing to protect or restore yet.
            </div>
          ) : (
            provisions.slice(0, 3).map((p) => (
              <div
                key={p.id}
                className="pe-pf-listrow"
                style={{
                  padding: '13px 18px',
                  display: 'flex',
                  gap: 18,
                  alignItems: 'flex-start',
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ flex: 'none', width: 150 }}>
                  <div className="pe-pf-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--pepf-secondary)' }}>
                    {p.committee.replaceAll('_', '-').toUpperCase()}
                  </div>
                  <div className="pe-pf-mono" style={{ fontSize: 11, color: 'var(--pepf-quiet)', marginTop: 3 }}>
                    {p.pageStart != null ? `p. ${p.pageStart}` : `FY${p.fy}`}
                  </div>
                </div>
                <div style={{ flex: '1 1 0', minWidth: 240 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--pepf-ink)' }}>{p.heading}</div>
                  <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--pepf-body)', marginTop: 4 }}>
                    {p.text.length > 220 ? `${p.text.slice(0, 220)}…` : p.text}
                  </div>
                </div>
                <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 9 }}>
                  <EvMark
                    state={p.reviewStatus === 'accepted' ? 'VERIFIED' : 'REVIEW REQUIRED'}
                    label={p.reviewStatus === 'accepted' ? '■ VERIFIED' : '⚠ REVIEW'}
                    quiet={p.reviewStatus === 'accepted'}
                  />
                </div>
              </div>
            ))
          )}
        </PfCard>
      </div>

      {/* Right rail */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0, flex: '1 1 300px', maxWidth: 336 }}>
        {/* Client impact */}
        <PfCard title="Client impact" headPadding="12px 16px 11px">
          {clients.length === 0 ? (
            <div className="pe-pf-empty" style={{ padding: 16 }}>
              No client in this tenant is linked to this line.
            </div>
          ) : (
            clients.slice(0, 4).map((c) => (
              <div key={c.clientId} className="pe-pf-listrow" style={{ padding: '13px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <span className="pe-pf-initials">
                    {c.clientName.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
                  </span>
                  <span
                    style={{
                      fontSize: 13.5,
                      fontWeight: 700,
                      color: 'var(--pepf-ink)',
                      flex: 1,
                      minWidth: 0,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {c.clientName}
                  </span>
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--pepf-body)', marginTop: 8 }}>
                  {c.paths[0]?.evidence[0] ?? 'Linked via capability relevance.'}
                </div>
                <div className="pe-pf-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--pepf-secondary)', marginTop: 8 }}>
                  SCORE {c.score.toFixed(2)}
                </div>
              </div>
            ))
          )}
        </PfCard>

        {/* Open actions */}
        <PfCard
          title="Open actions"
          headPadding="12px 16px 11px"
          right={
            <button type="button" className="pe-pf-quiet-link ink" onClick={() => navigate('/actions')}>
              Actions →
            </button>
          }
        >
          {openActions.length === 0 ? (
            <div className="pe-pf-empty" style={{ padding: 16 }}>
              No open action on this line.
            </div>
          ) : (
            openActions.slice(0, 3).map((a) => (
              <div key={a.id} className="pe-pf-listrow" style={{ padding: '13px 16px' }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--pepf-ink)', lineHeight: 1.35 }}>
                  {a.issueTitle}
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '74px minmax(0,1fr)',
                    gap: '5px 10px',
                    marginTop: 9,
                    alignItems: 'baseline',
                  }}
                >
                  <span className="pe-pf-eyebrow-quiet" style={{ letterSpacing: '0.06em' }}>Client</span>
                  <span style={{ fontSize: 12.5, color: 'var(--pepf-heading)' }}>{a.clientName ?? '—'}</span>
                  <span className="pe-pf-eyebrow-quiet" style={{ letterSpacing: '0.06em' }}>Due</span>
                  <span className="pe-pf-mono" style={{ fontSize: 11, color: 'var(--pepf-ink)' }}>
                    {a.deadline
                      ? new Date(a.deadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                      : '—'}
                  </span>
                </div>
                <div style={{ marginTop: 9 }}>
                  <span className="pe-pf-ev-chip ink">{a.status.replaceAll('_', ' ').toUpperCase()}</span>
                </div>
              </div>
            ))
          )}
        </PfCard>

        {/* Bills (quiet) */}
        <PfCard
          title="Relevant bills"
          headPadding="12px 16px 11px"
          right={<span className="pe-pf-eyebrow-quiet">{bills.length || ''}</span>}
        >
          {bills.length === 0 ? (
            <div className="pe-pf-empty" style={{ padding: 16 }}>
              No bill or vehicle carries a position on this line yet.
            </div>
          ) : (
            bills.slice(0, 3).map((b) => (
              <div key={b.id} className="pe-pf-listrow" style={{ padding: '11px 16px' }}>
                <button
                  type="button"
                  onClick={() => navigate(`/bills/${b.id}`)}
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'var(--pepf-ink)',
                    textAlign: 'left',
                    cursor: 'pointer',
                    background: 'none',
                    border: 0,
                    padding: 0,
                  }}
                >
                  {b.billType.toUpperCase()}. {b.billNumber} — {b.title}
                </button>
                <div className="pe-pf-mono" style={{ fontSize: 11, color: 'var(--pepf-secondary)', marginTop: 3 }}>
                  {b.latestActionDate ?? ''} {b.latestActionText ? `· ${b.latestActionText.slice(0, 80)}` : ''}
                </div>
              </div>
            ))
          )}
        </PfCard>
      </div>
    </div>
  );
}
