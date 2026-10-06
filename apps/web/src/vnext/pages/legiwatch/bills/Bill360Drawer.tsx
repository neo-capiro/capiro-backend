/**
 * Bill 360 (§7.6) — ONE component with two mounts (§4.1 #3): an in-place
 * drawer over the board and the full-page route `/bills/:billId`. The dossier
 * never forks. Header: Export · Open full page · Tracked · Close. Seven tabs,
 * all real: Overview · Path & Votes · Funding · Provisions · Impact · Hearings ·
 * Evidence.
 *
 * Invariants: authorization and appropriations are parallel tracks, never
 * summed (§8.3); unfiled stages read `Not filed`, never `0` (§8.1); passage
 * likelihood is null-safe for terminal bills (§8.5).
 */
import { useRef, useState } from 'react';
import { useDialogFocus } from '../../../components/overlays/index.js';

import { Link, useNavigate } from 'react-router-dom';

import { useBillDossier } from '../../../../pages/bills/bill-360-api.js';
import {
  kpiSubText,
  kpiUnavailable,
  kpiValueText,
  orderedKpis,
} from '../../../../pages/bills/bill-360-kpis.js';
import { fmtAmt, fmtDate, fmtDelta } from '../../../../components/dossier/dossier-format.js';
import { useBillHearings } from '../../../../pages/clients/tracker/bill-hearings-api.js';
import { LwPill, LwButton } from '../lib/primitives.js';
import { LwStateLoading, LwStateUnavailable } from '../states/SystemStates.js';
import { FolderContextPanel } from './FolderContextPanel.js';
import { BillSourceHealth } from '../../../../pages/bills/BillSourceHealth.js';
import { BillSourceRecords } from './BillSourceRecords.js';
import { Bill360ExportVNext } from '../../bills/Bill360ExportVNext.js';
import { BillAgenda } from '../hearings/BillAgenda.js';
import { BillProvisionsTab } from '../../bills/BillProvisionsTab.js';
import { BillImpactTab } from '../../bills/BillImpactTab.js';
import '../../bills/bill-360-vnext.css';

const TABS = [
  'Overview',
  'Path & Votes',
  'Funding',
  'Provisions',
  'Impact',
  'Hearings',
  'Evidence',
] as const;
type DossierTab = (typeof TABS)[number];

/**
 * Research scope from the dossier's canonical identity — never naive
 * `billId.split('-')` segments (`ca-2025-ab1093` sent lowercase `ca`, which the
 * research service rejects; `119-hr-8800` sent `119` as the jurisdiction).
 * Federal resolves US even when `jurisdiction` is missing; a state bill with
 * missing jurisdiction falls back to its canonical DD1 key prefix.
 */
function researchScopeFor(bill: {
  id: string;
  jurisdiction: string | null;
  isState: boolean;
  congress: number | null;
}): { jurisdiction: string; session: string } {
  // DD1 state-bill key: <state>-<session>-<number>; session keeps its full
  // canonical form (2026, or a special session like 2026x2266).
  const key = /^([a-z]{2})-(\d{4}(?:x\d+)?)-[a-z]+\d+[a-z]?$/i.exec(bill.id);
  if (bill.isState) {
    const fromMeta = /^[A-Za-z]{2}$/.test(bill.jurisdiction ?? '')
      ? bill.jurisdiction!.toUpperCase()
      : null;
    return {
      jurisdiction: fromMeta ?? (key ? key[1]!.toUpperCase() : 'FL'),
      session: key?.[2] ?? '',
    };
  }
  return { jurisdiction: 'US', session: bill.congress ? String(bill.congress) : '' };
}

