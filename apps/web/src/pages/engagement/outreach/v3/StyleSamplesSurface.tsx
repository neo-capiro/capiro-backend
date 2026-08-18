import { useState, type FormEvent } from 'react';
import {
  CircleAlert,
  Loader2,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  WandSparkles,
} from 'lucide-react';
import { addStyleSamplesCommand, removeStyleSamplesCommand } from './commands.js';
import { outreachV3StyleSamples, type OutreachV3SessionEnvelope } from './contracts.js';
import type { OutreachV3Command, OutreachV3CommandBatchResult } from './contracts.js';
import { safeOutreachV3Error } from './outreach-v3-api.js';

/**
 * Mirrors the server bound (OUTREACH_STYLE_SAMPLE_LIMITS.maxSamples). Duplicated
 * rather than fetched because the server is the enforcer: this only decides when
 * to stop offering the Add form, and a drift shows up as a clear 422 rather than
 * as silently dropped examples.
 */
const MAX_SAMPLES = 5;
const MAX_BODY_CHARS = 20_000;

export interface StyleSamplesSurfaceProps {
  session: OutreachV3SessionEnvelope;
  busy: boolean;
  applyCommands: (commands: OutreachV3Command[]) => Promise<OutreachV3CommandBatchResult>;
  /** Advance to the next step. Optional — this step never blocks progress. */
  onContinue?: () => void;
}

function previewLine(body: string): string {
  const firstLine = body.split('\n').find((line) => line.trim().length > 0) ?? '';
  return firstLine.length > 140 ? `${firstLine.slice(0, 140)}…` : firstLine;
}

function wordCount(body: string): number {
  return body.split(/\s+/).filter(Boolean).length;
}

/**
 * Optional step: paste past emails so generation imitates the author's voice.
 *
 * This step is deliberately skippable and contributes no readiness blocker — a
 * campaign with no examples is complete, so the primary action is "Continue"
 * whether or not anything was added. Everything the user types here is committed
 * through the same canonical command batch as every other decision, so an
 * example is a versioned part of the Campaign Spec rather than a side note that
 * could drift away from the drafts it shaped.
 */
