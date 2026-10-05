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
import { lazy, Suspense, useEffect, useState } from 'react';
import { useLwAlert, useLwPacket, useLwWorkState, useLwAssignSelf } from '../lib/api.js';
import {
  WORK_STATE_LABEL,
  WORK_STATE_TONE,
  packetBand,
  ageLabel,
  type WorkState,
} from '../lib/types.js';
import { LwPill, LwButton } from '../lib/primitives.js';
import { LwStateLoading } from '../states/SystemStates.js';
import { feedHearingDetailHref } from '../lib/feed-hearing-link.js';

const MemoComposerDrawer = lazy(async () => ({
  default: (await import('./MemoComposerDrawerVNext.js')).MemoComposerDrawer,
}));

interface PacketDrawerProps {
  scope: string;
  alertId: string;
  onClose: () => void;
}

export function PacketDrawer(props: PacketDrawerProps) {
  return <PacketDrawerContent key={`${props.scope}:${props.alertId}`} {...props} />;
}

function PacketDrawerContent({
  scope,
  alertId,
  onClose,
}: PacketDrawerProps) {
  const alert = useLwAlert(scope, alertId);
  const workState = useLwWorkState(scope);
  const self = useLwAssignSelf();
  const it = alert.data ?? null;
  // Packet route is per OWNING client — there is no `_all` route. Under All
  // clients the owner is the alert's own clientId, resolved after the alert
  // read; under a client lens only when the scope IS the owner, so a foreign
  // client's packet is never requested or leaked through a lens URL.
  const ownerClientId = it
    ? scope && it.clientId !== scope
      ? null
      : it.clientId || null
    : null;
  const packet = useLwPacket(ownerClientId, alertId);
  // Honest reason when no packet can be shown: owner not resolvable, foreign
  // lens, or the request failed — never rendered as absence of evidence.
  const packetBlocked = Boolean(it) && !ownerClientId;
  const packetUnavailableReason =
    packet.errorKind === 'request_failed'
      ? 'Official evidence could not be loaded.'
      : packetBlocked && scope
        ? 'Official evidence could not be loaded — this alert belongs to a different client than the selected view.'
        : packetBlocked
          ? 'Official evidence could not be loaded.'
          : null;
  /** Result of the last Change-menu action — the drawer's only feedback path. */
  const [notice, setNotice] = useState<string | null>(null);
  const [memoOpen, setMemoOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pk = packet.data;
  const bandInfo = it ? packetBand(it) : null;
  const ws = ((it?.workState?.state ?? 'new') as WorkState);
  const memoClientId = it?.clientId || (scope !== '_all' ? scope : '');
  const hearingHref = it ? feedHearingDetailHref(it) : null;

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
                  {/* Defense-in-depth (certification pass): `it` is the API response
                      shape at runtime, not compile-time-checked — a boundary that
                      ever answers with something other than a bare FeedItem (this
                      crashed in production on a mis-shaped response) must degrade
                      to a label, never throw calling .toUpperCase() on undefined. */}
                  {it.evidence?.bill?.displayNum ?? (it.sourceType || 'ALERT').toUpperCase()} · {ageLabel(it.createdAt)}
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
                    // LW-QA-019: this call had no callbacks at all — the drawer
                    // was silent on both success AND failure.
                    disabled={workState.isPending}
                    aria-busy={workState.isPending}
                    onChange={(e) => {
                      const next = e.target.value as WorkState;
                      setNotice(null);
                      // LW-QA-021: 'assigned' without the actor's id 400s at
                      // the real API. Block honestly instead.
                      if (next === 'assigned' && !self.userId) {
                        setNotice('Assignee could not be resolved — state not changed');
                        return;
                      }
                      workState.mutate(
                        {
                          alertIds: [it.id],
                          state: next,
                          ...(next === 'assigned' ? { assignedTo: self.userId } : {}),
                        },
                        {
                          onSuccess: () =>
                            setNotice(`Marked ${WORK_STATE_LABEL[next].toLowerCase()}`),
                          onError: () => setNotice('Could not update — change reverted'),
                        },
                      );
                    }}
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
                      <option key={s} value={s}>
                        {s === 'assigned' ? (self.userId ? 'Assign to me' : 'Assigned (unavailable)') : WORK_STATE_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </div>
                {notice ? (
                  <p
                    className="lw-state__body"
                    role="status"
                    style={{ margin: '8px 0 0', maxWidth: 'none' }}
                  >
                    {notice}
                  </p>
                ) : null}
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
                    Now at <strong>{readableStage(pk.proceduralMeaning.currentStage)}</strong>
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
                {packetUnavailableReason ? (
                  <p className="lw-state__body" style={{ maxWidth: 'none' }}>
                    {packetUnavailableReason}
                  </p>
                ) : packet.isPending ? (
                  <p className="lw-state__body" style={{ maxWidth: 'none' }} role="status">
                    Loading official evidence…
                  </p>
                ) : pk?.officialEvidence?.length ? (
                  pk.officialEvidence.slice(0, 3).map((ev) => (
                    <div key={ev.claimId} className="lw-block" style={{ marginBottom: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <LwPill tone={ev.verification === 'official' ? 'success' : ev.verification === 'extracted' ? 'brand' : 'gray'} size="22">
                          {evidenceStatus(ev.verification)}
                        </LwPill>
                        {ev.retrievedAt ? (
                          <span className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-meta)' }}>
                            Source checked {ageLabel(ev.retrievedAt)} ago
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
                  ) : it.evidence?.match?.topicLabel ? (
                    <p className="lw-state__body">Watchlist topic: {it.evidence.match.topicLabel}. A detailed match trace was not retained.</p>
                  ) : (
                  <p className="lw-state__body" style={{ maxWidth: 'none' }}>
                    {it.evidence?.match?.why || 'Client relevance has not been verified. Review this update before acting on it.'}
                  </p>
                )}
                  {!it.evidence?.match?.details?.length && (
                    <p className="lw-state__body">Priority reflects the stored alert ranking. Its client match has not been verified against a detailed trace.</p>
                  )}
              </section>

              {/* Confidence + Unknowns side by side */}
              <section className="lw-two-up">
                <div className="lw-block">
                  <div className="lw-block__label">Analysis confidence</div>
                  {packetUnavailableReason ? (
                    <div className="lw-block__body">Not loaded.</div>
                  ) : packet.isPending ? (
                    <div className="lw-block__body" role="status">Loading…</div>
                  ) : pk?.confidence ? (
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
                    {packetUnavailableReason
                      ? 'Not loaded.'
                      : packet.isPending
                        ? 'Loading…'
                        : pk?.confidence?.missingFields?.length
                          ? pk.confidence.missingFields.map(readableField).join(', ')
                          : pk?.proceduralMeaning?.uncertainty?.length
                            ? pk.proceduralMeaning.uncertainty.map(readableField).join(', ')
                            : 'No explicit unknowns were recorded for this packet.'}
                  </div>
                </div>
              </section>
            </div>

            {/* Action bar — internal artefacts only (§1.5). No external send. */}
            <div className="lw-drawer__foot">
              <LwButton disabled title="Create a brief from the hearing detail page.">
                Create brief
              </LwButton>
              <LwButton variant="primary" onClick={() => setMemoOpen(true)} disabled={!memoClientId || !it.id}
                title={memoClientId ? undefined : 'This alert must belong to a client before drafting a memo.'}>Draft memo</LwButton>
              <LwButton disabled title="Stage outreach from the hearing detail page.">Stage outreach</LwButton>
              <p className="lw-card__meta" style={{ width: '100%', margin: '6px 0 0' }}>
                Create briefs and stage outreach from a hearing’s detail page.
                {hearingHref ? <> <a href={hearingHref}>Open hearing actions</a></> : null}
              </p>
            </div>
          </>
        )}
      </aside>
      {memoOpen && it && memoClientId ? (
        <Suspense fallback={<div role="status">Opening memo editor…</div>}>
          <MemoComposerDrawer open clientId={memoClientId} clientName={it.clientName ?? 'Client'}
            item={it} onClose={() => setMemoOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}

function readableStage(stage: string | null | undefined): string {
  if (!stage || /^(unknown|undefined|null|unavailable)$/i.test(stage)) return 'Unavailable from source';
  return stage.replaceAll('_', ' ');
}

function readableField(value: string): string {
  const label = value.split('.').at(-1) ?? value;
  return label.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').toLowerCase();
}

function evidenceStatus(value: string | null | undefined): string {
  if (value === 'official') return 'SOURCE OFFICIAL';
  if (value === 'extracted') return 'SOURCE EXTRACTED';
  return 'SOURCE STATUS UNAVAILABLE';
}

function confidenceLabel(v: number): string {
  return v >= 0.8 ? 'High' : v >= 0.5 ? 'Medium' : 'Low';
}
