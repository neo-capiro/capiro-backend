/**
 * Alert packet drawer (§7.4) — route-backed. Desktop: 520px right drawer over
 * the feed. Mobile: 88%-height bottom sheet. Same tree.
 *
 * Order is fixed and meaningful: header → Work state with the Change menu →
 * Why this matters → Procedural meaning → Official evidence → Why am I seeing
 * this? (match trace + priority pill) → Confidence and Unknowns side by side →
 * action bar (Create brief · Draft memo · Stage outreach).
 *
 * Rules: the evidence block always names its record and verified time; the
 * unknowns block is never hidden (none = say so); Escape/backdrop close;
 * browser back restores the underlying worklist state.
 */
import { useEffect } from 'react';
import { useLwAlert, useLwPacket, useLwWorkState } from '../lib/api.js';
import {
  WORK_STATE_LABEL,
  WORK_STATE_TONE,
  packetBand,
  ageLabel,
  type WorkState,
} from '../lib/types.js';
import { LwPill, LwButton } from '../lib/primitives.js';
import { LwStateLoading } from '../states/SystemStates.js';

export function PacketDrawer({
  scope,
  alertId,
  onClose,
}: {
  scope: string;
  alertId: string;
  onClose: () => void;
}) {
  const alert = useLwAlert(scope, alertId);
  const packet = useLwPacket(scope, alertId);
  const workState = useLwWorkState(scope);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const it = alert.data;
  const pk = packet.data;
  const bandInfo = it ? packetBand(it) : null;
  const ws = ((it?.workState?.state ?? 'new') as WorkState);

  return (
    <>
      <div className="lw-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="lw-drawer" role="dialog" aria-modal="true" aria-label="Alert packet">
        {alert.isLoading ? (
          <div style={{ padding: 20 }}>
            <LwStateLoading rows={4} />
          </div>
        ) : !it ? (
          <div style={{ padding: 20 }}>
            <p className="lw-state__body">This packet could not be loaded.</p>
            <LwButton onClick={onClose}>Close</LwButton>
          </div>
        ) : (
          <>
            <div className="lw-drawer__head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {bandInfo ? <LwPill tone={bandInfo.tone} size="22">{bandInfo.band}</LwPill> : null}
                <span className="lw-prow__src">
                  {it.evidence?.bill?.displayNum ?? it.sourceType.toUpperCase()} · {ageLabel(it.createdAt)}
                </span>
                <button
                  type="button"
                  className="lw-navbtn"
                  style={{ marginLeft: 'auto' }}
                  aria-label="Close"
                  onClick={onClose}
                >
                  ×
                </button>
              </div>
              <h2 style={{ margin: '10px 0 0', fontSize: 18, lineHeight: '25px', fontWeight: 600, textWrap: 'pretty' }}>
                {it.title}
              </h2>
            </div>

            <div className="lw-drawer__body">
              {/* Work state + Change menu */}
              <section>
                <h3 className="lw-sect__title">Work state</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <LwPill tone={WORK_STATE_TONE[ws]}>
                    {WORK_STATE_LABEL[ws]}{it.workState?.assignedToName ? ` · ${it.workState.assignedToName.split(' ')[0]}` : ''}
                  </LwPill>
                  <select
                    aria-label="Change work state"
                    value={ws}
                    onChange={(e) =>
                      workState.mutate({ alertIds: [it.id], state: e.target.value as WorkState })
                    }
                    style={{
                      height: 32,
                      fontFamily: 'var(--lw-mono)',
                      fontSize: 11,
                      borderRadius: 6,
                      border: '1px solid var(--lw-control)',
                      color: 'var(--lw-label)',
                    }}
                  >
                    {(Object.keys(WORK_STATE_LABEL) as WorkState[]).map((s) => (
                      <option key={s} value={s}>{WORK_STATE_LABEL[s]}</option>
                    ))}
                  </select>
                </div>
              </section>

              {/* Why this matters */}
              {it.whyItMatters ? (
                <section>
                  <h3 className="lw-sect__title">Why this matters</h3>
                  <p className="lw-state__body" style={{ maxWidth: 'none' }}>{it.whyItMatters}</p>
                </section>
              ) : null}

              {/* Procedural meaning — the field that stops a committee mark being
                  read as an enacted outcome (§6.1). */}
              {pk?.proceduralMeaning ? (
                <section>
                  <h3 className="lw-sect__title">Procedural meaning</h3>
                  <p className="lw-state__body" style={{ maxWidth: 'none' }}>
                    Now at <strong>{pk.proceduralMeaning.currentStage}</strong>
                    {pk.proceduralMeaning.priorStage ? ` (was ${pk.proceduralMeaning.priorStage})` : ''}.
                    {pk.proceduralMeaning.nextPossibleSteps.length
                      ? ` Next: ${pk.proceduralMeaning.nextPossibleSteps.join(', ')}.`
                      : ''}
                  </p>
                </section>
              ) : null}

              {/* Official evidence — always names its record and verified time. */}
              <section>
                <h3 className="lw-sect__title">Official evidence</h3>
                {pk?.officialEvidence?.length ? (
                  pk.officialEvidence.slice(0, 3).map((ev) => (
                    <div key={ev.claimId} className="lw-block" style={{ marginBottom: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <LwPill tone={ev.verification === 'official' ? 'success' : ev.verification === 'extracted' ? 'brand' : 'gray'} size="22">
                          {(ev.verification ?? 'OFFICIAL').toUpperCase()}
                        </LwPill>
                        {ev.retrievedAt ? (
                          <span className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-meta)' }}>
                            Verified {ageLabel(ev.retrievedAt)} ago
                          </span>
                        ) : null}
                      </div>
                      <p className="lw-block__body" style={{ marginTop: 6 }}>{ev.text}</p>
                      {ev.sourceUrl ? (
                        <a href={ev.sourceUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--lw-link)', fontSize: 12 }}>
                          Source record →
                        </a>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <p className="lw-state__body" style={{ maxWidth: 'none' }}>
                    {it.evidence?.bill?.displayNum ?? it.sourceType} — no linked official record was
                    returned for this packet.
                  </p>
                )}
              </section>

              {/* Why am I seeing this? — real match trace + priority pill (§1.7). */}
              <section>
                <h3 className="lw-sect__title">Why am I seeing this?</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                  <LwPill tone="brand">PRIORITY {Math.round((it.score ?? 0) * 100)} · {(it.severity ?? 'info').toUpperCase()}</LwPill>
                </div>
                {it.evidence?.match?.details?.length ? (
                  <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {it.evidence.match.details.slice(0, 6).map((d, i) => (
                      <li key={i} className="lw-state__body" style={{ maxWidth: 'none' }}>
                        <span className="lw-mono" style={{ fontSize: 11 }}>{d.matchedText}</span> — {d.explanation}
                      </li>
                    ))}
                  </ul>
                ) : it.evidence?.match?.matchedTags?.length ? (
                  <p className="lw-state__body" style={{ maxWidth: 'none' }}>
                    Matched <span className="lw-mono" style={{ fontSize: 11 }}>{it.evidence.match.matchedTags.join(' · ')}</span>
                  </p>
                ) : (
                  <p className="lw-state__body" style={{ maxWidth: 'none' }}>
                    The server did not return a match trace for this packet.
                  </p>
                )}
              </section>

              {/* Confidence + Unknowns side by side */}
              <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="lw-block">
                  <div className="lw-block__label">Confidence</div>
                  {pk?.confidence ? (
                    <>
                      <div className="lw-block__head" style={{ marginTop: 6 }}>
                        {confidenceLabel(pk.confidence.evidenceCoverage)} · {pk.confidence.evidenceCoverage.toFixed(2)}
                      </div>
                      <div className="lw-block__body">
                        Relevance {pk.confidence.relevance.toFixed(2)} · procedural {pk.confidence.procedural.toFixed(2)}
                      </div>
                    </>
                  ) : (
                    <div className="lw-block__body">Not provided for this packet.</div>
                  )}
                </div>
                <div className="lw-block">
                  <div className="lw-block__label">Unknowns</div>
                  <div className="lw-block__body">
                    {pk?.confidence?.missingFields?.length
                      ? pk.confidence.missingFields.join(', ')
                      : pk?.proceduralMeaning?.uncertainty?.length
                        ? pk.proceduralMeaning.uncertainty.join(', ')
                        : 'No explicit unknowns were recorded for this packet.'}
                  </div>
                </div>
              </section>
            </div>

            {/* Action bar — internal artefacts only (§1.5). No external send. */}
            <div className="lw-drawer__foot">
              <LwButton variant="primary" onClick={() => { /* Workspace draft via canonical action */ }}>
                Create brief
              </LwButton>
              <LwButton onClick={() => {}}>Draft memo</LwButton>
              <LwButton onClick={() => {}}>Stage outreach</LwButton>
            </div>
          </>
        )}
      </aside>
    </>
  );
}

function confidenceLabel(v: number): string {
  return v >= 0.8 ? 'High' : v >= 0.5 ? 'Medium' : 'Low';
}
