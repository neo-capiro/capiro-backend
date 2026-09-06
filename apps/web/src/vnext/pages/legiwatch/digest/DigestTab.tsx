/**
 * Digest tab (LEGIWATCH-V2-HANDOFF §5.8) — the persistent morning-brief
 * product, with real generation, persistence and history (Wave 3;
 * legiwatch-digest.service.ts). `Send now` stays disabled — §1.5, no
 * external send until the Stage H security review — and `Export PDF` is the
 * browser's own print-to-PDF (a real PDF, no server-side rendering
 * dependency introduced for one feature).
 */
import { useState, type ReactNode } from 'react';
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
            <p className="lw-state__body">No matching developments were recorded in this window.</p>
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
            <p className="lw-state__body">No high-priority decisions were identified in this window.</p>
          ) : (
            content.decisionsRequired.map((it) => (
              <div key={it.id} className="lw-block" style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{it.title}</span>
                  <LwPill tone="error" size="22">PRIORITY</LwPill>
                </div>
                {it.recommendedAction ? (
                  <p className="lw-block__body" style={{ marginTop: 4 }}>{it.recommendedAction}</p>
                ) : null}
              </div>
            ))
          )}
        </Section>

        <Section title="Upcoming public hearings">
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
            {' '}{content.provenance.officialRecordCount} source alert{content.provenance.officialRecordCount === 1 ? '' : 's'} ·
            {' '}{content.provenance.captureCount} hearing-linked alert{content.provenance.captureCount === 1 ? '' : 's'}.
          </p>
        </footer>
      </div>
    </section>
  );
}

export function DigestTab({ scope }: { scope: string }) {
  // A client change must discard selection and mutation state, including a
  // generation that completes after its original scope has been left.
  return <ScopedDigestTab key={scope} scope={scope} />;
}

function ScopedDigestTab({ scope }: { scope: string }) {
  const [viewingRunId, setViewingRunId] = useState<string | null>(null);
  const generate = useGenerateDigest(scope);
  const history = useDigestHistory(scope);
  const selectedRunId = viewingRunId ?? history.data?.rows[0]?.id ?? null;
  const viewedRun = useDigestRun(selectedRunId);
  const schedule = useDigestSchedule(scope);
  const putSchedule = usePutDigestSchedule(scope);

  // Generated content is only a fast path for THAT selected run. Choosing
  // history must never leave the most recently generated brief on screen.
  const content = generate.data?.id === selectedRunId ? generate.data : viewedRun.data;
  const isLoading = !content && (history.isLoading || (Boolean(selectedRunId) && viewedRun.isLoading));
  const hasNoHistoryYet = history.isSuccess && history.data.rows.length === 0 && !selectedRunId;
  const generateNow = () => generate.mutate(undefined, {
    onSuccess: (run) => setViewingRunId(run.id),
  });

  return (
    <div className="lw-body">
      <div className="lw-feed-cols">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          {isLoading ? (
            <div className="lw-card" style={{ padding: 18 }}><LwStateLoading rows={4} /></div>
          ) : history.isError && !content ? (
            <LwStateUnavailable source="Digest history" reason="Saved briefs could not be loaded." onRetry={() => void history.refetch()} />
          ) : viewedRun.isError && !content ? (
            <LwStateUnavailable source="Digest" reason="The selected brief could not be loaded." onRetry={() => void viewedRun.refetch()} />
          ) : generate.isError && !content ? (
            <LwStateUnavailable source="Digest" reason="The brief could not be generated." onRetry={generateNow} />
          ) : content ? (
            <Brief content={content} />
          ) : hasNoHistoryYet ? (
            <div className="lw-card" style={{ padding: 24, textAlign: 'center' }}>
              <p className="lw-state__body" style={{ maxWidth: 'none', marginBottom: 12 }}>
                No digest has been generated yet for this scope.
              </p>
              <LwButton variant="primary" onClick={generateNow} disabled={generate.isPending}>
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
                onClick={generateNow}
                disabled={generate.isPending}
              >
                {generate.isPending ? 'Generating…' : 'Generate now'}
              </LwButton>
              <LwButton onClick={() => window.print()} disabled={!content}>Export PDF</LwButton>
              <LwButton
                disabled
                title="Send now is disabled until the Stage H security review ships. The digest produces an internal artefact pending human action."
              >
                Send now
              </LwButton>
            </div>
            {generate.isError && content ? (
              <p role="alert" className="lw-state__body" style={{ padding: '0 16px 16px' }}>
                The new brief could not be generated. The previously selected brief is still shown.
              </p>
            ) : null}

            <div className="lw-rail__sect">
              <div className="lw-rail__label">Saved delivery preference</div>
              {schedule.isLoading ? (
                <p style={{ margin: 0, fontSize: 12, color: 'var(--lw-body)' }}>Loading…</p>
              ) : schedule.isError ? (
                <LwStateUnavailable source="Digest schedule" reason="The schedule could not be loaded." onRetry={() => void schedule.refetch()} />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                    <span style={{ width: 70 }}>Cadence</span>
                    <select
                      disabled={putSchedule.isPending}
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
                      Preference saved: {schedule.data.cadence} at {String(schedule.data.hourUtc).padStart(2, '0')}:00 UTC. Automatic delivery is not active.
                    </p>
                  ) : null}
                </div>
              )}
              {putSchedule.isError ? <p role="alert" className="lw-state__body">The schedule could not be saved.</p> : null}
            </div>

            <div className="lw-rail__sect">
              <div className="lw-rail__label">Delivery</div>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--lw-body)' }}>
                Generate briefs here on demand. Delivery preferences are stored for future use;
                they do not currently generate or email a digest automatically.
              </p>
            </div>
          </section>

          <section className="lw-card">
            <div className="lw-card__head"><h3 className="lw-card__title" style={{ fontSize: 16 }}>Digest history</h3></div>
            <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {history.isLoading ? (
                <LwStateLoading rows={3} />
              ) : history.isError ? (
                <p role="alert" className="lw-state__body">Digest history could not be loaded.</p>
              ) : history.data?.rows.length ? (
                history.data.rows.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="lw-block"
                    style={{ textAlign: 'left', width: '100%', cursor: 'pointer', background: selectedRunId === r.id ? 'var(--lw-selected)' : undefined }}
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
