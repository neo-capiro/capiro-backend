import { useState, type FormEvent } from 'react';
import { CircleHelp, Loader2, Sparkles } from 'lucide-react';
import { goalCommands, type GoalDraft } from './commands.js';
import type { DecisionSurfacesProps } from './DecisionSurfaces.js';
import { safeOutreachV3Error } from './outreach-v3-api.js';

export type GoalDecisionSurfaceProps = Pick<
  DecisionSurfacesProps,
  'session' | 'busy' | 'applyCommands'
> &
  Pick<Partial<DecisionSurfacesProps>, 'goalVariant'>;

/**
 * Read-only confirmation body for the goal step — UI-parity §7.
 *
 * Keys are Topic / Outcome / Ask / Sponsor, taken from the prototype's own
 * `readBack` array (`Capiro Engagement - Untitled UI.dc.html`, the
 * `readBack:[['Topic',…],['Outcome',…],['Ask',…],['Sponsor',…]]` literal).
 * The parity doc's §7 prose lists "Client, Audience, Ask, Sponsor" instead,
 * but the doc states every value is transcribed from the prototype, and the
 * prototype is the authority where the two disagree. These four also map 1:1
 * onto real campaign-spec fields, where Client/Audience would not: audience
 * is not a field on the spec at all, and the sponsor's client refs are
 * already carried by the Sponsor row.
 */
