/**
 * Analytics tab (§7.11). Four metric tiles, 30-day signal-volume by source
 * family, issue momentum, client exposure matrix, jurisdiction activity, and
 * the dark source-coverage panel.
 *
 * Every panel names its denominator. The exposure matrix distinguishes a real
 * zero (monitored, no signals) from an unmonitored cell. Signal volume, issue
 * momentum, and the exposure matrix have NO server-side aggregate (GAPS
 * LW-G7) — per §7.11 we do NOT compute aggregates in the browser over a
 * paginated list, so those three still render their UNAVAILABLE state with
 * the gap named.
 *
 * Source coverage (GAPS LW-G5, closed by W2-5) now reads the real per-client
 * coverage score. It is scoped to ONE client — with no client selected there
 * is no single watchlist to score, so the panel says so rather than
 * fabricating a cross-client average.
 */
import { useLwFeed, useLwFeedItems } from '../lib/api.js';
import { LwPill } from '../lib/primitives.js';
import { LwStateLoading, LwStateUnavailable } from '../states/SystemStates.js';
import { useWatchlistCoverage, COVERAGE_STATUS_LABEL, COVERAGE_STATUS_TONE, SIGNAL_FAMILY_LABEL } from '../lib/wave2-api.js';

export function AnalyticsTab({ scope }: { scope: string }) {
  const feed = useLwFeed(scope, 'all', 'date', undefined);
  const { items, counts, severityCounts } = useLwFeedItems(feed);
  const coverage = useWatchlistCoverage(scope);

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
  const coveragePct = scope ? coverage.data?.overall.percentage ?? null : null;
  const coverageUnavailable = !scope || coverage.isError || coveragePct == null;

  return (
    <div className="lw-body">
      {/* metric tiles — each names its denominator */}
      <div className="lw-tiles">
        <Tile label="Total signals" value={totalSignals} denom="current feed page" />
        <Tile label="Client decisions" value={decisions} denom="critical severity in scope" />
        <Tile label="Bills moved" value={counts.bill ?? null} denom="federal bill packets" />
        <Tile
          label="Source coverage"
          value={coveragePct}
          denom={scope ? 'watchlist concepts covered' : 'select a client'}
          unavailable={coverageUnavailable}
          suffix="%"
        />
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

          {/* dark source-coverage panel — real per-family breakdown (W2-5) */}
          <section style={{ background: 'var(--lw-ink)', borderRadius: 12, padding: 18, color: '#fff' }}>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Source coverage</h3>
            {!scope ? (
              <p style={{ margin: '10px 0 0', fontSize: 13, lineHeight: '20px', color: 'var(--lw-faint)' }}>
                Coverage is scored per client. Select a client to see which signal families and
                concepts its watchlist actually covers.
              </p>
            ) : coverage.isLoading ? (
              <p style={{ margin: '10px 0 0', fontSize: 13, color: 'var(--lw-faint)' }}>Loading…</p>
            ) : coverage.isError ? (
              <>
                <p style={{ margin: '10px 0 0', fontSize: 13, lineHeight: '20px', color: 'var(--lw-faint)' }}>
                  Coverage could not be loaded for this client.
                </p>
                <div style={{ marginTop: 12 }}>
                  <LwPill tone="gray">UNAVAILABLE</LwPill>
                </div>
              </>
            ) : coverage.data?.overall.status === 'NOT_CONFIGURED' ? (
              <>
                <p style={{ margin: '10px 0 0', fontSize: 13, lineHeight: '20px', color: 'var(--lw-faint)' }}>
                  No watchlist concepts are configured for this client yet, so there is nothing to
                  score.
                </p>
                <div style={{ marginTop: 12 }}>
                  <LwPill tone="gray">NOT CONFIGURED</LwPill>
                </div>
              </>
            ) : (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {coverage.data?.signalFamilies.map((f) => (
                  <div key={f.family} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ flex: 1, fontSize: 13 }}>{SIGNAL_FAMILY_LABEL[f.family]}</span>
                    <span style={{ fontSize: 12, color: 'var(--lw-faint)', fontFamily: 'var(--lw-mono)' }}>
                      {f.coveredConcepts}/{f.configuredConcepts}
                    </span>
                    <LwPill tone={COVERAGE_STATUS_TONE[f.status]} size="22">
                      {COVERAGE_STATUS_LABEL[f.status]}
                    </LwPill>
                  </div>
                ))}
                {coverage.data?.recommendations.length ? (
                  <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--lw-faint)' }}>
                    {coverage.data.recommendations[0]}
                  </p>
                ) : null}
              </div>
            )}
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
  suffix,
}: {
  label: string;
  value: number | null;
  denom: string;
  unavailable?: boolean;
  suffix?: string;
}) {
  return (
    <div className="lw-tile">
      <div className="lw-tile__value">
        {unavailable || value == null ? '—' : `${value.toLocaleString()}${suffix ?? ''}`}
      </div>
      <div className="lw-tile__label">{label}</div>
      <div style={{ marginTop: 4, fontFamily: 'var(--lw-mono)', fontSize: 10, color: 'var(--lw-faint)' }}>
        {unavailable ? 'UNAVAILABLE' : denom}
      </div>
    </div>
  );
}
