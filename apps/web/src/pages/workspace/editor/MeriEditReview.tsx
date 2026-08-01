import { useMemo, useState } from 'react';
import { VerificationStatus, type VerificationDisplay } from '../../../components/trust/VerificationStatus.js';
import type {
  WsAssistantConfidence,
  WsAssistantEdit,
  WsAssistantStructuralWarning,
} from '../api.js';
import {
  diffReviewText,
  htmlToReviewText,
  resolveCanonicalSection,
  type WorkspaceSectionState,
} from './edit-review.js';

export interface MeriEditCitation {
  n: number;
  title: string;
  url?: string | null;
}

export interface EditApplyOutcome {
  status: 'saved' | 'save_failed' | 'failed';
  message?: string;
}

function verificationDisplay(
  confidence: WsAssistantConfidence | undefined,
  warnings: WsAssistantStructuralWarning[],
): VerificationDisplay {
  const findings = warnings.map((warning) => ({
    check: warning.code,
    severity: 'high',
    detail: warning.message,
    section: warning.peCode,
  }));
  if (!confidence || confidence.level === 'unknown') {
    return {
      state: 'not_verified',
      label: 'Not verified',
      detail: 'No completed verification result was returned for these edits.',
      supportedCount: 0,
      unsupportedCount: 0,
      findings,
    };
  }
  if (confidence.level === 'high' && findings.length === 0) {
    return {
      state: 'verified',
      label: 'Verified',
      detail: confidence.label,
      supportedCount: 1,
      unsupportedCount: 0,
      findings,
    };
  }
  return {
    state: 'partially_verified',
    label: 'Partially verified',
    detail: confidence.label,
    supportedCount: confidence.level === 'low' ? 0 : 1,
    unsupportedCount: confidence.level === 'low' ? 1 : 0,
    findings,
  };
}

