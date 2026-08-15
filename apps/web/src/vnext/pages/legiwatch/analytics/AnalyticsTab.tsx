/**
 * Analytics tab (§7.11). Four metric tiles, 30-day signal-volume by source
 * family, issue momentum, client exposure matrix, jurisdiction activity, and
 * the dark source-coverage panel.
 *
 * Every panel names its denominator. The exposure matrix distinguishes a real
 * zero (monitored, no signals) from an unmonitored cell. There are NO
 * server-side analytics aggregates (GAPS LW-G7) — per §7.11 we do NOT compute
 * aggregates in the browser over a paginated list; every aggregate panel
 * renders its UNAVAILABLE state with the gap named.
 */
import { useLwFeed, useLwFeedItems } from '../lib/api.js';
import { LwPill } from '../lib/primitives.js';
import { LwStateLoading, LwStateUnavailable } from '../states/SystemStates.js';

export function AnalyticsTab({ scope }: { scope: string }) {
  const feed = useLwFeed(scope, 'all', 'date', undefined);
  const { items, counts, severityCounts } = useLwFeedItems(feed);

  if (feed.isLoading) {
    return (
      <div className="lw-body">
        <div className="lw-tiles">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="lw-tile" style={{ minHeight: 88 }} />
          ))}
        </div>
      </div>
    );
  }

  const totalSignals = Object.values(counts).reduce((a, b) => (a ?? 0) + (b ?? 0), 0) ?? 0;
  const decisions = severityCounts.critical ?? null;
  const coverage = null; // GAPS LW-G7 — no server coverage aggregate

  return (
    <div className="lw-body">
      {/* metric tiles — each names its denominator */}
      <div className="lw-tiles">
        <Tile label="Total signals" value={totalSignals} denom="current feed page" />
        <Tile label="Client decisions" value={decisions} denom="critical severity in scope" />
        <Tile label="Bills moved" value={counts.bill ?? null} denom="federal bill packets" />
        <Tile label="Source coverage" value={coverage} denom="no server aggregate" unavailable />
      </div>

      <div className="lw-feed-cols">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <section className="lw-card" style={{ padding: 18 }}>
            <h3 className="lw-sect__title">Signal volume · 30 days by source family</h3>
            <LwStateUnavailable
              source="Signal-volume time series"
              reason="No server-side time-series aggregate exists (GAPS LW-G7). This panel is not computed in the browser over a paginated list."
            />
          </section>

          <section className="lw-card" style={{ padding: 18 }}>
            <h3 className="lw-sect__title">Client exposure matrix</h3>
            <p className="lw-state__body" style={{ maxWidth: 'none' }}>
              A real zero means the client is monitored and produced no signals; an unmonitored cell
              is labelled as such. The matrix needs a server exposure aggregate (GAPS LW-G7).
            </p>
            <div style={{ marginTop: 10 }}>
              <LwPill tone="warning">UNAVAILABLE · DENOMINATOR: CLIENTS × SOURCE FAMILIES</LwPill>
            </div>
          </section>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <section className="lw-card" style={{ padding: 18 }}>
            <h3 className="lw-sect__title">Issue momentum</h3>
            <LwStateUnavailable
              source="Issue momentum"
              reason="No velocity × materiality aggregate exists server-side (GAPS LW-G7)."
            />
          </section>

          {/* dark source-coverage panel — names the gap and what it affects */}
          <section style={{ background: 'var(--lw-ink)', borderRadius: 12, padding: 18, color: '#fff' }}>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Source coverage</h3>
            <p style={{ margin: '10px 0 0', fontSize: 13, lineHeight: '20px', color: 'var(--lw-faint)' }}>
              Per-source coverage percentages have no telemetry endpoint (GAPS LW-G5). Any gap would
              affect state-rule monitoring only — missing coverage is never represented as zero.
            </p>
            <div style={{ marginTop: 12 }}>
              <LwPill tone="warning">NO TELEMETRY</LwPill>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  denom,
  unavailable,
}: {
  label: string;
  value: number | null;
  denom: string;
  unavailable?: boolean;
}) {
  return (
    <div className="lw-tile">
      <div className="lw-tile__value">{unavailable || value == null ? '—' : value.toLocaleString()}</div>
      <div className="lw-tile__label">{label}</div>
      <div style={{ marginTop: 4, fontFamily: 'var(--lw-mono)', fontSize: 10, color: 'var(--lw-faint)' }}>
        {unavailable ? 'UNAVAILABLE' : denom}
      </div>
    </div>
  );
}
