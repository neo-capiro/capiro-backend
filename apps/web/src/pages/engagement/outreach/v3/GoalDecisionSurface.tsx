import { useState, type FormEvent } from 'react';
import { CircleHelp, Loader2, Sparkles } from 'lucide-react';
import { goalCommands, type GoalDraft } from './commands.js';
import type { DecisionSurfacesProps } from './DecisionSurfaces.js';
import { safeOutreachV3Error } from './outreach-v3-api.js';

export type GoalDecisionSurfaceProps = Pick<
  DecisionSurfacesProps,
  'session' | 'busy' | 'applyCommands'
>;

const OUTCOMES = [
  ['Request a meeting', 'Ask the office for a focused staff briefing.'],
  ['Protect funding', 'Build support before the next authorization or mark.'],
  ['Share an update', 'Keep stakeholders informed with a concise policy update.'],
  ['Custom outcome', 'Describe a different result in your own words.'],
] as const;

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

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !draft.goal.trim() ||
      !draft.objective.trim() ||
      !draft.topic.trim() ||
      !draft.desiredOutcome.trim()
    ) {
      setError('Campaign goal, objective, topic, and desired outcome are required.');
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
          <span className="ov3-section-label">Choose an outcome or describe your own</span>
          <div className="ov3-choice-grid">
            {OUTCOMES.map(([title, description]) => (
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
          <Field
            label="Desired outcome"
            required
            value={draft.desiredOutcome}
            placeholder="Request a focused briefing"
            onChange={(value) => setDraft((current) => ({ ...current, desiredOutcome: value }))}
          />

          <div className="ov3-inline-choice" role="group" aria-label="Ask mode">
            <button
              type="button"
              className={draft.askMode === 'explicit' ? 'is-selected' : ''}
              aria-pressed={draft.askMode === 'explicit'}
              onClick={() => setDraft((current) => ({ ...current, askMode: 'explicit' }))}
            >
              Explicit ask
            </button>
            <button
              type="button"
              className={draft.askMode === 'none' ? 'is-selected' : ''}
              aria-pressed={draft.askMode === 'none'}
              onClick={() => setDraft((current) => ({ ...current, askMode: 'none' }))}
            >
              No formal ask
            </button>
          </div>
          {draft.askMode === 'explicit' ? (
            <Field
              label="Explicit ask"
              required
              value={draft.askText}
              placeholder="Request a 30-minute staff briefing"
              onChange={(value) => setDraft((current) => ({ ...current, askText: value }))}
            />
          ) : null}
          <Field
            label="Why now"
            value={draft.whyNow}
            placeholder="The current mark is below the request"
            onChange={(value) => setDraft((current) => ({ ...current, whyNow: value }))}
            multiline
          />
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
    </form>
  );
}
