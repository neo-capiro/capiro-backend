import { useMemo, useState } from 'react';
import { AlertTriangle, Plus, Trash2, Eye, Save, X } from 'lucide-react';
import type { OutreachContentSkeleton } from './outreach-v3-template-api.js';
import {
  SKELETON_LIMITS,
  blankSkeletonSlot,
  extractSlotKeys,
  previewSkeleton,
  validateSkeletonDraft,
  type SkeletonIssue,
} from './outreach-v3-skeleton-editing.js';

/**
 * The step-3 content-template editor.
 *
 * ## What the author is actually editing
 *
 * Not an example email — the literal structure of every message this campaign
 * sends. Text outside a `{{token}}` ships verbatim to the recipient; each token
 * is a section Meri writes. That distinction is the single most important thing
 * this UI has to communicate, because the previous feature (a read-only sample
 * preview) trained users to read this text as illustrative.
 *
 * ## Why the preview has two modes
 *
 * "All sections" shows the fullest possible email. "Only required" shows what a
 * recipient with thin evidence receives, after optional sections drop out. The
 * second is the one that catches layout mistakes — a heading left stranded above
 * nothing — and it is exactly the case an author never thinks to check.
 */
export interface OutreachContentTemplateEditorProps {
  initial: OutreachContentSkeleton;
  /** Shown in the heading; helps an author know which template they opened. */
  templateName: string;
  busy?: boolean;
  onCancel: () => void;
  onSave: (skeleton: OutreachContentSkeleton) => void;
  /** Surfaced verbatim; the server is authoritative even though we pre-validate. */
  serverError?: string | null;
}

