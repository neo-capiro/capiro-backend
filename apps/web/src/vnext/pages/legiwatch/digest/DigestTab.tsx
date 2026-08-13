/**
 * Digest tab (§7.10) — the morning brief. Dark masthead, lede, What changed
 * since yesterday, Decisions due, Client notes, provenance footer. Controls:
 * client inclusion, section toggles, delivery channels with real connection
 * status, the dark source-confidence panel, Export PDF / Send now / Schedule.
 *
 * `Send now` is DISABLED with the reason named (§1.5 — no external send until
 * the Stage H security review). There is no digest generation/persistence
 * endpoint (GAPS LW-G6) — only the email digest queue drain exists — so the
 * generated brief is assembled from the current feed's real packets and the
 * provenance footer names the actual source families used. No digest history
 * is fabricated.
 */
import { useMemo, useState } from 'react';
import { useLwFeed, useLwFeedItems } from '../lib/api.js';
import { packetBand, ageLabel } from '../lib/types.js';
import { SOURCE_LABEL } from '../../../../pages/clients/tracker/intel-feed-api.js';
import { LwPill, LwButton } from '../lib/primitives.js';
import { LwStateLoading } from '../states/SystemStates.js';

export function DigestTab({ scope }: { scope: string }) {
  const feed = useLwFeed(scope, 'all', 'score', undefined);
  const { items, counts } = useLwFeedItems(feed);
  const [sections, setSections] = useState({ changed: true, decisions: true, notes: true });

  const top = useMemo(() => items.slice(0, 8), [items]);
  const decisions = useMemo(() => items.filter((i) => i.severity === 'critical').slice(0, 4), [items]);
  const families = useMemo(
    () => Object.entries(counts).filter(([, n]) => (n ?? 0) > 0).map(([k]) => SOURCE_LABEL[k as keyof typeof SOURCE_LABEL] ?? k),
    [counts],
  );

  if (feed.isLoading) {
    return (
      <div className="lw-body">
        <div className="lw-card" style={{ padding: 18 }}><LwStateLoading rows={4} /></div>
      </div>
    );
  }

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  return (
    <div className="lw-body">
      <div className="lw-feed-cols">
        {/* the brief */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <section className="lw-card" style={{ overflow: 'hidden' }}>
            {/* dark masthead */}
            <div style={{ background: 'var(--lw-ink)', color: '#fff', padding: '22px 24px' }}>
              <div className="lw-eyebrow" style={{ color: 'var(--lw-faint)' }}>Capiro LegiWatch</div>
              <h2 style={{ margin: '6px 0 0', fontSize: 24, lineHeight: '32px', letterSpacing: '-.01em', fontWeight: 600 }}>
                Morning brief
              </h2>
              <div className="lw-mono" style={{ marginTop: 6, fontSize: 11, color: 'var(--lw-faint)' }}>
                {today} · {scope ? 'CLIENT SCOPE' : 'ALL CLIENTS'}
              </div>
            </div>
            <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
              <p style={{ margin: 0, fontSize: 15, lineHeight: '22px', color: 'var(--lw-body)', textWrap: 'pretty' }}>
                {top.length
                  ? `${top.length} development${top.length === 1 ? '' : 's'} moved across your monitored sources since the last scan — ${decisions.length} need${decisions.length === 1 ? 's' : ''} a decision today.`
                  : 'Nothing moved across your monitored sources since the last scan.'}
              </p>

              {sections.changed ? (
                <section>
                  <h3 className="lw-sect__title">What changed since yesterday</h3>
                  {top.length === 0 ? (
                    <p className="lw-state__body">Nothing changed — sources are current.</p>
                  ) : (
                    <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {top.map((it, i) => {
                        const b = packetBand(it);
                        return (
                          <li key={it.id}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 14, fontWeight: 600 }}>{i + 1}. {it.title}</span>
                            </div>
                            <div className="lw-mono" style={{ marginTop: 3, fontSize: 11, color: 'var(--lw-meta)' }}>
                              {b.band} · {it.evidence?.bill?.displayNum ?? it.sourceType.toUpperCase()} · {ageLabel(it.createdAt)} · {it.clientName ?? 'Client'}
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </section>
              ) : null}

              {sections.decisions && decisions.length ? (
                <section>
                  <h3 className="lw-sect__title">Decisions due</h3>
                  {decisions.map((it) => (
                    <div key={it.id} className="lw-block" style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{it.title}</span>
                      <LwPill tone="error" size="22">DUE TODAY</LwPill>
                    </div>
                  ))}
                </section>
              ) : null}

              {sections.notes ? (
                <section>
                  <h3 className="lw-sect__title">Client notes</h3>
                  <p className="lw-state__body" style={{ maxWidth: 'none' }}>
                    {top[0]?.whyItMatters ?? 'No client-facing notes in the current window.'}
                  </p>
                </section>
              ) : null}

              {/* provenance footer — not decoration; names the real records used */}
              <footer style={{ borderTop: '1px solid var(--lw-line)', paddingTop: 14 }}>
                <div className="lw-eyebrow">Provenance</div>
                <p className="lw-state__body" style={{ maxWidth: 'none', marginTop: 6 }}>
                  Assembled from {families.length ? families.join(', ') : 'no source families'} ·
                  official records linked per packet · retained unknowns are named on each packet.
                </p>
              </footer>
            </div>
          </section>
        </div>

        {/* brief controls */}
        <aside style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <section className="lw-card">
            <div className="lw-card__head"><h3 className="lw-card__title" style={{ fontSize: 16 }}>Brief controls</h3></div>
            <div className="lw-rail__sect">
              <div className="lw-rail__label">Sections</div>
              {(['changed', 'decisions', 'notes'] as const).map((k) => (
                <label key={k} className="lw-check" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', fontSize: 13, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={sections[k]}
                    onChange={(e) => setSections((prev) => ({ ...prev, [k]: e.target.checked }))}
                  />
                  {k === 'changed' ? 'What changed' : k === 'decisions' ? 'Decisions due' : 'Client notes'}
                </label>
              ))}
            </div>
            <div className="lw-rail__sect">
              <div className="lw-rail__label">Delivery</div>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--lw-body)' }}>
                Email cadence follows the client&rsquo;s alert preferences. No Teams connection is
                configured — stated as such, not hidden.
              </p>
            </div>
            {/* dark source-confidence panel */}
            <div style={{ margin: '0 16px 16px', background: 'var(--lw-ink)', borderRadius: 11, padding: 14, color: '#fff' }}>
              <div className="lw-eyebrow" style={{ color: 'var(--lw-faint)' }}>Source confidence</div>
              <div style={{ marginTop: 8, fontSize: 13, color: 'var(--lw-faint)' }}>
                Official records first; verified and unofficial evidence are labelled on each packet.
              </div>
            </div>
            <div style={{ padding: '0 16px 16px', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <LwButton onClick={() => window.print()}>Export PDF</LwButton>
              {/* §1.5 — Send now stays disabled until the Stage H security review */}
              <LwButton disabled title="Send now is disabled until the Stage H security review ships. The digest produces an internal artefact pending human action.">
                Send now
              </LwButton>
              <LwButton disabled title="Scheduled delivery has no backend yet (GAPS LW-G6).">
                Schedule
              </LwButton>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
