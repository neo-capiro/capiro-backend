import { useMemo, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowUp,
  Loader2,
  Plus,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import type { OutreachV3Stage, OutreachV3TranscriptTurn } from './contracts.js';

const STAGE_PROMPTS: Partial<Record<OutreachV3Stage, string[]>> = {
  goal: [
    'Help me define a clear congressional ask.',
    'Turn my objective into a concise outreach goal.',
  ],
  sponsor: [
    'This campaign is firm-wide.',
    'This is for one client.',
  ],
  targets: [
    'Recommend the best people and offices.',
    'Find targets with an existing relationship.',
  ],
  delivery: [
    'Recommend the safest delivery pattern.',
    'Keep personalization light.',
  ],
  context: [
    'Find relevant approved memory and government records.',
    'Explain which facts are evidence versus writing guidance.',
  ],
  strategy: [
    'Propose the campaign angle, tone, and length.',
    'Explain why this strategy fits the selected audience.',
  ],
};

export interface OutreachConversationProps {
  title: string;
  stage: OutreachV3Stage;
  turns: OutreachV3TranscriptTurn[];
  unavailable: boolean;
  unavailableMessage?: string | null;
  sending: boolean;
  onSend: (message: string) => Promise<unknown>;
  onRetry: () => void | Promise<void>;
}

export function OutreachConversation({
  title,
  stage,
  turns,
  unavailable,
  unavailableMessage,
  sending,
  onSend,
  onRetry,
}: OutreachConversationProps) {
  const [message, setMessage] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const suggestions = STAGE_PROMPTS[stage] ?? [];
  const visibleTurns = useMemo(
    () => turns.filter((turn) => turn.text.trim().length > 0),
    [turns],
  );

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const value = message.trim();
    if (!value || sending || unavailable) return;
    setMessage('');
    try {
      await onSend(value);
    } catch {
      setMessage(value);
      inputRef.current?.focus();
    }
  };

  return (
    <section className="ov3-conversation" aria-label="Outreach conversation">
      <header className="ov3-conversation__header">
        <div>
          <span className="ov3-eyebrow">Outreach conversation</span>
          <h2>{title}</h2>
        </div>
        <span className={`ov3-badge ${unavailable ? 'is-warning' : 'is-info'}`}>
          <span aria-hidden="true" className="ov3-badge__dot" />
          {unavailable ? 'Controls active' : 'Meri available'}
        </span>
      </header>

      <div className="ov3-conversation__scroll" role="log" aria-live="polite">
        {visibleTurns.length === 0 && !unavailable ? (
          <article className="ov3-message is-meri">
            <div className="ov3-message__meta">
              <Sparkles size={14} aria-hidden="true" />
              <strong>Meri</strong>
              <span>Ready</span>
            </div>
            <p>
              Tell me what you want to accomplish. I can help structure the campaign,
              research targets and context, and propose changes for your review. Nothing
              applies automatically.
            </p>
          </article>
        ) : null}

        {visibleTurns.map((turn, index) => (
          <article
            key={turn.id ?? `${turn.role}-${index}`}
            className={`ov3-message is-${turn.role} ${turn.status === 'failed' ? 'is-failed' : ''}`}
          >
            <div className="ov3-message__meta">
              {turn.role === 'assistant' ? <Sparkles size={14} aria-hidden="true" /> : null}
              {turn.role === 'system' ? <AlertTriangle size={14} aria-hidden="true" /> : null}
              <strong>
                {turn.role === 'assistant' ? 'Meri' : turn.role === 'system' ? 'Campaign state' : 'You'}
              </strong>
              <span>{turn.status === 'pending' ? 'Working' : turn.status ?? 'Complete'}</span>
            </div>
            <p>{turn.text}</p>
          </article>
        ))}

        {sending ? (
          <article className="ov3-message is-meri is-working">
            <div className="ov3-message__meta">
              <Loader2 className="ov3-spin" size={14} aria-hidden="true" />
              <strong>Meri</strong>
              <span>Reasoning</span>
            </div>
            <p>Reviewing the current campaign state and authorized sources…</p>
          </article>
        ) : null}

        {unavailable ? (
          <div className="ov3-recovery is-warning" role="status">
            <AlertTriangle size={18} aria-hidden="true" />
            <div>
              <strong>Reasoning is temporarily unavailable</strong>
              <p>
                {unavailableMessage ??
                  'Campaign state is safe. Use the deterministic controls to continue.'}
              </p>
              <button
                type="button"
                className="ov3-button is-secondary"
                onClick={() => void onRetry()}
              >
                <RotateCcw size={15} aria-hidden="true" />
                Retry reasoning
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {visibleTurns.length === 0 && !unavailable && suggestions.length > 0 ? (
        <div className="ov3-conversation__suggestions" aria-label="Suggested prompts">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => {
                setMessage(suggestion);
                inputRef.current?.focus();
              }}
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}

      <form className="ov3-composer" onSubmit={submit}>
        <label className="sr-only" htmlFor="outreach-v3-message">
          Message Meri about this campaign
        </label>
        <textarea
          id="outreach-v3-message"
          ref={inputRef}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={
            unavailable
              ? 'Reasoning unavailable — campaign controls remain usable'
              : 'Tell Meri what you want to accomplish…'
          }
          disabled={unavailable || sending}
          rows={3}
          maxLength={16_000}
        />
        <div className="ov3-composer__toolbar">
          <button
            className="ov3-icon-button"
            type="button"
            disabled
            aria-label="Add context — available from the Context stage"
            title="Add context from the Context stage"
          >
            <Plus size={17} aria-hidden="true" />
          </button>
          <span className="ov3-composer__scope">Campaign state · governed sources</span>
          <button
            className="ov3-send-button"
            type="submit"
            disabled={!message.trim() || unavailable || sending}
            aria-label="Send message to Meri"
          >
            {sending ? <Loader2 className="ov3-spin" size={16} /> : <ArrowUp size={16} />}
          </button>
        </div>
        <p className="ov3-composer__hint">
          Enter to send · Shift+Enter for a new line · recommendations never apply automatically
        </p>
      </form>
    </section>
  );
}