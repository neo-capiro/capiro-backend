/*
 * Strategies vNext — Steward review (/strategies/context/steward),
 * STRATEGIES-HANDOFF §7.7.
 *
 * The human review surface over the Context Steward's extracted facts
 * (sp_context_fact) and detected disagreements (sp_context_conflict): a dark
 * health band (per-client context health when a client is selected, library
 * aggregates otherwise), the conflicts list (open first, candidates side by
 * side, Dismiss / Resolve → the §7.10f overlay route), and the facts ledger
 * (state tabs + search, Reject on active facts). A ?fact=<id> deep-link (from
 * the editor's 'Grounded in' chips) highlights and scrolls to that row,
 * switching to its state tab when needed.
 *
 * Governance (§7.7 must-nots):
 * - No conflict resolves without a rationale — resolution (with its required
 *   note) lives in the Resolve-conflict overlay; this screen only links there.
 * - No inline edit of a source value, no fact delete. Rejection removes the
 *   fact from agent reasoning and never edits the source document.
 * - Dismissal is itself a recorded decision; both facts stay queryable.
 *
 * Gaps (§13, reported — no endpoint exists, nothing fabricated):
 * - Fact RESTORE (§4.1 #9): POST /context/facts/:id/reject 409s on any
 *   non-active fact; there is no restore route. The Rejected tab stays
 *   reachable; the Restore action is omitted until the backend lands.
 * - "Mark client reviewed", a numeric health score and source coverage
 *   (§7.7 band): no server scalar/endpoint. The band shows the real
 *   ContextHealth shape (status · missing required · stale documents · open
 *   material conflicts) instead.
 * - Conflict type/question/detection-location fields (§8.10): the server row
 *   carries `material` + the two candidate facts only; the card renders what
 *   the server has (material flag, candidate provenance) and logs the rest.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroBadge } from '../../../components/badges/index.js';
import {
  CapiroEmptyState,
  CapiroErrorState,
  CapiroSkeleton,
} from '../../../components/feedback/index.js';
import { useCapiroToast } from '../../../components/feedback/toast.js';
import { CapiroSearchIcon } from '../../../components/icons/index.js';
import { CapiroSelect } from '../../../components/fields/index.js';
import { CapiroTabs } from '../../../components/menus/index.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../../components/tables/index.js';
import {
  clientName,
  useClientsLite,
  useContextConflicts,
  useContextFacts,
  useContextHealth,
  useDismissContextConflict,
  useRejectContextFact,
} from '../strategies-api.js';
import { errorMessage } from '../../../../lib/error-message.js';
import { clip, templateLabel } from '../../../../pages/strategy/context/context-utils.js';
import type {
  ContextConflict,
  ContextFact,
  ContextFactState,
} from '../../../../pages/strategy/types.js';
import './steward-review.css';

const FACT_STATES: readonly { id: ContextFactState; label: string }[] = [
  { id: 'active', label: 'Active' },
  { id: 'stale', label: 'Stale' },
  { id: 'superseded', label: 'Superseded' },
  { id: 'rejected', label: 'Rejected' },
];

const FACT_STATE_TONE: Record<ContextFactState, 'success' | 'warning' | 'neutral' | 'danger'> = {
  active: 'success',
  stale: 'warning',
  superseded: 'neutral',
  rejected: 'danger',
};

const CONFLICT_STATE_TONE: Record<ContextConflict['state'], 'warning' | 'success' | 'neutral'> = {
  open: 'warning',
  resolved: 'success',
  dismissed: 'neutral',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ISO (date or datetime) → "Aug 7". Tolerates garbage. */
function fmtDay(iso: string | null): string | null {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split('-');
  if (!y || !m || !d) return null;
  const label = MONTHS[Number(m) - 1];
  if (!label || Number.isNaN(Number(d))) return null;
  return `${label} ${Number(d)}`;
}

function isForbidden(error: unknown): boolean {
  return (error as { response?: { status?: number } } | null)?.response?.status === 403;
}

