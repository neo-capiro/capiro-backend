/**
 * Program Elements v2 — Overview tab.
 * Funding-by-FY bars (enacted ink / request comparison / FYDP dashed) ·
 * WHAT CHANGED card with fact strip · Legislative activity · right rail
 * (Client impact + Open actions). Data from the shared profile hook.
 */
import { Skeleton } from 'antd';
import type { ProgramElementProfileFinalVm } from '../useProgramElementProfileFinal.js';
import { STAGE_LABEL } from '../funding-model.js';
import {
  historySeries,
  money,
  sgn,
  spct,
} from './pe-v2-model.js';
import { EvMark } from './pe-v2-primitives.js';

export function PeV2OverviewTab({ vm }: { vm: ProgramElementProfileFinalVm }) {
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
    code,
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
        {/* Funding by fiscal year */}
        <div className="pe-v2-card pe-v2-card-inktop">
          <div className="pe-v2-card-head">
            <div className="pe-v2-card-title">Funding by fiscal year</div>
            <div style={{ flex: 1, minWidth: 8 }} />
            <div
              className="pe-v2-mono"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                fontSize: 11,
                letterSpacing: '0.05em',
                color: 'var(--pev2-secondary)',
                flexWrap: 'wrap',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 9, height: 9, background: '#131A24', display: 'block' }} /> ENACTED / CURRENT
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 9, height: 9, background: '#96A1B4', display: 'block' }} /> REQUEST
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 9, height: 9, border: '1px dashed #8792A3', display: 'block' }} /> FYDP OUTLOOK
              </span>
            </div>
          </div>
          <div style={{ padding: '22px 18px 14px' }}>
            {hist.length === 0 ? (
              <div className="pe-v2-empty">No fiscal-year funding has been ingested for this line.</div>
            ) : (
              <>
                <div className="pe-v2-bars" role="img" aria-label="Funding by fiscal year bar chart">
                  {hist.map((h) => (
                    <div key={h.fy} className="pe-v2-bars-col">
                      <div
                        className="pe-v2-mono"
                        style={{
                          fontSize: 11,
                          color: 'var(--pev2-ink-2)',
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
                          ...(h.kind === 'enacted' || h.kind === 'current'
                            ? { background: '#131A24' }
                            : h.kind === 'request'
                              ? { background: '#96A1B4' }
                              : { border: '1px dashed #8792A3', background: 'transparent' }),
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
                    borderTop: '1px solid var(--pev2-border)',
                    paddingTop: 8,
                  }}
                >
                  {hist.map((h) => (
                    <div
                      key={h.fy}
                      className="pe-v2-mono"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 10.5,
                        letterSpacing: '0.03em',
                        color: 'var(--pev2-secondary)',
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
        </div>

        {/* What changed */}
        <div className="pe-v2-card pe-v2-card-inktop" style={{ borderColor: 'var(--pev2-border-strong)', padding: '17px 20px 19px' }}>
          <div className="pe-v2-eyebrow" style={{ letterSpacing: '0.1em' }}>
            What changed
          </div>
          <div style={{ fontSize: 17, lineHeight: 1.5, color: '#121722', marginTop: 9, maxWidth: 760 }}>
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
              borderTop: '1px solid var(--pev2-hairline)',
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
                <div className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.08em' }}>
                  {k}
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--pev2-ink)', marginTop: 5 }}>{v}</div>
              </div>
            ))}
            <div style={{ flex: 1, minWidth: 8 }} />
            <button
              type="button"
              className="pe-v2-btn pe-v2-btn-sm"
              onClick={() => setActiveSection('funding')}
            >
              Open evidence
            </button>
          </div>
        </div>

        {/* Legislative activity */}
        <div className="pe-v2-card">
          <div className="pe-v2-card-head">
            <div className="pe-v2-card-title">Legislative activity</div>
            <div style={{ flex: 1 }} />
            <button type="button" className="pe-v2-quiet-link ink" onClick={() => setActiveSection('legislative')}>
              All legislative detail →
            </button>
          </div>
          {provisionsQuery.isLoading ? (
            <div style={{ padding: 18 }}>
              <Skeleton active paragraph={{ rows: 2 }} title={false} />
            </div>
          ) : provisions.length === 0 ? (
            <div className="pe-v2-empty" style={{ padding: '22px 18px' }}>
              No committee has acted on this line in the active cycle. Nothing to protect or restore yet.
            </div>
          ) : (
            provisions.slice(0, 3).map((p) => (
              <div
                key={p.id}
                style={{
                  padding: '13px 18px',
                  borderBottom: '1px solid var(--pev2-hairline)',
                  display: 'flex',
                  gap: 18,
                  alignItems: 'flex-start',
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ flex: 'none', width: 150 }}>
                  <div className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--pev2-secondary)' }}>
                    {p.committee.replaceAll('_', '-').toUpperCase()}
                  </div>
                  <div className="pe-v2-mono" style={{ fontSize: 11, color: 'var(--pev2-quiet)', marginTop: 3 }}>
                    {p.pageStart != null ? `p. ${p.pageStart}` : `FY${p.fy}`}
                  </div>
                </div>
                <div style={{ flex: '1 1 0', minWidth: 240 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--pev2-ink)' }}>{p.heading}</div>
                  <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--pev2-body)', marginTop: 4 }}>
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
        </div>
      </div>

      {/* Right rail */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0, flex: '1 1 300px', maxWidth: 336 }}>
        {/* Client impact */}
        <div className="pe-v2-card">
          <div className="pe-v2-card-head" style={{ padding: '12px 16px 11px' }}>
            <div className="pe-v2-card-title">Client impact</div>
          </div>
          {clients.length === 0 ? (
            <div className="pe-v2-empty" style={{ padding: 16 }}>
              No client in this tenant is linked to this line.
            </div>
          ) : (
            clients.slice(0, 4).map((c) => (
              <div key={c.clientId} style={{ padding: '13px 16px', borderBottom: '1px solid var(--pev2-hairline)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <span className="pe-v2-initials">
                    {c.clientName.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
                  </span>
                  <span
                    style={{
                      fontSize: 13.5,
                      fontWeight: 700,
                      color: 'var(--pev2-ink)',
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
                <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--pev2-body)', marginTop: 8 }}>
                  {c.paths[0]?.evidence[0] ?? 'Linked via capability relevance.'}
                </div>
                <div className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--pev2-secondary)', marginTop: 8 }}>
                  SCORE {c.score.toFixed(2)}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Open actions */}
        <div className="pe-v2-card">
          <div className="pe-v2-card-head" style={{ padding: '12px 16px 11px' }}>
            <div className="pe-v2-card-title">Open actions</div>
            <div style={{ flex: 1 }} />
            <button type="button" className="pe-v2-quiet-link ink" onClick={() => navigate('/actions')}>
              Actions →
            </button>
          </div>
          {openActions.length === 0 ? (
            <div className="pe-v2-empty" style={{ padding: 16 }}>
              No open action on this line.
            </div>
          ) : (
            openActions.slice(0, 3).map((a) => (
              <div key={a.id} style={{ padding: '13px 16px', borderBottom: '1px solid var(--pev2-hairline)' }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--pev2-ink)', lineHeight: 1.35 }}>
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
                  <span className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.06em' }}>Client</span>
                  <span style={{ fontSize: 12.5, color: 'var(--pev2-ink-2)' }}>{a.clientName ?? '—'}</span>
                  <span className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.06em' }}>Due</span>
                  <span className="pe-v2-mono" style={{ fontSize: 11, color: 'var(--pev2-ink)' }}>
                    {a.deadline
                      ? new Date(a.deadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                      : '—'}
                  </span>
                </div>
                <div style={{ marginTop: 9 }}>
                  <span className="pe-v2-ev-chip ink">{a.status.replaceAll('_', ' ').toUpperCase()}</span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Bills (quiet) */}
        <div className="pe-v2-card">
          <div className="pe-v2-card-head" style={{ padding: '12px 16px 11px' }}>
            <div className="pe-v2-card-title">Relevant bills</div>
            <div style={{ flex: 1 }} />
            <span className="pe-v2-eyebrow-quiet">{bills.length || ''}</span>
          </div>
          {bills.length === 0 ? (
            <div className="pe-v2-empty" style={{ padding: 16 }}>
              No bill or vehicle carries a position on this line yet.
            </div>
          ) : (
            bills.slice(0, 3).map((b) => (
              <div key={b.id} style={{ padding: '11px 16px', borderBottom: '1px solid var(--pev2-hairline)' }}>
                <button
                  type="button"
                  onClick={() => navigate(`/bills/${b.id}`)}
                  style={{ fontSize: 13, fontWeight: 600, color: 'var(--pev2-ink)', textAlign: 'left', cursor: 'pointer' }}
                >
                  {b.billType.toUpperCase()}. {b.billNumber} — {b.title}
                </button>
                <div className="pe-v2-mono" style={{ fontSize: 11, color: 'var(--pev2-secondary)', marginTop: 3 }}>
                  {b.latestActionDate ?? ''} {b.latestActionText ? `· ${b.latestActionText.slice(0, 80)}` : ''}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
