import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Check,
  CircleAlert,
  Eye,
  Loader2,
  Mail,
  MessagesSquare,
  ShieldCheck,
  Sparkles,
  UsersRound,
} from 'lucide-react';
import { deliveryCommands } from './commands.js';
import type { OutreachV3DecisionSurfaceProps } from './decision-surface-contract.js';
import type {
  OutreachV3DeliveryPattern,
  OutreachV3Personalization,
  OutreachV3StrategyData,
} from './contracts.js';
import { safeOutreachV3Error } from './outreach-v3-api.js';

export type DeliveryDecisionSurfaceProps = Pick<
  OutreachV3DecisionSurfaceProps,
  'session' | 'busy' | 'applyCommands' | 'strategy' | 'strategyPending' | 'strategyError'
>;

const DELIVERY_OPTIONS: Array<{
  value: Exclude<OutreachV3DeliveryPattern, 'undecided'>;
  title: string;
  description: string;
  detail: string;
  icon: ReactNode;
}> = [
  {
    value: 'personalized_separate',
    title: 'Personalized separate',
    description: 'Each recipient receives a separately reviewed message.',
    detail: 'Separate immutable versions · recipients hidden from one another',
    icon: <Mail size={19} />,
  },
  {
    value: 'uniform_separate',
    title: 'Uniform separate',
    description: 'One approved message is delivered separately to each recipient.',
    detail: 'Shared content · separate delivery envelopes',
    icon: <MessagesSquare size={19} />,
  },
  {
    value: 'shared_thread',
    title: 'Shared thread',
    description: 'Recipients appear together on one visible email thread.',
    detail: 'All recipients visible · reply-all risk · group-safe facts only',
    icon: <UsersRound size={19} />,
  },
];