export function StewardReviewVNext() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useCapiroToast();

  const facts = useContextFacts();
  const conflicts = useContextConflicts();
  const clients = useClientsLite();
  const reject = useRejectContextFact();
  const dismiss = useDismissContextConflict();

  const clientFilter = searchParams.get('client') ?? 'all';
  const stateFilter = (searchParams.get('state') ?? 'active') as ContextFactState;
  const query = searchParams.get('q') ?? '';

  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ kind: 'reject' | 'dismiss'; id: string } | null>(
    null,
  );
  const highlightRowRef = useRef<HTMLTableRowElement | null>(null);

  const healthClientId = clientFilter !== 'all' && clientFilter !== 'firm' ? clientFilter : null;
  const health = useContextHealth(healthClientId);

  const setParam = (key: string, value: string | null) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (
          value === null ||
          value === '' ||
          (key === 'client' && value === 'all') ||
          (key === 'state' && value === 'active')
        ) {
          next.delete(key);
        } else {
          next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );
  };

  const clientLabel = (id: string | null) =>
    id === null ? 'Firm-wide' : clientName(clients.data, id);

  /* ?fact=<id> deep-link (the editor's 'Grounded in' chips): highlight the row
   * and — when it is outside the current state tab — switch to its state.
   * Consumed once per param value so a later manual filter change is not fought. */
  const consumedFactParam = useRef<string | null>(null);
  useEffect(() => {
    const param = searchParams.get('fact');
    if (!param || !facts.data || consumedFactParam.current === param) return;
    consumedFactParam.current = param;
    const hit = facts.data.find((fact) => fact.id === param);
    if (!hit) {
      toast.error('That fact could not be found — it may have been removed.');
      return;
    }
    setHighlightId(hit.id);
    setParam('state', hit.state);
    setParam('client', 'all'); // never let the client filter hide the deep-linked row
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, facts.data]);

  /* Scroll the highlighted row into view once it is actually rendered. */
  useEffect(() => {
    if (highlightId) {
      highlightRowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [highlightId, stateFilter, clientFilter, facts.data]);

  const matchesClient = (clientId: string | null) =>
    clientFilter === 'all' || (clientFilter === 'firm' ? clientId === null : clientId === clientFilter);

  /* Client options derive from the ledger itself (facts ∪ conflicts), like the
   * canonical steward; names resolve through the shared clients-lite query. */
  const clientOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const fact of facts.data ?? []) if (fact.clientId) ids.add(fact.clientId);
    for (const conflict of conflicts.data ?? []) if (conflict.clientId) ids.add(conflict.clientId);
    return [...ids].map((id) => ({ value: id, label: clientName(clients.data, id) }));
  }, [facts.data, conflicts.data, clients.data]);
  const hasFirmRows =
    (facts.data ?? []).some((fact) => fact.clientId === null) ||
    (conflicts.data ?? []).some((conflict) => conflict.clientId === null);

  const stateCounts = useMemo(() => {
    const counts = { active: 0, stale: 0, superseded: 0, rejected: 0 } as Record<
      ContextFactState,
      number
    >;
    for (const fact of facts.data ?? []) {
      if (matchesClient(fact.clientId)) counts[fact.state] += 1;
    }
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facts.data, clientFilter]);

  const visibleFacts = useMemo(() => {
    const term = query.trim().toLowerCase();
    return (facts.data ?? []).filter((fact) => {
      if (fact.state !== stateFilter || !matchesClient(fact.clientId)) return false;
      if (term && !`${fact.fact} ${fact.documentTitle ?? ''} ${fact.sourceRef}`.toLowerCase().includes(term))
        return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facts.data, stateFilter, clientFilter, query]);

  /* Conflicts: open first, then newest; the client filter rides the conflict's
   * derived clientId (a conflict with no client info always stays visible). */
  const visibleConflicts = useMemo(() => {
    const rows = (conflicts.data ?? []).filter((conflict) =>
      conflict.clientId === null ? true : matchesClient(conflict.clientId),
    );
    return rows.sort(
      (a, b) =>
        (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) ||
        (a.createdAt < b.createdAt ? 1 : -1),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflicts.data, clientFilter]);
  const openConflictCount = visibleConflicts.filter((conflict) => conflict.state === 'open').length;

  /* Candidate provenance joins: the conflict row embeds display fields only;
   * the ledger carries documentId / sourceRef / confidence for the same fact. */
  const factById = useMemo(() => {
    const map = new Map<string, ContextFact>();
    for (const fact of facts.data ?? []) map.set(fact.id, fact);
    return map;
  }, [facts.data]);

  const onRejectFact = (fact: ContextFact) => {
    if (reject.isPending) return;
    reject.mutate(fact.id, {
      onSuccess: () => {
        setConfirming(null);
        toast.success('Fact rejected. The source document is unchanged.');
      },
      onError: (err) => {
        setConfirming(null);
        toast.error(errorMessage(err, 'Could not reject the fact.'));
      },
    });
  };

  const onDismissConflict = (conflict: ContextConflict) => {
    if (dismiss.isPending) return;
    dismiss.mutate(conflict.id, {
      onSuccess: () => {
        setConfirming(null);
        toast.success('Conflict dismissed — both facts stay active and queryable.');
      },
      onError: (err) => {
        setConfirming(null);
        toast.error(errorMessage(err, 'Could not dismiss the conflict.'));
      },
    });
  };

  return (
    <div className="st-steward">
      {/* ---- header ------------------------------------------------------- */}
      <header className="st-steward__header">
        <Link className="st-steward__back" to="/strategies/context">
          ‹ Context library
        </Link>
        <div className="st-steward__title-row">
          <div className="st-steward__title-block">
            <div className="st-steward__eyebrow">Grounded agent context</div>
            <h1 className="st-steward__title">Steward review</h1>
            <p className="st-steward__lede">
              Facts the Context Steward extracted from your context documents, with every
              disagreement it detected. Resolving a conflict or rejecting a fact never edits a
              source document — and the Steward never touches a strategy.
            </p>
          </div>
          <CapiroSelect
            label="Client"
            aria-label="Filter by client"
            value={clientFilter}
            onChange={(event) => setParam('client', event.target.value)}
            options={[
              { value: 'all', label: 'All clients' },
              ...(hasFirmRows ? [{ value: 'firm', label: 'Firm-wide' }] : []),
              ...clientOptions,
            ]}
          />
        </div>
      </header>

      <main className="st-steward__body">
        {/* ---- dark health band ------------------------------------------ */}
        <section className="st-steward__band" aria-label="Context health">
          <div className="st-steward__band-head">
            <span className="st-steward__band-label">Context health</span>
            <strong>{healthClientId ? clientLabel(healthClientId) : 'All clients'}</strong>
          </div>
          {healthClientId ? (
            health.isLoading ? (
              <div className="st-steward__band-metrics">
                {[0, 1, 2].map((metric) => (
                  <CapiroSkeleton key={metric} width={120} height={30} />
                ))}
              </div>
            ) : health.isError ? (
              <div className="st-steward__band-state" role="status">
                <span>
                  {isForbidden(health.error)
                    ? 'You don’t have access to this client’s context health.'
                    : 'Context health could not be loaded.'}
                </span>
                <CapiroButton variant="quiet" size="compact" onClick={() => void health.refetch()}>
                  Retry
                </CapiroButton>
              </div>
            ) : health.data ? (
              <>
                <div className="st-steward__band-metrics">
                  <span className="st-steward__band-metric">
                    <CapiroBadge
                      tone={
                        health.data.status === 'ok'
                          ? 'success'
                          : health.data.status === 'degraded'
                            ? 'warning'
                            : 'danger'
                      }
                      dot={<span className="st-steward__dot" aria-hidden="true" />}
                    >
                      {health.data.status === 'ok'
                        ? 'Healthy'
                        : health.data.status === 'degraded'
                          ? 'Degraded'
                          : 'Conflicted'}
                    </CapiroBadge>
                  </span>
                  <BandMetric value={health.data.staleDocuments} label="Stale documents" />
                  <BandMetric
                    value={health.data.openMaterialConflicts.length}
                    label="Open material conflicts"
                    alert={health.data.openMaterialConflicts.length > 0}
                  />
                  <BandMetric value={health.data.missingRequired.length} label="Missing required" />
                </div>
                {health.data.missingRequired.length > 0 ? (
                  <div className="st-steward__band-missing">
                    <span className="st-steward__band-missing-label">Missing required templates</span>
                    {health.data.missingRequired.slice(0, 4).map((key) => (
                      <span key={key} className="st-steward__band-missing-chip st-mono">
                        {key}
                      </span>
                    ))}
                    {health.data.missingRequired.length > 4 ? (
                      <span className="st-steward__band-missing-more">
                        +{health.data.missingRequired.length - 4} more
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null
          ) : (
            <div className="st-steward__band-metrics">
              <BandMetric
                value={(facts.data ?? []).filter((fact) => fact.state === 'active').length}
                label="Active facts"
                loading={facts.isLoading}
                failed={facts.isError}
              />
              <BandMetric
                value={(facts.data ?? []).filter((fact) => fact.state === 'stale').length}
                label="Stale facts"
                loading={facts.isLoading}
                failed={facts.isError}
              />
              <BandMetric
                value={(conflicts.data ?? []).filter((conflict) => conflict.state === 'open').length}
                label="Open conflicts"
                loading={conflicts.isLoading}
                failed={conflicts.isError}
                alert={openConflictCount > 0}
              />
              <span className="st-steward__band-hint">
                Pick a client above to see its context health — required templates, staleness and
                material conflicts.
              </span>
            </div>
          )}
        </section>

        {/* ---- conflicts ---------------------------------------------------- */}
        <section className="st-steward__section" aria-label="Conflicts">
          <div className="st-steward__section-head">
            <h2 className="st-steward__section-title">Conflicts</h2>
            <span className="st-steward__section-count">
              {conflicts.isError
                ? 'Unavailable'
                : `${openConflictCount} open · ${visibleConflicts.length} total`}
            </span>
          </div>

          {conflicts.isRefetchError && conflicts.data ? (
            <div className="st-steward__note is-warning" role="status">
              Refresh failed — showing data from{' '}
              {new Date(conflicts.dataUpdatedAt).toLocaleTimeString()}.
            </div>
          ) : null}

          {conflicts.isLoading ? (
            <div className="st-steward__conflicts" aria-label="Loading conflicts">
              {[0, 1].map((card) => (
                <div className="st-steward__conflict" key={card}>
                  <CapiroSkeleton width={180} height={12} />
                  <div className="st-steward__candidates">
                    <CapiroSkeleton height={86} />
                    <CapiroSkeleton height={86} />
                  </div>
                </div>
              ))}
            </div>
          ) : conflicts.isError ? (
            isForbidden(conflicts.error) ? (
              <CapiroEmptyState
                title="You don't have access to steward conflicts"
                description="Conflict review needs the Context Steward feature. Ask an admin to enable it for your account."
              />
            ) : (
              <CapiroErrorState
                title="Conflicts could not be loaded"
                description="The conflict list request failed. No decisions are affected."
                onRetry={() => void conflicts.refetch()}
              />
            )
          ) : visibleConflicts.length === 0 ? (
            <CapiroEmptyState
              title={
                (conflicts.data?.length ?? 0) > 0
                  ? 'No conflicts match this filter'
                  : 'No open conflicts'
              }
              description={
                (conflicts.data?.length ?? 0) > 0
                  ? 'Try another client filter — the context agrees with itself here.'
                  : 'Resolved decisions stay queryable in history.'
              }
            />
          ) : (
            <div className="st-steward__conflicts">
              {visibleConflicts.map((conflict) => (
                <ConflictCard
                  key={conflict.id}
                  conflict={conflict}
                  factById={factById}
                  clientLabel={clientLabel(conflict.clientId)}
                  confirming={confirming?.kind === 'dismiss' && confirming.id === conflict.id}
                  busy={dismiss.isPending}
                  onAskDismiss={() => setConfirming({ kind: 'dismiss', id: conflict.id })}
                  onCancelDismiss={() => setConfirming(null)}
                  onDismiss={() => onDismissConflict(conflict)}
                />
              ))}
            </div>
          )}
        </section>

        {/* ---- facts ledger ------------------------------------------------- */}
        <section className="st-steward__section" aria-label="Facts">
          <div className="st-steward__section-head">
            <h2 className="st-steward__section-title">Facts</h2>
            <span className="st-steward__section-spacer" />
            <CapiroTabs
              label="Filter facts by state"
              activeId={stateFilter}
              onChange={(id) => setParam('state', id)}
              items={FACT_STATES.map((state) => ({
                id: state.id,
                label: facts.isError
                  ? state.label
                  : `${state.label} · ${stateCounts[state.id]}`,
              }))}
            />
            <label className="st-steward__search">
              <CapiroSearchIcon size={0.9} />
              <input
                value={query}
                onChange={(event) => setParam('q', event.target.value)}
                placeholder="Search facts"
                aria-label="Search facts"
              />
            </label>
          </div>

          {facts.isRefetchError && facts.data ? (
            <div className="st-steward__note is-warning" role="status">
              Refresh failed — showing data from {new Date(facts.dataUpdatedAt).toLocaleTimeString()}.
            </div>
          ) : null}

          {facts.isLoading ? (
            <CapiroTableWrap>
              <CapiroTable aria-label="Loading facts">
                <CapiroTableBody>
                  {[0, 1, 2, 3].map((row) => (
                    <tr key={row}>
                      <CapiroTableCell colSpan={7}>
                        <CapiroSkeleton width={`${86 - row * 12}%`} height={14} />
                      </CapiroTableCell>
                    </tr>
                  ))}
                </CapiroTableBody>
              </CapiroTable>
            </CapiroTableWrap>
          ) : facts.isError ? (
            isForbidden(facts.error) ? (
              <CapiroEmptyState
                title="You don't have access to the fact ledger"
                description="Extracted facts need the Context Steward feature. Ask an admin to enable it for your account."
              />
            ) : (
              <CapiroErrorState
                title="The fact ledger could not be loaded"
                description="The facts request failed. Extracted facts are unchanged."
                onRetry={() => void facts.refetch()}
              />
            )
          ) : visibleFacts.length === 0 ? (
            <CapiroEmptyState
              title={
                (facts.data?.length ?? 0) > 0
                  ? `No ${stateFilter} facts match this filter`
                  : 'No facts yet'
              }
              description={
                (facts.data?.length ?? 0) > 0
                  ? 'Try another client, state tab, or search term.'
                  : 'Open a context document and run Extract facts to start the ledger.'
              }
              action={
                (facts.data?.length ?? 0) === 0 ? (
                  <CapiroButton
                    variant="primary"
                    size="compact"
                    onClick={() => navigate('/strategies/context')}
                  >
                    Open context library
                  </CapiroButton>
                ) : undefined
              }
            />
          ) : (
            <CapiroTableWrap>
              <CapiroTable aria-label="Extracted facts">
                <CapiroTableHead>
                  <tr>
                    <CapiroTableHeaderCell>Fact</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Source doc</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Source ref</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Authority</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>As of</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Conf.</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>
                      <span className="st-steward__sr">Action</span>
                    </CapiroTableHeaderCell>
                  </tr>
                </CapiroTableHead>
                <CapiroTableBody>
                  {visibleFacts.map((fact) => (
                    <FactRow
                      key={fact.id}
                      fact={fact}
                      clientLabel={clientLabel(fact.clientId)}
                      highlighted={fact.id === highlightId}
                      rowRef={fact.id === highlightId ? highlightRowRef : undefined}
                      confirming={confirming?.kind === 'reject' && confirming.id === fact.id}
                      busy={reject.isPending}
                      onAskReject={() => setConfirming({ kind: 'reject', id: fact.id })}
                      onCancelReject={() => setConfirming(null)}
                      onReject={() => onRejectFact(fact)}
                    />
                  ))}
                </CapiroTableBody>
              </CapiroTable>
            </CapiroTableWrap>
          )}
        </section>
      </main>
    </div>
  );
}

/* ---- subcomponents -------------------------------------------------------- */

function BandMetric({
  value,
  label,
  alert = false,
  loading = false,
  failed = false,
}: {
  value: number;
  label: string;
  alert?: boolean;
  loading?: boolean;
  failed?: boolean;
}) {
  return (
    <span className={`st-steward__band-metric${alert ? ' is-alert' : ''}`}>
      {loading ? (
        <CapiroSkeleton width={34} height={24} />
      ) : failed ? (
        <strong className="st-steward__band-value is-unavailable">—</strong>
      ) : (
        <strong className="st-steward__band-value">{value}</strong>
      )}
      <span className="st-steward__band-metric-label">{failed ? `${label} — unavailable` : label}</span>
    </span>
  );
}

function CandidateView({
  label,
  candidate,
  ledgerFact,
}: {
  label: string;
  candidate: ContextConflict['factA'];
  ledgerFact: ContextFact | undefined;
}) {
  if (!candidate) {
    return (
      <div className="st-steward__candidate is-missing">
        <span className="st-steward__candidate-label">{label}</span>
        <p>This side of the conflict is no longer available — the fact may have been removed.</p>
      </div>
    );
  }
  return (
    <div className="st-steward__candidate">
      <span className="st-steward__candidate-label">{label}</span>
      <p className="st-steward__candidate-text">{candidate.fact}</p>
      <dl className="st-steward__candidate-meta">
        <div>
          <dt>Source</dt>
          <dd>
            {ledgerFact ? (
              <Link to={`/strategies/context/${ledgerFact.documentId}`}>
                {candidate.documentTitle ??
                  (ledgerFact.templateKey ? templateLabel(ledgerFact.templateKey) : 'Document')}
              </Link>
            ) : (
              (candidate.documentTitle ?? 'Document')
            )}
          </dd>
        </div>
        <div>
          <dt>Source ref</dt>
          <dd>{ledgerFact?.sourceRef ? <span className="st-mono">{ledgerFact.sourceRef}</span> : '—'}</dd>
        </div>
        <div>
          <dt>Authority</dt>
          <dd>{candidate.authority ? candidate.authority.replace(/_/g, ' ') : 'unattributed'}</dd>
        </div>
        <div>
          <dt>As of</dt>
          <dd>{candidate.asOf ? (fmtDay(candidate.asOf) ?? candidate.asOf.slice(0, 10)) : 'undated'}</dd>
        </div>
        <div>
          <dt>Confidence</dt>
          <dd>
            {ledgerFact?.confidence != null ? (
              <span className="st-mono">{ledgerFact.confidence.toFixed(2)}</span>
            ) : (
              '—'
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function ConflictCard({
  conflict,
  factById,
  clientLabel,
  confirming,
  busy,
  onAskDismiss,
  onCancelDismiss,
  onDismiss,
}: {
  conflict: ContextConflict;
  factById: Map<string, ContextFact>;
  clientLabel: string;
  confirming: boolean;
  busy: boolean;
  onAskDismiss: () => void;
  onCancelDismiss: () => void;
  onDismiss: () => void;
}) {
  const navigate = useNavigate();
  const sources = [conflict.factA?.documentTitle, conflict.factB?.documentTitle].filter(
    (title): title is string => Boolean(title),
  );
  const detectedIn =
    sources.length === 2 && sources[0] !== sources[1]
      ? `Detected across ${sources[0]} · ${sources[1]}`
      : sources.length > 0
        ? `Detected in ${sources[0]}`
        : null;

  return (
    <article className={`st-steward__conflict${conflict.state === 'open' ? ' is-open' : ''}`}>
      <header className="st-steward__conflict-head">
        <CapiroBadge
          tone={CONFLICT_STATE_TONE[conflict.state]}
          dot={<span className="st-steward__dot" aria-hidden="true" />}
        >
          {conflict.state === 'open' ? 'Open' : conflict.state === 'resolved' ? 'Resolved' : 'Dismissed'}
        </CapiroBadge>
        {conflict.material ? (
          <CapiroBadge tone="danger" dot={<span className="st-steward__dot" aria-hidden="true" />}>
            Material
          </CapiroBadge>
        ) : null}
        <span className="st-steward__conflict-meta">
          {clientLabel} · {fmtDay(conflict.createdAt) ?? conflict.createdAt.slice(0, 10)}
          {detectedIn ? ` · ${detectedIn}` : ''}
        </span>
      </header>

      <p className="st-steward__conflict-question">
        Which statement should agents treat as current?
      </p>

      <div className="st-steward__candidates">
        <CandidateView label="Statement A" candidate={conflict.factA} ledgerFact={factById.get(conflict.factAId)} />
        <CandidateView label="Statement B" candidate={conflict.factB} ledgerFact={factById.get(conflict.factBId)} />
      </div>

      {conflict.state !== 'open' && conflict.resolutionNote ? (
        <div className="st-steward__decision">
          <span className="st-steward__decision-label">
            {conflict.state === 'resolved' ? 'Resolution note' : 'Dismissal note'}
          </span>
          <p>{conflict.resolutionNote}</p>
        </div>
      ) : null}

      {conflict.state === 'open' ? (
        <footer className="st-steward__conflict-actions">
          {confirming ? (
            <span className="st-steward__confirm" role="group" aria-label="Confirm dismissal">
              <span className="st-steward__confirm-label">
                Dismiss? Both facts stay active — the dismissal is recorded.
              </span>
              <CapiroButton variant="primary" size="compact" loading={busy} onClick={onDismiss}>
                Confirm dismiss
              </CapiroButton>
              <CapiroButton variant="quiet" size="compact" disabled={busy} onClick={onCancelDismiss}>
                Cancel
              </CapiroButton>
            </span>
          ) : (
            <>
              <CapiroButton variant="quiet" size="compact" onClick={onAskDismiss}>
                Dismiss conflict
              </CapiroButton>
              <span className="st-steward__section-spacer" />
              <CapiroButton
                variant="primary"
                size="compact"
                onClick={() => navigate(`/strategies/context/steward/${conflict.id}`)}
              >
                Resolve conflict
              </CapiroButton>
            </>
          )}
        </footer>
      ) : null}
    </article>
  );
}

function FactRow({
  fact,
  clientLabel,
  highlighted,
  rowRef,
  confirming,
  busy,
  onAskReject,
  onCancelReject,
  onReject,
}: {
  fact: ContextFact;
  clientLabel: string;
  highlighted: boolean;
  rowRef: React.Ref<HTMLTableRowElement> | undefined;
  confirming: boolean;
  busy: boolean;
  onAskReject: () => void;
  onCancelReject: () => void;
  onReject: () => void;
}) {
  return (
    <tr ref={rowRef} className={highlighted ? 'is-highlighted' : undefined}>
      <CapiroTableCell className="st-steward__fact-cell">
        {fact.fact}
        {fact.citation ? (
          <span className="st-steward__fact-citation st-mono">“{clip(fact.citation, 140)}”</span>
        ) : null}
      </CapiroTableCell>
      <CapiroTableCell>
        <Link className="st-steward__doc-link" to={`/strategies/context/${fact.documentId}`}>
          {fact.documentTitle ?? (fact.templateKey ? templateLabel(fact.templateKey) : 'Document')}
        </Link>
        <span className="st-steward__doc-client">{clientLabel}</span>
      </CapiroTableCell>
      <CapiroTableCell>
        {fact.sourceRef ? <span className="st-mono st-steward__ref">{fact.sourceRef}</span> : '—'}
      </CapiroTableCell>
      <CapiroTableCell>
        {fact.authority ? fact.authority.replace(/_/g, ' ') : 'unattributed'}
      </CapiroTableCell>
      <CapiroTableCell className="st-steward__nowrap">
        {fact.asOf ? (fmtDay(fact.asOf) ?? fact.asOf.slice(0, 10)) : 'undated'}
      </CapiroTableCell>
      <CapiroTableCell className="st-steward__nowrap">
        {fact.confidence != null ? (
          <span className="st-mono">{fact.confidence.toFixed(2)}</span>
        ) : (
          '—'
        )}
      </CapiroTableCell>
      <CapiroTableCell className="st-steward__nowrap st-steward__action-cell">
        {fact.state === 'active' ? (
          confirming ? (
            <span className="st-steward__confirm" role="group" aria-label="Confirm rejection">
              <span className="st-steward__confirm-label">Reject? Source stays unchanged.</span>
              <CapiroButton variant="primary" size="compact" loading={busy} onClick={onReject}>
                Confirm
              </CapiroButton>
              <CapiroButton variant="quiet" size="compact" disabled={busy} onClick={onCancelReject}>
                Cancel
              </CapiroButton>
            </span>
          ) : (
            <button type="button" className="st-steward__reject" onClick={onAskReject}>
              Reject
            </button>
          )
        ) : (
          <CapiroBadge
            tone={FACT_STATE_TONE[fact.state]}
            dot={<span className="st-steward__dot" aria-hidden="true" />}
          >
            {fact.state}
          </CapiroBadge>
        )}
      </CapiroTableCell>
    </tr>
  );
}