export function StyleSamplesSurface({
  session,
  busy,
  applyCommands,
  onContinue,
}: StyleSamplesSurfaceProps) {
  const samples = outreachV3StyleSamples(session.spec);
  const [label, setLabel] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const atLimit = samples.length >= MAX_SAMPLES;

  const add = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!body.trim()) {
      setError('Paste the body of an email you have sent before.');
      return;
    }
    try {
      await applyCommands([addStyleSamplesCommand([{ label, subject, body }])]);
      setLabel('');
      setSubject('');
      setBody('');
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  const remove = async (sampleKey: string) => {
    setError(null);
    setRemovingKey(sampleKey);
    try {
      await applyCommands([removeStyleSamplesCommand([sampleKey])]);
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    } finally {
      setRemovingKey(null);
    }
  };

  return (
    <div className="ov3-decision-panel">
      <header className="ov3-panel-header">
        <div>
          <span className="ov3-eyebrow">Examples · optional</span>
          <h2>Show Meri how you write</h2>
          <p>
            Paste emails you have sent before and generation will match their register, rhythm
            and structure. Nothing here is required — you can continue without adding any.
          </p>
        </div>
        <span className={`ov3-badge ${samples.length ? 'is-info' : ''}`}>
          {samples.length
            ? `${samples.length} of ${MAX_SAMPLES} example${samples.length === 1 ? '' : 's'}`
            : 'Optional'}
        </span>
      </header>

      <div className="ov3-split is-delivery">
        <div className="ov3-form-stack">
          <span className="ov3-section-label">
            Example emails{samples.length ? ` (${samples.length})` : ''}
          </span>

          {samples.length === 0 ? (
            <div className="ov3-recovery is-info">
              <WandSparkles size={17} aria-hidden="true" />
              <div>
                <strong>No examples yet</strong>
                <p>
                  Two or three real emails are usually enough for the voice to carry. Skip this
                  step and drafting falls back to the campaign tone you already chose.
                </p>
              </div>
            </div>
          ) : (
            <ul className="ov3-sample-list">
              {samples.map((sample, index) => (
                <li key={sample.sampleKey} className="ov3-sample-card">
                  <div className="ov3-sample-card__head">
                    <span className="ov3-sample-card__index" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="ov3-sample-card__title">
                      <strong>{sample.label || sample.subject || `Example ${index + 1}`}</strong>
                      <small>
                        {sample.subject ? `Subject: ${sample.subject} · ` : ''}
                        {wordCount(sample.body)} words
                      </small>
                    </span>
                    <button
                      type="button"
                      className="ov3-icon-button"
                      aria-label={`Remove example ${index + 1}`}
                      disabled={busy || removingKey === sample.sampleKey}
                      onClick={() => void remove(sample.sampleKey)}
                    >
                      {removingKey === sample.sampleKey ? (
                        <Loader2 className="ov3-spin" size={15} aria-hidden="true" />
                      ) : (
                        <Trash2 size={15} aria-hidden="true" />
                      )}
                    </button>
                  </div>
                  <p className="ov3-sample-card__preview">{previewLine(sample.body)}</p>
                </li>
              ))}
            </ul>
          )}

          {atLimit ? (
            <div className="ov3-recovery is-info">
              <ShieldCheck size={17} aria-hidden="true" />
              <div>
                <strong>{MAX_SAMPLES} examples is the maximum</strong>
                <p>Remove one to add a different email.</p>
              </div>
            </div>
          ) : (
            <form className="ov3-sample-form" onSubmit={add}>
              <span className="ov3-section-label">Add an example</span>
              <label className="ov3-field">
                <span>Label</span>
                <input
                  value={label}
                  maxLength={160}
                  placeholder="Optional — e.g. Appropriations ask, FY26"
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>
              <label className="ov3-field">
                <span>Subject</span>
                <input
                  value={subject}
                  maxLength={500}
                  placeholder="Optional — the original subject line"
                  onChange={(event) => setSubject(event.target.value)}
                />
              </label>
              <label className="ov3-field">
                <span>
                  Email body
                  <em>Required</em>
                </span>
                <textarea
                  rows={10}
                  value={body}
                  maxLength={MAX_BODY_CHARS}
                  placeholder="Paste the full body of an email you have sent."
                  onChange={(event) => setBody(event.target.value)}
                />
                <small>
                  {body.length.toLocaleString()} / {MAX_BODY_CHARS.toLocaleString()} characters
                </small>
              </label>
              <button
                type="submit"
                className="ov3-button is-secondary"
                disabled={busy || !body.trim()}
              >
                {busy ? (
                  <Loader2 className="ov3-spin" size={16} aria-hidden="true" />
                ) : (
                  <Plus size={16} aria-hidden="true" />
                )}
                Add example
              </button>
            </form>
          )}
        </div>

        <aside className="ov3-guidance-card is-strategy">
          <Sparkles size={18} aria-hidden="true" />
          <span className="ov3-eyebrow">How examples are used</span>
          <h3>Voice only — never facts</h3>
          <p>
            Drafting copies how these read: sentence length, formality, how you open and close,
            phrasing you favour.
          </p>
          <div className="ov3-recovery is-info">
            <ShieldCheck size={17} aria-hidden="true" />
            <div>
              <strong>Nothing is carried across as fact</strong>
              <p>
                Figures, dates, bills, meetings and commitments inside an example stay in that
                older message. A claim can only reach a draft through the governed context you
                accepted in the Context step.
              </p>
            </div>
          </div>
          <ul>
            <li>Real sent emails work better than idealized samples.</li>
            <li>Prefer examples aimed at a similar audience to this campaign.</li>
            <li>Remove an example and every later draft stops imitating it.</li>
          </ul>
        </aside>
      </div>

      {error ? (
        <div className="ov3-recovery is-danger" role="alert">
          <CircleAlert size={18} aria-hidden="true" />
          <div>
            <strong>That example was not saved</strong>
            <p>{error}</p>
          </div>
        </div>
      ) : null}

      <footer className="ov3-panel-footer">
        <span>
          {samples.length
            ? `${samples.length} example${samples.length === 1 ? '' : 's'} will shape the voice of every draft.`
            : 'This step is optional. Continue whenever you are ready.'}
        </span>
        <div className="ov3-panel-footer__actions">
          {onContinue ? (
            <button type="button" className="ov3-button is-primary" onClick={onContinue}>
              {samples.length ? 'Continue' : 'Skip for now'}
            </button>
          ) : null}
        </div>
      </footer>
    </div>
  );
}
