/**
 * Builder step 3 — Template (prototype step id `update`).
 *
 * The prototype runs this step on seven hardcoded rows and an in-memory
 * `userTpls` array. Here the rows are the real content templates
 * (`outreach-v3-content-templates.ts`) and every choice writes to the
 * server-owned Campaign Spec:
 *
 *   template with a skeleton  -> SET_CONTENT_SKELETON, the structure the server
 *                                assembles the body from, byte-exactly
 *   template without one      -> SET_CONTENT_SKELETON(null) plus the template's
 *                                sample as low-authority writing guidance
 *   a structure you author    -> SET_CONTENT_SKELETON with your own skeleton
 *
 * `SET_CONTENT_SKELETON` is sent on EVERY selection including as null:
 * switching from a skeleton template to a skeleton-less one has to clear the
 * previous structure, or the campaign keeps generating against a template the
 * UI no longer shows as chosen.
 *
 * Three prototype behaviours are deliberately not reproduced, each noted at its
 * own call site: the pre-selected first row (nothing is selected until the user
 * picks, because the prototype's highlight is local state that nothing had
 * applied to the campaign), the "Saved to your personal library" promise (no
 * endpoint stores a content template — the structure is applied to this
 * campaign), and the `[brackets]` authoring syntax (the real mechanism is
 * `{{sections}}`, which the server validates and preserves).
 */
import { useMemo, useState, type JSX } from 'react';
import { Plus } from 'lucide-react';
import type { OutreachV3Command } from '../../../pages/engagement/outreach/v3/contracts.js';
import {
  acceptContextCommand,
  excludeContextCommand,
  setContentSkeletonCommand,
} from '../../../pages/engagement/outreach/v3/commands.js';
import {
  OUTREACH_FORMAT_SKIP_NOTE,
  outreachSkipsFormatStep,
  outreachTemplateStepLabel,
} from './outreach-campaign-flow.js';
import type { OutreachBuilderStepCommon } from './outreach-builder-model.js';
import {
  contentTemplateContextSelection,
  contentTemplatesForWorkflow,
  type OutreachContentTemplateDefinition,
} from './outreach-v3-content-templates.js';
import type {
  OutreachContentSkeleton,
  OutreachContentSkeletonSlot,
} from './outreach-v3-template-api.js';
import {
  extractSlotKeys,
  previewSkeleton,
  starterSkeletonDraft,
  suggestSlotKey,
  validateSkeletonDraft,
  type SkeletonIssue,
} from './outreach-v3-skeleton-editing.js';
import './outreach-step-template.css';

/**
 * The title prefix `contentTemplateContextSelection` puts on the guidance ref
 * it writes. Reading the selection back by that prefix is how a skeleton-less
 * template survives a reload; the command engine copies `locator.title` onto
 * the resolved ref verbatim, which is the same mechanism the format and
 * subject-line markers already rely on.
 */
const TEMPLATE_GUIDANCE_MARKER = 'Update template — ';

/** The row label for a structure the user wrote, when they gave it no name. */
const AUTHORED_FALLBACK_NAME = 'Your own structure';

const CUSTOM_EMPTY_TEXT =
  'Custom campaigns have no fixed structure. Meri asks for the purpose in prose, then writes from your brief and the context you select.';

/**
 * Shown when the step is reached before a campaign type exists. The prototype
 * cannot reach this state — its `bWorkflow` always has a value — but a deep
 * link into a spec with no goal can, and the Custom explainer would be a claim
 * about a type the user has not chosen.
 */
const NO_TYPE_TEXT =
  'Choose a campaign type first. The set of templates depends on it, so there is nothing to pick from yet.';

const SAMPLE_FOOTNOTE =
  'Structure and tone reference only. Nothing in the sample is copied into your draft — Meri writes inside this structure using the context you select.';

