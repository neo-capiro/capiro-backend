/**
 * Search LegiWatch overlay (LEGIWATCH-V2-HANDOFF §2 header action).
 *
 * Federates the real server-side searches this module already has — the
 * Archive's full-text corpus (hearing identity, transcript text, witnesses,
 * public intelligence — W1-3) and the committee directory (W1's committee
 * registry, filtered client-side over its own already-complete ≤230-row
 * result set, never a per-keystroke request). Bills has no search endpoint
 * yet, so this does not claim bill coverage rather than faking it over a
 * paginated board fetch.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { LwModal } from './LwModal.js';
import { LwSkeleton } from '../lib/primitives.js';
import { useArchiveSearch } from '../lib/wave1-api.js';

interface CommitteeRow {
  systemCode: string;
  name: string;
  chamber: string;
  isSubcommittee: boolean;
}

export function LegiWatchSearchOverlay({
  onClose,
  onOpenHearing,
  onOpenCommittee,
}: {
  onClose: () => void;
  onOpenHearing: (id: string) => void;
  onOpenCommittee: (systemCode: string) => void;
}) {
  const api = useApi();
  const [raw, setRaw] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => {
    const t = window.setTimeout(() => setQ(raw.trim()), 250);
    return () => window.clearTimeout(t);
  }, [raw]);

  const hearings = useArchiveSearch({ q, page: 1, pageSize: 6 }, q.length >= 2);

  const committees = useQuery<{ rows: CommitteeRow[] }>({
    queryKey: ['lw-vnext', 'search-committees'],
    queryFn: async () => (await api.get<{ rows: CommitteeRow[] }>('/api/legiwatch/live-hearings/committees')).data,
    staleTime: 5 * 60_000,
  });
  const matchedCommittees = useMemo(() => {
    if (q.length < 2) return [];
    const needle = q.toLowerCase();
    return (committees.data?.rows ?? [])
      .filter((c) => c.name.toLowerCase().includes(needle) || c.systemCode.toLowerCase().includes(needle))
      .slice(0, 6);
  }, [committees.data, q]);

  // The 250ms debounce leaves `raw` ahead of `q`; without this the previous
  // query's hits stay on screen underneath the newly typed text.
  const isTyping = raw.trim() !== q;
  const isLoading = q.length >= 2 && (isTyping || hearings.isFetching || committees.isFetching);
  const hasAnyResults = (hearings.data?.rows.length ?? 0) > 0 || matchedCommittees.length > 0;

  return (
    <LwModal
      kind="search"
      eyebrow="LegiWatch"
      title="Search LegiWatch"
      subtitle="Hearings, transcripts, witnesses, intelligence, and committees."
      note="Bills search is not built yet — this does not include bill text."
      primaryLabel="Close"
      onPrimary={onClose}
      onClose={onClose}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="lw-search">
          <span aria-hidden="true" style={{ color: 'var(--lw-meta)' }}>⌕</span>
          <input
            autoFocus
            type="search"
            placeholder="Search hearings, transcripts, witnesses, committees…"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            aria-label="Search LegiWatch"
          />
        </div>

        {q.length < 2 ? (
          <p className="lw-state__body" style={{ maxWidth: 'none' }}>Type at least 2 characters to search.</p>
        ) : isLoading ? (
          <LwSkeleton height={120} />
        ) : !hasAnyResults ? (
          <p className="lw-state__body" style={{ maxWidth: 'none' }}>No matches for &ldquo;{q}&rdquo;.</p>
        ) : (
          <>
            {matchedCommittees.length ? (
              <section>
                <h3 className="lw-sect__title">Committees</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {matchedCommittees.map((c) => (
                    <button
                      key={c.systemCode}
                      type="button"
                      className="lw-block"
                      style={{ textAlign: 'left', width: '100%', cursor: 'pointer' }}
                      onClick={() => onOpenCommittee(c.systemCode)}
                    >
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{c.name}</div>
                      <div className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-meta)' }}>
                        {c.chamber.toUpperCase()} · {c.isSubcommittee ? 'SUBCOMMITTEE' : 'FULL COMMITTEE'}
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {hearings.data?.rows.length ? (
              <section>
                <h3 className="lw-sect__title">Hearings &amp; transcripts</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {hearings.data.rows.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className="lw-block"
                      style={{ textAlign: 'left', width: '100%', cursor: 'pointer' }}
                      onClick={() => onOpenHearing(r.id)}
                    >
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{r.title}</div>
                      <div className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-meta)' }}>
                        {r.committeeName ?? r.chamber.toUpperCase()} · {r.calendarDate ?? 'date not announced'}
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        )}
      </div>
    </LwModal>
  );
}
