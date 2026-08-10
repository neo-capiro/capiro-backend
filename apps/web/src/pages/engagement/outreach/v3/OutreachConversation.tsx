import { useMemo, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Clock3,
  Loader2,
  MessageSquareText,
  Plus,
  RotateCcw,
  Sparkles,
  X,
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

function turnLabel(turn: OutreachV3TranscriptTurn): string {
  if (turn.role === 'assistant') return 'Meri';
  if (turn.role === 'system') return 'Campaign state';
  return 'You';
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const suggestions = STAGE_PROMPTS[stage] ?? [];
  const visibleTurns = useMemo(
    () => turns.filter((turn) => turn.text.trim().length > 0),
    [turns],
  );
  const latestTurn = useMemo(
    () => visibleTurns[visibleTurns.length - 1],
    [visibleTurns],
  );
  const latestAssistant = useMemo(
    () => [...visibleTurns].reverse().find((turn) => turn.role === 'assistant'),
    [visibleTurns],
  );

  const liveText = unavailable
    ? unavailableMessage ?? 'Reasoning is temporarily unavailable. Campaign controls remain usable.'
    : sending
      ? 'Reviewing the current campaign state and authorized sources…'
      : latestAssistant?.text ??
        'Tell me what you want to accomplish. I can structure the campaign, research targets and context, and propose changes for your review.';

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
    <section className="ov3-conversation-dock" aria-label="Outreach conversation">
      {historyOpen ? (
        <div className="ov3-conversation-history" role="dialog" aria-label="Conversation history">
          <header className="ov3-conversation-history__header">
            <div>
              <span className="ov3-eyebrow">Conversation history</span>
              <h3>{title}</h3>
            </div>
            <button
              type="button"
              className="ov3-icon-button"
              onClick={() => setHistoryOpen(false)}
              aria-label="Close conversation history"
            >
              <X size={17} aria-hidden="true" />
            </button>
          </header>
          <div className="ov3-conversation-history__scroll" role="log" aria-live="polite">
            {visibleTurns.length ? (
              visibleTurns.map((turn, index) => (
                <article
                  key={turn.id ?? `${turn.role}-${index}`}
                  className={`ov3-history-turn is-${turn.role} ${turn.status === 'failed' ? 'is-failed' : ''}`}
                >
                  <div className="ov3-history-turn__meta">
                    {turn.role === 'assistant' ? <Sparkles size={13} aria-hidden="true" /> : null}
                    {turn.role === 'system' ? <AlertTriangle size={13} aria-hidden="true" /> : null}
                    <strong>{turnLabel(turn)}</strong>
                    <span>{turn.status === 'pending' ? 'Working' : turn.status ?? 'Complete'}</span>
                  </div>
                  <p>{turn.text}</p>
                </article>
              ))
            ) : (
              <div className="ov3-history-empty">
                <MessageSquareText size={20} aria-hidden="true" />
                <p>No prior turns yet. Start with the goal below.</p>
              </div>
            )}
          </div>
        </div>
      ) : null}

      <div className={`ov3-live-turn ${unavailable ? 'is-warning' : ''}`}>
        <div className="ov3-live-turn__identity">
          <span className="ov3-live-turn__mark" aria-hidden="true">
            {unavailable ? <AlertTriangle size={16} /> : sending ? <Loader2 className="ov3-spin" size={16} /> : <Sparkles size={16} />}
          </span>
          <div>
            <span className="ov3-eyebrow">{unavailable ? 'Meri unavailable' : 'Meri · live'}</span>
            <p>{liveText}</p>
          </div>
        </div>
        <div className="ov3-live-turn__actions">
          {unavailable ? (
            <button type="button" className="ov3-button is-secondary" onClick={() => void onRetry()}>
              <RotateCcw size={14} aria-hidden="true" />
              Retry
            </button>
          ) : null}
          <button
            type="button"
            className="ov3-button is-quiet ov3-history-toggle"
            onClick={() => setHistoryOpen((open) => !open)}
            aria-expanded={historyOpen}
          >
            <Clock3 size={14} aria-hidden="true" />
            {visibleTurns.length ? `${visibleTurns.length} turns` : 'History'}
            {historyOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
        </div>
      </div>

      {!unavailable && !sending && suggestions.length > 0 && visibleTurns.length <= 1 ? (
        <div className="ov3-dock-suggestions" aria-label="Suggested responses">
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

      <form className="ov3-docked-composer" onSubmit={submit}>
        <button
          className="ov3-icon-button ov3-docked-composer__add"
          type="button"
          disabled
          aria-label="Add context — use the Context stage"
          title="Add governed context from the Context stage"
        >
          <Plus size={17} aria-hidden="true" />
        </button>
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
              ? 'Reasoning unavailable — deterministic controls remain usable'
              : 'Tell Meri what to change, ask a question, or keep working…'
          }
          disabled={unavailable || sending}
          rows={1}
          maxLength={16_000}
        />
        <div className="ov3-docked-composer__scope">
          <span>Campaign V3</span>
          <span>Governed sources</span>
        </div>
        <button
          className="ov3-send-button"
          type="submit"
          disabled={!message.trim() || unavailable || sending}
          aria-label="Send message to Meri"
        >
          {sending ? <Loader2 className="ov3-spin" size={16} /> : <ArrowUp size={16} />}
        </button>
      </form>

      <p className="ov3-dock-footnote">
        Enter to send · Shift+Enter for a new line · typed instructions become proposals and never apply themselves
        {latestTurn?.status === 'failed' ? ' · last turn needs attention' : ''}
      </p>
    </section>
  );
}