function sentence(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function DeliveryDecisionSurface({
  session,
  busy,
  applyCommands,
  strategy,
  strategyPending,
  strategyError,
}: DeliveryDecisionSurfaceProps) {
  const [pattern, setPattern] = useState<OutreachV3DeliveryPattern>(
    session.spec.delivery.pattern,
  );
  const [personalization, setPersonalization] = useState<OutreachV3Personalization>(
    session.spec.delivery.personalization,
  );
  const [sharedVisibilityAccepted, setSharedVisibilityAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recommendation = strategy?.data as
    | (OutreachV3StrategyData & {
        recommendedPattern?: OutreachV3DeliveryPattern;
        recommendedPersonalization?: OutreachV3Personalization;
      })
    | undefined;
  const recommendedPattern = recommendation?.recommendedPattern;
  const recommendedPersonalization = recommendation?.recommendedPersonalization;
  const selectedOption = useMemo(
    () => DELIVERY_OPTIONS.find((option) => option.value === pattern),
    [pattern],
  );

  const selectPattern = (next: Exclude<OutreachV3DeliveryPattern, 'undecided'>) => {
    setPattern(next);
    setError(null);
    if (next === 'shared_thread') {
      if (personalization === 'high') setPersonalization('none');
    } else {
      setSharedVisibilityAccepted(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pattern === 'undecided' || personalization === 'undecided') {
      setError('Choose a delivery pattern and personalization level.');
      return;
    }
    if (pattern === 'shared_thread' && !sharedVisibilityAccepted) {
      setError('Acknowledge that recipients can see one another and may reply all.');
      return;
    }
    setError(null);
    try {
      await applyCommands(deliveryCommands(pattern, personalization));
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  return (
    <form className="ov3-decision-panel" onSubmit={submit}>
      <header className="ov3-panel-header">
        <div>
          <span className="ov3-eyebrow">Delivery · 3 of 6</span>
          <h2>How should recipients receive the message?</h2>
          <p>
            Delivery controls recipient visibility. Personalization controls how much approved,
            scope-safe context may shape each message.
          </p>
        </div>
        <span className={`ov3-badge ${pattern === 'undecided' ? 'is-warning' : 'is-info'}`}>
          {pattern === 'undecided' ? 'Choose one' : sentence(pattern)}
        </span>
      </header>

      <div className="ov3-split is-delivery">
        <div className="ov3-form-stack">
          <span className="ov3-section-label">Delivery pattern</span>
          {DELIVERY_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`ov3-delivery-card ${pattern === option.value ? 'is-selected' : ''}`}
              aria-pressed={pattern === option.value}
              onClick={() => selectPattern(option.value)}
            >
              <span className="ov3-delivery-card__icon">{option.icon}</span>
              <span>
                <strong>{option.title}</strong>
                <small>{option.description}</small>
                <em>{option.detail}</em>
              </span>
              {recommendedPattern === option.value ? (
                <span className="ov3-badge is-info">
                  <Sparkles size={12} aria-hidden="true" /> Recommended
                </span>
              ) : pattern === option.value ? (
                <Check size={18} aria-hidden="true" />
              ) : null}
            </button>
          ))}

          <span className="ov3-section-label">Personalization level</span>
          <div className="ov3-inline-choice is-three" role="group" aria-label="Personalization level">
            {(['high', 'light', 'none'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={personalization === value ? 'is-selected' : ''}
                aria-pressed={personalization === value}
                disabled={pattern === 'shared_thread' && value === 'high'}
                onClick={() => setPersonalization(value)}
              >
                {sentence(value)}
                {recommendedPersonalization === value ? ' · recommended' : ''}
              </button>
            ))}
          </div>

          {pattern === 'shared_thread' ? (
            <label className="ov3-acknowledgement">
              <input
                type="checkbox"
                checked={sharedVisibilityAccepted}
                onChange={(event) => setSharedVisibilityAccepted(event.target.checked)}
              />
              <span>
                <strong>I understand every recipient can see the other addresses.</strong>
                <small>
                  They may reply all. Only group-safe facts may appear in the shared message.
                </small>
              </span>
            </label>
          ) : null}
        </div>

        <aside className="ov3-guidance-card is-strategy">
          <Sparkles size={18} aria-hidden="true" />
          <span className="ov3-eyebrow">Deterministic recommendation</span>
          <h3>
            {strategyPending
              ? 'Reviewing the current campaign'
              : recommendedPattern
                ? sentence(recommendedPattern)
                : 'Choose the recipient experience'}
          </h3>
          {strategyPending ? (
            <p><Loader2 className="ov3-spin" size={16} /> Loading a state-based recommendation…</p>
          ) : (
            <p>
              Meri may explain or recommend. The delivery choice is committed only when you press
              Continue.
            </p>
          )}
          {recommendation?.rationale?.length ? (
            <ul>{recommendation.rationale.slice(0, 4).map((item) => <li key={item}>{item}</li>)}</ul>
          ) : null}
          <div className="ov3-recovery is-info">
            <ShieldCheck size={17} aria-hidden="true" />
            <div>
              <strong>Selection does not generate or send</strong>
              <p>No draft, approval, preflight, sender, or provider action exists in Phase 6.</p>
            </div>
          </div>
          {selectedOption ? (
            <div className="ov3-delivery-summary">
              <Eye size={16} aria-hidden="true" />
              <div><strong>{selectedOption.title}</strong><p>{selectedOption.detail}</p></div>
            </div>
          ) : null}
        </aside>
      </div>

      {(error || strategyError) ? (
        <div className="ov3-recovery is-danger" role="alert">
          <CircleAlert size={18} aria-hidden="true" />
          <div><strong>Complete the delivery decision</strong><p>{error ?? strategyError}</p></div>
        </div>
      ) : null}

      <footer className="ov3-panel-footer">
        <span>Cards select. Continue commits the pattern and personalization in one batch.</span>
        <div className="ov3-panel-footer__actions">
          <button type="submit" className="ov3-button is-primary" disabled={busy}>
            {busy ? <Loader2 className="ov3-spin" size={16} /> : null}
            Continue{selectedOption ? ` with ${selectedOption.title.toLowerCase()}` : ''}
          </button>
        </div>
      </footer>
    </form>
  );
}
