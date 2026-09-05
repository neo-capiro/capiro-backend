/**
 * Digest tab (LEGIWATCH-V2-HANDOFF §5.8) — the persistent morning-brief
 * product, with real generation, persistence and history (Wave 3;
 * legiwatch-digest.service.ts). `Send now` stays disabled — §1.5, no
 * external send until the Stage H security review — and `Export PDF` is the
 * browser's own print-to-PDF (a real PDF, no server-side rendering
 * dependency introduced for one feature).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { LwPill, LwButton } from '../lib/primitives.js';
import { LwStateLoading, LwStateUnavailable } from '../states/SystemStates.js';
import {
  useGenerateDigest,
  useDigestHistory,
  useDigestRun,
  useDigestSchedule,
  usePutDigestSchedule,
  type DigestContent,
} from '../lib/wave3-api.js';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="lw-sect__title">{title}</h3>
      {children}
    </section>
  );
}

function Brief({ content }: { content: DigestContent }) {
  const day = new Date(content.generatedAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const time = new Date(content.generatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  return (
    <section className="lw-card" style={{ overflow: 'hidden' }}>
      <div style={{ background: 'var(--lw-ink)', color: '#fff', padding: '22px 24px' }}>
        <div className="lw-eyebrow" style={{ color: 'var(--lw-faint)' }}>Capiro LegiWatch · Morning brief</div>
        <h2 style={{ margin: '6px 0 0', fontSize: 24, lineHeight: '32px', letterSpacing: '-.01em', fontWeight: 600 }}>{day}</h2>
        <div className="lw-mono" style={{ marginTop: 6, fontSize: 11, color: 'var(--lw-faint)' }}>
          GENERATED {time} · {content.scopeLabel.toUpperCase()} · {content.clientsInScope} CLIENT{content.clientsInScope === 1 ? '' : 'S'} IN SCOPE
        </div>
      </div>
      <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <p style={{ margin: 0, fontSize: 15, lineHeight: '22px', color: 'var(--lw-body)', textWrap: 'pretty' }}>{content.headline}</p>

        <Section title="What changed">
          {content.whatChanged.length === 0 ? (
            <p className="lw-state__body">Nothing changed — sources are current.</p>
          ) : (
            <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {content.whatChanged.map((it, i) => (
                <li key={it.id}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{i + 1}. {it.title}</span>
                  <div className="lw-mono" style={{ marginTop: 3, fontSize: 11, color: 'var(--lw-meta)' }}>
                    {it.band} · {it.sourceLabel} · {it.ageHours}h ago · {it.clientName ?? 'Historical client'}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Section>

        <Section title="Decisions required">
          {content.decisionsRequired.length === 0 ? (
            <p className="lw-state__body">No decisions are due today.</p>
          ) : (
            content.decisionsRequired.map((it) => (
              <div key={it.id} className="lw-block" style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{it.title}</span>
                  <LwPill tone="error" size="22">DUE TODAY</LwPill>
                </div>
                {it.recommendedAction ? (
                  <p className="lw-block__body" style={{ marginTop: 4 }}>{it.recommendedAction}</p>
                ) : null}
              </div>
            ))
          )}
        </Section>

        <Section title="Upcoming hearings">
          {content.upcomingHearings.length === 0 ? (
            <p className="lw-state__body">Nothing further this week.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {content.upcomingHearings.slice(0, 6).map((h) => (
                <li key={h.id} style={{ fontSize: 13, marginBottom: 4 }}>
                  {h.date} · {h.committeeName ?? 'Committee not announced'} · {h.title}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Bill movement">
          {content.billMovement.length === 0 ? (
            <p className="lw-state__body">No tracked bills changed stage in this window.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {content.billMovement.map((b) => (
                <li key={b.id} style={{ fontSize: 13, marginBottom: 4 }}>{b.display} — {b.status ?? 'status unknown'}</li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Client implications">
          {content.clientImplications.length === 0 ? (
            <p className="lw-state__body">No clients are in scope.</p>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {content.clientImplications.map((c) => (
                <LwPill key={c.clientId} tone={c.band === 'HIGH' ? 'error' : c.band === 'MEDIUM' ? 'warning' : c.band === 'LOW' ? 'gray' : 'gray'} size="22">
                  {c.clientName} · {c.band}
                </LwPill>
              ))}
            </div>
          )}
        </Section>

        {content.recommendedActions.length > 0 ? (
          <Section title="Recommended action">
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {content.recommendedActions.map((a) => (
                <li key={a} style={{ fontSize: 13, marginBottom: 4 }}>{a}</li>
              ))}
            </ul>
          </Section>
        ) : null}

        <footer style={{ borderTop: '1px solid var(--lw-line)', paddingTop: 14 }}>
          <div className="lw-eyebrow">Provenance</div>
          <p className="lw-state__body" style={{ maxWidth: 'none', marginTop: 6 }}>
            Built from {content.provenance.sourceFamilies.length ? content.provenance.sourceFamilies.join(', ') : 'no source families'} ·
            {' '}{content.provenance.officialRecordCount} official record{content.provenance.officialRecordCount === 1 ? '' : 's'} ·
            {' '}{content.provenance.captureCount} Capiro capture{content.provenance.captureCount === 1 ? '' : 's'}.
          </p>
        </footer>
      </div>
    </section>
  );
}

export function DigestTab({ scope }: { scope: string }) {
  const [viewingRunId, setViewingRunId] = useState<string | null>(null);
  const generate = useGenerateDigest(scope);
  const history = useDigestHistory(scope);
  const viewedRun = useDigestRun(viewingRunId);
  const schedule = useDigestSchedule(scope);
  const putSchedule = usePutDigestSchedule(scope);

  // Landing view is the most recent persisted run, never a silent write —
  // "Generate now" is the only action that creates a new one.
  useEffect(() => {
    setViewingRunId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  useEffect(() => {
    if (!viewingRunId && history.data && history.data.rows.length > 0) {
      setViewingRunId(history.data.rows[0]!.id);
    }
  }, [history.data, viewingRunId]);

  const content = generate.data ?? viewedRun.data;
  const isLoading = history.isLoading || (Boolean(viewingRunId) && viewedRun.isLoading);
  const hasNoHistoryYet = !history.isLoading && (history.data?.rows.length ?? 0) === 0 && !generate.data;

  return (
    <div className="lw-body">
      <div className="lw-feed-cols">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          {isLoading ? (
            <div className="lw-card" style={{ padding: 18 }}><LwStateLoading rows={4} /></div>
          ) : generate.isError && !content ? (
            <LwStateUnavailable source="Digest" reason="The brief could not be generated." onRetry={() => generate.mutate()} />
          ) : content ? (
            <Brief content={content} />
          ) : hasNoHistoryYet ? (
            <div className="lw-card" style={{ padding: 24, textAlign: 'center' }}>
              <p className="lw-state__body" style={{ maxWidth: 'none', marginBottom: 12 }}>
                No digest has been generated yet for this scope.
              </p>
              <LwButton variant="primary" onClick={() => generate.mutate()} disabled={generate.isPending}>
                {generate.isPending ? 'Generating…' : 'Generate now'}
              </LwButton>
            </div>
          ) : null}
        </div>

        <aside style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <section className="lw-card">
            <div className="lw-card__head"><h3 className="lw-card__title" style={{ fontSize: 16 }}>Brief controls</h3></div>
            <div style={{ padding: '0 16px 16px', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <LwButton
                variant="primary"
                onClick={() => {
                  setViewingRunId(null);
                  generate.mutate();
                }}
                disabled={generate.isPending}
              >
                {generate.isPending ? 'Generating…' : 'Generate now'}
              </LwButton>
              <LwButton onClick={() => window.print()}>Export PDF</LwButton>
              <LwButton
                disabled
                title="Send now is disabled until the Stage H security review ships. The digest produces an internal artefact pending human action."
              >
                Send now
              </LwButton>
            </div>

            <div className="lw-rail__sect">
              <div className="lw-rail__label">Schedule delivery</div>
              {schedule.isLoading ? (
                <p style={{ margin: 0, fontSize: 12, color: 'var(--lw-body)' }}>Loading…</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                    <span style={{ width: 70 }}>Cadence</span>
                    <select
                      value={schedule.data?.cadence ?? 'off'}
                      onChange={(e) =>
                        putSchedule.mutate({
                          cadence: e.target.value as 'daily' | 'weekly' | 'off',
                          hourUtc: schedule.data?.hourUtc ?? 11,
                          emailEnabled: schedule.data?.emailEnabled ?? true,
                        })
                      }
                    >
                      <option value="off">Off</option>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                    </select>
                  </label>
                  {schedule.data && schedule.data.cadence !== 'off' ? (
                    <p style={{ margin: 0, fontSize: 12, color: 'var(--lw-body)' }}>
                      Delivered {schedule.data.cadence} at {String(schedule.data.hourUtc).padStart(2, '0')}:00 UTC.
                    </p>
                  ) : null}
                </div>
              )}
            </div>

            <div className="lw-rail__sect">
              <div className="lw-rail__label">Delivery</div>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--lw-body)' }}>
                Email cadence follows the client&rsquo;s alert preferences. No Teams connection is
                configured — stated as such, not hidden.
              </p>
            </div>
          </section>

          <section className="lw-card">
            <div className="lw-card__head"><h3 className="lw-card__title" style={{ fontSize: 16 }}>Digest history</h3></div>
            <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {history.isLoading ? (
                <LwStateLoading rows={3} />
              ) : history.data?.rows.length ? (
                history.data.rows.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="lw-block"
                    style={{ textAlign: 'left', width: '100%', cursor: 'pointer', background: viewingRunId === r.id ? 'var(--lw-selected)' : undefined }}
                    onClick={() => setViewingRunId(r.id)}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {new Date(r.generatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </div>
                    <div className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-meta)' }}>
                      {r.itemCount} item{r.itemCount === 1 ? '' : 's'} · {r.decisionCount} decision{r.decisionCount === 1 ? '' : 's'}
                    </div>
                  </button>
                ))
              ) : (
                <p className="lw-state__body" style={{ maxWidth: 'none' }}>No prior digests yet.</p>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