function citedNumbers(content: string | undefined): number[] {
  if (!content) return [];
  return [...content.matchAll(/\[(\d+)]/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isInteger(value));
}

export function MeriEditReview({
  edits,
  document,
  confidence,
  structuralWarnings = [],
  citations = [],
  onApply,
  onDismiss,
  onRetrySave,
  onUndo,
}: {
  edits: WsAssistantEdit[];
  document: WorkspaceSectionState;
  confidence?: WsAssistantConfidence;
  structuralWarnings?: WsAssistantStructuralWarning[];
  citations?: MeriEditCitation[];
  onApply: (edits: WsAssistantEdit[]) => Promise<EditApplyOutcome>;
  onDismiss: () => void;
  onRetrySave?: () => Promise<EditApplyOutcome>;
  onUndo?: () => Promise<EditApplyOutcome>;
}) {
  const [rejected, setRejected] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<Set<number>>(new Set(edits.map((_, index) => index)));
  const [state, setState] = useState<'pending' | 'applying' | 'saved' | 'save_failed' | 'failed'>('pending');
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDeletes, setConfirmDeletes] = useState(false);
  const display = verificationDisplay(confidence, structuralWarnings);

  const kept = useMemo(() => edits.filter((_, index) => !rejected.has(index)), [edits, rejected]);
  const destructive = kept.filter((edit) => edit.op === 'remove_section');

  const runApply = async (selected: WsAssistantEdit[]) => {
    setConfirmDeletes(false);
    setState('applying');
    setMessage(null);
    try {
      const outcome = await onApply(selected);
      setState(outcome.status);
      setMessage(outcome.message ?? null);
    } catch (error) {
      setState('failed');
      setMessage(error instanceof Error ? error.message : 'The edits could not be applied.');
    }
  };

  const applySelected = () => {
    if (!kept.length) return;
    if (destructive.length) setConfirmDeletes(true);
    else void runApply(kept);
  };

  const retrySave = async () => {
    if (!onRetrySave) return;
    setState('applying');
    const outcome = await onRetrySave();
    setState(outcome.status);
    setMessage(outcome.message ?? null);
  };

  const undo = async () => {
    if (!onUndo) return;
    setState('applying');
    const outcome = await onUndo();
    setState(outcome.status === 'saved' ? 'pending' : outcome.status);
    setMessage(outcome.message ?? 'Meri edits were undone.');
  };

  if (state === 'saved') {
    return (
      <div className="meri-edit-review meri-edit-review--saved" role="status">
        <strong>Applied and saved.</strong>
        {message && <span> {message}</span>}
        {onUndo && (
          <button type="button" onClick={() => void undo()}>
            Undo last Meri application
          </button>
        )}
      </div>
    );
  }

  return (
    <section className="meri-edit-review" aria-label="Review Meri edits">
      <header>
        <div>
          <strong>Proposed edits · {edits.length}</strong>
          <span> Review before anything changes.</span>
        </div>
        <VerificationStatus display={display} compact />
      </header>

      {(state === 'save_failed' || state === 'failed') && (
        <div className="meri-edit-review__error" role="alert">
          <strong>{state === 'save_failed' ? 'Applied locally; save failed.' : 'Apply failed.'}</strong>{' '}
          {message || 'Your proposed edits remain available.'}
          <div>
            {state === 'save_failed' && onRetrySave && (
              <button type="button" onClick={() => void retrySave()}>
                Retry save
              </button>
            )}
            {onUndo && (
              <button type="button" onClick={() => void undo()}>
                Undo local changes
              </button>
            )}
          </div>
        </div>
      )}

      <div className="meri-edit-review__items">
        {edits.map((edit, index) => {
          const off = rejected.has(index);
          const target =
            edit.op === 'insert_section'
              ? edit.name || 'New section'
              : resolveCanonicalSection(document.sections, edit.section) || edit.section || 'Section';
          const beforeHtml =
            edit.op === 'insert_section' ? '' : document.content[target] ?? '';
          const afterHtml = edit.op === 'remove_section' ? '' : edit.content ?? '';
          const before = htmlToReviewText(beforeHtml);
          const after = htmlToReviewText(afterHtml);
          const diff = diffReviewText(before, after);
          const editCitations = citedNumbers(edit.content)
            .map((number) => citations.find((citation) => citation.n === number))
            .filter((citation): citation is MeriEditCitation => Boolean(citation));
          const isExpanded = expanded.has(index);
          return (
            <article
              key={`${edit.op}-${target}-${index}`}
              className={`meri-edit-review__item${off ? ' meri-edit-review__item--rejected' : ''}`}
            >
              <div className="meri-edit-review__item-heading">
                <div>
                  <span className={`meri-edit-review__op meri-edit-review__op--${edit.op}`}>
                    {edit.op === 'replace_section'
                      ? 'Rewrite'
                      : edit.op === 'insert_section'
                        ? 'Add section'
                        : 'Remove section'}
                  </span>
                  <strong>{target}</strong>
                  {edit.op === 'remove_section' && <span className="meri-edit-review__destructive">Destructive</span>}
                </div>
                <div>
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (next.has(index)) next.delete(index);
                        else next.add(index);
                        return next;
                      })
                    }
                    aria-expanded={isExpanded}
                  >
                    {isExpanded ? 'Collapse' : 'Expand'}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setRejected((current) => {
                        const next = new Set(current);
                        if (next.has(index)) next.delete(index);
                        else next.add(index);
                        return next;
                      })
                    }
                  >
                    {off ? 'Accept' : 'Reject'}
                  </button>
                </div>
              </div>

              {edit.note && <p className="meri-edit-review__rationale">{edit.note}</p>}

              {isExpanded && (
                <div className="meri-edit-review__expanded">
                  <div className="meri-edit-review__columns">
                    <section>
                      <h5>Before</h5>
                      <div>{before || '(new section)'}</div>
                    </section>
                    <section>
                      <h5>After</h5>
                      <div>{after || '(section removed)'}</div>
                    </section>
                  </div>
                  <section className="meri-edit-review__diff" aria-label={`Diff for ${target}`}>
                    <h5>Changes</h5>
                    <div>
                      {diff.map((part, partIndex) => (
                        <span key={partIndex} className={`diff-part diff-part--${part.type}`}>
                          {part.value}
                        </span>
                      ))}
                    </div>
                  </section>
                  <div className="meri-edit-review__sources">
                    {editCitations.length ? (
                      editCitations.map((citation) =>
                        citation.url ? (
                          <a key={citation.n} href={citation.url} target="_blank" rel="noreferrer">
                            [{citation.n}] {citation.title}
                          </a>
                        ) : (
                          <span key={citation.n}>[{citation.n}] {citation.title}</span>
                        ),
                      )
                    ) : (
                      <span>No source citations attached to this edit.</span>
                    )}
                  </div>
                  {edit.content && (
                    <button
                      type="button"
                      onClick={() => void navigator.clipboard.writeText(htmlToReviewText(edit.content))}
                    >
                      Copy proposed content
                    </button>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>

      <footer className="meri-edit-review__actions">
        <button type="button" disabled={!kept.length || state === 'applying'} onClick={applySelected}>
          {state === 'applying' ? 'Applying…' : `Apply ${kept.length} selected`}
        </button>
        {display.state === 'verified' && edits.some((edit) => edit.op !== 'remove_section') && (
          <button
            type="button"
            disabled={state === 'applying'}
            onClick={() => void runApply(edits.filter((edit) => edit.op !== 'remove_section'))}
          >
            Apply all verified non-destructive edits
          </button>
        )}
        <button type="button" disabled={state === 'applying'} onClick={onDismiss}>
          Dismiss
        </button>
      </footer>

      {confirmDeletes && (
        <div className="action-proposal-dialog-backdrop" role="presentation">
          <section
            className="action-proposal-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-section-removal"
          >
            <h3 id="confirm-section-removal">Remove {destructive.length} section{destructive.length === 1 ? '' : 's'}?</h3>
            <p>This deletes the current section content from the working document. You can undo the last Meri application after it saves.</p>
            <ul>{destructive.map((edit, index) => <li key={index}>{edit.section}</li>)}</ul>
            <div className="action-proposal-dialog__actions">
              <button type="button" onClick={() => setConfirmDeletes(false)}>Cancel</button>
              <button type="button" onClick={() => void runApply(kept)}>Confirm removal and apply</button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
