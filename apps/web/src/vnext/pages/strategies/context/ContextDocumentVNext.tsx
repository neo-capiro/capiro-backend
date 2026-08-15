/*
 * Strategies vNext — Context document (/strategies/context/:documentId),
 * STRATEGIES-HANDOFF §7.6.
 *
 * The provenance surface for one grounded-agent-context document: header with
 * template key / client / title plus the Extract-facts and Archive actions, a
 * metadata strip (scope · authority · state · as-of · valid-to + supersession),
 * the raw markdown body as numbered monospace lines (what the agents read is
 * exactly what you see — deliberately no markdown renderer, no edit affordance
 * anywhere), and a right rail with the outline (the single selection control,
 * §4.1 #8), the SHA-256 provenance card and the extracted-fact counts.
 *
 * Governance (§7.6 must-nots):
 * - NO edit affordance on source content — the viewer is read-only.
 * - Archive is replaced by an explicit "steward decision required" state while
 *   active facts still reference the document (the server only 409s on state,
 *   so this check is client-side over the shared facts ledger).
 * - Extract is disabled once the current version is extracted, with the reason
 *   in the tooltip; visibility follows canExtractContextFacts (agenticMeri AND
 *   contextSteward flags AND an active document) so no guaranteed-403 button
 *   is ever rendered.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroBadge } from '../../../components/badges/index.js';
import {
  CapiroEmptyState,
  CapiroErrorState,
  CapiroSkeleton,
} from '../../../components/feedback/index.js';
import { useCapiroToast } from '../../../components/feedback/toast.js';
import {
  CapiroCopyIcon,
  CapiroFolderIcon,
  CapiroThunderboltIcon,
} from '../../../components/icons/index.js';
import { CapiroTooltip } from '../../../components/menus/index.js';
import {
  clientName,
  useArchiveContextDocument,
  useClientsLite,
  useContextDocument,
  useContextDocuments,
  useContextFacts,
  useContextLocate,
  useContextSections,
  useExtractContextFacts,
} from '../strategies-api.js';
import { useMe } from '../../../../lib/me.js';
import { errorMessage } from '../../../../lib/error-message.js';
import {
  canArchiveContextDoc,
  canExtractContextFacts,
  fmScalar,
  isContextDocStale,
  resolveHighlight,
} from '../../../../pages/strategy/context/context-utils.js';
import type { ContextDocState } from '../../../../pages/strategy/types.js';
import './context-document.css';

const STATE_TONE: Record<ContextDocState, 'success' | 'warning' | 'neutral'> = {
  active: 'success',
  draft: 'warning',
  superseded: 'neutral',
  archived: 'neutral',
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

export function ContextDocumentVNext() {
  const { documentId = null } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useCapiroToast();
  const me = useMe();

  const doc = useContextDocument(documentId);
  const sections = useContextSections(documentId);
  const clients = useClientsLite();
  const documents = useContextDocuments();
  const facts = useContextFacts();
  const archive = useArchiveContextDocument();
  const extract = useExtractContextFacts();

  /* §4.1 #8: selection is single-sourced from the outline and lives in the URL
   * (?ref=), so a copied source link restores the exact highlighted range. */
  const activeRef = searchParams.get('ref');
  const locate = useContextLocate(documentId, activeRef);
  const firstHitRef = useRef<HTMLDivElement | null>(null);
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  const setActiveRef = (ref: string | null) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (ref) next.set('ref', ref);
        else next.delete('ref');
        return next;
      },
      { replace: false },
    );
  };

  const contentLines = useMemo(() => (doc.data?.content ?? '').split('\n'), [doc.data?.content]);
  /* Hoisted before the early returns: after the !doc.data guard the query
   * result narrows to the success variant and these members become never. */
  const docRefetchFailed = doc.isRefetchError;
  const docDataUpdatedAt = doc.dataUpdatedAt;
  const highlight = useMemo(
    () => (locate.data ? resolveHighlight(contentLines, locate.data) : null),
    [contentLines, locate.data],
  );

  /* Bring the located lines into view once the locate result lands. */
  useEffect(() => {
    if (highlight) firstHitRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlight]);

  /* Facts extracted from THIS document (drives the extract-disabled reason,
   * the archive steward gate and the rail counts). Never rendered as 0 when
   * the ledger failed — the counts card has its own explicit state. */
  const docFacts = useMemo(
    () => (facts.data ?? []).filter((fact) => fact.documentId === documentId),
    [facts.data, documentId],
  );
  const activeFactCount = docFacts.filter((fact) => fact.state === 'active').length;
  const factCounts = useMemo(() => {
    const counts = { active: 0, stale: 0, superseded: 0, rejected: 0 };
    for (const fact of docFacts) counts[fact.state] += 1;
    return counts;
  }, [docFacts]);

  /* Supersession provenance from the shared library list (same query key). */
  const supersededBy = useMemo(
    () => (documents.data ?? []).find((row) => row.supersedesId === documentId) ?? null,
    [documents.data, documentId],
  );
  const supersedes = useMemo(
    () =>
      doc.data?.supersedesId
        ? ((documents.data ?? []).find((row) => row.id === doc.data?.supersedesId) ?? null)
        : null,
    [documents.data, doc.data?.supersedesId],
  );

  /* Outline line ranges: a section runs to the next section's heading line
   * (when the API provides heading lines). The locate call remains the exact
   * authority once a section is selected. */
  const sectionRanges = useMemo(() => {
    const rows = sections.data ?? [];
    return rows.map((section, index) => {
      const start = section.line;
      const next = rows[index + 1]?.line ?? null;
      const end = start !== null && next !== null && next > start ? next - 1 : null;
      return { ref: section.ref, start, end };
    });
  }, [sections.data]);

  if (doc.isLoading) {
    return (
      <div className="st-ctxdoc" aria-label="Loading context document">
        <div className="st-ctxdoc__header">
          <CapiroSkeleton width={140} height={12} />
          <CapiroSkeleton width={220} height={11} />
          <CapiroSkeleton width="46%" height={26} />
          <div className="st-ctxdoc__meta-skeleton">
            {[0, 1, 2, 3, 4].map((chip) => (
              <CapiroSkeleton key={chip} width={86} height={22} />
            ))}
          </div>
        </div>
        <div className="st-ctxdoc__main">
          <div className="st-ctxdoc__viewer st-ctxdoc__viewer--skeleton">
            {Array.from({ length: 18 }, (_, row) => (
              <CapiroSkeleton key={row} width={`${88 - (row % 4) * 9}%`} height={13} />
            ))}
          </div>
          <div className="st-ctxdoc__rail">
            <CapiroSkeleton height={180} />
            <CapiroSkeleton height={150} />
          </div>
        </div>
      </div>
    );
  }

  if (doc.isError || !doc.data) {
    return (
      <div className="st-ctxdoc">
        <div className="st-ctxdoc__state-page">
          <Link className="st-ctxdoc__back" to="/strategies/context">
            ‹ Context library
          </Link>
          {isForbidden(doc.error) ? (
            <CapiroEmptyState
              title="You don't have access to this context document"
              description="Context documents need the agentic Meri feature. Ask an admin to enable it for your account."
            />
          ) : (
            <CapiroErrorState
              title="This context document could not be loaded"
              description="The document request failed. The document itself is unchanged."
              onRetry={() => void doc.refetch()}
            />
          )}
        </div>
      </div>
    );
  }

  const d = doc.data;
  const stale = isContextDocStale(d);
  const clientLabel = d.clientId ? clientName(clients.data, d.clientId) : 'Firm';
  const authority = fmScalar(d.frontmatter, 'authority');
  const asOf = fmScalar(d.frontmatter, 'as_of');
  const validUntil = d.validUntil ?? fmScalar(d.frontmatter, 'valid_until');

  /* §7.6: Extract is disabled once the current version is extracted (reason in
   * the tooltip); hidden entirely when the flags/state can never succeed. */
  const showExtract = canExtractContextFacts(me.data?.features, d.state);
  const alreadyExtracted = facts.isSuccess && docFacts.length > 0;
  const extractDisabledReason = alreadyExtracted
    ? `Already extracted — ${docFacts.length} fact${docFacts.length === 1 ? '' : 's'} from this document ${docFacts.length === 1 ? 'is' : 'are'} in the steward ledger.`
    : null;

  /* §7.6 must-not: while active facts reference this document, archive needs a
   * steward decision — say so instead of archiving. */
  const archiveBlockedByFacts = facts.isSuccess && activeFactCount > 0;

  const onExtract = () => {
    if (extract.isPending) return;
    extract.mutate(d.id, {
      onSuccess: (result) => {
        const parts = [
          `Steward extracted ${result.inserted} fact${result.inserted === 1 ? '' : 's'}`,
        ];
        if (result.droppedRefs > 0) {
          parts.push(
            `dropped ${result.droppedRefs} unlocatable ref${result.droppedRefs === 1 ? '' : 's'}`,
          );
        }
        if (result.conflicts > 0) {
          parts.push(`flagged ${result.conflicts} conflict${result.conflicts === 1 ? '' : 's'}`);
        }
        toast.success(`${parts.join(', ')}.`);
      },
      onError: (err) =>
        toast.error(errorMessage(err, 'The Steward could not extract facts from this document.')),
    });
  };

  const onArchive = () => {
    if (archive.isPending) return;
    archive.mutate(d.id, {
      onSuccess: () => {
        setConfirmingArchive(false);
        toast.success('Document archived. Its history is retained.');
      },
      onError: (err) => {
        setConfirmingArchive(false);
        toast.error(errorMessage(err, 'Could not archive the document.'));
      },
    });
  };

  const onCopySourceLink = () => {
    const url = `${window.location.origin}/strategies/context/${d.id}${activeRef ? `?ref=${encodeURIComponent(activeRef)}` : ''}`;
    void navigator.clipboard
      .writeText(url)
      .then(() => toast.success('Source link copied.'))
      .catch(() => toast.error('Could not copy the source link.'));
  };

  return (
    <div className="st-ctxdoc">
      {/* ---- header ------------------------------------------------------- */}
      <header className="st-ctxdoc__header">
        <Link className="st-ctxdoc__back" to="/strategies/context">
          ‹ Context library
        </Link>
        <div className="st-ctxdoc__title-row">
          <div className="st-ctxdoc__title-block">
            <div className="st-ctxdoc__eyebrow">
              <span className="st-mono">{d.templateKey}</span>
              <span aria-hidden="true"> · </span>
              {clientLabel}
            </div>
            <h1 className="st-ctxdoc__title">{d.title}</h1>
          </div>
          <div className="st-ctxdoc__actions">
            {showExtract ? (
              <CapiroTooltip
                content={
                  extractDisabledReason ??
                  'Run the Context Steward over this document — extracted facts keep exact source references.'
                }
              >
                <span className="st-ctxdoc__action-wrap">
                  <CapiroButton
                    variant="primary"
                    leadingIcon={<CapiroThunderboltIcon size={0.95} />}
                    disabled={extractDisabledReason !== null}
                    loading={extract.isPending}
                    onClick={onExtract}
                  >
                    Extract facts
                  </CapiroButton>
                </span>
              </CapiroTooltip>
            ) : null}
            {canArchiveContextDoc(d.state) ? (
              confirmingArchive ? (
                <span className="st-ctxdoc__confirm" role="group" aria-label="Confirm archive">
                  <span className="st-ctxdoc__confirm-label">Archive this document?</span>
                  <CapiroButton variant="primary" size="compact" loading={archive.isPending} onClick={onArchive}>
                    Confirm archive
                  </CapiroButton>
                  <CapiroButton
                    variant="quiet"
                    size="compact"
                    disabled={archive.isPending}
                    onClick={() => setConfirmingArchive(false)}
                  >
                    Cancel
                  </CapiroButton>
                </span>
              ) : (
                <CapiroTooltip
                  content={
                    archiveBlockedByFacts
                      ? `${activeFactCount} active fact${activeFactCount === 1 ? '' : 's'} still reference${activeFactCount === 1 ? 's' : ''} this document — archiving needs a steward decision in Steward review.`
                      : 'Retire this document. It will no longer ground new agent work; its history is retained.'
                  }
                >
                  <span className="st-ctxdoc__action-wrap">
                    <CapiroButton
                      variant="quiet"
                      leadingIcon={<CapiroFolderIcon size={0.95} />}
                      disabled={archiveBlockedByFacts}
                      onClick={() => setConfirmingArchive(true)}
                    >
                      Archive
                    </CapiroButton>
                  </span>
                </CapiroTooltip>
              )
            ) : null}
          </div>
        </div>

        {/* metadata strip: scope · authority · state · as-of · valid-to · supersession */}
        <div className="st-ctxdoc__meta" aria-label="Document metadata">
          <span className="st-ctxdoc__chip">{d.scope} scope</span>
          {authority ? <span className="st-ctxdoc__chip">{authority.replace(/_/g, ' ')}</span> : null}
          <CapiroBadge tone={STATE_TONE[d.state]} dot={<span className="st-ctxdoc__dot" aria-hidden="true" />}>
            {d.state}
          </CapiroBadge>
          {stale ? (
            <CapiroBadge tone="warning" dot={<span className="st-ctxdoc__dot" aria-hidden="true" />}>
              Stale
            </CapiroBadge>
          ) : null}
          {asOf ? <span className="st-ctxdoc__chip">as of {fmtDay(asOf) ?? asOf.slice(0, 10)}</span> : null}
          {validUntil ? (
            <span className={`st-ctxdoc__chip${stale ? ' is-stale' : ''}`}>
              valid to {fmtDay(validUntil) ?? validUntil.slice(0, 10)}
            </span>
          ) : null}
          {supersedes ? (
            <Link className="st-ctxdoc__chip is-link" to={`/strategies/context/${supersedes.id}`}>
              Supersedes {supersedes.title}
            </Link>
          ) : d.supersedesId ? (
            <span className="st-ctxdoc__chip">
              Supersedes <span className="st-mono">{d.supersedesId.slice(0, 8)}…</span>
            </span>
          ) : null}
          {supersededBy ? (
            <Link className="st-ctxdoc__chip is-link" to={`/strategies/context/${supersededBy.id}`}>
              Superseded by {supersededBy.title}
            </Link>
          ) : null}
        </div>

        {docRefetchFailed ? (
          <div className="st-ctxdoc__note is-warning" role="status">
            Refresh failed — showing data from {new Date(docDataUpdatedAt).toLocaleTimeString()}.
          </div>
        ) : null}
        {archiveBlockedByFacts ? (
          <div className="st-ctxdoc__note is-warning" role="status">
            {activeFactCount} active fact{activeFactCount === 1 ? '' : 's'} still reference
            {activeFactCount === 1 ? 's' : ''} this document — archiving requires a steward decision.{' '}
            <Link to="/strategies/context/steward">Open steward review</Link>.
          </div>
        ) : null}
      </header>

      <div className="st-ctxdoc__main">
        {/* ---- source viewer: numbered monospace lines, read-only ---------- */}
        <section className="st-ctxdoc__viewer" aria-label="Document source">
          <div className="st-ctxdoc__lines">
            {contentLines.map((line, index) => {
              const n = index + 1;
              const hit = highlight !== null && n >= highlight.start && n <= highlight.end;
              return (
                <div
                  key={index}
                  ref={highlight !== null && n === highlight.start ? firstHitRef : undefined}
                  className={`st-ctxdoc__line${hit ? ' is-hit' : ''}`}
                >
                  <span className="st-ctxdoc__line-no st-mono" aria-hidden="true">
                    {n}
                  </span>
                  <span className="st-ctxdoc__line-text st-mono">{line || ' '}</span>
                </div>
              );
            })}
          </div>
          <div className="st-ctxdoc__selection-footer">
            {activeRef && locate.isFetching ? (
              <span className="st-ctxdoc__selection-label">Locating source lines…</span>
            ) : highlight ? (
              <span className="st-ctxdoc__selection-label">
                Selected <span className="st-mono">L{highlight.start}–{highlight.end}</span>
              </span>
            ) : (
              <span className="st-ctxdoc__selection-label">
                Select a section in the outline to highlight its exact source lines.
              </span>
            )}
            <span className="st-ctxdoc__selection-spacer" />
            {activeRef ? (
              <CapiroButton variant="quiet" size="compact" onClick={() => setActiveRef(null)}>
                Clear selection
              </CapiroButton>
            ) : null}
            <CapiroButton
              variant="secondary"
              size="compact"
              leadingIcon={<CapiroCopyIcon size={0.9} />}
              onClick={onCopySourceLink}
            >
              Copy source link
            </CapiroButton>
          </div>
        </section>

        {/* ---- right rail: outline / provenance / facts -------------------- */}
        <aside className="st-ctxdoc__rail">
          <section className="st-ctxdoc__card" aria-label="Outline">
            <span className="st-ctxdoc__card-label">Outline</span>
            <p className="st-ctxdoc__card-hint">
              Click a section to locate its exact source lines — retrieved deterministically, no AI
              involved.
            </p>
            {sections.isLoading ? (
              <div className="st-ctxdoc__outline">
                {[0, 1, 2, 3].map((row) => (
                  <CapiroSkeleton key={row} width={`${82 - row * 11}%`} height={13} />
                ))}
              </div>
            ) : sections.isError ? (
              <div className="st-ctxdoc__card-state" role="status">
                <span>Sections could not be loaded.</span>
                <CapiroButton variant="quiet" size="compact" onClick={() => void sections.refetch()}>
                  Retry
                </CapiroButton>
              </div>
            ) : (sections.data ?? []).length === 0 ? (
              <div className="st-ctxdoc__card-state" role="status">
                <span>No sections in this document.</span>
              </div>
            ) : (
              <div className="st-ctxdoc__outline">
                {(sections.data ?? []).map((section, index) => {
                  const active = section.ref === activeRef;
                  const range = sectionRanges[index];
                  return (
                    <button
                      key={`${section.ref}-${index}`}
                      type="button"
                      aria-pressed={active}
                      className={`st-ctxdoc__section${active ? ' is-active' : ''}`}
                      style={{ paddingLeft: 9 + Math.max(0, Math.min(section.level - 1, 4)) * 10 }}
                      onClick={() => setActiveRef(active ? null : section.ref)}
                    >
                      <span className="st-ctxdoc__section-heading">{section.heading}</span>
                      {range?.start != null ? (
                        <span className="st-ctxdoc__section-lines st-mono">
                          L{range.start}
                          {range.end != null && range.end > range.start ? `–${range.end}` : ''}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
            {activeRef && locate.isError ? (
              <div className="st-ctxdoc__note is-error" role="status">
                Could not locate this section in the source.
              </div>
            ) : null}
            {activeRef && locate.isSuccess && !highlight ? (
              <div className="st-ctxdoc__note" role="status">
                The exact source lines for this section could not be anchored in the current body.
              </div>
            ) : null}
          </section>

          <section className="st-ctxdoc__card" aria-label="Provenance">
            <span className="st-ctxdoc__card-label">Provenance</span>
            <div className="st-ctxdoc__hash-row">
              <span className="st-ctxdoc__hash-chip st-mono">SHA-256</span>
              <span className="st-ctxdoc__hash-value st-mono" title={d.checksum}>
                {d.checksum.slice(0, 16)}…
              </span>
              <CapiroTooltip content="Copy the full document hash">
                <button
                  type="button"
                  className="st-ctxdoc__hash-copy"
                  aria-label="Copy the full document hash"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(d.checksum)
                      .then(() => toast.success('Document hash copied.'))
                      .catch(() => toast.error('Could not copy the document hash.'));
                  }}
                >
                  <CapiroCopyIcon size={0.85} />
                </button>
              </CapiroTooltip>
            </div>
            <dl className="st-ctxdoc__prov">
              <div>
                <dt>Created</dt>
                <dd>{fmtDay(d.createdAt) ?? d.createdAt.slice(0, 10)}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{fmtDay(d.updatedAt) ?? d.updatedAt.slice(0, 10)}</dd>
              </div>
              <div>
                <dt>Supersedes</dt>
                <dd>
                  {supersedes ? (
                    <Link to={`/strategies/context/${supersedes.id}`}>{supersedes.title}</Link>
                  ) : d.supersedesId ? (
                    <span className="st-mono">{d.supersedesId.slice(0, 8)}…</span>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
              <div>
                <dt>Superseded by</dt>
                <dd>
                  {supersededBy ? (
                    <Link to={`/strategies/context/${supersededBy.id}`}>{supersededBy.title}</Link>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
            </dl>
          </section>

          <section className="st-ctxdoc__card" aria-label="Extracted facts">
            <span className="st-ctxdoc__card-label">Extracted facts</span>
            {facts.isLoading ? (
              <div className="st-ctxdoc__fact-counts">
                {[0, 1].map((row) => (
                  <CapiroSkeleton key={row} width="70%" height={12} />
                ))}
              </div>
            ) : facts.isError ? (
              <div className="st-ctxdoc__card-state" role="status">
                <span>Fact counts unavailable — the steward ledger could not be loaded.</span>
                <CapiroButton variant="quiet" size="compact" onClick={() => void facts.refetch()}>
                  Retry
                </CapiroButton>
              </div>
            ) : (
              <>
                <div className="st-ctxdoc__fact-counts">
                  <span>
                    <strong>{factCounts.active}</strong> active
                  </span>
                  <span>
                    <strong>{factCounts.stale}</strong> stale
                  </span>
                  <span>
                    <strong>{factCounts.superseded}</strong> superseded
                  </span>
                  <span>
                    <strong>{factCounts.rejected}</strong> rejected
                  </span>
                </div>
                {docFacts.length === 0 && d.state === 'active' ? (
                  <p className="st-ctxdoc__card-hint">
                    Not extracted yet — run Extract facts to ground agents in this document.
                  </p>
                ) : null}
              </>
            )}
            <CapiroButton variant="secondary" onClick={() => navigate('/strategies/context/steward')}>
              Open steward review
            </CapiroButton>
          </section>
        </aside>
      </div>
    </div>
  );
}
