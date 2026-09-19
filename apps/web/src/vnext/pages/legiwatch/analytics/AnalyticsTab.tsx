/**
 * Analytics tab (LEGIWATCH-V2-HANDOFF §5.8) — four metric tiles, 30-day
 * signal-volume, issue momentum, client exposure matrix, committee activity,
 * and source coverage. Every panel is a real server aggregate (Wave 3;
 * legiwatch-analytics.service.ts) — never the frontend summing a paginated
 * Feed page. A monitored client with no signals renders `0`; an unmonitored
 * client renders a dash — the two are never conflated.
 */
import { LwStateLoading, LwStateUnavailable } from '../states/SystemStates.js';
import {
  useAnalyticsSummary,
  useAnalyticsSignalVolume,
  useAnalyticsIssueMomentum,
  useAnalyticsClientExposure,
  useAnalyticsCommitteeActivity,
  useAnalyticsSourceCoverage,
} from '../lib/wave3-api.js';

const EXPOSURE_FAMILIES = ['Congress.gov', 'Committee pages', 'Congress.gov + Committee pages', 'State legislatures', 'Federal Register', 'Program element service'];

export function AnalyticsTab({ scope }: { scope: string }) {
  const summary = useAnalyticsSummary(scope);
  const volume = useAnalyticsSignalVolume(scope);
  const momentum = useAnalyticsIssueMomentum(scope);
  const exposure = useAnalyticsClientExposure();
  const committees = useAnalyticsCommitteeActivity(scope);
  const coverage = useAnalyticsSourceCoverage();

  if (summary.isLoading) {
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
  if (summary.isError || !summary.data) {
    return (
      <div className="lw-body">
        <LwStateUnavailable source="Analytics" reason="The analytics summary did not respond. This is not zero signals." onRetry={() => summary.refetch()} />
      </div>
    );
  }

  const s = summary.data;
  const maxDay = Math.max(1, ...(volume.data?.days.map((d) => d.count) ?? [1]));
  const maxMomentum = Math.max(1, ...(momentum.data?.topics.map((t) => t.index) ?? [1]));

  return (
    <div className="lw-body lw-analytics">
      <p className="lw-state__body" style={{ maxWidth: 'none', marginTop: 0 }}>
        Trends for {scope === 'all' ? 'all accessible clients' : 'the selected client'} · server totals for the last 30 days.
      </p>
      <div className="lw-tiles">
        <Tile label="Signals in 30 days" value={s.signalsTotal} denom={`across ${s.sourceFamiliesInvolved} source famil${s.sourceFamiliesInvolved === 1 ? 'y' : 'ies'}`} />
        <Tile label="Client decisions" value={s.clientDecisions} denom={`of ${s.signalsTotal} signals reached a decision`} />
        <Tile label="Bills moved" value={s.billsMoved} denom={`of ${s.billsTrackedTotal} tracked bills changed stage`} />
        <Tile
          label="Source coverage"
          value={s.sourceCoveragePct}
          suffix="%"
          denom={`${s.sourceFamiliesCurrent} of ${s.sourceFamiliesTotal} committee sources healthy`}
          unavailable={s.sourceCoveragePct == null}
        />
      </div>

      {/* Signal volume runs full width directly under the tiles (reference
          analytics.png); the two-column split starts below it. */}
      <section className="lw-card" style={{ padding: 18 }}>
        <h3 className="lw-sect__title">Signal volume · last 30 days</h3>
        {volume.isLoading ? (
          <LwStateLoading rows={3} />
        ) : volume.isError || !volume.data ? (
          <LwStateUnavailable source="Signal volume" reason="The time-series aggregate did not respond." onRetry={() => volume.refetch()} />
        ) : volume.data.total === 0 ? (
          <p className="lw-state__body" style={{ maxWidth: 'none' }}>No signals in this window.</p>
        ) : (
          <>
            <p className="lw-state__body" style={{ maxWidth: 'none', marginBottom: 10 }}>
              {volume.data.total} signals across the tracked source families.
            </p>
            <div className="lw-volbars" role="img" aria-label="Signal volume per day">
              {volume.data.days.map((d) => (
                <div key={d.date} className="lw-volbars__col">
                  <div
                    className="lw-volbars__bar"
                    title={`${d.date}: ${d.count}`}
                    style={{ height: `${Math.max(4, (d.count / maxDay) * 120)}px` }}
                  />
                  <div className="lw-volbars__date">{d.date.slice(5)}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="lw-card" style={{ padding: 18 }}>
        <h3 className="lw-sect__title">Issue momentum</h3>
        <p className="lw-state__body" style={{ maxWidth: 'none', marginBottom: 10 }}>
          The last seven days, weighted by materiality, compared with each topic&rsquo;s
          previous 23-day daily average. A steady rate is 100.
        </p>
        {momentum.isLoading ? (
          <LwStateLoading rows={4} />
        ) : momentum.isError || !momentum.data ? (
          <LwStateUnavailable source="Issue momentum" reason="The momentum aggregate did not respond." onRetry={() => momentum.refetch()} />
        ) : momentum.data.topics.length === 0 ? (
          <p className="lw-state__body" style={{ maxWidth: 'none' }}>No watchlist topics have enough history yet.</p>
        ) : (
          <div className="lw-momentum">
            {momentum.data.topics.map((t) => (
              <div key={t.topicId} className="lw-momentum__row">
                <span className="lw-momentum__label">{t.label}</span>
                <span className="lw-momentum__value">{t.index}</span>
                <div className="lw-momentum__track" aria-hidden="true">
                  <div className="lw-momentum__fill" style={{ width: `${Math.min(100, (t.index / maxMomentum) * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="lw-feed-cols">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <section className="lw-card" style={{ padding: 18 }}>
            <h3 className="lw-sect__title">Client exposure by source family</h3>
            <p className="lw-state__body" style={{ maxWidth: 'none', marginBottom: 10 }}>
              A monitored client with no signals reads 0. A client with no monitoring model reads a
              dash — not zero.
            </p>
            {exposure.isLoading ? (
              <LwStateLoading rows={4} />
            ) : exposure.isError || !exposure.data ? (
              <LwStateUnavailable source="Client exposure" reason="The exposure matrix did not respond." onRetry={() => exposure.refetch()} />
            ) : (
              <div style={{ overflowX: 'auto' }} tabIndex={0} role="region" aria-label="Client exposure by source family table">
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '4px 8px' }}>Client</th>
                      {EXPOSURE_FAMILIES.map((family) => (
                        <th key={family} style={{ textAlign: 'right', padding: '4px 8px' }}>{family}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {exposure.data.rows.map((r) => (
                      <tr key={r.clientId} style={{ borderTop: '1px solid var(--lw-line)' }}>
                        <td style={{ padding: '6px 8px', fontWeight: 600 }}>{r.clientName}</td>
                        {EXPOSURE_FAMILIES.map((fam) => (
                          <td key={fam} style={{ textAlign: 'right', padding: '6px 8px', color: r.monitored ? undefined : 'var(--lw-faint)' }}>
                            {r.monitored ? (r.bySourceFamily?.[fam] ?? 0) : 'not monitored'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <section className="lw-card" style={{ padding: 18 }}>
            <h3 className="lw-sect__title">Committee activity</h3>
            <p className="lw-state__body" style={{ maxWidth: 'none', marginBottom: 10 }}>
              {committees.data ? `Share of the ${committees.data.total} signals attributable to each committee.` : 'Loading…'}
            </p>
            {committees.isLoading ? (
              <LwStateLoading rows={4} />
            ) : committees.isError || !committees.data ? (
              <LwStateUnavailable source="Committee activity" reason="The committee-activity aggregate did not respond." onRetry={() => committees.refetch()} />
            ) : committees.data.rows.length === 0 ? (
              <p className="lw-state__body" style={{ maxWidth: 'none' }}>No committee-attributed signals in this window.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {committees.data.rows.map((r) => (
                  <div key={r.systemCode ?? r.committeeName} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ flex: 1, fontSize: 13 }}>{r.committeeName}</span>
                    <span className="lw-mono" style={{ fontSize: 12, color: 'var(--lw-meta)' }}>{r.count}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* dark source-coverage panel */}
          <section style={{ background: 'var(--lw-ink)', borderRadius: 12, padding: 18, color: '#fff' }}>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Source coverage</h3>
            <p style={{ margin: '6px 0 10px', fontSize: 12, color: '#D0D5DD' }}>
              Missing coverage is never represented as zero.
            </p>
            {coverage.isLoading ? (
              <p style={{ margin: 0, fontSize: 13, color: '#D0D5DD' }}>Loading…</p>
            ) : coverage.isError || !coverage.data ? (
              <p style={{ margin: 0, fontSize: 13, color: '#D0D5DD' }}>Source coverage could not be loaded.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {coverage.data.sources.map((src) => (
                  <div key={src.family} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ flex: 1, fontSize: 13 }}>{src.family}</span>
                    <span className="lw-mono" style={{ fontSize: 12, color: '#D0D5DD' }}>
                      {src.coveragePct == null ? '—' : `${src.coveragePct}%`}
                    </span>
                  </div>
                ))}
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
      <div className="lw-tile__label">{label}</div>
      <div className="lw-tile__value">
        {unavailable || value == null ? '—' : `${value.toLocaleString()}${suffix ?? ''}`}
      </div>
      <div className="lw-tile__denom">{unavailable ? 'Unavailable' : denom}</div>
    </div>
  );
}
