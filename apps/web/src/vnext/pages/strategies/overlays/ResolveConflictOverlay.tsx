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
 * and writes a REQUIRED note; useResolveContextConflict rejects the losing active
 * fact server-side. Dismiss is a SEPARATE explicit action
 * (useDismissContextConflict) for "not a real conflict". No source document
 * is edited anywhere on this surface (governance §1).
 *
 * Rendered after the canonical StewardReview resolve modal (same decision
 * shape). Focus trap / Escape / dirty guard / route sync live in the shell.
 */
import { useEffect, useMemo, useState } from 'react';
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
import { errorMessage } from '../../../../lib/error-message.js';

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
    return <div className="st-quote st-mono">{full.citation}</div>;
  }
  if (facts.isLoading || locate.isLoading) {
    return (
      <div className="st-skel-stack" style={{ marginTop: 8 }}>
        <CapiroSkeleton height={14} />
        <CapiroSkeleton height={14} width="80%" />
      </div>
    );
  }
  if (facts.isError || locate.isError) {
    return <div className="st-quote" role="status">Source evidence could not be loaded.</div>;
  }
  if (locate.data?.lines?.length) {
    const { startLine, lines } = locate.data;
    return (
      <div className="st-quote st-mono">
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
  const facts = useContextFacts();
  const resolve = useResolveContextConflict();
  const dismiss = useDismissContextConflict();

  const conflict: ContextConflict | undefined = useMemo(
    () => (conflicts.data ?? []).find((candidate) => candidate.id === conflictId),
    [conflicts.data, conflictId],
  );

  const [pick, setPick] = useState<'A' | 'B' | null>(null);
  const [note, setNote] = useState('');
  const [confirmingDismiss, setConfirmingDismiss] = useState(false);
  useEffect(() => {
    setPick(null);
    setNote('');
    setConfirmingDismiss(false);
  }, [conflictId]);

  const isOpen = conflict?.state === 'open';
  const controllingFactId =
    pick === 'A'
      ? conflict?.factA?.id || conflict?.factAId || ''
      : pick === 'B'
        ? conflict?.factB?.id || conflict?.factBId || ''
        : '';
  const canSubmit =
    Boolean(conflict && isOpen && pick && controllingFactId && note.trim().length > 0) &&
    !conflicts.isError &&
    !facts.data?.some((fact) => fact.id === controllingFactId && fact.state !== 'active') &&
    !resolve.isPending &&
    !dismiss.isPending;

  /* Live "Resulting states" preview (README "Modals" → resolve conflict) —
   * both facts are already loaded on `conflict`, so this is a real preview
   * of what resolving now would do, not a fabricated one. */
  const pickedFact = pick === 'A' ? conflict?.factA ?? null : pick === 'B' ? conflict?.factB ?? null : null;
  const otherFact = pick === 'A' ? conflict?.factB ?? null : pick === 'B' ? conflict?.factA ?? null : null;
  const losingState = facts.data?.find((fact) => fact.id === otherFact?.id)?.state;
  const resultingLosingState = losingState && losingState !== 'active' ? losingState : 'rejected';

  const submit = () => {
    if (!canSubmit || !conflict) return;
    resolve.mutate(
      { conflictId: conflict.id, input: { controllingFactId, note: note.trim() } },
      { onSuccess: () => navigate('/strategies/context/steward') },
    );
  };

  const doDismiss = () => {
    if (!conflict || !isOpen || conflicts.isError || dismiss.isPending || resolve.isPending) return;
    dismiss.mutate(conflict.id, { onSuccess: () => navigate('/strategies/context/steward') });
  };

  const busy = resolve.isPending || dismiss.isPending;

  const candidate = (key: 'A' | 'B', fact: ContextConflictFact | null, factId: string | null) => (
    <button
      type="button"
      className={`st-option-card${pick === key ? ' is-selected' : ''}`}
      aria-pressed={pick === key}
      disabled={!isOpen || busy || !fact || facts.data?.some((row) => row.id === factId && row.state !== 'active')}
      onClick={() => setPick(key)}
      style={{ textAlign: 'left' }}
    >
      <span className="st-option-card__head">
        <span className="st-pill st-mono">Fact {key}</span>
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
      subtitle="Pick the fact that controls going forward and say why. An active losing fact is rejected — no source document is edited."
      closeTo="/strategies/context/steward"
      maxWidth={900}
      dirty={Boolean((pick || note.trim()) && !busy)}
      primaryLabel="Resolve conflict"
      onPrimary={isOpen ? submit : undefined}
      primaryDisabled={!canSubmit}
      primaryBusy={busy}
      primaryDanger
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
              {errorMessage(resolve.error, 'Could not resolve the conflict. Please try again.')}
            </p>
          ) : null}
          {dismiss.isError ? (
            <p className="st-modal__alert" role="alert">
              {errorMessage(dismiss.error, 'Could not dismiss the conflict. Please try again.')}
            </p>
          ) : null}

          {/* Item 17: a small red monospace header specifically above the two
           * candidate cards — separate from the modal shell's own eyebrow
           * ("Steward review") and title ("Resolve the conflict"), which stay
           * as-is; this is new body copy, not a change to the shell chrome. */}
          <p className="st-panel__label st-mono" style={{ color: 'var(--st-error-fg)' }}>
            Choose authoritative value
          </p>
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
              <div className="st-cols st-cols--even">
                <div className="st-panel">
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
                  <p style={{ margin: '10px 0 0' }}>
                    <span className="st-pill st-pill--danger st-mono">No source content is edited</span>
                  </p>
                </div>

                <div className="st-dark-panel">
                  <p className="st-dark-panel__label">Resulting states</p>
                  {pickedFact ? (
                    <>
                      <p className="st-dark-panel__title" style={{ fontSize: 18, letterSpacing: 0 }}>
                        {pickedFact.fact}
                      </p>
                      <span className="st-pill st-pill--success">Active</span>
                      <p className="st-dark-panel__text" style={{ margin: '6px 0 12px' }}>
                        This fact remains active as the controlling source for this conflict.
                      </p>
                      <span className="st-pill st-pill--danger">{resultingLosingState.charAt(0).toUpperCase() + resultingLosingState.slice(1)}</span>
                      <p className="st-dark-panel__text" style={{ margin: '6px 0 0' }}>
                        {otherFact
                          ? `"${otherFact.fact}" remains queryable in history.`
                          : 'The other fact remains queryable in history.'}
                      </p>
                    </>
                  ) : (
                    <p className="st-dark-panel__text">Choose Fact A or Fact B above to preview the result.</p>
                  )}
                </div>
              </div>

              <div className="st-audit st-audit--danger">
                <span className="st-audit__icon-tile" aria-hidden="true">
                  !
                </span>
                <span>
                  <strong style={{ display: 'block', marginBottom: 4 }}>
                    This decision creates a durable steward record.
                  </strong>
                  Resolving rejects the losing fact if it is active; retired facts retain their existing state.{' '}
                  <strong>No source document is edited</strong> — the decision is recorded on the
                  conflict itself.
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
                  <span className="st-pill st-pill--danger st-mono">AUDIT-SAFE</span>
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
                </span>
              </div>
            </>
          ) : null}
        </>
      )}
    </StrategiesModalShell>
  );
}