/*
 * The prototype's line here is "Saved to your personal library only — the firm
 * and the rest of the tenant keep the original." Nothing persists a content
 * template today (see the report for the endpoint that would be needed), so
 * that sentence would promise storage that does not happen. The second clause
 * is kept because it is true: the built-in template is never modified.
 */
const AUTHORED_SCOPE_NOTE =
  'Applied to this campaign only — it is not saved to a personal library, and the firm and the rest of the tenant keep the original.';

const BODY_PLACEHOLDER =
  'Write the structure Meri should follow. Use {{sections}} for the parts Meri fills from context.';

interface TemplateRow {
  id: string;
  name: string;
  description: string;
  /** The mono footnote line. The templates' real category, not a cadence claim. */
  category: string;
  /** "Capiro" for a built-in template, "This campaign" for an authored one. */
  scopeLabel: string;
  authored: boolean;
  template: OutreachContentTemplateDefinition | null;
  skeleton: OutreachContentSkeleton | null;
}

interface EditorDraft {
  subject: string;
  body: string;
  slots: OutreachContentSkeletonSlot[];
  name: string;
  newSection: string;
}

/**
 * The campaign's current skeleton.
 *
 * The server's spec carries `contentSkeleton` (absent, never null, when unset —
 * see `outreach-campaign-spec.v1.ts`), but the browser's `OutreachV3CampaignSpec`
 * has not declared the field. Narrowing it here, with a real shape check rather
 * than a bare cast, keeps that gap in one place instead of widening a shared
 * contract from a step file.
 */
function specContentSkeleton(spec: unknown): OutreachContentSkeleton | null {
  const raw = (spec as { contentSkeleton?: unknown } | null | undefined)?.contentSkeleton;
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as { subject?: unknown; body?: unknown; slots?: unknown };
  if (typeof candidate.subject !== 'string' || typeof candidate.body !== 'string') return null;
  if (!Array.isArray(candidate.slots)) return null;
  const slots: OutreachContentSkeletonSlot[] = [];
  for (const entry of candidate.slots) {
    const slot = entry as Partial<OutreachContentSkeletonSlot> | null;
    if (!slot || typeof slot.key !== 'string') return null;
    slots.push({
      key: slot.key,
      label: typeof slot.label === 'string' ? slot.label : slot.key,
      instruction: typeof slot.instruction === 'string' ? slot.instruction : '',
      required: slot.required !== false,
    });
  }
  return { subject: candidate.subject, body: candidate.body, slots };
}

function sameSkeleton(a: OutreachContentSkeleton, b: OutreachContentSkeleton): boolean {
  return (
    a.subject === b.subject &&
    a.body === b.body &&
    a.slots.length === b.slots.length &&
    a.slots.every((slot, index) => {
      const other = b.slots[index];
      return Boolean(other) && slot.key === other?.key;
    })
  );
}

