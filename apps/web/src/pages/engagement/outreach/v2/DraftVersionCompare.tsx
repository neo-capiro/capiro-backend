// Phase 2 §3.f3 — compare/merge UI for a regeneration the server offered as a
// CANDIDATE instead of applying directly (see versioned-drafts.ts DraftCandidate
// and outreach-draft.service.ts upsertGeneratedVersionOrCandidate). The current
// draft is never touched until the user picks one of the three actions below.

import { useState } from 'react';
import type { DraftCandidate } from './versioned-drafts.js';

interface Props {
  candidate: DraftCandidate;
  /** The slot's current, unedited-by-this-flow display name (for the card header). */
  slotName: string;
  current: { subject: string; body: string };
  /** Discard the candidate — it stays immutable, non-current history; nothing to send. */
  onKeepMine: () => void;
  /** POST the accept endpoint, then apply the candidate as the slot's new draft. */
  onAccept: () => void | Promise<void>;
  /** Save `subject`/`body` as a new edited version based on the CURRENT draft. */
  onMergeManually: (subject: string, body: string) => void | Promise<void>;
  busy?: boolean;
}

/** Strips the lightweight HTML the editor renders, for a plain-text side-by-side preview. */
function toPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}

export function DraftVersionCompare({
  candidate,
  slotName,
  current,
  onKeepMine,
  onAccept,
  onMergeManually,
  busy,
}: Props) {
  const [merging, setMerging] = useState(false);
  const [mergeSubject, setMergeSubject] = useState(current.subject);
  const [mergeBody, setMergeBody] = useState(toPlainText(current.body));

  const startMerge = () => {
    setMergeSubject(current.subject);
    setMergeBody(toPlainText(current.body));
    setMerging(true);
  };

  return (
    <div className="ov2-draftcmp" role="region" aria-label={`Regeneration offered for ${slotName}`}>
      <div className="ov2-draftcmp-head">
        <span className="ov2-draftcmp-title">A regenerated draft is available for {slotName}</span>
        <span className="ov2-draftcmp-sub">
          Your edited draft was kept as-is — nothing was overwritten. Choose how to proceed.
        </span>
      </div>

      {!merging ? (
        <div className="ov2-draftcmp-columns">
          <div className="ov2-draftcmp-col">
            <div className="ov2-draftcmp-col-head">Current (yours)</div>
            <div className="ov2-draftcmp-subject">{current.subject || '(no subject)'}</div>
            <div className="ov2-draftcmp-body">{toPlainText(current.body) || '(empty)'}</div>
          </div>
          <div className="ov2-draftcmp-col">
            <div className="ov2-draftcmp-col-head">Regenerated candidate</div>
            <div className="ov2-draftcmp-subject">{candidate.subject || '(no subject)'}</div>
            <div className="ov2-draftcmp-body">{toPlainText(candidate.body) || '(empty)'}</div>
          </div>
        </div>
      ) : (
        <div className="ov2-draftcmp-merge">
          <div className="ov2-draftcmp-col-head">
            Merge manually — starts from your current draft; copy in anything you want from the
            candidate above.
          </div>
          <input
            className="ov2-draftcmp-merge-subject"
            value={mergeSubject}
            onChange={(e) => setMergeSubject(e.target.value)}
            placeholder="Subject"
          />
          <textarea
            className="ov2-draftcmp-merge-body"
            value={mergeBody}
            onChange={(e) => setMergeBody(e.target.value)}
            rows={8}
          />
        </div>
      )}

      <div className="ov2-draftcmp-actions">
        {!merging ? (
          <>
            <button type="button" className="ov2-draftcmp-btn" disabled={busy} onClick={onKeepMine}>
              Keep mine
            </button>
            <button
              type="button"
              className="ov2-draftcmp-btn primary"
              disabled={busy}
              onClick={() => void onAccept()}
            >
              Use regenerated
            </button>
            <button type="button" className="ov2-draftcmp-btn" disabled={busy} onClick={startMerge}>
              Merge manually
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="ov2-draftcmp-btn"
              disabled={busy}
              onClick={() => setMerging(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="ov2-draftcmp-btn primary"
              disabled={busy}
              onClick={() => void onMergeManually(mergeSubject, mergeBody)}
            >
              Save merged draft
            </button>
          </>
        )}
      </div>
    </div>
  );
}
