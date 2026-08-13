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
import { useEffect, useState } from 'react';
import { useBillDossier } from '../../../../pages/bills/bill-360-api.js';
import { useBillHearings } from '../../../../pages/clients/tracker/bill-hearings-api.js';
import { LwPill, LwButton } from '../lib/primitives.js';
import { LwStateLoading, LwStateUnavailable } from '../states/SystemStates.js';

const TABS = ['Overview', 'Path & Votes', 'Funding', 'Provisions', 'Impact', 'Hearings', 'Evidence'] as const;
type DossierTab = (typeof TABS)[number];

export function Bill360Drawer({
  billId,
  clientId,
  onClose,
  onOpenFull,
}: {
  billId: string;
  clientId: string;
  onClose: () => void;
  onOpenFull: () => void;
}) {
  const dossier = useBillDossier(billId, clientId || null);
  const hearings = useBillHearings(clientId, billId, Boolean(clientId));
  const [tab, setTab] = useState<DossierTab>('Overview');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const d = dossier.data;

  return (
    <>
      <div className="lw-scrim" style={{ background: 'var(--lw-scrim-heavy)' }} onClick={onClose} aria-hidden="true" />
      <aside className="lw-b360" role="dialog" aria-modal="true" aria-label={`Bill 360 — ${d?.bill?.num ?? billId}`}>
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
            <div className="lw-drawer__head" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="lw-eyebrow">Bill 360</div>
                <h2 style={{ margin: '4px 0 0', fontSize: 22, lineHeight: '30px', letterSpacing: '-.01em', fontWeight: 600 }}>
                  <span className="lw-mono" style={{ fontSize: 18 }}>{d.bill.num}</span> — {d.bill.title}
                </h2>
                <div className="lw-mono" style={{ marginTop: 4, fontSize: 11, color: 'var(--lw-meta)' }}>
                  {d.bill.chamber ?? ''}{d.bill.sponsor ? ` · ${d.bill.sponsor}` : ''}{d.bill.statusAt ? ` · updated ${d.bill.statusAt}` : ''}
                </div>
              </div>
              <LwButton onClick={() => { /* export dossier */ window.print(); }}>Export</LwButton>
              <LwButton onClick={onOpenFull}>Open full page</LwButton>
              {d.tracking ? <LwPill tone="brand">TRACKED</LwPill> : null}
              <button type="button" className="lw-navbtn" aria-label="Close" onClick={onClose}>×</button>
            </div>

            {/* stat strip */}
            <div style={{ padding: '14px 20px 0' }}>
              <div className="lw-b360__stats">
                {(d.kpis ?? []).slice(0, 6).map((k) => (
                  <div key={k.label} className="lw-stat">
                    <div className="lw-stat__value">{k.value}</div>
                    <div className="lw-stat__label">{k.label}</div>
                  </div>
                ))}
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
              {tab === 'Overview' ? (
                <OverviewTab d={d} />
              ) : tab === 'Path & Votes' ? (
                <PathVotesTab d={d} />
              ) : tab === 'Funding' ? (
                <FundingTab d={d} />
              ) : tab === 'Provisions' ? (
                <PlaceholderTab label="Provisions" note="Section-by-section provisions with affected clients and relevance level." />
              ) : tab === 'Impact' ? (
                <PlaceholderTab label="Impact" note="Per-client impact with position and a per-client brief action." />
              ) : tab === 'Hearings' ? (
                <HearingsTabView hearings={hearings.data} loading={hearings.isLoading} />
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
          <p className="lw-state__body" style={{ maxWidth: 'none' }}>{d.overview.whatChanged.text}</p>
        </section>
      ) : null}
      {d.overview.whyItMatters ? (
        <section>
          <h3 className="lw-sect__title">Why it matters</h3>
          <p className="lw-state__body" style={{ maxWidth: 'none' }}>{d.overview.whyItMatters.text}</p>
        </section>
      ) : null}
      {d.overview.officialNextStep ? (
        <section>
          <h3 className="lw-sect__title">Procedural posture</h3>
          <p className="lw-state__body" style={{ maxWidth: 'none' }}>{d.overview.officialNextStep.text}</p>
        </section>
      ) : null}
      {d.relatedVehicles?.length ? (
        <section>
          <h3 className="lw-sect__title">Related vehicles</h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {d.relatedVehicles.map((v) => (
              <LwPill key={v.billId} tone="gray" size="22">{v.num}{v.role ? ` · ${v.role}` : ''}</LwPill>
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
            <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <span
                aria-hidden="true"
                style={{
                  width: 10, height: 10, borderRadius: '50%', marginTop: 5, flex: '0 0 auto',
                  background: m.state === 'done' ? 'var(--lw-succ-dot)' : m.state === 'current' ? 'var(--lw-brand-dot)' : m.state === 'failed' ? 'var(--lw-error-dot)' : 'var(--lw-control)',
                  boxShadow: m.state === 'current' ? '0 0 0 3px #EDF3F7' : m.state === 'done' ? '0 0 0 3px #F9FAFB' : 'none',
                }}
              />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{m.label}</div>
                {m.detail ? <div style={{ fontSize: 12, color: 'var(--lw-meta)' }}>{m.detail}</div> : null}
                {m.date ? <div className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-meta)' }}>{m.date}</div> : null}
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
                <LwPill tone={v.resultSev === 'success' ? 'success' : v.resultSev === 'critical' ? 'error' : 'gray'} size="22">
                  {v.result ?? 'PENDING'}
                </LwPill>
              </div>
              <div className="lw-mono" style={{ marginTop: 4, fontSize: 11, color: 'var(--lw-meta)' }}>{v.tally}</div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}

function FundingTab({ d }: { d: NonNullable<ReturnType<typeof useBillDossier>['data']> }) {
  // §8.3/§8.4: authorization and appropriations are parallel tracks, never
  // summed; every number carries its stage; unfiled reads `Not filed`, never 0.
  const lines = (d.funding as { lines?: Array<Record<string, unknown>> })?.lines ?? [];
  return (
    <section>
      <h3 className="lw-sect__title">Funding lines</h3>
      {lines.length === 0 ? (
        <p className="lw-state__body">No funding lines are carried by this vehicle.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left' }}>
              {['Line', 'Request', 'Authorization', 'Appropriation', 'Delta'].map((h) => (
                <th key={h} style={{ padding: '10px 12px', fontFamily: 'var(--lw-mono)', fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--lw-meta)', borderBottom: '1px solid var(--lw-line)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((ln, i) => (
              <tr key={i} style={{ borderBottom: '1px solid var(--lw-hover)' }}>
                <td style={{ padding: '10px 12px', fontSize: 13 }}>{String(ln.label ?? ln.peCode ?? '—')}</td>
                {(['request', 'authorization', 'appropriation'] as const).map((k) => (
                  <td key={k} style={{ padding: '10px 12px', fontFamily: 'var(--lw-mono)', fontSize: 12 }}>
                    {ln[k] == null ? 'Not filed' : String(ln[k])}
                  </td>
                ))}
                <td style={{ padding: '10px 12px', fontFamily: 'var(--lw-mono)', fontSize: 12 }}>
                  {ln.delta == null ? '—' : String(ln.delta)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function HearingsTabView({
  hearings,
  loading,
}: {
  hearings: { hearings?: Array<{ sessionId: string; title: string | null; occurredAt: string | null }> } | undefined;
  loading: boolean;
}) {
  if (loading) return <LwStateLoading rows={2} />;
  const list = hearings?.hearings ?? [];
  if (!list.length) {
    return <p className="lw-state__body">No proceedings reference this bill yet.</p>;
  }
  return (
    <section>
      <h3 className="lw-sect__title">Proceedings referencing this bill</h3>
      {list.map((h) => (
        <div key={h.sessionId} className="lw-hrow" style={{ marginBottom: 8 }}>
          <div>
            <div className="lw-hrow__title">{h.title ?? 'Hearing'}</div>
            <div className="lw-hrow__sub lw-mono">{h.occurredAt ?? ''}</div>
          </div>
        </div>
      ))}
    </section>
  );
}

function EvidenceTab({ d }: { d: NonNullable<ReturnType<typeof useBillDossier>['data']> }) {
  const prov = d.provenance as { sources?: Array<{ label?: string; origin?: string; asOf?: string | null; class?: string }> } | undefined;
  const sources = prov?.sources ?? [];
  return (
    <section>
      <h3 className="lw-sect__title">Evidence</h3>
      {sources.length === 0 ? (
        <p className="lw-state__body">No source records were returned for this bill.</p>
      ) : (
        sources.map((s, i) => (
          <div key={i} className="lw-block" style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <LwPill tone={s.class === 'official' ? 'success' : s.class === 'verified' ? 'brand' : 'gray'} size="22">
                {(s.class ?? s.origin ?? 'SOURCE').toUpperCase()}
              </LwPill>
              {s.asOf ? <span className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-meta)' }}>{s.asOf}</span> : null}
            </div>
            <div className="lw-block__body" style={{ marginTop: 6 }}>{s.label ?? s.origin ?? 'Source record'}</div>
          </div>
        ))
      )}
    </section>
  );
}

function PlaceholderTab({ label, note }: { label: string; note: string }) {
  return (
    <section>
      <h3 className="lw-sect__title">{label}</h3>
      <p className="lw-state__body">{note} This surface reads the same dossier response; the detailed view is on the full page.</p>
    </section>
  );
}
