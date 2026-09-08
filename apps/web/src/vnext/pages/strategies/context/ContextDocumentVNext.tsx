/*
 * Strategies vNext — Context document (/strategies/context/:documentId),
 * STRATEGIES-HANDOFF §7.6.
 *
 * The provenance surface for one grounded-agent-context document: header with
 * template key / client / title plus the Extract-facts and Archive actions, a
 * metadata strip (scope · authority · state · as-of · valid-to + supersession),
 * a sanitized reading view with the original numbered source available on demand, and a right rail with the outline (the single selection control,
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
import { CapiroCopyIcon } from '../../../components/icons/index.js';
import { CapiroTooltip } from '../../../components/menus/index.js';
import {
  clientName,
  useArchiveContextDocument,
  useApproveContextDocument,
  useClientsLite,
  useContextDocument,
  useContextDocuments,
  useContextFacts,
  useContextHealth,
  useContextLocate,
  useContextSections,
  useExtractContextFacts,
} from '../strategies-api.js';
import { ScopeBar, type ScopeBarStatus } from '../ScopeBar.js';
import { useShellClientContext } from '../../../adapters/legacy/useShellClientContext.js';
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
import { ContextReadingView } from './ContextReadingView.js';
import { ContextAssociation } from './ContextAssociation.js';
import { contextCategoryLabel } from './context-categories.js';
import { contextHealthStatus } from './context-health-label.js';
import './context-document.css';

/*
 * Local glyphs (design handoff: ChevronLeft / Stars02 / Package). The shared
 * icon set (../../../components/icons/index.tsx) has no chevron, sparkle or
 * package entry, and adding one there is out of scope for this pass — that
 * file may be touched by another concurrent Strategies agent. These mirror
 * its stroke conventions (24x24 viewBox, currentColor, 1.75 stroke) as
 * self-contained, view-local glyphs instead.
 */
function ChevronLeftGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

function StarsGlyph({ size = 18, color }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? 'currentColor'} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 3l1.6 4.2L17 9l-4.4 1.8L11 15l-1.6-4.2L5 9l4.4-1.8L11 3Z" />
      <path d="M18.5 14.5l.75 1.9 1.9.75-1.9.75-.75 1.9-.75-1.9-1.9-.75 1.9-.75.75-1.9Z" />
    </svg>
  );
}