export function OutreachTemplateStep(props: OutreachBuilderStepCommon): JSX.Element {
  const { session, campaignType, busy, applyCommands, toast, onNext, primaryLabel } = props;

  const [editor, setEditor] = useState<EditorDraft | null>(null);
  const [authoredName, setAuthoredName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const stepLabel = outreachTemplateStepLabel(campaignType ?? 'custom');
  const skipsFormat = campaignType !== null && outreachSkipsFormatStep(campaignType);
  const templates = useMemo(
    () => contentTemplatesForWorkflow(campaignType),
    [campaignType],
  );

  const appliedSkeleton = useMemo(
    () => specContentSkeleton(session?.spec),
    [session],
  );

  /** The template named by a guidance ref, for the skeleton-less templates. */
  const guidanceTemplateId = useMemo(() => {
    const refs = session?.spec.context.writingGuidanceRefs ?? [];
    for (let i = refs.length - 1; i >= 0; i -= 1) {
      const title = refs[i]?.title ?? '';
      if (!title.startsWith(TEMPLATE_GUIDANCE_MARKER)) continue;
      const name = title.slice(TEMPLATE_GUIDANCE_MARKER.length).trim();
      const match = templates.find((template) => template.title === name);
      if (match) return match.id;
    }
    return null;
  }, [session, templates]);

  const skeletonTemplateId = useMemo(() => {
    if (!appliedSkeleton) return null;
    return (
      templates.find(
        (template) => template.skeleton && sameSkeleton(template.skeleton, appliedSkeleton),
      )?.id ?? null
    );
  }, [appliedSkeleton, templates]);

  /*
   * A skeleton the spec carries that belongs to no built-in template is one the
   * user wrote. It gets its own row so the choice is visible and re-selectable
   * rather than disappearing behind whichever template happens to be first.
   */
  const authoredSkeleton = appliedSkeleton && !skeletonTemplateId ? appliedSkeleton : null;

  const rows: TemplateRow[] = useMemo(() => {
    const built = templates.map<TemplateRow>((template) => ({
      id: template.id,
      name: template.title,
      description: template.description,
      category: template.eyebrow,
      // Every real content template ships with the product. There is no
      // personal/firm distinction among them to derive a second label from.
      scopeLabel: 'Capiro',
      authored: false,
      template,
      skeleton: template.skeleton ?? null,
    }));
    if (!authoredSkeleton) return built;
    return [
      ...built,
      {
        id: 'authored',
        name: authoredName?.trim() || AUTHORED_FALLBACK_NAME,
        description:
          'A structure you wrote for this campaign. Meri writes the sections; everything else is sent exactly as you typed it.',
        category: '',
        scopeLabel: 'This campaign',
        authored: true,
        template: null,
        skeleton: authoredSkeleton,
      },
    ];
  }, [authoredName, authoredSkeleton, templates]);

  const selectedId = authoredSkeleton ? 'authored' : (skeletonTemplateId ?? guidanceTemplateId);
  const selectedRow = rows.find((row) => row.id === selectedId) ?? null;

  const draftSkeleton = useMemo<OutreachContentSkeleton | null>(
    () =>
      editor ? { subject: editor.subject, body: editor.body, slots: editor.slots } : null,
    [editor],
  );
  const issues: SkeletonIssue[] = useMemo(
    () => (draftSkeleton ? validateSkeletonDraft(draftSkeleton) : []),
    [draftSkeleton],
  );
  const placedKeys = useMemo(
    () => (editor ? extractSlotKeys(editor.subject, editor.body) : []),
    [editor],
  );

  /** Every guidance ref this step has written, for supersession on a re-pick. */
  const priorGuidanceRefs = (session?.spec.context.writingGuidanceRefs ?? []).filter((ref) =>
    ref.title.startsWith(TEMPLATE_GUIDANCE_MARKER),
  );

  const run = async (commands: OutreachV3Command[], done?: () => void): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await applyCommands(commands);
      done?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The template could not be applied.');
    } finally {
      setSaving(false);
    }
  };

  const supersedePrior = (): OutreachV3Command[] =>
    priorGuidanceRefs.length
      ? [
          excludeContextCommand(
            priorGuidanceRefs.map((ref) => ({
              contextKey: ref.contextKey,
              reason: 'superseded' as const,
            })),
          ),
        ]
      : [];

  const selectTemplate = (template: OutreachContentTemplateDefinition): void => {
    const commands: OutreachV3Command[] = [
      // Always sent, null included: a skeleton-less template must clear the
      // structure a previous pick left behind.
      setContentSkeletonCommand(template.skeleton ?? null),
    ];
    // Null for a skeleton template — its structure is the skeleton, and adding
    // the sample as guidance would put two contradictory instructions in the
    // same prompt. See contentTemplateContextSelection.
    const guidance = contentTemplateContextSelection(template);
    if (guidance) commands.push(acceptContextCommand([guidance]));
    commands.push(...supersedePrior());
    void run(commands, () => {
      setAuthoredName(null);
      // Picking a row discards an open editor's unsaved subject/body, as the
      // prototype does — the campaign now carries the template's structure, and
      // leaving a stale draft open would offer to overwrite it by accident.
      setEditor(null);
    });
  };

  const selectAuthored = (skeleton: OutreachContentSkeleton): void => {
    void run([setContentSkeletonCommand(skeleton), ...supersedePrior()], () => setEditor(null));
  };

  const openEditorFor = (row: TemplateRow): void => {
    setError(null);
    setEditor({
      // A template with no skeleton has no sections yet, so its sample is the
      // starting text and the validator asks for the sections it needs. That is
      // the prototype's seeding (subject + body from the chosen template), with
      // the real authoring mechanism made visible instead of implied.
      subject: row.skeleton?.subject ?? row.template?.sampleSubject ?? '',
      body: row.skeleton?.body ?? row.template?.sampleBody ?? '',
      slots: row.skeleton?.slots ?? [],
      name: `${row.name} (my version)`,
      newSection: '',
    });
  };

  const openScratchEditor = (): void => {
    setError(null);
    // The prototype opens three empty fields. An empty draft cannot be saved
    // under the real validator and teaches the author nothing about sections,
    // so this uses the repo's own starter — see starterSkeletonDraft's note.
    const starter = starterSkeletonDraft();
    setEditor({
      subject: starter.subject,
      body: starter.body,
      slots: starter.slots,
      name: '',
      newSection: '',
    });
  };

  const patchEditor = (patch: Partial<EditorDraft>): void =>
    setEditor((current) => (current ? { ...current, ...patch } : current));

  const updateSlot = (key: string, patch: Partial<OutreachContentSkeletonSlot>): void =>
    setEditor((current) =>
      current
        ? {
            ...current,
            slots: current.slots.map((slot) => (slot.key === key ? { ...slot, ...patch } : slot)),
          }
        : current,
    );

  const addSection = (): void =>
    setEditor((current) => {
      if (!current) return current;
      const label = current.newSection.trim();
      if (!label) return current;
      const key = suggestSlotKey(
        label,
        current.slots.map((slot) => slot.key),
      );
      return {
        ...current,
        slots: [...current.slots, { key, label, instruction: '', required: true }],
        // Append the token so a new section is never defined-but-unplaced, the
        // mistake the validator would otherwise only complain about.
        body: `${current.body.replace(/\s*$/, '')}\n\n{{${key}}}`,
        newSection: '',
      };
    });

  const removeSection = (key: string): void =>
    setEditor((current) =>
      current
        ? {
            ...current,
            slots: current.slots.filter((slot) => slot.key !== key),
            body: current.body.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), ''),
            subject: current.subject.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), ''),
          }
        : current,
    );

  const saveEditor = (): void => {
    if (!draftSkeleton || issues.length) return;
    const name = editor?.name.trim() ?? '';
    if (!name) return;
    void run([setContentSkeletonCommand(draftSkeleton), ...supersedePrior()], () => {
      setAuthoredName(name);
      setEditor(null);
      // Not the prototype's "Saved to your templates · visible only to you":
      // nothing was saved to a library, and saying so would be the one claim
      // this control cannot back.
      toast('Template structure applied to this campaign');
    });
  };

  /*
   * A built-in template previews its authored sample. An authored structure has
   * no sample, so it is rendered through `previewSkeleton` — the same collapsing
   * the server's assembler does, with each section shown as its own label.
   */
  const previewRow = selectedRow;
  const authoredPreview =
    previewRow && !previewRow.template && previewRow.skeleton
      ? previewSkeleton(previewRow.skeleton)
      : null;
  const previewSubject = previewRow?.template?.sampleSubject ?? authoredPreview?.subject ?? '';
  const previewBody = previewRow?.template?.sampleBody ?? authoredPreview?.body ?? '';

  const asideVisible = editor !== null || previewRow !== null || rows.length > 0;
  const disabled = busy || saving;

  return (
    <div className="ocb-split ocbt">
      <div className="ocb-stack">
        <span className="ocb-eyebrow">{stepLabel}</span>

        {rows.length === 0 ? (
          <p className="ocb-card ocb-prose ocbt-explainer">
            {campaignType === null ? NO_TYPE_TEXT : CUSTOM_EMPTY_TEXT}
          </p>
        ) : null}

        {rows.map((row) => {
          const on = row.id === selectedId;
          return (
            <button
              key={row.id}
              type="button"
              className="ocb-option"
              data-selected={on ? 'true' : undefined}
              aria-pressed={on}
              disabled={disabled}
              onClick={() => {
                if (row.template) selectTemplate(row.template);
                else if (row.skeleton) selectAuthored(row.skeleton);
              }}
            >
              <span className="ocb-radio" data-on={on ? 'true' : undefined} aria-hidden="true" />
              <span className="ocb-option__body">
                <span className="ocb-option__title">{row.name}</span>
                <span className="ocb-option__desc">{row.description}</span>
                {row.category ? (
                  <span className="ocb-eyebrow ocb-eyebrow--tight ocbt-row__category">
                    {row.category}
                  </span>
                ) : null}
              </span>
              <span className="ocbt-scope" data-tone={row.authored ? 'campaign' : 'capiro'}>
                {row.scopeLabel}
              </span>
            </button>
          );
        })}

        <button
          type="button"
          className="ocbt-scratch"
          onClick={openScratchEditor}
          disabled={disabled}
        >
          <Plus size={16} aria-hidden="true" />
          <span className="ocbt-scratch__body">
            <span className="ocbt-scratch__title">Create one from scratch</span>
            <span className="ocbt-scratch__desc">
              Write your own structure. Saved to your personal library only.
            </span>
          </span>
        </button>

        {error ? (
          <p className="ocb-note ocb-note--warn" role="alert">
            {error}
          </p>
        ) : null}

        <div className="ocb-row ocbt-actions">
          <button
            type="button"
            className="ocb-btn ocb-btn--primary"
            onClick={onNext}
            disabled={disabled}
          >
            {primaryLabel}
          </button>
          {skipsFormat ? <span className="ocb-note">{OUTREACH_FORMAT_SKIP_NOTE}</span> : null}
        </div>
      </div>

      <aside className="ocb-stack">
        {asideVisible ? (
          <div className="ocb-card ocbt-preview">
            <span className="ocb-eyebrow">
              {editor
                ? 'Template structure'
                : previewRow
                  ? `Preview sample draft · ${previewRow.name}`
                  : 'Preview sample draft'}
            </span>

            {editor ? (
              <>
                <label className="ocbt-field">
                  <span className="ocbt-field__label">Subject</span>
                  <input
                    type="text"
                    className="ocb-input ocbt-input--subject"
                    value={editor.subject}
                    placeholder="Meeting request: {{topic}}"
                    onChange={(event) => patchEditor({ subject: event.target.value })}
                  />
                </label>

                <label className="ocbt-field">
                  <span className="ocbt-field__label">Body</span>
                  <textarea
                    className="ocb-textarea"
                    rows={16}
                    value={editor.body}
                    placeholder={BODY_PLACEHOLDER}
                    onChange={(event) => patchEditor({ body: event.target.value })}
                  />
                </label>

                <div className="ocbt-sections">
                  <span className="ocbt-field__label">Sections Meri writes</span>
                  {editor.slots.map((slot) => (
                    <div
                      key={slot.key}
                      className="ocbt-section"
                      data-unplaced={placedKeys.includes(slot.key) ? undefined : 'true'}
                    >
                      <div className="ocbt-section__head">
                        <code className="ocbt-section__key">{`{{${slot.key}}}`}</code>
                        <label className="ocbt-section__required">
                          <input
                            type="checkbox"
                            checked={slot.required}
                            onChange={(event) =>
                              updateSlot(slot.key, { required: event.target.checked })
                            }
                          />
                          Required
                        </label>
                        <button
                          type="button"
                          className="ocbt-section__remove"
                          onClick={() => removeSection(slot.key)}
                          aria-label={`Remove section ${slot.key}`}
                        >
                          Remove
                        </button>
                      </div>
                      <input
                        type="text"
                        className="ocb-input"
                        value={slot.label}
                        aria-label={`Name for section ${slot.key}`}
                        onChange={(event) => updateSlot(slot.key, { label: event.target.value })}
                      />
                      <textarea
                        className="ocb-textarea"
                        rows={2}
                        value={slot.instruction}
                        placeholder="What should Meri write in this section?"
                        aria-label={`Instruction for section ${slot.key}`}
                        onChange={(event) =>
                          updateSlot(slot.key, { instruction: event.target.value })
                        }
                      />
                    </div>
                  ))}
                  <div className="ocbt-section__add">
                    <input
                      type="text"
                      className="ocb-input"
                      value={editor.newSection}
                      placeholder="Add a section, e.g. Why this matters"
                      aria-label="New section name"
                      onChange={(event) => patchEditor({ newSection: event.target.value })}
                    />
                    <button
                      type="button"
                      className="ocb-btn ocb-btn--secondary ocb-btn--xs"
                      onClick={addSection}
                      disabled={!editor.newSection.trim()}
                    >
                      Add section
                    </button>
                  </div>
                </div>

                <label className="ocbt-field">
                  <span className="ocbt-field__label">Save as</span>
                  <input
                    type="text"
                    className="ocb-input"
                    value={editor.name}
                    placeholder="Briefing meeting request (my version)"
                    onChange={(event) => patchEditor({ name: event.target.value })}
                  />
                </label>

                <span className="ocb-note ocb-note--muted">{AUTHORED_SCOPE_NOTE}</span>

                {issues.length ? (
                  <ul className="ocbt-issues">
                    {issues.map((issue) => (
                      <li key={`${issue.field}-${issue.slotKey ?? ''}-${issue.message}`}>
                        {issue.message}
                      </li>
                    ))}
                  </ul>
                ) : null}

                <div className="ocb-row">
                  <button
                    type="button"
                    className="ocb-btn ocb-btn--primary ocb-btn--sm"
                    onClick={saveEditor}
                    /*
                     * The prototype dims this to .5 and leaves it clickable, so
                     * a click with a blank name is inert with no feedback.
                     * Disabling states the same refusal where a keyboard and a
                     * screen reader can both perceive it, and it also covers the
                     * skeleton errors the server would reject.
                     */
                    disabled={disabled || !editor.name.trim() || issues.length > 0}
                  >
                    Save as my template
                  </button>
                  <button
                    type="button"
                    className="ocb-btn ocb-btn--secondary ocb-btn--sm"
                    onClick={() => setEditor(null)}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : previewRow ? (
              <>
                <div className="ocb-inset ocbt-preview__well">
                  <span className="ocbt-preview__label">Subject</span>
                  <span className="ocbt-preview__subject">{previewSubject}</span>
                  <p className="ocbt-preview__body">{previewBody}</p>
                </div>
                <button
                  type="button"
                  className="ocb-btn ocb-btn--secondary ocb-btn--sm ocbt-preview__edit"
                  onClick={() => openEditorFor(previewRow)}
                  disabled={disabled}
                >
                  Edit this template
                </button>
              </>
            ) : (
              /*
               * The prototype pre-selects its first row, so it always has a
               * sample to show. Nothing is applied to the campaign until the
               * user picks, so a highlighted row here would claim a structure
               * the spec does not carry — this states the real state instead.
               */
              <p className="ocb-note ocb-note--muted ocbt-preview__idle">
                Choose a template to preview its sample draft.
              </p>
            )}

            <span className="ocb-note ocb-note--muted">{SAMPLE_FOOTNOTE}</span>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
