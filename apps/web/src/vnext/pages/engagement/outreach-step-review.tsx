import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useApi } from '../../../lib/use-api.js';
import {
  acceptContextCommand,
  excludeContextCommand,
} from '../../../pages/engagement/outreach/v3/commands.js';
import type {
  OutreachV3Command,
  OutreachV3ContextSelection,
  OutreachV3ResolvedContextRef,
  OutreachV3SessionEnvelope,
} from '../../../pages/engagement/outreach/v3/contracts.js';
import { safeOutreachV3Error } from '../../../pages/engagement/outreach/v3/outreach-v3-api.js';
import {
  approveOutreachV3ReviewPacket,
  classifyOutreachV3FullGenerationResult,
  outreachV3FullGenerationRequestKey,
  startOutreachV3FullGeneration,
} from './engagement-api.js';
import {
  type OutreachBuilderStepCommon,
  outreachCampaignNameFromSpec,
  outreachRecipientSummary,
  outreachSelectedTargets,
  outreachTargetIsSendable,
} from './outreach-builder-model.js';
import {
  targetDisplayName,
  targetNoteContextSelection,
} from './outreach-v3-guided-workflow.js';
import './outreach-builder.css';
import './outreach-step-review.css';

/* ------------------------------------------------------------------ *
 * Personal notes, read back out of the spec
 * ------------------------------------------------------------------ */

/**
 * A personal note is a real, target-scoped `target_specific` context ref, not
 * component state — that is what makes the step's own promise ("A note reaches
 * that person's draft and no one else's") true rather than decorative.
 *
 * Both constants must stay byte-identical to what
 * `targetNoteContextSelection` writes, curly apostrophe included: they are the
 * only handle this step has for recognising its own refs on a later visit.
 */
const NOTE_TITLE_PREFIX = 'Personal note — ';
const NOTE_BODY_MARKER = 'Apply this note only to this recipient’s draft: ';

interface SavedNote {
  targetKey: string;
  contextKey: string;
  text: string;
}

/**
 * The manual locator's `text` is echoed back as the resolved ref's `summary`
 * (see `resolvedManualContext` in `outreach-command-engine.service.spec.ts`),
 * so the note survives a round trip. A ref whose summary no longer carries the
 * marker yields an empty note rather than the machine preamble — showing the
 * user "Personal note for X. Apply this note only to…" in an editable field
 * would be worse than showing nothing.
 */
function savedPersonalNotes(session: OutreachV3SessionEnvelope | null): SavedNote[] {
  const refs: OutreachV3ResolvedContextRef[] = session?.spec.context.targetSpecificRefs ?? [];
  const notes: SavedNote[] = [];
  for (const ref of refs) {
    const targetKey = ref.scope.targetKey;
    if (ref.scope.kind !== 'target' || typeof targetKey !== 'string' || !targetKey) continue;
    if (!ref.title.startsWith(NOTE_TITLE_PREFIX)) continue;
    const summary = typeof ref.summary === 'string' ? ref.summary : '';
    const at = summary.indexOf(NOTE_BODY_MARKER);
    notes.push({
      targetKey,
      contextKey: ref.contextKey,
      text: at === -1 ? '' : summary.slice(at + NOTE_BODY_MARKER.length).trim(),
    });
  }
  return notes;
}

/* ------------------------------------------------------------------ *
 * "Context in this packet"
 * ------------------------------------------------------------------ */

interface ContextChip {
  label: string;
  count: string;
}

/**
 * The prototype's chips come from a seed constant — per-template knobs, or six
 * hardcoded sources with hardcoded record counts ("4 records", "6 records").
 * None of that exists on the real spec, and printing a fixed count beside a
 * real campaign would be a fabricated number. So the chips report what the
 * packet actually carries: the accepted context refs, grouped by the class
 * that decides how each one may be used.
 */
const CONTEXT_CLASS_CHIPS: Array<{
  label: string;
  refs: (spec: OutreachV3SessionEnvelope['spec']) => OutreachV3ResolvedContextRef[];
}> = [
  { label: 'Required policy', refs: (spec) => spec.context.requiredPolicyRefs },
  { label: 'Campaign facts', refs: (spec) => spec.context.campaignFactRefs },
  { label: 'Writing guidance', refs: (spec) => spec.context.writingGuidanceRefs },
  { label: 'Recipient-specific', refs: (spec) => spec.context.targetSpecificRefs },
  { label: 'Group-safe', refs: (spec) => spec.context.groupSafeRefs },
];