export function OutreachContentTemplateEditor(props: OutreachContentTemplateEditorProps) {
  const [subject, setSubject] = useState(props.initial.subject);
  const [body, setBody] = useState(props.initial.body);
  const [slots, setSlots] = useState(props.initial.slots);
  const [previewOmitOptional, setPreviewOmitOptional] = useState(false);
  const [newSlotLabel, setNewSlotLabel] = useState('');

  const skeleton = useMemo<OutreachContentSkeleton>(
    () => ({ subject, body, slots }),
    [subject, body, slots],
  );
  const issues = useMemo(() => validateSkeletonDraft(skeleton), [skeleton]);
  const preview = useMemo(
    () => previewSkeleton(skeleton, { omitOptional: previewOmitOptional }),
    [skeleton, previewOmitOptional],
  );
  const usedKeys = useMemo(() => extractSlotKeys(subject, body), [subject, body]);

  const issuesFor = (field: SkeletonIssue['field'], slotKey?: string): SkeletonIssue[] =>
    issues.filter((i) => i.field === field && (slotKey ? i.slotKey === slotKey : true));

  const addSlot = () => {
    const label = newSlotLabel.trim();
    if (!label) return;
    const slot = blankSkeletonSlot(
      label,
      slots.map((s) => s.key),
    );
    setSlots([...slots, slot]);
    setNewSlotLabel('');
    // Append the token so a new section is never left defined-but-unplaced —
    // the most common authoring mistake, and one the validator would otherwise
    // just complain about.
    setBody((current) => `${current.replace(/\s*$/, '')}\n\n{{${slot.key}}}`);
  };

  const removeSlot = (key: string) => {
    setSlots(slots.filter((s) => s.key !== key));
    // Remove its token too, otherwise deleting a section immediately creates an
    // "undeclared token" error the author did not cause.
    const tokenLine = new RegExp(`^\\s*\\{\\{${key}\\}\\}\\s*$\n?`, 'gm');
    setBody((current) =>
      current.replace(tokenLine, '').replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), ''),
    );
    setSubject((current) => current.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), ''));
  };

  const updateSlot = (key: string, patch: Partial<OutreachContentSkeleton['slots'][number]>) => {
    setSlots(slots.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  };

  const canSave = issues.length === 0 && !props.busy;

  return (
    <div className="outreach-skeleton-editor">
      <header className="outreach-skeleton-editor__head">
        <div>
          <span>Template structure</span>
          <h3>{props.templateName}</h3>
          <p>
            Everything outside a <code>{'{{section}}'}</code> is sent exactly as written. Each
            section is written by Meri for every recipient, from this campaign’s own evidence.
          </p>
        </div>
        <button
          type="button"
          className="outreach-skeleton-editor__close"
          onClick={props.onCancel}
          aria-label="Close editor"
        >
          <X size={18} />
        </button>
      </header>

      {props.serverError ? (
        <div className="outreach-skeleton-editor__error" role="alert">
          <AlertTriangle size={16} />
          <span>{props.serverError}</span>
        </div>
      ) : null}

      <div className="outreach-skeleton-editor__grid">
        <div className="outreach-skeleton-editor__pane">
          <label className="outreach-skeleton-editor__field">
            <span>Subject line</span>
            <input
              type="text"
              value={subject}
              maxLength={SKELETON_LIMITS.maxSubjectChars}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Meeting request: {{topic}}"
            />
            {issuesFor('subject').map((issue) => (
              <em key={issue.message} className="outreach-skeleton-editor__issue">
                {issue.message}
              </em>
            ))}
          </label>

          <label className="outreach-skeleton-editor__field">
            <span>
              Email body
              <small>
                {body.length.toLocaleString()} / {SKELETON_LIMITS.maxBodyChars.toLocaleString()}
              </small>
            </span>
            <textarea
              value={body}
              rows={18}
              maxLength={SKELETON_LIMITS.maxBodyChars}
              onChange={(e) => setBody(e.target.value)}
              spellCheck
            />
            {issuesFor('body').map((issue) => (
              <em key={issue.message} className="outreach-skeleton-editor__issue">
                {issue.message}
              </em>
            ))}
          </label>

          <section className="outreach-skeleton-editor__slots">
            <div className="outreach-skeleton-editor__slots-head">
              <h4>Sections Meri writes</h4>
              <p>
                The instruction is what actually steers the writing — be specific about what
                belongs here and what does not.
              </p>
            </div>

            {slots.map((slot) => {
              const placed = usedKeys.includes(slot.key);
              return (
                <div
                  key={slot.key}
                  className="outreach-skeleton-editor__slot"
                  data-unplaced={!placed}
                >
                  <div className="outreach-skeleton-editor__slot-head">
                    <code>{`{{${slot.key}}}`}</code>
                    <input
                      type="text"
                      className="outreach-skeleton-editor__slot-label"
                      value={slot.label}
                      maxLength={SKELETON_LIMITS.maxLabelChars}
                      onChange={(e) => updateSlot(slot.key, { label: e.target.value })}
                      aria-label={`Name for section ${slot.key}`}
                    />
                    <label className="outreach-skeleton-editor__slot-required">
                      <input
                        type="checkbox"
                        checked={slot.required}
                        onChange={(e) => updateSlot(slot.key, { required: e.target.checked })}
                      />
                      Required
                    </label>
                    <button
                      type="button"
                      onClick={() => removeSlot(slot.key)}
                      aria-label={`Remove section ${slot.key}`}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <textarea
                    value={slot.instruction}
                    rows={2}
                    maxLength={SKELETON_LIMITS.maxInstructionChars}
                    placeholder="What should Meri write in this section?"
                    onChange={(e) => updateSlot(slot.key, { instruction: e.target.value })}
                    aria-label={`Instruction for section ${slot.key}`}
                  />
                  {!slot.required ? (
                    <small className="outreach-skeleton-editor__slot-note">
                      Optional — if this campaign’s evidence doesn’t support it, the section is
                      left out instead of being filled with invented content.
                    </small>
                  ) : null}
                  {issuesFor('slots', slot.key).map((issue) => (
                    <em key={issue.message} className="outreach-skeleton-editor__issue">
                      {issue.message}
                    </em>
                  ))}
                </div>
              );
            })}

            {issuesFor('slots')
              .filter((i) => !i.slotKey)
              .map((issue) => (
                <em key={issue.message} className="outreach-skeleton-editor__issue">
                  {issue.message}
                </em>
              ))}

            <div className="outreach-skeleton-editor__add-slot">
              <input
                type="text"
                value={newSlotLabel}
                placeholder="Add a section, e.g. Why this matters"
                onChange={(e) => setNewSlotLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addSlot();
                  }
                }}
                aria-label="New section name"
              />
              <button
                type="button"
                onClick={addSlot}
                disabled={!newSlotLabel.trim() || slots.length >= SKELETON_LIMITS.maxSlots}
              >
                <Plus size={15} />
                Add section
              </button>
            </div>
          </section>
        </div>

        <aside className="outreach-skeleton-editor__preview">
          <div className="outreach-skeleton-editor__preview-head">
            <h4>
              <Eye size={15} />
              Preview
            </h4>
            <div
              className="outreach-skeleton-editor__preview-toggle"
              role="group"
              aria-label="Preview mode"
            >
              <button
                type="button"
                data-active={!previewOmitOptional}
                onClick={() => setPreviewOmitOptional(false)}
              >
                All sections
              </button>
              <button
                type="button"
                data-active={previewOmitOptional}
                onClick={() => setPreviewOmitOptional(true)}
              >
                Only required
              </button>
            </div>
          </div>
          <p className="outreach-skeleton-editor__preview-note">
            {previewOmitOptional
              ? 'What a recipient receives when the evidence supports only the required sections.'
              : 'Square brackets mark where Meri writes. Everything else is sent as written.'}
          </p>
          <strong className="outreach-skeleton-editor__preview-subject">
            {preview.subject || '(no subject)'}
          </strong>
          <pre className="outreach-skeleton-editor__preview-body">{preview.body}</pre>
        </aside>
      </div>

      <footer className="outreach-skeleton-editor__actions">
        {issues.length ? (
          <span className="outreach-skeleton-editor__issue-count">
            <AlertTriangle size={15} />
            {issues.length} {issues.length === 1 ? 'issue' : 'issues'} to fix before saving
          </span>
        ) : (
          <span />
        )}
        <div>
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="outreach-skeleton-editor__save"
            disabled={!canSave}
            onClick={() => props.onSave(skeleton)}
          >
            <Save size={15} />
            Save template
          </button>
        </div>
      </footer>
    </div>
  );
}