export function Bill360Drawer({
  billId,
  clientId,
  folderId,
  onClose,
  onOpenFull,
}: {
  billId: string;
  clientId: string;
  folderId?: string;
  onClose: () => void;
  onOpenFull: () => void;
}) {
  const dossier = useBillDossier(billId, clientId || null);
  const hearings = useBillHearings(clientId, billId, Boolean(clientId));
  const [tab, setTab] = useState<DossierTab>('Overview');
  const navigate = useNavigate();

  const dialogRef = useRef<HTMLElement | null>(null);
  useDialogFocus(dialogRef, onClose);

  const d = dossier.data;

  return (
    <>
      <div
        className="lw-scrim"
        style={{ background: 'var(--lw-scrim-heavy)' }}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        ref={dialogRef}
        tabIndex={-1}
        className="lw-b360"
        role="dialog"
        aria-modal="true"
        aria-label={`Bill 360 — ${d?.bill?.num ?? billId}`}
      >
        {dossier.isLoading ? (
          <div style={{ padding: 22 }}>
            <LwStateLoading rows={5} />
          </div>
        ) : dossier.isError || !d ? (
          <div style={{ padding: 22 }}>
            <LwStateUnavailable
              source="Bill 360"
              reason="The dossier could not be loaded for this bill."
              onRetry={() => void dossier.refetch()}
            />
            <div style={{ marginTop: 12 }}>
              <LwButton onClick={onClose}>Close</LwButton>
            </div>
          </div>
        ) : (
          <>
            {/* header */}
            <div className="lw-drawer__head lw-b360__head">
              <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                <div className="lw-eyebrow">Bill 360</div>
                <h2
                  style={{
                    margin: '4px 0 0',
                    fontSize: 22,
                    lineHeight: '30px',
                    letterSpacing: '-.01em',
                    fontWeight: 600,
                  }}
                >
                  <span className="lw-mono" style={{ fontSize: 18 }}>
                    {d.bill.num}
                  </span>{' '}
                  — {d.bill.title}
                </h2>
                <div
                  className="lw-mono"
                  style={{ marginTop: 4, fontSize: 11, color: 'var(--lw-meta)' }}
                >
                  {d.bill.statusLabel}
                  {d.bill.statusAt ? ` · ${fmtDate(d.bill.statusAt)}` : ''}
                  {d.latest.date ? ` · Latest action ${fmtDate(d.latest.date)}` : ''}
                  {d.bill.sponsor ? ` · ${d.bill.sponsor}` : ''}
                </div>
                {d.bill.isState && d.bill.sponsorLegislatorId && (
                  <a
                    href={`/directory/state-legislators/${encodeURIComponent(d.bill.sponsorLegislatorId)}`}
                  >
                    Sponsor profile
                  </a>
                )}
              </div>
              <Bill360ExportVNext dossier={d} />
              <LwButton onClick={onOpenFull}>Open full page</LwButton>
              {d.tracking ? <LwPill tone="brand">TRACKED</LwPill> : null}
              <button type="button" className="lw-navbtn" aria-label="Close" onClick={onClose}>
                ×
              </button>
            </div>

            {/* stat strip — label ABOVE value (the app-wide KPI convention), each
                cell found by its semantic id, and an unavailable cell saying why
                rather than reading blank (LW-QA-021). */}
            <div style={{ padding: '14px 20px 0' }}>
              <div className="lw-b360__stats">
                {orderedKpis(d.kpis ?? []).map((k) => {
                  const sub = kpiSubText(k);
                  return (
                    <div key={k.id} className="lw-stat">
                      <div className="lw-stat__label">{k.label}</div>
                      <div
                        className="lw-stat__value"
                        style={kpiUnavailable(k) ? { color: 'var(--lw-meta)' } : undefined}
                      >
                        {kpiValueText(k)}
                      </div>
                      {sub ? <div className="lw-stat__sub">{sub}</div> : null}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* tabs */}
            <div className="lw-tabs" style={{ padding: '0 20px', marginTop: 12 }}>
              {TABS.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  className={`lw-tab${tab === t ? ' is-active' : ''}`}
                  onClick={() => setTab(t)}
                >
                  {t}
                </button>
              ))}
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px' }}>
              {folderId && tab === 'Overview' && (
                <FolderContextPanel folderId={folderId} billId={billId} />
              )}

              {tab === 'Evidence' ? (
                <Link
                  to={
                    '/legiwatch?' +
                    new URLSearchParams({
                      tab: 'research',
                      researchView: 'bills',
                      bill: billId,
                      ...researchScopeFor(d.bill),
                      ...(clientId ? { client: clientId } : {}),
                      ...(folderId ? { folder: folderId } : {}),
                    })
                  }
                >
                  Research and compare exact bill documents
                </Link>
              ) : null}

              {d.bill.isState && (tab === 'Evidence' || tab === 'Path & Votes') && (
                <BillSourceRecords
                  key={`${billId}:${tab}`}
                  billId={billId}
                  initialSection={tab === 'Evidence' ? 'documents' : 'history'}
                />
              )}
              {tab === 'Overview' ? (
                <OverviewTab d={d} />
              ) : tab === 'Path & Votes' ? (
                <PathVotesTab d={d} />
              ) : tab === 'Funding' ? (
                <FundingTab d={d} />
              ) : tab === 'Provisions' ? (
                <><BillProvisionsTab provisions={d.funding.provisions} />
                  {d.bill.isState && <BillSourceRecords billId={billId} initialSection="documents" />}</>
              ) : tab === 'Impact' ? (
                <><BillImpactTab funding={d.funding} onOpenPe={(pe) => navigate(`/program-elements/${encodeURIComponent(pe)}`)} />
                  {d.bill.isState && <BillSourceRecords billId={billId} initialSection="documents" />}</>
              ) : tab === 'Hearings' ? (
                <>
                  <BillAgenda billId={billId} clientId={clientId} folderId={folderId} />
                  <HearingsTabView hearings={hearings.data} loading={hearings.isLoading} />
                </>
              ) : (
                <EvidenceTab d={d} />
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}

function OverviewTab({ d }: { d: NonNullable<ReturnType<typeof useBillDossier>['data']> }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {d.overview.whatChanged ? (
        <section>
          <h3 className="lw-sect__title">What changed</h3>
          <p className="lw-state__body" style={{ maxWidth: 'none' }}>
            {d.overview.whatChanged.text}
          </p>
        </section>
      ) : null}
      {d.overview.whyItMatters ? (
        <section>
          <h3 className="lw-sect__title">Why it matters</h3>
          <p className="lw-state__body" style={{ maxWidth: 'none' }}>
            {d.overview.whyItMatters.text}
          </p>
        </section>
      ) : null}
      {d.overview.officialNextStep ? (
        <section>
          <h3 className="lw-sect__title">Procedural posture</h3>
          <p className="lw-state__body" style={{ maxWidth: 'none' }}>
            {d.overview.officialNextStep.text}
          </p>
        </section>
      ) : null}
      {d.relatedVehicles?.length ? (
        <section>
          <h3 className="lw-sect__title">Related vehicles</h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {d.relatedVehicles.map((v) => (
              <LwPill key={v.billId} tone="gray" size="22">
                {v.num}
                {v.role ? ` · ${v.role}` : ''}
              </LwPill>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function PathVotesTab({ d }: { d: NonNullable<ReturnType<typeof useBillDossier>['data']> }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <section>
        <h3 className="lw-sect__title">Procedural timeline</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {(d.milestones ?? []).map((m, i) => (
            <div
              key={m.sourceIds?.join(':') ?? i}
              style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  marginTop: 5,
                  flex: '0 0 auto',
                  background:
                    m.state === 'done'
                      ? 'var(--lw-succ-dot)'
                      : m.state === 'current'
                        ? 'var(--lw-brand-dot)'
                        : m.state === 'failed'
                          ? 'var(--lw-error-dot)'
                          : 'var(--lw-control)',
                  boxShadow:
                    m.state === 'current'
                      ? '0 0 0 3px #EDF3F7'
                      : m.state === 'done'
                        ? '0 0 0 3px #FAF9F6'
                        : 'none',
                }}
              />
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{m.label}</span>
                  {m.outcome ? (
                    <LwPill
                      tone={
                        m.outcomeSev === 'critical'
                          ? 'error'
                          : m.outcomeSev === 'success'
                            ? 'success'
                            : 'gray'
                      }
                      size="22"
                    >
                      {m.outcome}
                    </LwPill>
                  ) : m.state === 'failed' ? (
                    <LwPill tone="error" size="22">
                      Failed
                    </LwPill>
                  ) : null}
                </div>
                {m.detail ? (
                  <div style={{ fontSize: 12, color: 'var(--lw-meta)' }}>{m.detail}</div>
                ) : null}
                {(m.sourceCount ?? 0) > 1 ? (
                  <div style={{ fontSize: 11, color: 'var(--lw-meta)' }}>
                    {m.sourceCount} official source records
                  </div>
                ) : null}
                {m.date ? (
                  <div className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-meta)' }}>
                    {fmtDate(m.date)}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h3 className="lw-sect__title">Votes</h3>
        {(d.votes ?? []).length === 0 ? (
          <p className="lw-state__body">{d.noVote ?? 'No votes scheduled.'}</p>
        ) : (
          (d.votes ?? []).map((v) => (
            <div key={v.id} className="lw-block" style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{v.label}</span>
                <LwPill
                  tone={
                    v.resultSev === 'success'
                      ? 'success'
                      : v.resultSev === 'critical'
                        ? 'error'
                        : 'gray'
                  }
                  size="22"
                >
                  {v.result ?? 'PENDING'}
                </LwPill>
              </div>
              <div
                className="lw-mono"
                style={{ marginTop: 4, fontSize: 11, color: 'var(--lw-meta)' }}
              >
                {v.tally}
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}

function FundingTab({ d }: { d: NonNullable<ReturnType<typeof useBillDossier>['data']> }) {
  const funding = d.funding;
  const primary = funding.positions.find((position) => position.primary) ?? null;
  const pending = funding.analysisStatus === 'analysis_pending';
  const vehicle = funding.vehicle ?? null;
  const impacts = funding.programElementImpacts;
  const hasEvidence = funding.positions.length > 0 || impacts.length > 0;
  const firstImpact = impacts[0];
  const track = firstImpact?.vehicleTrack ?? vehicle?.track ?? null;
  const houseLabel =
    firstImpact?.houseLabel ??
    (track === 'authorization'
      ? 'House authorization (HASC)'
      : track === 'appropriation'
        ? 'House appropriation (HAC-D)'
        : 'House amount (track not verified)');
  const senateLabel =
    firstImpact?.senateLabel ??
    (track === 'authorization'
      ? 'Senate authorization (SASC)'
      : track === 'appropriation'
        ? 'Senate appropriation (SAC-D)'
        : 'Senate amount (track not verified)');
  const conferenceLabel =
    firstImpact?.conferenceLabel ??
    (track === 'authorization'
      ? 'NDAA conference authorization'
      : track === 'appropriation'
        ? 'Appropriations conference'
        : 'Conference amount (track not verified)');
  const showConference = impacts.some((impact) => impact.conferenceMillions != null);
  const showEnacted = impacts.some((impact) => impact.enactedMillions != null);

  return (
    <section>
      <h3 className="lw-sect__title">
        {vehicle ? drawerFundingLabel(vehicle.stage, vehicle.track) : 'Funding analysis'}
      </h3>

      {pending ? (
        <div className="lw-state__body" style={{ marginBottom: 16 }}>
          <LwPill tone="warning" size="22">
            ANALYSIS PENDING
          </LwPill>
          <p style={{ margin: '8px 0 4px' }}>
            {funding.status ?? 'Funding tables are available; amounts await verification.'}
          </p>
          {vehicle ? (
            <p style={{ margin: 0 }}>
              {'FY' + vehicle.fiscalYear + ' · ' + drawerAmountTreatment(vehicle.amountTreatment)}
              {vehicle.sourceDocumentTitle || vehicle.sourceDocumentKey
                ? ' · Source: ' +
                  [
                    vehicle.sourceDocumentTitle ?? vehicle.label,
                    vehicle.sourceDocumentKey,
                    vehicle.sourceDocumentVersion
                      ? 'version ' + vehicle.sourceDocumentVersion.slice(0, 12)
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : ''}
            </p>
          ) : null}
        </div>
      ) : primary ? (
        <div className="lw-state__body" style={{ marginBottom: 16 }}>
          <strong>{fmtAmt(primary.amountMillions)}</strong>
          <span>
            {' · FY' +
              (primary.fiscalYear ?? vehicle?.fiscalYear ?? '—') +
              ' · ' +
              drawerAmountTreatment(primary.amountTreatment) +
              ' · ' +
              primary.verification}
          </span>
        </div>
      ) : null}

      {funding.guardrail ? (
        <p className="lw-state__body" style={{ marginBottom: 16 }}>
          <strong>Verification guardrail:</strong> {funding.guardrail}
        </p>
      ) : null}

      {funding.overrideReconciliation === 'reconciled' ? (
        <p className="lw-state__body" style={{ marginBottom: 16 }}>
          <strong>Override reconciliation:</strong> Verified against the bill&apos;s
          amount-changing provisions.
        </p>
      ) : null}

      {!hasEvidence ? (
        <p className="lw-state__body">
          {funding.status ??
            'No reviewed funding positions or linked funding tables are available for this vehicle.'}
        </p>
      ) : impacts.length ? (
        <div className="capiro-scroll-x lw-tablewrap">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left' }}>
                {[
                  'Program element',
                  'FY request',
                  houseLabel,
                  senateLabel,
                  ...(showConference ? [conferenceLabel] : []),
                  ...(showEnacted ? ['Enacted appropriation'] : []),
                  'Change vs. request',
                ].map((h) => (
                  <th
                    key={h}
                    style={{
                      padding: '10px 12px',
                      fontFamily: 'var(--lw-mono)',
                      fontSize: 11,
                      letterSpacing: '.06em',
                      textTransform: 'uppercase',
                      color: 'var(--lw-meta)',
                      borderBottom: '1px solid var(--lw-line)',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {impacts.map((impact) => (
                <tr key={impact.pe} style={{ borderBottom: '1px solid var(--lw-hover)' }}>
                  <td style={{ padding: '10px 12px', fontSize: 13 }}>
                    <span className="lw-mono">{impact.pe}</span>
                    {impact.name ? <span> · {impact.name}</span> : null}
                    <small style={{ display: 'block' }}>{impact.basis === 'explicit' ? 'Linked by published Program Element code' : 'Inferred program match'}</small>
                    {impact.source ? <details><summary>Match evidence</summary><p>{impact.source.replaceAll('_', ' ').replace(/confidence ([01](?:\.\d+)?)/g, (_, score) => `Match confidence ${Math.round(Number(score) * 100)}%`)}</p></details> : null}
                  </td>
                  <td style={{ padding: '10px 12px', fontFamily: 'var(--lw-mono)', fontSize: 12 }}>
                    {fmtAmt(impact.requestMillions)}
                  </td>
                  <td style={{ padding: '10px 12px', fontFamily: 'var(--lw-mono)', fontSize: 12 }}>
                    {fmtAmt(impact.houseMillions)}
                  </td>
                  <td style={{ padding: '10px 12px', fontFamily: 'var(--lw-mono)', fontSize: 12 }}>
                    {fmtAmt(impact.senateMillions)}
                  </td>
                  {showConference ? (
                    <td style={{ padding: '10px 12px', fontFamily: 'var(--lw-mono)', fontSize: 12 }}>
                      {fmtAmt(impact.conferenceMillions ?? null)}
                    </td>
                  ) : null}
                  {showEnacted ? (
                    <td style={{ padding: '10px 12px', fontFamily: 'var(--lw-mono)', fontSize: 12 }}>
                      {fmtAmt(impact.enactedMillions ?? null)}
                    </td>
                  ) : null}
                  <td style={{ padding: '10px 12px', fontFamily: 'var(--lw-mono)', fontSize: 12 }}>
                    {fmtDelta(impact.deltaVsRequestMillions)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function drawerFundingLabel(stage: string, track: string): string {
  const stageLabel =
    stage === 'house'
      ? 'House'
      : stage === 'senate'
        ? 'Senate'
        : stage === 'conference'
          ? 'Conference'
          : stage === 'enacted'
            ? 'Enacted'
            : stage === 'president'
              ? "President's"
              : stage;
  const trackLabel =
    track === 'authorization'
      ? 'authorization'
      : track === 'appropriation'
        ? 'appropriation'
        : track.replaceAll('_', ' ');
  return stageLabel + ' ' + trackLabel;
}

function drawerAmountTreatment(treatment: string | null | undefined): string {
  if (treatment === 'proposed_authorization') {
    return 'Proposed authorization level — not appropriated funding';
  }
  if (treatment === 'appropriated_funding') return 'Appropriated funding';
  if (treatment === 'request') return 'Executive budget request';
  return 'Funding treatment not verified';
}

function HearingsTabView({
  hearings,
  loading,
}: {
  hearings:
    | {
        hearings?: Array<{
          sessionId: string;
          hearingId: string | null;
          title: string | null;
          occurredAt: string | null;
        }>;
      }
    | undefined;
  loading: boolean;
}) {
  const navigate = useNavigate();
  if (loading) return <LwStateLoading rows={2} />;
  const list = hearings?.hearings ?? [];
  if (!list.length) {
    return (
      <p className="lw-state__body">
        No linked saved-session references are available in this view.
      </p>
    );
  }
  return (
    <section>
      <h3 className="lw-sect__title">Saved sessions referencing this bill</h3>
      {list.map((h) => {
        const row = (
          <div>
            <div className="lw-hrow__title">{h.title ?? 'Hearing'}</div>
            <div className="lw-hrow__sub lw-mono">{h.occurredAt ?? ''}</div>
          </div>
        );
        return h.hearingId ? (
          <button
            key={h.sessionId}
            type="button"
            className="lw-hrow"
            style={{ marginBottom: 8, textAlign: 'left', width: '100%', cursor: 'pointer' }}
            onClick={() => navigate(`/legiwatch/hearings/${encodeURIComponent(h.hearingId!)}`)}
          >
            {row}
          </button>
        ) : (
          <div key={h.sessionId} className="lw-hrow" style={{ marginBottom: 8 }}>
            {row}
          </div>
        );
      })}
    </section>
  );
}

function EvidenceTab({ d }: { d: NonNullable<ReturnType<typeof useBillDossier>['data']> }) {
  const prov = d.provenance as
    | { sources?: Array<{ label?: string; origin?: string; asOf?: string | null; class?: string }> }
    | undefined;
  const sources = prov?.sources ?? [];
  return (
    <section>
      <h3 className="lw-sect__title">Evidence</h3>
      <BillSourceHealth provenance={d.provenance} />
      {sources.length === 0 ? (
        <p className="lw-state__body">No source records were returned for this bill.</p>
      ) : (
        sources.map((s, i) => (
          <div key={i} className="lw-block" style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <LwPill
                tone={
                  s.class === 'official' ? 'success' : s.class === 'verified' ? 'brand' : 'gray'
                }
                size="22"
              >
                {(s.class ?? s.origin ?? 'SOURCE').toUpperCase()}
              </LwPill>
              {s.asOf ? (
                <span className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-meta)' }}>
                  {fmtDate(s.asOf)}
                </span>
              ) : null}
            </div>
            <div className="lw-block__body" style={{ marginTop: 6 }}>
              {s.label ?? s.origin ?? 'Source record'}
            </div>
          </div>
        ))
      )}
    </section>
  );
}