function PackageGlyph({ size = 18, color }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? 'currentColor'} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 8.2 12 4l8.5 4.2v7.6L12 20l-8.5-4.2V8.2Z" />
      <path d="M3.7 8.4 12 12.3l8.3-3.9M12 12.3V20" />
    </svg>
  );
}

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
  return `${label} ${Number(d)}, ${y}`;
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
  const facts = useContextFacts({ documentId: documentId ?? undefined }, !!documentId);
  const activeFacts = useContextFacts({ documentId: documentId ?? undefined, state: 'active' }, !!documentId);
  const archive = useArchiveContextDocument();
  const approve = useApproveContextDocument();
  const [confirmingApproval, setConfirmingApproval] = useState(false);
  const [reviewedChecksum, setReviewedChecksum] = useState<string | null>(null);
  const extract = useExtractContextFacts();

  /* ScopeBar status — same shared cross-app client scope + real ContextHealth
   * signal as the context library (not this document's own client): there is
   * no single meaningful "N facts" number across all clients, so an unscoped
   * portfolio never gets a fabricated "Healthy" reading. */
  const clientContext = useShellClientContext();
  const scopeClientId = doc.data?.clientId ?? null;
  const fixedScopeClientName = doc.data ? (doc.data.clientId ? clientName(clients.data, doc.data.clientId) : 'Firm-wide') : undefined;
  const health = useContextHealth(scopeClientId);
  const scopeStatus: ScopeBarStatus = scopeClientId
    ? contextHealthStatus(health.data, health.isError, health.isLoading, health.data?.activeFacts)
    : { tone: 'gray', label: 'Shared firm context' };
  useEffect(() => {
    if (doc.data?.clientId) clientContext.setSelectedClientId?.(doc.data.clientId);
  }, [doc.data?.clientId]);

  /* §4.1 #8: selection is single-sourced from the outline and lives in the URL
   * (?ref=), so a copied source link restores the exact highlighted range. */
  const activeRef = searchParams.get('ref');
  const locate = useContextLocate(documentId, activeRef);
  const firstHitRef = useRef<HTMLDivElement | null>(null);
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  useEffect(() => {
    setConfirmingArchive(false);
    setConfirmingApproval(false);
    setReviewedChecksum(null);
  }, [documentId]);

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
  const activeFactCount = (activeFacts.data ?? []).filter((fact) => fact.documentId === documentId && fact.state === 'active').length;
  const factCounts = useMemo(() => {
    const counts = { active: 0, stale: 0, superseded: 0, rejected: 0 };
    for (const fact of docFacts) counts[fact.state] += 1;
    return counts;
  }, [docFacts]);

  /* Supersession provenance — derived from the shared library list (same
   * query key). The server carries `supersedesId` on the document row; the
   * reverse direction (supersededBy) is derived by scanning the list for a
   * row whose `supersedesId` points at this document. This is the
   * authoritative derivation — the server has no "supersededBy" endpoint. */
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
        <ScopeBar clientLabel="CLIENT" fixedClientName={fixedScopeClientName} status={scopeStatus} />
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

  if (!doc.data || (doc.isError && isForbidden(doc.error))) {
    return (
      <div className="st-ctxdoc">
        <ScopeBar clientLabel="CLIENT" fixedClientName={fixedScopeClientName} status={scopeStatus} />
        <div className="st-ctxdoc__state-page">
          <Link className="st-ctxdoc__back" to={`/strategies/context${scopeClientId ? `?clientId=${scopeClientId}` : ''}`}>
            <ChevronLeftGlyph />Context library
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
   * the tooltip); hidden entirely when the flags/state can never succeed.
   * extractDisabledReason is client-derived from the shared facts ledger
   * (same query key as the steward) — the server has no single "is extracted"
   * scalar, so this is the authoritative derivation. */
  const showExtract = canExtractContextFacts(me.data?.features, d.state);
  const alreadyExtracted = facts.isSuccess && docFacts.length > 0;
  const extractDisabledReason = !facts.isSuccess
    ? 'The fact ledger must load successfully before extracting. Retry the fact counts below.'
    : alreadyExtracted
    ? `Already extracted — ${docFacts.length} fact${docFacts.length === 1 ? '' : 's'} from this document ${docFacts.length === 1 ? 'is' : 'are'} in the steward ledger.`
    : d.state === 'superseded'
      ? 'This document has been superseded — extract from the current version instead.'
      : d.state === 'archived'
        ? 'This document is archived and cannot be extracted.'
        : null;

  /* §7.6 must-not: while active facts reference this document, archive needs a
   * steward decision — say so instead of archiving. */
  const archiveBlockedByFacts = activeFactCount > 0;
  const archiveDisabledReason = !activeFacts.isSuccess
    ? 'The active fact check must load successfully before archiving.'
    : archiveBlockedByFacts
      ? `${activeFactCount} active fact${activeFactCount === 1 ? '' : 's'} still reference${activeFactCount === 1 ? 's' : ''} this document — archiving needs a steward decision in Steward review.`
      : null;

  const approved = ['firm_approved', 'client_approved'].includes(String(d.frontmatter?.authority)) && d.frontmatter?.source_of_truth === true;
  const approvalAdmin = me.data?.role === 'capiro_admin' || me.data?.role === 'user_admin';
  const canApprove = approvalAdmin && d.state === 'active' && d.frontmatter?.confidentiality === 'client_confidential' && !isContextDocStale(d);
  const onApprove = () => approve.mutate({ id: d.id, expectedChecksum: reviewedChecksum ?? '' }, {
    onSuccess: (next) => {
      setConfirmingApproval(false);
      toast.success('Approved for client reports. The original is retained in history. Extract facts from this approved revision when needed.');
      navigate(`/strategies/context/${next.id}`);
    },
    onError: (err) => toast.error(errorMessage(err, 'Approval failed. Reload the document and try again.')),
  });

  const onExtract = () => {
    if (extract.isPending || extractDisabledReason !== null) return;
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
    if (archive.isPending || archiveDisabledReason !== null) return;
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

  const onCopySourceLink = async () => {
    const url = `${window.location.origin}/strategies/context/${d.id}${activeRef ? `?ref=${encodeURIComponent(activeRef)}` : ''}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Source link copied.');
    } catch {
      toast.error('Could not copy the source link.');
    }
  };

  return (
    <div className="st-ctxdoc">
      <ScopeBar clientLabel="CLIENT" fixedClientName={fixedScopeClientName} status={scopeStatus} />

      {/* ---- header ------------------------------------------------------- */}
      <header className="st-ctxdoc__header">
        <Link className="st-ctxdoc__back" to={`/strategies/context${scopeClientId ? `?clientId=${scopeClientId}` : ''}`}>
          <ChevronLeftGlyph />Context library
        </Link>
        <div className="st-ctxdoc__title-row">
          <div className="st-ctxdoc__title-block">
            <div className="st-ctxdoc__eyebrow st-mono">
              {contextCategoryLabel(d.templateKey)}
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
                    leadingIcon={<StarsGlyph size={18} />}
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
                  <CapiroButton variant="primary" size="compact" disabled={archiveDisabledReason !== null} loading={archive.isPending} onClick={onArchive}>
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
                    archiveDisabledReason ??
                    'Retire this document. It will no longer ground new agent work; its history is retained.'
                  }
                >
                  <span className="st-ctxdoc__action-wrap">
                    <CapiroButton
                      variant="secondary"
                      leadingIcon={<PackageGlyph size={18} color="var(--st-gray-500)" />}
                      disabled={archiveDisabledReason !== null}
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

        {d.state === 'active' ? <div className="st-ctxdoc__note" role="status">
          {approved ? 'Approved source of truth for client reports.' : <>
            <p>This document is a working source. Review its contents before approving it for client reports.</p>
            {canApprove ? confirmingApproval ? <div role="group" aria-label="Confirm document approval">
              <p>Confirm that this version is accurate and may be used as a firm-approved source of truth in client reports. Approval preserves the original and does not change its expiry date.</p>
              <CapiroButton loading={approve.isPending} onClick={onApprove}>Confirm approval</CapiroButton>
              <CapiroButton disabled={approve.isPending} onClick={() => setConfirmingApproval(false)}>Cancel</CapiroButton>
            </div> : <CapiroButton onClick={() => { setReviewedChecksum(d.checksum); setConfirmingApproval(true); }}>Approve for client reports</CapiroButton>
              : <p>{!approvalAdmin ? 'An administrator can approve this document.' : 'Only current client-confidential documents can be approved for client reports.'}</p>}
          </>}
        </div> : null}
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
        {activeFacts.isError ? (
          <div className="st-ctxdoc__note is-warning" role="status">
            Archive eligibility could not be checked.{' '}
            <CapiroButton variant="quiet" size="compact" onClick={() => void activeFacts.refetch()}>
              Retry archive check
            </CapiroButton>
          </div>
        ) : null}
      </header>

      {/* ---- meta strip: scope · authority · state · as-of · valid-to · supersession ---- */}
      <div className="st-ctxdoc__metastrip" aria-label="Document metadata">
        <span className="st-ctxdoc__chip">
          <span className="st-ctxdoc__chip-label">Scope</span>
          <span className="st-ctxdoc__chip-value">{d.scope}</span>
        </span>
        {authority ? (
          <span className="st-ctxdoc__chip">
            <span className="st-ctxdoc__chip-label">Authority</span>
            <span className="st-ctxdoc__chip-value">{authority.replace(/_/g, ' ')}</span>
          </span>
        ) : null}
        <CapiroBadge tone={STATE_TONE[d.state]} dot>
          {d.state}
        </CapiroBadge>
        {stale ? (
          <CapiroBadge tone="warning" dot>
            Stale
          </CapiroBadge>
        ) : null}
        {asOf ? (
          <span className="st-ctxdoc__chip">
            <span className="st-ctxdoc__chip-label">As of</span>
            <span className="st-ctxdoc__chip-value">{fmtDay(asOf) ?? asOf.slice(0, 10)}</span>
          </span>
        ) : null}
        {validUntil ? (
          <span className={`st-ctxdoc__chip${stale ? ' is-stale' : ''}`}>
            <span className="st-ctxdoc__chip-label">Valid to</span>
            <span className="st-ctxdoc__chip-value">{fmtDay(validUntil) ?? validUntil.slice(0, 10)}</span>
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
        <span className="st-ctxdoc__metastrip-spacer" />
        {/* The handoff's right-aligned line reads "Version 3 · supersedes v2 ·
           uploaded by …" — there is no version counter or resolved uploader
           display name anywhere in the API (only raw *ByUserId columns), so
           this shows the one real timestamp instead of a fabricated one. */}
        <span className="st-ctxdoc__metastrip-version">
          Updated {fmtDay(d.updatedAt) ?? d.updatedAt.slice(0, 10)}
        </span>
      </div>

      <ContextAssociation key={d.id} document={d} />
      <div className="st-ctxdoc__main">
        {/* ---- source viewer: numbered monospace lines, read-only ---------- */}
        <section className="st-ctxdoc__viewer" aria-label="Document">
          <ContextReadingView content={d.content} highlight={highlight} />
          <details className="st-ctxdoc__source-details">
            <summary>Original source and citation lines</summary>
          <div className="st-ctxdoc__viewer-head">
            <span className="st-mono">{d.templateKey}.md</span>
            <span className="st-ctxdoc__viewer-head-label">Line view</span>
          </div>
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
          </details>
          <div className="st-ctxdoc__selection-footer">
            {activeRef && locate.isFetching ? (
              <span className="st-ctxdoc__selection-label">Locating source lines…</span>
            ) : highlight ? (
              <span className="st-ctxdoc__selection-label">
                Selected <span className="st-mono">L{highlight.start}–{highlight.end}</span>
              </span>
            ) : (
              <span className="st-ctxdoc__selection-label">
                Select a section in the outline to highlight it and copy its citation.
              </span>
            )}
            <span className="st-ctxdoc__selection-spacer" />
            {activeRef ? (
              <CapiroButton variant="quiet" size="compact" onClick={() => setActiveRef(null)}>
                Clear selection
              </CapiroButton>
            ) : null}
            <CapiroButton variant="secondary" size="compact" onClick={onCopySourceLink}>
              Copy source link
            </CapiroButton>
          </div>
        </section>

        {/* ---- right rail: outline / provenance / facts -------------------- */}
        <aside className="st-ctxdoc__rail">
          <section className="st-ctxdoc__card" aria-label="Outline">
            <span className="st-ctxdoc__card-label">Outline</span>
            <h2 className="st-ctxdoc__card-title">Document outline</h2>
            <p className="st-ctxdoc__card-hint">
              Select a section to read it in the document. Original source lines remain available for checking citations.
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

          <details className="st-ctxdoc__card st-ctxdoc__card--muted" aria-label="Provenance">
            <summary>Document history and technical details</summary>
            <span className="st-ctxdoc__card-label">Provenance</span>
            <div className="st-ctxdoc__hash-row">
              <span className="st-ctxdoc__hash-chip st-mono">Stored document checksum</span>
              <span className="st-ctxdoc__hash-value st-mono" title={d.checksum}>
                {d.checksum.slice(0, 16)}…
              </span>
              <CapiroTooltip content="Copy the full document hash">
                <button
                  type="button"
                  className="st-ctxdoc__hash-copy"
                  aria-label="Copy the full document hash"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(d.checksum);
                      toast.success('Document hash copied.');
                    } catch {
                      toast.error('Could not copy the document hash.');
                    }
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
          </details>

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
                <CapiroButton variant="quiet" size="compact" onClick={() => { void facts.refetch(); void activeFacts.refetch(); }}>
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
            <CapiroButton variant="primary" onClick={() => navigate(`/strategies/context/steward${scopeClientId ? `?clientId=${scopeClientId}` : ''}`)}>
              Open steward review
            </CapiroButton>
          </section>
        </aside>
      </div>
    </div>
  );
}
