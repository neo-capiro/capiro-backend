import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Loader2, RefreshCcw, Sparkles } from 'lucide-react';
import { useApi } from '../../../lib/use-api.js';
import type {
  OutreachV3ResolvedTargetRef,
  OutreachV3SessionEnvelope,
} from '../../../pages/engagement/outreach/v3/contracts.js';
import { safeOutreachV3Error } from '../../../pages/engagement/outreach/v3/outreach-v3-api.js';
import {
  approveOutreachV3Draft,
  getOutreachV3DraftVersion,
  listOutreachV3Drafts,
  refineOutreachV3Draft,
  reviseOutreachV3Draft,
  type OutreachV3DraftArtifact,
  type OutreachV3DraftVersion,
} from './engagement-api.js';
import {
  outreachSelectedTargets,
  type OutreachBuilderStepCommon,
} from './outreach-builder-model.js';
import './outreach-step-drafts.css';

/**
 * Drafts — one draft per recipient, read one at a time.
 *
 * Three prototype behaviours are deliberately NOT reproduced:
 *
 * 1. The prototype's `refine()` bumps a local version counter and never touches
 *    the body, so "Regenerate" and "Change tone" claim work they did not do.
 *    Every tool here calls the real endpoint and the version shown is the one
 *    the server returned — there is no client-side counter in this file.
 * 2. The prototype writes the edit textarea into the draft on every keystroke,
 *    which makes "Save as new version" decorative and contradicts the step's
 *    own promise that a draft is immutable. Typing fills a local buffer here;
 *    only Save creates a version.
 * 3. The prototype keeps the Meri instruction and the tone in one global slot,
 *    so a half-typed instruction for one recipient is still in the box when you
 *    open another. Both are cleared when the reader moves.
 */

const TONES = [
  'Professional',
  'Warm',
  'Concise',
  'Direct',
  'Persuasive',
  'Conversational',
] as const;

type OutreachDraftTone = (typeof TONES)[number];

type OutreachDraftTool = 'edit' | 'meri' | 'tone' | null;

/**
 * The instruction wording is the one `outreach-v3-draft-recipient-controls.tsx`
 * already sends for the same three tools, kept identical so a refine issued
 * from this surface and one issued from the approve/send workspace reach the
 * model as the same request. It is also what the panel's footnote promises.
 */
function meriInstruction(request: string): string {
  return `Create a new version of this recipient's draft with this instruction: ${request}. Preserve the exact approved subject line, recipient, sponsor facts, recipient-specific note, and ask. Do not introduce unsupported facts.`;
}

function toneInstruction(tone: OutreachDraftTone): string {
  return `Create a new version of this recipient's draft in a ${tone.toLowerCase()} tone. Preserve the exact approved subject line, recipient, factual content, recipient-specific note, and ask. Do not add new facts.`;
}

const REGENERATE_INSTRUCTION =
  "Regenerate this recipient's draft from the approved campaign packet. Keep the exact approved subject line, recipient, sponsor facts, recipient-specific note, and ask. Write a genuinely fresh body instead of lightly editing the current wording, and do not introduce unsupported facts.";

/**
 * The title `targetNoteContextSelection` writes for a personal note. Other
 * target-scoped context can exist (a manual profile, a client record), and only
 * the note belongs under "Personal note used".
 */
const PERSONAL_NOTE_TITLE_PREFIX = 'Personal note';

/**
 * The note is stored inside a sentence addressed to the writer. Strip that
 * lead-in for display, and show the stored text unchanged when it does not
 * match — a note the reader can see verbatim is worth more than a tidy one.
 */
