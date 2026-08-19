/**
 * Program Elements vNext profile — Legislative tab.
 * Native port of PeV2LegislativeTab: relevant bills · budget actions ·
 * committee language (quote blocks) · right rail recommended actions.
 * Same data (getBudgetActions / provisions / bills) and copy; vNext tokens.
 */
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroSkeleton } from '../../../components/feedback/index.js';
import type { ProgramElementProfileFinalVm } from '../../../../pages/program-element/useProgramElementProfileFinalCore.js';
import { recommendedAction, sgn, toLineRow } from '../../../../pages/program-element/v2/pe-v2-model.js';
import { EvMark, PfCard } from './pe-profile-primitives.js';

export function PeProfileLegislativeTab({ vm }: { vm: ProgramElementProfileFinalVm }) {
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
        <PfCard title="Relevant bills and vehicles" headPadding="12px 18px 11px">
          {bills.length === 0 ? (
            <div className="pe-pf-empty" style={{ padding: 18 }}>
              No bill or vehicle carries a position on this line yet.
            </div>
          ) : (
            <div className="pe-pf-scroll-x">
              {bills.map((b) => (
                <div
                  key={b.id}
                  className="pe-pf-listrow"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0,1fr) 150px 240px',
                    columnGap: 14,
                    padding: '11px 18px',
                    alignItems: 'center',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => navigate(`/bills/${b.id}`)}
                    style={{
                      fontSize: 13.5,
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
                  <span className="pe-pf-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--pepf-body)' }}>
                    {(b.budgetPackage?.track ?? b.policyArea ?? 'BILL').toUpperCase()}
                  </span>
                  <span style={{ fontSize: 12.5, color: 'var(--pepf-secondary)' }}>
                    {b.latestActionText ? `${b.latestActionText.slice(0, 90)}` : ''}
                    {b.latestActionDate ? ` · ${b.latestActionDate}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </PfCard>

        {/* Budget actions */}
        <PfCard title="Budget actions" headPadding="12px 18px 11px">
          <div className="pe-pf-scroll-x">
            <div style={{ minWidth: 560 }}>
              <div
                className="pe-pf-gridhead"
                style={{
                  display: 'grid',
                  gridTemplateColumns: '170px 110px 96px minmax(0,1fr)',
                  columnGap: 14,
                  padding: '9px 18px',
                }}
              >
                <div>Action</div>
                <div style={{ textAlign: 'right' }}>Amount</div>
                <div>Stage</div>
                <div>Basis</div>
              </div>
              {budgetActionsQuery.isLoading ? (
                <div style={{ padding: 18, display: 'grid', gap: 10 }}>
                  <CapiroSkeleton height={14} />
                  <CapiroSkeleton height={14} width="68%" />
                </div>
              ) : budgetActions.length === 0 ? (
                <div className="pe-pf-empty" style={{ padding: 18 }}>
                  No committee has increased, decreased, transferred or rescinded funding on this line.
                </div>
              ) : (
                budgetActions.map((a) => (
                  <div
                    key={a.id}
                    className="pe-pf-listrow"
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '170px 110px 96px minmax(0,1fr)',
                      columnGap: 14,
                      padding: '10px 18px',
                      alignItems: 'center',
                    }}
                  >
                    <div>
                      <span
                        className={`pe-pf-cls ${a.action === 'add' ? 'add' : a.action === 'cut' ? 'official' : ''}`}
                      >
                        {a.action === 'add'
                          ? 'PROGRAM INCREASE'
                          : a.action === 'cut'
                            ? 'PROGRAM DECREASE'
                            : a.action.replaceAll('_', ' ').toUpperCase()}
                      </span>
                    </div>
                    <div
                      className="pe-pf-mono"
                      style={{ textAlign: 'right', fontSize: 12, fontWeight: 600, color: 'var(--pepf-ink)' }}
                    >
                      {a.amount != null ? sgn(a.amount) : '—'}
                    </div>
                    <div className="pe-pf-mono" style={{ fontSize: 11, color: 'var(--pepf-ink)' }}>
                      {a.stage.replaceAll('_', '-').toUpperCase()}
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--pepf-body)' }}>{a.note ?? ''}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </PfCard>

        {/* Committee language */}
        <PfCard
          title="Committee language"
          headPadding="12px 18px 11px"
          right={
            <span className="pe-pf-eyebrow-quiet">
              {provisions.length ? `${provisions.length} PROVISION${provisions.length === 1 ? '' : 'S'}` : ''}
            </span>
          }
        >
          {provisionsQuery.isLoading ? (
            <div style={{ padding: 18, display: 'grid', gap: 10 }}>
              <CapiroSkeleton height={14} />
              <CapiroSkeleton height={14} />
              <CapiroSkeleton height={14} width="60%" />
            </div>
          ) : provisions.length === 0 ? (
            <div className="pe-pf-empty" style={{ padding: 18 }}>
              No committee report language references this line in the active cycle.
            </div>
          ) : (
            provisions.map((p) => (
              <div key={p.id} className="pe-pf-listrow" style={{ padding: '15px 18px 17px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                  <span className="pe-pf-mono" style={{ fontSize: 11, letterSpacing: '0.08em', color: 'var(--pepf-secondary)' }}>
                    {p.committee.replaceAll('_', '-').toUpperCase()}
                  </span>
                  <span style={{ flex: 1, minWidth: 8 }} />
                  <EvMark
                    state={p.reviewStatus === 'accepted' ? 'VERIFIED' : 'REVIEW REQUIRED'}
                    label={p.reviewStatus === 'accepted' ? '■ VERIFIED' : '⚠ REVIEW REQUIRED'}
                    quiet={p.reviewStatus === 'accepted'}
                  />
                  <span className="pe-pf-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--pepf-secondary)' }}>
                    {p.pageStart != null ? `p. ${p.pageStart}` : `FY${p.fy}`}
                  </span>
                </div>
                <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--pepf-ink)', marginTop: 7 }}>{p.heading}</div>
                <div className="pe-pf-quote">
                  <div style={{ fontSize: 13.5, lineHeight: 1.62, color: 'var(--pepf-heading)' }}>{p.text}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginTop: 10, flexWrap: 'wrap' }}>
                  <span className="pe-pf-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--pepf-ink)' }}>
                    FY{p.fy} APPROPRIATION
                  </span>
                  {p.attributionCaveat ? (
                    <span className="pe-pf-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--pepf-secondary)' }}>
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
                        color: 'var(--pepf-heading)',
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
        </PfCard>
      </div>

      {/* Right rail — recommended actions */}
      <div className="pe-pf-card pe-pf-card-inktop" style={{ flex: '1 1 300px', maxWidth: 336 }}>
        <div className="pe-pf-card-head" style={{ padding: '12px 16px 11px' }}>
          <div className="pe-pf-card-title">Recommended actions</div>
        </div>
        {row ? (
          <div className="pe-pf-listrow" style={{ padding: '13px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span
                className="pe-pf-mono"
                style={{
                  fontSize: 11,
                  letterSpacing: '0.06em',
                  border: '1px solid var(--pepf-dark)',
                  color: 'var(--pepf-ink)',
                  padding: '2px 5px',
                  borderRadius: 6,
                }}
              >
                ● 1
              </span>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--pepf-ink)' }}>
                {recommendedAction(row)}
              </span>
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--pepf-body)', marginTop: 7 }}>
              {row.delta != null && row.delta < 0
                ? `The current position is ${sgn(row.delta)} below the request. Client posture should be set before conference.`
                : row.delta != null && row.delta > 0
                  ? `The current position is ${sgn(row.delta)} above the request. Sustain the increase through enactment.`
                  : 'No divergence in either track. Keep the line on the watch list through enactment.'}
            </div>
            <CapiroButton
              size="compact"
              style={{ marginTop: 9 }}
              onClick={() => navigate(`/actions?peCode=${encodeURIComponent(code)}`)}
            >
              Create action
            </CapiroButton>
          </div>
        ) : null}
        <div style={{ padding: '13px 16px' }}>
          <div className="pe-pf-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--pepf-secondary)', lineHeight: 1.6 }}>
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