function contextChips(session: OutreachV3SessionEnvelope | null): ContextChip[] {
  if (!session) return [];
  return CONTEXT_CLASS_CHIPS.flatMap(({ label, refs }) => {
    const count = refs(session.spec).length;
    if (!count) return [];
    return [{ label, count: `${count} ${count === 1 ? 'record' : 'records'}` }];
  });
}

/* ------------------------------------------------------------------ *
 * Step
 * ------------------------------------------------------------------ */

export interface OutreachReviewStepProps extends OutreachBuilderStepCommon {
  /** Generation started for real; the builder moves to Drafts. */
  onGenerationStarted: () => void;
}

export function OutreachReviewStep(props: OutreachReviewStepProps): JSX.Element {
  const { session, sessionId, busy, applyCommands, toast, primaryLabel, onGenerationStarted } =
    props;
  const api = useApi();
  const [noteEdits, setNoteEdits] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targets = outreachSelectedTargets(session);
  const subject = outreachCampaignNameFromSpec(session);
  const chips = useMemo(() => contextChips(session), [session]);
  const saved = useMemo(() => savedPersonalNotes(session), [session]);

  const savedByTarget = useMemo(() => {
    const map = new Map<string, string>();
    for (const note of saved) map.set(note.targetKey, note.text);
    return map;
  }, [saved]);

  /**
   * An unedited field shows whatever the spec already holds, so returning to
   * this step after an accept shows the notes that were actually saved. Local
   * edits shadow the spec instead of being copied into state on load, which
   * removes the usual "effect overwrites what the user is typing" race.
   */
  const noteValue = (targetKey: string): string =>
    noteEdits[targetKey] ?? savedByTarget.get(targetKey) ?? '';

  const selectedKeys = new Set(targets.map((target) => target.targetKey));
  const notesChanged =
    // An orphan note — one whose recipient has since been deselected — must be
    // superseded too, or the packet keeps carrying a note about someone the
    // campaign no longer reaches.
    saved.some((note) => !selectedKeys.has(note.targetKey)) ||
    targets.some(
      (target) =>
        noteValue(target.targetKey).trim() !== (savedByTarget.get(target.targetKey) ?? ''),
    );

  const recipientCount = targets.length;
  // The prototype leaves this button live with zero recipients and its handler
  // has no guard, so the press is dead: it toasts "generating 0 drafts" and
  // lands on an empty Drafts step. Here it is disabled, which is the same
  // refusal stated once and perceivable by a keyboard and a screen reader.
  const canAccept = recipientCount > 0 && !busy && !submitting;

  const accept = async () => {
    if (!canAccept) return;
    setSubmitting(true);
    setError(null);
    try {
      if (notesChanged) {
        const selections: OutreachV3ContextSelection[] = [];
        for (const target of targets) {
          const selection = targetNoteContextSelection({
            target,
            note: noteValue(target.targetKey),
          });
          if (selection) selections.push(selection);
        }
        const commands: OutreachV3Command[] = [];
        // Both builders throw on an empty list, and a cleared-every-note accept
        // legitimately produces one — so each is conditional, not defensive.
        if (selections.length) commands.push(acceptContextCommand(selections));
        if (saved.length) {
          commands.push(
            excludeContextCommand(
              saved.map((note) => ({ contextKey: note.contextKey, reason: 'superseded' as const })),
            ),
          );
        }
        if (commands.length) await applyCommands(commands);
      }

      // Skipping the batch when nothing changed is not just an optimisation:
      // every accept mints fresh note refs, which moves the state version and
      // therefore the approval hash. Leaving the spec alone on a retry keeps
      // the request key below identical, so a retry after a failed start
      // resolves to the SAME backend job instead of a duplicate.
      const approval = await approveOutreachV3ReviewPacket(api, sessionId);
      const approvalHash = approval.approval?.approvalHash;
      if (!approvalHash) {
        // Fail closed. A malformed approval response is not an approval, and
        // deriving a request key from missing state would silently unbind
        // generation from the packet the user actually read.
        throw new Error(
          'The review packet could not be approved. No approval reference was returned.',
        );
      }

      const requestKey = outreachV3FullGenerationRequestKey(sessionId, approvalHash);
      const generation = await startOutreachV3FullGeneration(api, sessionId, requestKey);
      const outcome = classifyOutreachV3FullGenerationResult(generation);
      if (outcome.kind === 'invalid') {
        // Neither a job nor a completed generation. Never advance on this.
        throw new Error(
          'Generation did not start. The server returned neither a generation job nor a completed result.',
        );
      }
      if (outcome.kind === 'job') {
        try {
          window.sessionStorage.setItem(`outreach-v3:${sessionId}:phase1-job`, outcome.jobId);
        } catch {
          // A same-tab cache only — server-truth recovery reads
          // `/generation/jobs/latest`. A storage failure must not be reported
          // as a generation failure, because generation did start.
        }
      }

      toast(
        `Packet accepted · generating ${recipientCount} ${recipientCount === 1 ? 'draft' : 'drafts'}`,
      );
      onGenerationStarted();
    } catch (cause) {
      // Stay on Review with the packet intact: notes, edits and selection are
      // untouched and the whole sequence is safe to replay.
      setError(`Draft generation could not start. ${safeOutreachV3Error(cause)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="ocb-step ocb-stack ocb-stack--wide ocb-review">
      <div className="ocb-accent-panel ocb-review__packet">
        <span className="ocb-eyebrow">Subject line</span>
        {/* The prototype renders an empty 28px line when the name is blank.
            "Not set" is its own vocabulary for an unfilled field (the Name
            step's summary rows), so it is used here rather than a void. */}
        <span className="ocb-review__subject" data-unset={subject ? 'false' : 'true'}>
          {subject || 'Not set'}
        </span>
        <span className="ocb-review__count">{outreachRecipientSummary(recipientCount)}</span>
      </div>

      <div className="ocb-card ocb-review__context">
        <span className="ocb-eyebrow">Context in this packet</span>
        {chips.length === 0 && (
          <span className="ocb-review__ctx-empty">
            No context selected. Drafts will use the campaign brief only.
          </span>
        )}
        {/* Rendered even when empty, as in the prototype: the parent's 10px gap
            below the empty sentence is part of the layout. */}
        <div className="ocb-review__chips">
          {chips.map((chip) => (
            <span className="ocb-review__chip" key={chip.label}>
              {chip.label}
              <span className="ocb-review__chip-count">{chip.count}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="ocb-card ocb-review__table">
        <div className="ocb-card-head">
          <span className="ocb-eyebrow">Recipients · personal note</span>
          <span className="ocb-review__head-help">
            A note reaches that person’s draft and no one else’s
          </span>
        </div>
        <div className="ocb-review__rows">
          {targets.length === 0 ? (
            /* The prototype has no zero-recipient state here — it renders the
               header strip over nothing. This sentence is not prototype copy;
               its second clause is the Targets step's own title. */
            <p className="ocb-empty ocb-prose">
              No recipients selected. Choose the people and offices to contact before accepting the
              packet.
            </p>
          ) : (
            targets.map((target) => {
              const name = targetDisplayName(target);
              // The prototype composes "role · office" unguarded and prints a
              // bare " · " when either side is missing.
              const subtitle = [target.title, target.organization]
                .filter((part): part is string => Boolean(part && part.trim()))
                .join(' · ');
              return (
                <div className="ocb-review__row" key={target.targetKey}>
                  <span className="ocb-review__id">
                    <span className="ocb-review__id-top">
                      <span className="ocb-review__name">{name}</span>
                      {/* Same test the Send step's held-out set uses, so a
                          recipient flagged here is exactly one that will be
                          held back later. It also covers an address the server
                          marked invalid, which the prototype's copy does not
                          distinguish. */}
                      {!outreachTargetIsSendable(target) && (
                        <span className="ocb-review__no-email">No email on file</span>
                      )}
                    </span>
                    {subtitle && <span className="ocb-review__sub">{subtitle}</span>}
                  </span>
                  <textarea
                    className="ocb-textarea ocb-review__note"
                    rows={2}
                    aria-label={`Personal note for ${name}`}
                    placeholder="Optional — a line only this person will see referenced in their draft."
                    value={noteValue(target.targetKey)}
                    onChange={(event) => {
                      const { value } = event.target;
                      setNoteEdits((current) => ({ ...current, [target.targetKey]: value }));
                    }}
                  />
                </div>
              );
            })
          )}
        </div>
      </div>

      {error && (
        <p className="ocb-note ocb-note--warn" role="alert">
          {error}
        </p>
      )}

      <div className="ocb-review__foot">
        <p className="ocb-note">
          Accepting the packet is what authorises generation. Nothing is written before this.
        </p>
        <button
          type="button"
          className="ocb-btn ocb-btn--primary"
          onClick={() => void accept()}
          disabled={!canAccept}
          aria-busy={submitting}
        >
          {/* The prototype's button carries a vestigial 8px gap and no icon;
              the spinner uses it. The label never changes — this step has no
              "generating" copy of its own. */}
          {submitting && <Loader2 size={16} className="ocb-review__spin" aria-hidden="true" />}
          {primaryLabel}
        </button>
      </div>
    </div>
  );
}
