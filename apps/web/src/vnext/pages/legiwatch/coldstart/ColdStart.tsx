/**
 * Cold start (§7.12) — replaces the module body when the scoped client has no
 * approved targeting. Tabs report 0; no empty feed is ever rendered (§4.1 #10).
 *
 * Three elements: the dark guided start, the four-step first-watchlist build
 * (only the current step is actionable), and the server's suggested starter
 * model — visibly DRAFT · NOT ACTIVE. Suggestions stay suggestions until a
 * human approves them (§8.9); nothing here creates a live watchlist without
 * explicit approval (the approval mutation is the canonical watchlist PUT,
 * linked out to the client's configuration surface per §7.9).
 *
 * Coverage score: there is no server coverage score (GAPS LW-G3) — the score
 * panel renders its UNAVAILABLE state with the reason, never a fabricated %.
 */
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { LwPill, LwButton } from '../lib/primitives.js';
import { LwStateLoading } from '../states/SystemStates.js';

const STEPS = [
  ['01', 'Confirm client priorities', 'Choose the issues that matter and set Support, Oppose, or Monitor.'],
  ['02', 'Approve match targets', 'Review suggested terms, bills, committees, agencies, and jurisdictions.'],
  ['03', 'Choose triggers and delivery', 'Set materiality, work-state defaults, email cadence, and quiet hours.'],
  ['04', 'Run coverage check', 'Preview recent matches, reveal gaps, and save the approved watchlist.'],
] as const;

export function ColdStart({ clientId, onConfigure }: { clientId: string; onConfigure: () => void }) {
  const api = useApi();
  // The server's draft starter model — sector-derived suggestions on the
  // watchlist read (§7.12). Stays DRAFT · NOT ACTIVE until approved.
  const watchlist = useQuery<{ suggestedIssueAreas?: string[]; issueAreas?: string[] } | null>({
    queryKey: ['lw-vnext', 'coldstart', clientId],
    queryFn: async () =>
      (
        await api.get<{ suggestedIssueAreas?: string[]; issueAreas?: string[] }>(
          `/intel-api/tracker/watchlists/${encodeURIComponent(clientId)}`,
        )
      ).data,
    enabled: Boolean(clientId),
    retry: false,
    staleTime: 60_000,
  });

  const suggested = watchlist.data?.suggestedIssueAreas ?? [];

  return (
    <div className="lw-body">
      {/* guided start (dark) */}
      <section className="lw-cold lw-on-ink">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            <div className="lw-eyebrow" style={{ color: 'var(--lw-faint)' }}>No empty feed</div>
            <h2 className="lw-cold__h">Start with a monitoring model.</h2>
            <p className="lw-cold__p">
              LegiWatch needs an approved watchlist before it can show you what changed — issue
              areas, match targets, triggers and delivery. Until then there is no feed to render,
              and we don't render an empty one.
            </p>
            <div className="lw-cold__routes">
              <LwButton variant="primary" size="40" onClick={onConfigure}>Use starter template</LwButton>
              <LwButton size="40" onClick={onConfigure}>Configure manually</LwButton>
              <LwButton size="40" onClick={onConfigure}>Explore without alerts</LwButton>
            </div>
          </div>
          {/* coverage score — UNAVAILABLE honestly (GAPS LW-G3) */}
          <div style={{ minWidth: 220, background: 'rgba(255,255,255,.06)', borderRadius: 11, padding: 16 }}>
            <div className="lw-eyebrow" style={{ color: 'var(--lw-faint)' }}>Coverage</div>
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 28, fontWeight: 600, fontFamily: 'var(--lw-mono)' }}>—</span>
              <LwPill tone="warning">NOT READY</LwPill>
            </div>
            <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--lw-faint)' }}>
              No targeting is approved yet, and no server coverage score exists to preview one.
            </p>
          </div>
        </div>
      </section>

      <div className="lw-feed-cols">
        {/* build the first useful watchlist */}
        <section className="lw-card">
          <div className="lw-card__head">
            <h3 className="lw-card__title">Build the first useful watchlist</h3>
          </div>
          <div style={{ padding: '8px 18px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {STEPS.map(([n, title, body], i) => {
              const current = i === 0; // only the current step is actionable
              return (
                <div key={n} className="lw-block" style={{ display: 'flex', gap: 14, opacity: current ? 1 : 0.6 }}>
                  <span className="lw-mono" style={{ fontSize: 12, fontWeight: 600, color: 'var(--lw-meta)' }}>{n}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
                    <div className="lw-block__body">{body}</div>
                  </div>
                  {current ? (
                    <LwButton variant="primary" onClick={onConfigure}>Start</LwButton>
                  ) : (
                    <LwPill tone="gray" size="22">LOCKED</LwPill>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* suggested starter model */}
        <section className="lw-card">
          <div className="lw-card__head">
            <h3 className="lw-card__title">Suggested starter model</h3>
            <span className="lw-card__meta"><LwPill tone="warning" size="22">DRAFT · NOT ACTIVE</LwPill></span>
          </div>
          <div style={{ padding: '14px 18px' }}>
            {watchlist.isLoading ? (
              <LwStateLoading rows={2} />
            ) : suggested.length ? (
              <>
                <div className="lw-rail__label" style={{ marginBottom: 8 }}>Suggested issue areas</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {suggested.map((s) => (
                    <LwPill key={s} tone="warning" size="22">{s} · SUGGESTED</LwPill>
                  ))}
                </div>
              </>
            ) : (
              <p className="lw-state__body" style={{ maxWidth: 'none' }}>
                No server-suggested starter model is available for this client.
              </p>
            )}
            <p className="lw-state__body" style={{ maxWidth: 'none', marginTop: 12 }}>
              Suggestions stay suggestions until a human approves them — approving writes the
              client&rsquo;s watchlist through the canonical configuration surface.
            </p>
            <div style={{ marginTop: 12 }}>
              <LwButton variant="primary" onClick={onConfigure}>Review and approve</LwButton>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
