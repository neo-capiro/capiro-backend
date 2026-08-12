/*
 * §7.10f — Resolve conflict overlay. Route: /strategies/context/steward/:conflictId
 * (over the steward review).
 *
 * Two facts in material disagreement, side by side: the fact text, its
 * documentTitle / authority / asOf, and the exact line evidence — the full
 * ContextFact (joined from useContextFacts by fact id) carries the sourceRef /
 * citation / documentId the embedded ContextConflictFact view lacks, and
 * useContextLocate(documentId, sourceRef) resolves the 1-based source lines
 * the decision record cites. The steward picks the controlling fact (A or B)
 * and writes a REQUIRED note; useResolveContextConflict supersedes the losing
 * fact server-side. Dismiss is a SEPARATE explicit action
 * (useDismissContextConflict) for "not a real conflict". No source document
 * is edited anywhere on this surface (governance §1).
 *
 * Rendered after the canonical StewardReview resolve modal (same decision
 * shape). Focus trap / Escape / dirty guard / route sync live in the shell.
 */
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../../components/feedback/index.js';
import type {
  ContextConflict,
  ContextConflictFact,
  ContextFact,
} from '../../../../pages/strategy/types.js';
import {
  useContextConflicts,
  useContextFacts,
  useContextLocate,
  useDismissContextConflict,
  useResolveContextConflict,
} from '../strategies-api.js';
import { StrategiesModalShell } from './StrategiesModalShell.js';

function metaLine(fact: ContextConflictFact | null): string {
  if (!fact) return '';
  return `${fact.documentTitle ?? 'Unknown document'} · ${
    fact.authority ? fact.authority.replace(/_/g, ' ') : 'unattributed'
  } · as of ${fact.asOf ? fact.asOf.slice(0, 10) : 'undated'}`;
}

/** The line evidence for one side: verbatim citation, else located lines. */
function FactEvidence({ factId }: { factId: string | null }) {
  const facts = useContextFacts();
  const full: ContextFact | undefined = useMemo(
    () => (facts.data ?? []).find((candidate) => candidate.id === factId),
    [facts.data, factId],
  );
  const locate = useContextLocate(full?.documentId ?? null, full?.sourceRef ?? null);

  if (!factId) return null;
  if (full?.citation) {
    return <div className="st-quote">{full.citation}</div>;
  }
  if (locate.isLoading) {
    return (
      <div className="st-skel-stack" style={{ marginTop: 8 }}>
        <CapiroSkeleton height={14} />
        <CapiroSkeleton height={14} width="80%" />
      </div>
    );
  }
  if (locate.data?.lines?.length) {
    const { startLine, lines } = locate.data;
    return (
      <div className="st-quote">
        {startLine !== null ? (
          <span className="st-mono" style={{ display: 'block', color: 'var(--st-gray-400)' }}>
            L{startLine}–{locate.data.endLine ?? startLine + lines.length - 1}
          </span>
        ) : null}
        {lines.join('\n')}
      </div>
    );
  }
  return (
    <div className="st-quote" style={{ color: 'var(--st-gray-400)' }}>
      No source excerpt is available for this fact.
    </div>
  );
}