const NOTE_LEAD_IN =
  /^Personal note for [\s\S]*?Apply this note only to this recipient(?:'|’)s draft:\s*/;

function personalNoteFor(
  session: OutreachV3SessionEnvelope | null,
  targetKey: string | null,
): string {
  if (!targetKey) return '';
  const refs = session?.spec.context.targetSpecificRefs ?? [];
  const ref = refs.find(
    (candidate) =>
      candidate.scope.kind === 'target' &&
      candidate.scope.targetKey === targetKey &&
      candidate.title.startsWith(PERSONAL_NOTE_TITLE_PREFIX),
  );
  if (!ref) return '';
  const raw = typeof ref.locator.text === 'string' ? ref.locator.text : ref.summary;
  return (raw ?? '').replace(NOTE_LEAD_IN, '').trim();
}

function targetRole(target: OutreachV3ResolvedTargetRef): string {
  return [target.title, target.organization].filter(Boolean).join(' · ');
}

export interface OutreachDraftRow {
  key: string;
  artifact: OutreachV3DraftArtifact;
  /** The resolved target, or `null` for a shared-thread draft (there is no single one). */
  targetKey: string | null;
  name: string;
  role: string;
  version: number;
  state: string;
  note: string;
}

/**
 * A v3 draft's `recipientKey` IS the `targetKey` for an individual draft
 * (`outreach-v3-generation-plan.ts` sets both from the same target), so the rail
 * resolves names straight off the spec and needs no generation-plan read.
 *
 * A shared-thread draft keys on `shared:<hash>` and matches no single target —
 * it is named from the people actually on it rather than from that hash, and
 * carries no personal note, because a note that reaches one person cannot ride
 * a shared email.
 */
export function outreachDraftRows(
  drafts: OutreachV3DraftArtifact[],
  session: OutreachV3SessionEnvelope | null,
): OutreachDraftRow[] {
  const targets = outreachSelectedTargets(session);
  const targetName = (target: OutreachV3ResolvedTargetRef) =>
    target.displayName || target.email || target.targetKey;
  return drafts.map((artifact) => {
    const recipientKey = artifact.current?.recipientKey || artifact.recipientKey;
    const target = targets.find((candidate) => candidate.targetKey === recipientKey) ?? null;
    const version = artifact.current?.version ?? artifact.currentVersion;
    const shared = !target && artifact.audienceKind === 'group' && targets.length > 0;
    return {
      key: artifact.id,
      artifact,
      targetKey: target?.targetKey ?? null,
      name: target
        ? targetName(target)
        : shared
          ? targets.map(targetName).join(' · ')
          : recipientKey,
      role: target ? targetRole(target) : '',
      version,
      // Every tool creates a server version, so anything past V1 was edited.
      state: version > 1 ? 'Edited · new version' : 'Ready for your read',
      note: personalNoteFor(session, target?.targetKey ?? null),
    };
  });
}

function errorText(error: unknown, fallback: string): string {
  const safe = safeOutreachV3Error(error);
  return safe || (error instanceof Error ? error.message : fallback);
}

export function OutreachDraftsStep(props: OutreachBuilderStepCommon): JSX.Element {
  const { sessionId, session, busy, toast, onNext, primaryLabel } = props;
  const api = useApi();
  const qc = useQueryClient();

  const draftsQuery = useQuery({
    queryKey: ['outreach-v3', 'drafts', sessionId],
    queryFn: () => listOutreachV3Drafts(api, sessionId),
    enabled: Boolean(sessionId),
    retry: false,
  });

  const rows = useMemo(
    () => outreachDraftRows(draftsQuery.data ?? [], session),
    [draftsQuery.data, session],
  );

  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [tool, setTool] = useState<OutreachDraftTool>(null);
  /**
   * In-progress body edits, keyed by the draft VERSION they were started from.
   *
   * Keying on the version rather than on the panel's open/closed state is what
   * makes collapsing "Edit text" and reopening it non-destructive, and what
   * stops a switch to "Edit with Meri" and back from discarding a paragraph
   * the user had just rewritten. It also cannot leak between recipients: a
   * different recipient's current version is a different id, so the buffer is
   * empty and falls back to that draft's own body. Saving creates a NEW
   * version, whose id has no entry — so the reader shows the saved text, not
   * the stale draft it came from.
   */
  const [bodyEdits, setBodyEdits] = useState<Record<string, string>>({});
  const [instruction, setInstruction] = useState('');
  const [tone, setTone] = useState<OutreachDraftTone>('Professional');
  const [error, setError] = useState<string | null>(null);

  // No effect syncs `activeKey` to the first row: falling back on read gives
  // the prototype's `dactive || keys[0]` without a render in which the reader
  // is empty while a draft is already sitting in the rail.
  const active = rows.find((row) => row.key === activeKey) ?? rows.at(0) ?? null;

  /**
   * An artifact can exist with no current version (generation failed for that
   * recipient). Its newest history entry is still readable, so the reader
   * fetches it rather than showing a blank card with no explanation.
   */
  const historyFallbackId = active?.artifact.current
    ? null
    : ([...(active?.artifact.history ?? [])].sort((a, b) => b.version - a.version).at(0)?.id ??
      null);
  const historyQuery = useQuery({
    queryKey: ['outreach-v3', 'draft-version', sessionId, historyFallbackId],
    queryFn: () => getOutreachV3DraftVersion(api, sessionId, historyFallbackId ?? ''),
    enabled: Boolean(sessionId && historyFallbackId),
    retry: false,
  });

  const reading: OutreachV3DraftVersion | null =
    active?.artifact.current ?? historyQuery.data ?? null;
  // Only the artifact's CURRENT version can be revised, refined or approved; a
  // recovered history version is read-only.
  const editable = active?.artifact.current ?? null;

  const bufferKey = editable?.id ?? '';
  const bodyBuffer = bodyEdits[bufferKey] ?? reading?.body ?? '';
  const setBodyBuffer = (text: string) =>
    setBodyEdits((current) => ({ ...current, [bufferKey]: text }));

  const refresh = () => qc.invalidateQueries({ queryKey: ['outreach-v3', 'drafts', sessionId] });

  const selectRecipient = (key: string) => {
    setActiveKey(key);
    setTool(null);
    setInstruction('');
    setTone('Professional');
    setError(null);
  };

  const toggleTool = (next: Exclude<OutreachDraftTool, null>) => {
    setError(null);
    setTool((current) => (current === next ? null : next));
  };

  const settle = (label: string, name: string, version: OutreachV3DraftVersion) => {
    setTool(null);
    toast(`${label} · ${name} now at V${version.version}`);
    void refresh();
  };

  const saveEdit = useMutation({
    mutationFn: async (vars: { name: string; body: string }) => {
      if (!active || !editable) throw new Error('This recipient has no current draft version.');
      const version = await reviseOutreachV3Draft(api, sessionId, active.artifact.id, {
        baseVersionId: editable.id,
        // This step reads the subject; it does not edit it. Sending the
        // version's own subject back keeps the edit to the body alone.
        subject: editable.subject,
        body: vars.body,
        editKind: 'manual',
      });
      return { version, name: vars.name };
    },
    onSuccess: ({ version, name }) => settle('Text edit saved', name, version),
    onError: (cause) => setError(errorText(cause, 'The text edit could not be saved.')),
  });

  const refine = useMutation({
    mutationFn: async (vars: { name: string; label: string; instruction: string }) => {
      if (!active || !editable) throw new Error('This recipient has no current draft version.');
      const version = await refineOutreachV3Draft(api, sessionId, active.artifact.id, {
        baseVersionId: editable.id,
        instruction: vars.instruction,
      });
      return { version, name: vars.name, label: vars.label };
    },
    onSuccess: ({ version, name, label }) => settle(label, name, version),
    onError: (cause) => setError(errorText(cause, 'A new version could not be created.')),
  });

  /**
   * "Continue to send" approves the exact versions the reader has just been
   * shown, in one gesture.
   *
   * The prototype has no approve control at all, but the server's preflight
   * blocks on DRAFT_NOT_EXACTLY_APPROVED per version, so strict parity would
   * make Send unreachable. Approving here is the prototype's own stated
   * contract — "approval is pinned to the exact version you read" — expressed
   * as the act of leaving the step. Approvals run one at a time so a failure
   * names the draft it stopped on instead of landing as one opaque batch error,
   * and an already-approved version is skipped so re-entering the step is free.
   */
  const continueToSend = useMutation({
    mutationFn: async () => {
      for (const row of rows) {
        const version = row.artifact.current;
        if (!version || version.approvalStatus === 'approved') continue;
        await approveOutreachV3Draft(api, sessionId, version.id);
      }
    },
    onSuccess: async () => {
      await refresh();
      onNext();
    },
    onError: (cause) =>
      setError(errorText(cause, 'These versions could not be approved for sending.')),
  });

  const working = saveEdit.isPending || refine.isPending || continueToSend.isPending;
  const toolsDisabled = busy || working || !editable;
  const ungenerated = rows.filter((row) => !row.artifact.current).length;
  const spinner = <Loader2 size={14} className="ocb-drafts__spin" aria-hidden="true" />;

  return (
    <div className="ocb-split ocb-split--rail ocb-drafts">
      <div className="ocb-drafts__rail">
        <span className="ocb-eyebrow ocb-drafts__rail-label">Recipients</span>
        {rows.map((row) => {
          const on = row.key === active?.key;
          return (
            <button
              key={row.key}
              type="button"
              className="ocb-drafts__recipient"
              data-selected={on ? 'true' : undefined}
              aria-current={on ? 'true' : undefined}
              onClick={() => selectRecipient(row.key)}
            >
              <span className="ocb-drafts__recipient-top">
                <span className="ocb-drafts__recipient-name">{row.name}</span>
                <span className="ocb-drafts__recipient-version">{`V${row.version}`}</span>
              </span>
              <span className="ocb-drafts__recipient-role">{row.role}</span>
              <span className="ocb-drafts__recipient-state">
                <span>{row.state}</span>
                {row.note.trim() ? <span className="ocb-drafts__note-pill">Note</span> : null}
              </span>
            </button>
          );
        })}
      </div>

      <div className="ocb-card ocb-drafts__reader">
        {!active ? (
          // The prototype renders an em dash into an otherwise complete card
          // when there is nothing to read. Nothing has been generated at this
          // point in a real campaign, so the honest state says so and names the
          // step that fixes it.
          <div className="ocb-empty ocb-empty--center">
            {draftsQuery.isPending
              ? 'Loading drafts…'
              : draftsQuery.isError
                ? errorText(draftsQuery.error, 'The drafts could not be loaded.')
                : 'No drafts yet. Accept the packet on the review step to generate one draft per recipient.'}
          </div>
        ) : (
          <>
            <div className="ocb-drafts__head">
              <span className="ocb-drafts__head-name">{active.name}</span>
              <span className="ocb-drafts__head-role">{active.role}</span>
              <span className="ocb-drafts__version" aria-live="polite">
                {`V${active.version}`}
              </span>
            </div>

            <div className="ocb-drafts__body">
              <div className="ocb-drafts__tools">
                <span className="ocb-eyebrow ocb-eyebrow--inline ocb-drafts__tools-label">
                  Draft tools
                </span>
                <button
                  type="button"
                  className="ocb-btn ocb-btn--secondary ocb-btn--xs"
                  disabled={toolsDisabled}
                  aria-expanded={tool === 'edit'}
                  aria-controls="ocb-drafts-message"
                  onClick={() => toggleTool('edit')}
                >
                  Edit text
                </button>
                <button
                  type="button"
                  className="ocb-btn ocb-btn--secondary ocb-btn--xs"
                  disabled={toolsDisabled}
                  aria-expanded={tool === 'meri'}
                  onClick={() => toggleTool('meri')}
                >
                  <Sparkles size={14} aria-hidden="true" />
                  Edit with Meri
                </button>
                <button
                  type="button"
                  className="ocb-btn ocb-btn--secondary ocb-btn--xs"
                  disabled={toolsDisabled}
                  aria-expanded={tool === 'tone'}
                  onClick={() => toggleTool('tone')}
                >
                  Change tone
                  <ChevronDown size={13} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="ocb-btn ocb-btn--secondary ocb-btn--xs"
                  disabled={toolsDisabled}
                  onClick={() => {
                    setError(null);
                    refine.mutate({
                      name: active.name,
                      label: 'Regenerated from the approved packet',
                      instruction: REGENERATE_INSTRUCTION,
                    });
                  }}
                >
                  {refine.isPending ? spinner : <RefreshCcw size={14} aria-hidden="true" />}
                  Regenerate
                </button>
              </div>

              {error ? (
                <p className="ocb-note ocb-note--warn" role="alert">
                  {error}
                </p>
              ) : null}

              {tool === 'meri' ? (
                <div className="ocb-inset ocb-drafts__panel">
                  <label className="ocb-drafts__field" htmlFor="ocb-drafts-instruction">
                    <span className="ocb-drafts__panel-title">Tell Meri what to change</span>
                    <textarea
                      id="ocb-drafts-instruction"
                      className="ocb-textarea ocb-drafts__instruction"
                      rows={3}
                      value={instruction}
                      onChange={(event) => setInstruction(event.target.value)}
                      placeholder="Make the opening more personal and shorten the second paragraph."
                    />
                  </label>
                  <span className="ocb-drafts__panel-help">
                    The approved subject line, recipient, sponsor facts, personal note and ask are
                    preserved. No new facts are introduced.
                  </span>
                  <button
                    type="button"
                    className="ocb-btn ocb-btn--primary ocb-btn--sm ocb-drafts__panel-action"
                    // The prototype creates a version from an empty instruction.
                    // An empty instruction is not a request, so it is refused.
                    disabled={toolsDisabled || !instruction.trim()}
                    onClick={() => {
                      setError(null);
                      refine.mutate({
                        name: active.name,
                        label: 'Meri created a new version',
                        instruction: meriInstruction(instruction.trim()),
                      });
                    }}
                  >
                    {refine.isPending ? spinner : null}
                    Create new version
                  </button>
                </div>
              ) : null}

              {tool === 'tone' ? (
                <div className="ocb-inset ocb-drafts__panel ocb-drafts__panel--tone">
                  <label className="ocb-drafts__field" htmlFor="ocb-drafts-tone-select">
                    <span className="ocb-drafts__panel-title">New tone</span>
                    <select
                      id="ocb-drafts-tone-select"
                      className="ocb-select ocb-drafts__tone-select"
                      value={tone}
                      onChange={(event) => setTone(event.target.value as OutreachDraftTone)}
                    >
                      {TONES.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="ocb-btn ocb-btn--primary ocb-btn--sm ocb-drafts__tone-action"
                    disabled={toolsDisabled}
                    onClick={() => {
                      setError(null);
                      refine.mutate({
                        name: active.name,
                        label: `${tone} tone applied`,
                        instruction: toneInstruction(tone),
                      });
                    }}
                  >
                    {refine.isPending ? spinner : null}
                    Apply to new version
                  </button>
                </div>
              ) : null}

              <div id="ocb-drafts-message" className="ocb-inset ocb-drafts__message">
                <span className="ocb-drafts__subject-label">Subject</span>
                <span className="ocb-drafts__subject">{reading?.subject ?? ''}</span>
                {tool === 'edit' ? (
                  <>
                    <textarea
                      className="ocb-textarea ocb-drafts__editor"
                      aria-label="Draft body"
                      rows={12}
                      value={bodyBuffer}
                      onChange={(event) => setBodyBuffer(event.target.value)}
                    />
                    <button
                      type="button"
                      className="ocb-btn ocb-btn--primary ocb-btn--sm ocb-drafts__save"
                      disabled={toolsDisabled || bodyBuffer === (reading?.body ?? '')}
                      onClick={() => {
                        setError(null);
                        saveEdit.mutate({ name: active.name, body: bodyBuffer });
                      }}
                    >
                      {saveEdit.isPending ? spinner : null}
                      Save as new version
                    </button>
                  </>
                ) : (
                  <p className="ocb-drafts__text">
                    {reading
                      ? reading.body
                      : historyQuery.isPending
                        ? 'Loading this draft…'
                        : 'This recipient has no generated version yet.'}
                  </p>
                )}
              </div>

              <div className="ocb-drafts__note">
                <span className="ocb-eyebrow ocb-eyebrow--inline">Personal note used</span>
                <span className="ocb-drafts__note-value">
                  {active.note.trim() || 'No personal note for this recipient.'}
                </span>
              </div>

              <button
                type="button"
                className="ocb-btn ocb-btn--primary ocb-drafts__continue"
                disabled={busy || working || rows.length === 0}
                onClick={() => {
                  setError(null);
                  continueToSend.mutate();
                }}
              >
                {continueToSend.isPending ? spinner : null}
                {primaryLabel}
              </button>

              {ungenerated > 0 ? (
                <p className="ocb-note ocb-note--muted">
                  {ungenerated === 1
                    ? '1 recipient has no generated version yet, so nothing can be approved or sent for them.'
                    : `${ungenerated} recipients have no generated version yet, so nothing can be approved or sent for them.`}
                </p>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
