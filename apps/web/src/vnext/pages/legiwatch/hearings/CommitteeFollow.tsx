/**
 * LegiWatch V2 Wave 1 (W1-4) — committee following and intelligence history.
 *
 * A committee follow is TENANT/USER state pointing at a canonical committee
 * system code. No committee facts are duplicated into it; the Committee Room
 * keeps rendering the canonical directory data and this only adds interest and
 * notification preference on top.
 *
 * Intelligence history is derived from the committee's OWN canonical hearings.
 * Nothing is fabricated: a committee whose hearings produced no findings shows
 * the corpus counts that explain why, rather than an unexplained empty list.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import { LwModal } from '../overlays/LwModal.js';
import { LwButton, LwPill, LwSkeleton } from '../lib/primitives.js';
import { LwStateUnavailable } from '../states/SystemStates.js';
import {
  useCommitteeFollow,
  useCommitteeIntelligenceHistory,
  useSaveCommitteeFollow,
  useUnfollowCommittee,
  w1Error,
} from '../lib/wave1-api.js';

const COMMITTEE_NOTIFICATIONS = [
  {
    key: 'notifyOnNewHearing' as const,
    label: 'New hearings scheduled',
    hint: 'The committee announces a new proceeding.',
  },
  {
    key: 'notifyOnScheduleChange' as const,
    label: 'Schedule changes',
    hint: 'A proceeding’s date, time, location or witness list changes.',
  },
  {
    key: 'notifyOnTranscriptReady' as const,
    label: 'Transcript ready',
    hint: 'A canonical transcript becomes available for one of its proceedings.',
  },
  {
    key: 'notifyOnHighPriorityMatch' as const,
    label: 'High-priority client match',
    hint: 'A HIGH-relevance finding is detected for a selected client.',
  },
  {
    key: 'notifyOnPublication' as const,
    label: 'Committee publications',
    hint: 'The committee publishes documents, testimony or other material.',
  },
];

/** The Follow control for a Committee Room header. */
export function CommitteeFollowControl({
  systemCode,
  committeeName,
}: {
  systemCode: string;
  committeeName: string;
}) {
  const follow = useCommitteeFollow(systemCode);
  const [open, setOpen] = useState(false);

  return (
    <>
      <LwButton
        variant={follow.data?.following ? undefined : 'primary'}
        onClick={() => setOpen(true)}
        disabled={follow.isLoading}
      >
        {follow.isLoading
          ? 'Loading…'
          : follow.data?.following
            ? 'Following · edit'
            : 'Follow committee'}
      </LwButton>
      {open ? (
        <CommitteeFollowDialog
          systemCode={systemCode}
          committeeName={committeeName}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

export function CommitteeFollowDialog({
  systemCode,
  committeeName,
  onClose,
}: {
  systemCode: string;
  committeeName: string;
  onClose: () => void;
}) {
  const api = useApi();
  const apiScope = useApiScope();
  const existing = useCommitteeFollow(systemCode);
  const save = useSaveCommitteeFollow(systemCode);
  const unfollow = useUnfollowCommittee(systemCode);

  const clients = useQuery<Client[]>({
    queryKey: ['clients', apiScope],
    queryFn: async () => (await api.get<Client[]>('/api/clients')).data,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const [selected, setSelected] = useState<string[]>([]);
  const [prefs, setPrefs] = useState({
    notifyOnNewHearing: true,
    notifyOnScheduleChange: true,
    notifyOnTranscriptReady: false,
    notifyOnHighPriorityMatch: true,
    notifyOnPublication: true,
  });
  const [hydrated, setHydrated] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Rehydrate from what is actually persisted, once.
  useEffect(() => {
    if (!existing.data || hydrated) return;
    setSelected(existing.data.clientIds);
    setPrefs({
      notifyOnNewHearing: existing.data.notifyOnNewHearing,
      notifyOnScheduleChange: existing.data.notifyOnScheduleChange,
      notifyOnTranscriptReady: existing.data.notifyOnTranscriptReady,
      notifyOnHighPriorityMatch: existing.data.notifyOnHighPriorityMatch,
      // Server default is true; tolerate a pre-contract response that omits it.
      notifyOnPublication: existing.data.notifyOnPublication ?? true,
    });
    setHydrated(true);
  }, [existing.data, hydrated]);

  const activeClients = useMemo(
    () => (clients.data ?? []).filter((c) => c.status !== 'archived'),
    [clients.data],
  );
  const following = existing.data?.following ?? false;
  const busy = save.isPending || unfollow.isPending;

  return (
    <LwModal
      kind="follow"
      eyebrow="Follow committee"
      title={following ? 'Edit committee follow' : 'Follow this committee'}
      subtitle={committeeName}
      note="Following a committee notifies you. It does not schedule capture."
      primaryLabel={busy ? 'Saving…' : following ? 'Save changes' : 'Follow'}
      onPrimary={() => {
        setError(null);
        save.mutate(
          { clientIds: selected, ...prefs },
          { onSuccess: () => onClose(), onError: (err) => setError(w1Error(err)) },
        );
      }}
      primaryDisabled={busy}
      onClose={onClose}
      dirty={dirty && !busy}
      width={560}
    >
      {existing.isLoading ? (
        <p className="lw-card__meta">Loading your committee follow settings…</p>
      ) : existing.isError ? (
        <p role="alert" className="lw-card__meta">
          Your committee follow settings could not be loaded. {w1Error(existing.error)}
        </p>
      ) : (
        <>
          <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="lw-eyebrow" style={{ marginBottom: 8 }}>
              Clients (optional)
            </legend>
            <p className="lw-card__meta" style={{ marginTop: 0 }}>
              Selecting clients scopes client-specific alerts. Committee-level updates arrive
              either way.
            </p>
            {clients.isError ? (
              <p role="alert" className="lw-card__meta">
                Your client list could not be loaded, so clients cannot be selected right now.
              </p>
            ) : (
              <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}>
                {activeClients.map((client) => (
                  <li key={client.id}>
                    <label style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0' }}>
                      <input
                        type="checkbox"
                        checked={selected.includes(client.id)}
                        onChange={() => {
                          setDirty(true);
                          setSelected((prev) =>
                            prev.includes(client.id)
                              ? prev.filter((c) => c !== client.id)
                              : [...prev, client.id],
                          );
                        }}
                      />
                      <span>{client.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>

          <fieldset style={{ border: 0, margin: '18px 0 0', padding: 0 }}>
            <legend className="lw-eyebrow" style={{ marginBottom: 8 }}>
              Notify me about
            </legend>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {COMMITTEE_NOTIFICATIONS.map((opt) => (
                <li key={opt.key}>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 0' }}>
                    <input
                      type="checkbox"
                      checked={prefs[opt.key]}
                      onChange={() => {
                        setDirty(true);
                        setPrefs((prev) => ({ ...prev, [opt.key]: !prev[opt.key] }));
                      }}
                    />
                    <span>
                      <span style={{ display: 'block' }}>{opt.label}</span>
                      <span className="lw-card__meta" style={{ fontSize: 12 }}>
                        {opt.hint}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>

          {following ? (
            <div style={{ marginTop: 18 }}>
              <button
                type="button"
                className="lw-btn"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  unfollow.mutate(undefined, {
                    onSuccess: () => onClose(),
                    onError: (err) => setError(w1Error(err)),
                  });
                }}
              >
                {unfollow.isPending ? 'Removing…' : 'Unfollow committee'}
              </button>
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="lw-card__meta" style={{ marginTop: 12, color: 'var(--lw-danger, #b42318)' }}>
              {error}
            </p>
          ) : null}
        </>
      )}
    </LwModal>
  );
}

/** Intelligence History — the committee's own hearings' public findings. */
export function CommitteeIntelligenceHistorySection({
  systemCode,
  clientId,
}: {
  systemCode: string;
  clientId: string;
}) {
  const navigate = useNavigate();
  // Keyset pagination is forward-only by construction; a small stack of prior
  // cursors is what makes "← Previous" possible without an offset that a
  // continuously-arriving corpus would make unstable (see W2-1).
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([undefined]);
  const [includeSubcommittees, setIncludeSubcommittees] = useState(false);
  const [insightType, setInsightType] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [speaker, setSpeaker] = useState('');
  const [agency, setAgency] = useState('');
  const [bill, setBill] = useState('');
  const [programElement, setProgramElement] = useState('');
  const cursor = cursorStack[cursorStack.length - 1];

  const resetToFirstPage = () => setCursorStack([undefined]);

  const history = useCommitteeIntelligenceHistory(systemCode, {
    clientId: clientId || undefined,
    includeSubcommittees,
    insightType: insightType || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    speaker: speaker || undefined,
    agency: agency || undefined,
    bill: bill || undefined,
    programElement: programElement || undefined,
    cursor,
    pageSize: 20,
  });

  return (
    <section className="lw-card" style={{ padding: 18 }} aria-label="Intelligence history">
      <div className="lw-card__head">
        <h2 className="lw-card__title">Intelligence history</h2>
        <span className="lw-card__meta">
          {history.data ? `${history.data.total} findings` : ''}
        </span>
      </div>

      <div
        role="group"
        aria-label="Intelligence history filters"
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '0 0 14px' }}
      >
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={includeSubcommittees}
            onChange={(e) => {
              setIncludeSubcommittees(e.target.checked);
              resetToFirstPage();
            }}
          />
          Include subcommittees
        </label>
        <select
          aria-label="Intelligence type"
          value={insightType}
          onChange={(e) => {
            setInsightType(e.target.value);
            resetToFirstPage();
          }}
        >
          <option value="">Any type</option>
          {[
            'QUESTION',
            'COMMITMENT',
            'DEADLINE',
            'FUNDING_AMOUNT',
            'BILL_REFERENCE',
            'PROGRAM_ELEMENT_REFERENCE',
            'AGENCY_REFERENCE',
            'POLICY_POSITION',
            'KEY_QUOTE',
            'MENTION',
          ].map((t) => (
            <option key={t} value={t}>
              {t.replace(/_/g, ' ').toLowerCase()}
            </option>
          ))}
        </select>
        <input
          type="date"
          aria-label="From date"
          value={dateFrom}
          onChange={(e) => {
            setDateFrom(e.target.value);
            resetToFirstPage();
          }}
        />
        <input
          type="date"
          aria-label="To date"
          value={dateTo}
          onChange={(e) => {
            setDateTo(e.target.value);
            resetToFirstPage();
          }}
        />
        <input
          type="search"
          aria-label="Speaker"
          placeholder="Speaker"
          value={speaker}
          onChange={(e) => {
            setSpeaker(e.target.value);
            resetToFirstPage();
          }}
          style={{ width: 120 }}
        />
        <input
          type="search"
          aria-label="Agency"
          placeholder="Agency"
          value={agency}
          onChange={(e) => {
            setAgency(e.target.value);
            resetToFirstPage();
          }}
          style={{ width: 120 }}
        />
        <input
          type="search"
          aria-label="Bill"
          placeholder="Bill"
          value={bill}
          onChange={(e) => {
            setBill(e.target.value);
            resetToFirstPage();
          }}
          style={{ width: 100 }}
        />
        <input
          type="search"
          aria-label="Program element"
          placeholder="Program element"
          value={programElement}
          onChange={(e) => {
            setProgramElement(e.target.value);
            resetToFirstPage();
          }}
          style={{ width: 140 }}
        />
      </div>

      {history.isLoading ? (
        <LwSkeleton height={120} />
      ) : history.isError ? (
        <LwStateUnavailable
          source="Intelligence history"
          reason={`This committee's intelligence history is unavailable. ${w1Error(history.error)}`}
          onRetry={() => void history.refetch()}
        />
      ) : history.data && history.data.rows.length === 0 ? (
        // Honest unavailability: say WHY it is empty rather than implying
        // nothing has happened at this committee. A nonzero pendingExtraction-
        // Jobs means extraction is still PROCESSING and more may still land —
        // that reads differently from "extraction ran and found nothing."
        <p className="lw-card__meta" style={{ fontSize: 13 }}>
          {history.data.corpus.pendingExtractionJobs > 0
            ? 'Intelligence extraction is in progress for this committee — findings appear here as segments are processed.'
            : <>
                No intelligence has been extracted for this committee yet.{' '}
                {history.data.corpus.hearingsWithTranscript === 0
                  ? `None of its ${history.data.corpus.hearings} recorded proceeding${history.data.corpus.hearings === 1 ? ' has' : 's have'} a transcript to extract from.`
                  : `${history.data.corpus.hearingsWithTranscript} of its ${history.data.corpus.hearings} proceedings have transcripts.`}
              </>}
        </p>
      ) : history.data ? (
        <>
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            {history.data.rows.map((row) => (
              <li key={row.id} style={{ borderLeft: '2px solid var(--lw-brand-dot)', paddingLeft: 10 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <LwPill tone="brand" size="22">
                    {row.insightType.replace(/_/g, ' ')}
                  </LwPill>
                  <strong style={{ fontSize: 14 }}>{row.title}</strong>
                </div>
                <p style={{ margin: '4px 0 0', fontSize: 13 }}>{row.summary}</p>
                <button
                  type="button"
                  className="lw-backlink"
                  style={{ padding: 0, marginTop: 4 }}
                  onClick={() => navigate(row.detailPath)}
                >
                  {row.hearingTitle}
                  {row.hearingDate ? ` · ${row.hearingDate}` : ''} →
                </button>
              </li>
            ))}
          </ul>

          <nav
            aria-label="Intelligence history pagination"
            style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}
          >
            <LwButton
              onClick={() => setCursorStack((stack) => stack.slice(0, -1))}
              disabled={cursorStack.length <= 1}
            >
              ← Previous
            </LwButton>
            <span className="lw-card__meta">Page {cursorStack.length}</span>
            <LwButton
              onClick={() =>
                setCursorStack((stack) =>
                  history.data?.nextCursor ? [...stack, history.data.nextCursor] : stack,
                )
              }
              disabled={!history.data.hasMore}
            >
              Next →
            </LwButton>
          </nav>
        </>
      ) : null}
    </section>
  );
}
