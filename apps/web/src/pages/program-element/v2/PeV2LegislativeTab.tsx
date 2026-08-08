/**
 * Program Elements v2 — Legislative tab.
 * Relevant bills · Budget actions · Committee language (quote blocks) ·
 * right rail Recommended actions. Budget actions reuse the existing
 * LegislativeActivityPanel-adjacent data (getBudgetActions).
 */
import { Skeleton } from 'antd';
import type { ProgramElementProfileFinalVm } from '../useProgramElementProfileFinal.js';
import { recommendedAction, sgn, toLineRow } from './pe-v2-model.js';
import { EvMark } from './pe-v2-primitives.js';

export function PeV2LegislativeTab({ vm }: { vm: ProgramElementProfileFinalVm }) {
  const {
    detail,
    bills,
    budgetActionsQuery,
    provisionsQuery,
    openActions,
    navigate,
    code,
  } = vm;

  const budgetActions = budgetActionsQuery.data ?? [];
  const provisions = provisionsQuery.data ?? [];
  const row = detail ? toLineRow({ ...detailToListItem(detail) }) : null;

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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0, flex: '1 1 520px' }}>
        {/* Relevant bills */}
        <div className="pe-v2-card">
          <div className="pe-v2-card-head" style={{ padding: '12px 18px 11px' }}>
            <div className="pe-v2-card-title">Relevant bills and vehicles</div>
          </div>
          {bills.length === 0 ? (
            <div className="pe-v2-empty" style={{ padding: 18 }}>
              No bill or vehicle carries a position on this line yet.
            </div>
          ) : (
            bills.map((b) => (
              <div
                key={b.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0,1fr) 150px 240px',
                  columnGap: 14,
                  padding: '11px 18px',
                  borderBottom: '1px solid var(--pev2-hairline)',
                  alignItems: 'center',
                }}
              >
                <button
                  type="button"
                  onClick={() => navigate(`/bills/${b.id}`)}
                  style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--pev2-ink)', textAlign: 'left', cursor: 'pointer' }}
                >
                  {b.billType.toUpperCase()}. {b.billNumber} — {b.title}
                </button>
                <span className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--pev2-body)' }}>
                  {(b.budgetPackage?.track ?? b.policyArea ?? 'BILL').toUpperCase()}
                </span>
                <span style={{ fontSize: 12.5, color: 'var(--pev2-secondary)' }}>
                  {b.latestActionText ? `${b.latestActionText.slice(0, 90)}` : ''}
                  {b.latestActionDate ? ` · ${b.latestActionDate}` : ''}
                </span>
              </div>
            ))
          )}
        </div>

        {/* Budget actions */}
        <div className="pe-v2-card">
          <div className="pe-v2-card-head" style={{ padding: '12px 18px 11px' }}>
            <div className="pe-v2-card-title">Budget actions</div>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '170px 110px 96px minmax(0,1fr)',
              columnGap: 14,
              padding: '9px 18px',
              borderBottom: '1px solid var(--pev2-hairline)',
              background: 'var(--pev2-raised)',
              fontFamily: 'var(--pev2-mono)',
              fontSize: 11,
              letterSpacing: '0.08em',
              color: 'var(--pev2-secondary)',
            }}
          >
            <div>Action</div>
            <div style={{ textAlign: 'right' }}>Amount</div>
            <div>Stage</div>
            <div>Basis</div>
          </div>
          {budgetActionsQuery.isLoading ? (
            <div style={{ padding: 18 }}>
              <Skeleton active paragraph={{ rows: 2 }} title={false} />
            </div>
          ) : budgetActions.length === 0 ? (
            <div className="pe-v2-empty" style={{ padding: 18 }}>
              No committee has increased, decreased, transferred or rescinded funding on this line.
            </div>
          ) : (
            budgetActions.map((a) => (
              <div
                key={a.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '170px 110px 96px minmax(0,1fr)',
                  columnGap: 14,
                  padding: '10px 18px',
                  borderBottom: '1px solid var(--pev2-hairline)',
                  alignItems: 'center',
                }}
              >
                <div>
                  <span
                    className={`pe-v2-cls ${a.action === 'add' ? '' : a.action === 'cut' ? 'official' : ''}`}
                    style={
                      a.action === 'add'
                        ? { border: '1px solid var(--pev2-success)', color: 'var(--pev2-success)' }
                        : undefined
                    }
                  >
                    {a.action === 'add'
                      ? 'PROGRAM INCREASE'
                      : a.action === 'cut'
                        ? 'PROGRAM DECREASE'
                        : a.action.replaceAll('_', ' ').toUpperCase()}
                  </span>
                </div>
                <div
                  className="pe-v2-mono"
                  style={{ textAlign: 'right', fontSize: 12, fontWeight: 600, color: 'var(--pev2-ink)' }}
                >
                  {a.amount != null ? sgn(a.amount) : '—'}
                </div>
                <div className="pe-v2-mono" style={{ fontSize: 11, color: 'var(--pev2-ink)' }}>
                  {a.stage.replaceAll('_', '-').toUpperCase()}
                </div>
                <div style={{ fontSize: 13, color: 'var(--pev2-body)' }}>{a.note ?? ''}</div>
              </div>
            ))
          )}
        </div>

        {/* Committee language */}
        <div className="pe-v2-card">
          <div className="pe-v2-card-head" style={{ padding: '12px 18px 11px' }}>
            <div className="pe-v2-card-title">Committee language</div>
            <div style={{ flex: 1 }} />
            <span className="pe-v2-eyebrow-quiet">
              {provisions.length ? `${provisions.length} PROVISION${provisions.length === 1 ? '' : 'S'}` : ''}
            </span>
          </div>
          {provisionsQuery.isLoading ? (
            <div style={{ padding: 18 }}>
              <Skeleton active paragraph={{ rows: 3 }} title={false} />
            </div>
          ) : provisions.length === 0 ? (
            <div className="pe-v2-empty" style={{ padding: 18 }}>
              No committee report language references this line in the active cycle.
            </div>
          ) : (
            provisions.map((p) => (
              <div key={p.id} style={{ padding: '15px 18px 17px', borderBottom: '1px solid var(--pev2-hairline)' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                  <span className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.08em', color: 'var(--pev2-secondary)' }}>
                    {p.committee.replaceAll('_', '-').toUpperCase()}
                  </span>
                  <span style={{ flex: 1, minWidth: 8 }} />
                  <EvMark
                    state={p.reviewStatus === 'accepted' ? 'VERIFIED' : 'REVIEW REQUIRED'}
                    label={p.reviewStatus === 'accepted' ? '■ VERIFIED' : '⚠ REVIEW REQUIRED'}
                    quiet={p.reviewStatus === 'accepted'}
                  />
                  <span className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--pev2-secondary)' }}>
                    {p.pageStart != null ? `p. ${p.pageStart}` : `FY${p.fy}`}
                  </span>
                </div>
                <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--pev2-ink)', marginTop: 7 }}>{p.heading}</div>
                <div className="pe-v2-quote">
                  <div style={{ fontSize: 13.5, lineHeight: 1.62, color: '#121722' }}>{p.text}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginTop: 10, flexWrap: 'wrap' }}>
                  <span className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--pev2-ink)' }}>
                    FY{p.fy} APPROPRIATION
                  </span>
                  {p.attributionCaveat ? (
                    <span className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--pev2-secondary)' }}>
                      {p.attributionCaveat}
                    </span>
                  ) : null}
                  <span style={{ flex: 1, minWidth: 6 }} />
                  {p.sourceUrl ? (
                    <a
                      href={p.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: 'var(--pev2-ink-2)',
                        cursor: 'pointer',
                        textDecoration: 'underline',
                        textUnderlineOffset: 3,
                      }}
                    >
                      Open source at page
                    </a>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right rail — recommended actions */}
      <div className="pe-v2-card pe-v2-card-inktop" style={{ flex: '1 1 300px', maxWidth: 336 }}>
        <div className="pe-v2-card-head" style={{ padding: '12px 16px 11px' }}>
          <div className="pe-v2-card-title">Recommended actions</div>
        </div>
        {row ? (
          <div style={{ padding: '13px 16px', borderBottom: '1px solid var(--pev2-hairline)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span
                className="pe-v2-mono"
                style={{ fontSize: 11, letterSpacing: '0.06em', border: '1px solid var(--pev2-ink)', color: 'var(--pev2-ink)', padding: '2px 5px' }}
              >
                ● 1
              </span>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--pev2-ink)' }}>
                {recommendedAction(row)}
              </span>
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--pev2-body)', marginTop: 7 }}>
              {row.delta != null && row.delta < 0
                ? `The current position is ${sgn(row.delta)} below the request. Client posture should be set before conference.`
                : row.delta != null && row.delta > 0
                  ? `The current position is ${sgn(row.delta)} above the request. Sustain the increase through enactment.`
                  : 'No divergence in either track. Keep the line on the watch list through enactment.'}
            </div>
            <button
              type="button"
              className="pe-v2-btn pe-v2-btn-sm"
              style={{ marginTop: 9 }}
              onClick={() => navigate(`/actions?peCode=${encodeURIComponent(code)}`)}
            >
              Create action
            </button>
          </div>
        ) : null}
        <div style={{ padding: '13px 16px' }}>
          <div className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--pev2-secondary)', lineHeight: 1.6 }}>
            ACTIONS CREATED HERE OPEN IN THE EXISTING CAPIRO ACTIONS QUEUE WITH THIS LINE ATTACHED.
            {openActions.length ? ` ${openActions.length} OPEN.` : ''}
          </div>
        </div>
      </div>
    </div>
  );
}

function detailToListItem(detail: NonNullable<ProgramElementProfileFinalVm['detail']>) {
  return {
    peCode: detail.peCode,
    title: detail.title,
    service: detail.service,
    budgetActivity: detail.budgetActivity,
    appropriationType: detail.appropriationType,
    status: detail.status,
    lastSyncedAt: detail.lastSyncedAt,
  };
}
