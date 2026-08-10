import { useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  CircleAlert,
  FileText,
  Loader2,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { strategyCommands } from './commands.js';
import type { OutreachV3DecisionSurfaceProps } from './decision-surface-contract.js';
import type { OutreachV3Length } from './contracts.js';
import { safeOutreachV3Error } from './outreach-v3-api.js';

export type StrategyDecisionSurfaceProps = Pick<
  OutreachV3DecisionSurfaceProps,
  'session' | 'busy' | 'applyCommands' | 'strategy' | 'strategyPending' | 'strategyError'
>;

function sentence(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function StrategyDecisionSurface({
  session,
  busy,
  applyCommands,
  strategy,
  strategyPending,
  strategyError,
}: StrategyDecisionSurfaceProps) {
  const recommendation = strategy?.data.recommendation ?? null;
  const recommendedTone = recommendation?.tone ?? strategy?.data.tone ?? null;
  const recommendedLength = recommendation?.length ?? strategy?.data.length ?? null;
  const rationale = recommendation?.rationale ?? strategy?.data.rationale ?? [];
  const warnings = recommendation?.warnings ?? strategy?.data.warnings ?? [];
  const [campaignAngle, setCampaignAngle] = useState(
    session.spec.strategy.campaignAngle ?? recommendation?.campaignAngle ?? '',
  );
  const [tone, setTone] = useState(session.spec.strategy.tone ?? recommendedTone ?? '');
  const [length, setLength] = useState<OutreachV3Length>(
    session.spec.strategy.length !== 'undecided'
      ? session.spec.strategy.length
      : recommendedLength ?? 'undecided',
  );
  const [customInstruction, setCustomInstruction] = useState(
    session.spec.strategy.customLengthInstruction ?? '',
  );
  const [error, setError] = useState<string | null>(null);

  const summary = useMemo(
    () => [campaignAngle.trim(), tone.trim(), length !== 'undecided' ? sentence(length) : '']
      .filter(Boolean)
      .join(' · '),
    [campaignAngle, length, tone],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!campaignAngle.trim() || !tone.trim() || length === 'undecided') {
      setError('Campaign angle, tone, and length are required.');
      return;
    }
    if (length === 'custom' && !customInstruction.trim()) {
      setError('Describe the custom length.');
      return;
    }
    setError(null);
    try {
      await applyCommands(
        strategyCommands({
          campaignAngle,
          tone,
          length,
          customInstruction,
        }),
      );
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  return (
    <form className="ov3-decision-panel" onSubmit={submit}>
      <header className="ov3-panel-header">
        <div>
          <span className="ov3-eyebrow">Strategy · 5 of 6</span>
          <h2>Confirm the campaign approach</h2>
          <p>
            Capiro recommends from canonical campaign, target, delivery, and accepted-context
            facts. The user still chooses the angle, tone, and length.
          </p>
        </div>
        <span className={`ov3-badge ${summary ? 'is-info' : 'is-warning'}`}>
          {summary ? 'Review' : 'Incomplete'}
        </span>
      </header>

      <div className="ov3-split">
        <div className="ov3-form-stack">
          <label className="ov3-field">
            <span>Campaign angle<em>Required</em></span>
            <textarea
              rows={4}
              value={campaignAngle}
              onChange={(event) => setCampaignAngle(event.target.value)}
              placeholder="Protect funding through concise, evidence-led staff education"
            />
          </label>
          <label className="ov3-field">
            <span>Tone<em>Required</em></span>
            <input
              type="text"
              value={tone}
              onChange={(event) => setTone(event.target.value)}
              placeholder="Direct and professional"
            />
          </label>
          <div className="ov3-inline-choice is-five" role="group" aria-label="Message length">
            {(['short', 'medium', 'long', 'custom'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={length === value ? 'is-selected' : ''}
                aria-pressed={length === value}
                onClick={() => setLength(value)}
              >
                {sentence(value)}
                {recommendedLength === value ? ' · recommended' : ''}
              </button>
            ))}
          </div>
          {length === 'custom' ? (
            <label className="ov3-field">
              <span>Custom length instruction<em>Required</em></span>
              <input
                type="text"
                value={customInstruction}
                onChange={(event) => setCustomInstruction(event.target.value)}
                placeholder="No more than 180 words"
              />
            </label>
          ) : null}

          <div className="ov3-strategy-readback">
            <span className="ov3-section-label">Campaign strategy read-back</span>
            <strong>{summary || 'Complete the fields above'}</strong>
            <p>
              This is planning state only. Drafting remains unavailable until the governed
              generation phase is enabled.
            </p>
          </div>
        </div>

        <aside className="ov3-guidance-card is-strategy">
          <Sparkles size={18} aria-hidden="true" />
          <span className="ov3-eyebrow">Deterministic recommendation</span>
          <h3>{strategyPending ? 'Reviewing campaign state' : recommendedTone || 'Strategy guidance'}</h3>
          {strategyPending ? (
            <p><Loader2 className="ov3-spin" size={16} /> Loading from canonical state…</p>
          ) : (
            <p>
              Recommendations remain editable and cannot mutate the Campaign Spec until you save.
            </p>
          )}
          {rationale.length ? (
            <ul>{rationale.slice(0, 5).map((item) => <li key={item}>{item}</li>)}</ul>
          ) : (
            <p className="ov3-muted-copy">
              Use the conversation to ask Meri for an explainable proposal, or complete the
              deterministic fields directly.
            </p>
          )}
          {warnings.length ? (
            <div className="ov3-strategy-warning-list">
              {warnings.slice(0, 5).map((warning) => (
                <div key={warning} className="ov3-recovery is-warning">
                  <AlertTriangle size={15} aria-hidden="true" />
                  <p>{warning}</p>
                </div>
              ))}
            </div>
          ) : null}
          <div className="ov3-recovery is-info">
            <ShieldCheck size={17} aria-hidden="true" />
            <div>
              <strong>No hidden drafting path</strong>
              <p>
                Strategy can guide future governed generation; it cannot create, approve, or send
                prose in Phase 6.
              </p>
            </div>
          </div>
        </aside>
      </div>

      {(error || strategyError) ? (
        <div className="ov3-recovery is-danger" role="alert">
          <CircleAlert size={18} aria-hidden="true" />
          <div><strong>Complete the strategy</strong><p>{error ?? strategyError}</p></div>
        </div>
      ) : null}

      <footer className="ov3-panel-footer">
        <span>{summary || 'Campaign strategy is incomplete.'}</span>
        <div className="ov3-panel-footer__actions">
          <button type="submit" className="ov3-button is-primary" disabled={busy}>
            {busy ? <Loader2 className="ov3-spin" size={16} /> : <FileText size={16} />}
            Confirm strategy
          </button>
        </div>
      </footer>
    </form>
  );
}