function GoalReadBack({ session }: { session: GoalDecisionSurfaceProps['session'] }) {
  const { goal, sponsor } = session.spec;
  const askValue =
    goal.ask.mode === 'none'
      ? 'No formal ask'
      : goal.ask.mode === 'explicit'
        ? goal.ask.text
        : null;
  // "Capiro · firm" in the prototype — label, then the resolved kind. An
  // undecided kind contributes nothing rather than printing "undecided".
  const sponsorValue = sponsor.label
    ? sponsor.kind && sponsor.kind !== 'undecided'
      ? `${sponsor.label} · ${sponsor.kind.replace(/_/g, ' ')}`
      : sponsor.label
    : null;

  const rows: Array<[string, string | null]> = [
    ['Topic', goal.topic],
    ['Outcome', goal.desiredOutcome],
    ['Ask', askValue],
    ['Sponsor', sponsorValue],
  ];

  return (
    <div className="ov3-goal-readback">
      <div className="ov3-goal-readback__goal">
        {goal.goal ?? 'No goal captured yet. Tell Meri what this campaign should accomplish.'}
      </div>
      <span className="ov3-goal-readback__label">Meri read-back</span>
      <div className="ov3-goal-readback__rows">
        {rows.map(([key, value]) => (
          <div className="ov3-goal-readback__row" key={key}>
            <span>{key}</span>
            {/* Never invented: an unset field reads as "Not set", it does not
                borrow a placeholder or a neighbouring value. */}
            <span data-empty={value ? undefined : true}>{value ?? 'Not set'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const OUTREACH_TYPES = [
  ['Request a meeting', 'Ask the office for a focused staff briefing.'],
  ['Share an update', 'Keep stakeholders informed with a concise policy update.'],
] as const;

function NewOutreachTypeRequest({
  onClose,
  onSubmitRequest,
}: {
  onClose: () => void;
  onSubmitRequest: () => void;
}) {
  const [description, setDescription] = useState('');
  const [sampleEmail, setSampleEmail] = useState('');

  const submit = () => {
    if (!description.trim() || !sampleEmail.trim()) return;
    onSubmitRequest();
  };

  return (
    <div className="ov3-request-modal__backdrop" role="presentation">
      <div
        className="ov3-request-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ov3-request-modal-title"
      >
        <header className="ov3-panel-header">
          <div>
            <span className="ov3-eyebrow">Outreach type request</span>
            <h2 id="ov3-request-modal-title">Request New Outreach Type</h2>
            <p>Help us understand the outreach pattern you need.</p>
          </div>
          <button type="button" className="ov3-button is-quiet" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="ov3-form-stack">
          <Field
            label="Describe what you want to request"
            required
            value={description}
            placeholder="Describe the outreach outcome or workflow you need."
            onChange={setDescription}
            multiline
          />
          <Field
            label="Sample email of the desired outcome"
            required
            value={sampleEmail}
            placeholder="Paste a sample email that shows the desired outcome."
            onChange={setSampleEmail}
            multiline
          />
        </div>
        <footer className="ov3-panel-footer">
          <button type="button" className="ov3-button is-quiet" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ov3-button is-primary"
            disabled={!description.trim() || !sampleEmail.trim()}
            onClick={submit}
          >
            Submit outreach type request
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  required,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  multiline?: boolean;
}) {
  return (
    <label className="ov3-field">
      <span>
        {label}
        {required ? <em>Required</em> : null}
      </span>
      {multiline ? (
        <textarea
          rows={3}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}

export function GoalDecisionSurface({
  session,
  busy,
  applyCommands,
  goalVariant = 'form',
}: GoalDecisionSurfaceProps) {
  const goal = session.spec.goal;
  const [draft, setDraft] = useState<GoalDraft>({
    goal: goal.goal ?? '',
    objective: goal.objective ?? '',
    topic: goal.topic ?? '',
    desiredOutcome: goal.desiredOutcome ?? '',
    askMode: goal.ask.mode === 'none' ? 'none' : 'explicit',
    askText: goal.ask.text ?? '',
    whyNow: goal.whyNow ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !draft.goal.trim() ||
      !draft.objective.trim() ||
      !draft.topic.trim() ||
      !draft.desiredOutcome.trim()
    ) {
      setError('Campaign goal, objective, topic, and an outreach type are required.');
      return;
    }
    if (draft.askMode === 'explicit' && !draft.askText.trim()) {
      setError('Enter the explicit ask or choose “No formal ask.”');
      return;
    }
    setError(null);
    try {
      await applyCommands(goalCommands(draft));
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  // UI-parity §7: the confirmation surface. Single-column, full width — no
  // panel header, no outcome cards, no canonical fields and no explainer
  // rail; the explainer copy lives in Meri's turn in the chat rail and the
  // fields behind the brief bar's Edit.
  if (goalVariant === 'readback') {
    return <GoalReadBack session={session} />;
  }

  return (
    <form className="ov3-decision-panel" onSubmit={submit}>
      <header className="ov3-panel-header">
        <div>
          <span className="ov3-eyebrow">Goal · 1 of 6</span>
          <h2>What should this campaign accomplish?</h2>
          <p>
            Start with the result, not administration. Client or sponsor scope is optional and
            comes next.
          </p>
        </div>
        <span className="ov3-badge">Draft</span>
      </header>

      <div className="ov3-split is-brief">
        <div className="ov3-form-stack">
          <span className="ov3-section-label">Choose an outreach type</span>
          <div className="ov3-choice-grid">
            {OUTREACH_TYPES.map(([title, description]) => (
              <button
                key={title}
                type="button"
                className={`ov3-choice-card ${draft.desiredOutcome === title ? 'is-selected' : ''}`}
                aria-pressed={draft.desiredOutcome === title}
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    desiredOutcome: title,
                    goal: current.goal || title,
                    objective:
                      current.objective ||
                      (title === 'Request a meeting'
                        ? 'Educate the recipient and secure a focused staff briefing'
                        : title),
                    askMode: title === 'Request a meeting' ? 'explicit' : 'none',
                    askText:
                      title === 'Request a meeting' && !current.askText
                        ? 'Request a 30-minute staff briefing'
                        : current.askText,
                  }))
                }
              >
                <span className="ov3-choice-card__radio" aria-hidden="true">
                  {draft.desiredOutcome === title ? <span /> : null}
                </span>
                <span>
                  <strong>{title}</strong>
                  <small>{description}</small>
                </span>
              </button>
            ))}
            <button
              type="button"
              className="ov3-choice-card"
              onClick={() => setRequestOpen(true)}
            >
              <span className="ov3-choice-card__radio" aria-hidden="true" />
              <span>
                <strong>Request New Outreach Type</strong>
                <small>Tell us what kind of outreach you need.</small>
              </span>
            </button>
          </div>

          <Field
            label="Campaign goal"
            required
            value={draft.goal}
            placeholder="Protect FY27 Ground Robotics funding"
            onChange={(value) => setDraft((current) => ({ ...current, goal: value }))}
          />
          <div className="ov3-field-grid">
            <Field
              label="Topic"
              required
              value={draft.topic}
              placeholder="FY27 Ground Robotics funding"
              onChange={(value) => setDraft((current) => ({ ...current, topic: value }))}
            />
            <Field
              label="Objective"
              required
              value={draft.objective}
              placeholder="Educate staff before the next mark"
              onChange={(value) => setDraft((current) => ({ ...current, objective: value }))}
            />
          </div>
        </div>

        <aside className="ov3-guidance-card">
          <Sparkles size={18} aria-hidden="true" />
          <span className="ov3-eyebrow">Conversational and deterministic</span>
          <h3>Tell Meri the result; confirm the exact read-back</h3>
          <p>
            Natural language can help interpret the request, but these fields are the canonical
            campaign state and remain available when reasoning is offline.
          </p>
          <ul>
            <li>No client is required.</li>
            <li>No target is selected here.</li>
            <li>The ask is explicit or explicitly absent.</li>
            <li>No draft or external action is created.</li>
          </ul>
          <div className="ov3-recovery is-info">
            <CircleHelp size={16} aria-hidden="true" />
            <div>
              <strong>Accuracy starts here</strong>
              <p>The drafting model may not invent a different goal or ask later.</p>
            </div>
          </div>
        </aside>
      </div>

      {error ? (
        <div className="ov3-recovery is-danger" role="alert">
          <CircleHelp size={17} aria-hidden="true" />
          <div><strong>Complete the campaign intent</strong><p>{error}</p></div>
        </div>
      ) : null}

      <footer className="ov3-panel-footer">
        <span>Every confirmed change creates a new immutable Campaign Spec version.</span>
        <div className="ov3-panel-footer__actions">
          <button type="submit" className="ov3-button is-primary" disabled={busy}>
            {busy ? <Loader2 className="ov3-spin" size={16} /> : null}
            Confirm goal
          </button>
        </div>
      </footer>
      {requestOpen ? (
        <NewOutreachTypeRequest
          onClose={() => setRequestOpen(false)}
          onSubmitRequest={() => setRequestOpen(false)}
        />
      ) : null}
    </form>
  );
}