export function ResolveConflictOverlay() {
  const { conflictId } = useParams<{ conflictId: string }>();
  const navigate = useNavigate();
  const conflicts = useContextConflicts();
  const resolve = useResolveContextConflict();
  const dismiss = useDismissContextConflict();

  const conflict: ContextConflict | undefined = useMemo(
    () => (conflicts.data ?? []).find((candidate) => candidate.id === conflictId),
    [conflicts.data, conflictId],
  );

  const [pick, setPick] = useState<'A' | 'B' | null>(null);
  const [note, setNote] = useState('');
  const [confirmingDismiss, setConfirmingDismiss] = useState(false);

  const isOpen = conflict?.state === 'open';
  const controllingFactId =
    pick === 'A'
      ? conflict?.factA?.id || conflict?.factAId || ''
      : pick === 'B'
        ? conflict?.factB?.id || conflict?.factBId || ''
        : '';
  const canSubmit =
    Boolean(conflict && isOpen && pick && controllingFactId && note.trim().length > 0) &&
    !resolve.isPending &&
    !dismiss.isPending;

  const submit = () => {
    if (!canSubmit || !conflict) return;
    resolve.mutate(
      { conflictId: conflict.id, input: { controllingFactId, note: note.trim() } },
      { onSuccess: () => navigate('/strategies/context/steward') },
    );
  };

  const doDismiss = () => {
    if (!conflict || dismiss.isPending || resolve.isPending) return;
    dismiss.mutate(conflict.id, { onSuccess: () => navigate('/strategies/context/steward') });
  };

  const busy = resolve.isPending || dismiss.isPending;

  const candidate = (key: 'A' | 'B', fact: ContextConflictFact | null, factId: string | null) => (
    <button
      type="button"
      className={`st-option-card${pick === key ? ' is-selected' : ''}`}
      aria-pressed={pick === key}
      disabled={!isOpen || busy}
      onClick={() => setPick(key)}
      style={{ textAlign: 'left' }}
    >
      <span className="st-option-card__head">
        Fact {key}
        {pick === key ? <span className="st-pill st-pill--success">Controlling</span> : null}
      </span>
      <span className="st-candidate__value" style={{ display: 'block', fontSize: 14, fontWeight: 650 }}>
        {fact ? fact.fact : 'This fact is no longer available.'}
      </span>
      {fact ? <span className="st-candidate__meta">{metaLine(fact)}</span> : null}
      <FactEvidence factId={factId} />
    </button>
  );

  return (
    <StrategiesModalShell
      eyebrow="Steward review"
      title="Resolve the conflict"
      subtitle="Pick the fact that controls going forward and say why. The losing fact is superseded — no source document is edited."
      closeTo="/strategies/context/steward"
      size="lg"
      dirty={Boolean((pick || note.trim()) && !busy)}
      primaryLabel="Resolve conflict"
      onPrimary={isOpen ? submit : undefined}
      primaryDisabled={!canSubmit}
      primaryBusy={resolve.isPending}
      cancelLabel={isOpen ? 'Cancel' : 'Close'}
      footerNote={
        conflict
          ? `Opened ${conflict.createdAt.slice(0, 10)} · ${conflict.material ? 'material conflict' : 'not material'} · ${conflict.state}`
          : null
      }
    >
      {conflicts.isLoading ? (
        <div className="st-skel-stack">
          <CapiroSkeleton height={64} />
          <CapiroSkeleton height={64} />
          <CapiroSkeleton height={40} />
        </div>
      ) : conflicts.isError ? (
        <CapiroErrorState
          title="The conflict could not be loaded"
          description="The steward queue is unavailable. Nothing here was changed."
          onRetry={() => void conflicts.refetch()}
        />
      ) : !conflict ? (
        <CapiroEmptyState
          title="This conflict is no longer here"
          description="It may already have been resolved or dismissed from the steward queue."
        />
      ) : (
        <>
          {resolve.isError ? (
            <p className="st-modal__alert" role="alert">
              Could not resolve the conflict. {(resolve.error as Error)?.message || 'Please try again.'}
            </p>
          ) : null}
          {dismiss.isError ? (
            <p className="st-modal__alert" role="alert">
              Could not dismiss the conflict. {(dismiss.error as Error)?.message || 'Please try again.'}
            </p>
          ) : null}

          <div className="st-candidates">
            {candidate('A', conflict.factA, conflict.factAId)}
            {candidate('B', conflict.factB, conflict.factBId)}
          </div>

          {conflict.state !== 'open' && conflict.resolutionNote ? (
            <div className="st-audit">
              <span aria-hidden="true">✓</span>
              <span>
                <strong>{conflict.state === 'resolved' ? 'Resolved' : 'Dismissed'}.</strong>{' '}
                {conflict.resolutionNote}
              </span>
              <span className="st-pill">{conflict.state}</span>
            </div>
          ) : null}

          {isOpen ? (
            <>
              <label className="capiro-field">
                <span className="capiro-field__label">Decision note · Required</span>
                <textarea
                  className="st-textarea"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Why does the controlling fact win? (e.g. newer as_of date, higher authority, client-approved source.)"
                />
              </label>
              <div className="st-rationale-foot">
                <span>The note is recorded with the decision.</span>
                <span>{note.trim().length > 0 ? `${note.trim().length} characters` : 'Required'}</span>
              </div>

              <div className="st-audit">
                <span aria-hidden="true">i</span>
                <span>
                  Resolving supersedes the losing fact across every strategy that cites it.{' '}
                  <strong>No source document is edited</strong> — the decision is recorded on the
                  conflict itself.
                </span>
                {confirmingDismiss ? (
                  <span style={{ display: 'flex', gap: 8 }}>
                    <CapiroButton
                      size="compact"
                      variant="quiet"
                      disabled={busy}
                      onClick={() => setConfirmingDismiss(false)}
                    >
                      Keep
                    </CapiroButton>
                    <CapiroButton
                      size="compact"
                      variant="secondary"
                      loading={dismiss.isPending}
                      onClick={doDismiss}
                    >
                      Confirm dismiss
                    </CapiroButton>
                  </span>
                ) : (
                  <CapiroButton
                    size="compact"
                    variant="quiet"
                    disabled={busy}
                    onClick={() => setConfirmingDismiss(true)}
                  >
                    Dismiss — not a real conflict
                  </CapiroButton>
                )}
              </div>
            </>
          ) : null}
        </>
      )}
    </StrategiesModalShell>
  );
}
