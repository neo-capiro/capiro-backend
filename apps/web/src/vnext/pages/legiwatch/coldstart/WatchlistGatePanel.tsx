/**
 * PR C §13 — inline watchlist-setup guidance for watchlist-dependent tabs
 * (Feed / Digest / Analytics / client relevance) shown when the selected
 * client has no approved watchlist, WITHOUT replacing the whole module (the
 * §7.12 full-body ColdStart replacement is retired for everything except the
 * explicit "no watchlist at all" client scoping, which now lives INLINE).
 *
 * Honest by construction: the panel never renders on Hearings/Bills/Committees
 * (those stay public), and it names the exact reason — no approved monitoring
 * model yet — plus the path out (Configure / Explore without alerts).
 */
import { LwButton, LwPill } from '../lib/primitives.js';

export function WatchlistGatePanel({
  clientName,
  onConfigure,
  onExplore,
}: {
  clientName: string;
  onConfigure: () => void;
  onExplore: () => void;
}) {
  return (
    <div className="lw-body">
      <section className="lw-card" aria-label="Watchlist setup required" style={{ padding: 18 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <LwPill tone="warning" size="22">NO WATCHLIST</LwPill>
          <h2 className="lw-card__title" style={{ fontSize: 16 }}>This surface needs an approved monitoring model</h2>
        </div>
        <p style={{ fontSize: 13, color: 'var(--lw-body)', margin: '10px 0 0', maxWidth: 720 }}>
          {clientName || 'This client'} has no approved watchlist yet, so there is nothing to rank into this
          surface. Public LegiWatch data remains available — Hearings, Bill tracking, and Committee Rooms work
          for every client.
        </p>
        <p style={{ fontSize: 12, color: 'var(--lw-meta)', margin: '8px 0 0', maxWidth: 720 }}>
          Client-specific alerts, tailored Feed, Digest, and Analytics relevance require a monitoring model.
        </p>
        <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
          <LwButton variant="primary" onClick={onConfigure}>Configure the watchlist</LwButton>
          <LwButton onClick={onExplore}>Explore without alerts</LwButton>
        </div>
      </section>
    </div>
  );
}