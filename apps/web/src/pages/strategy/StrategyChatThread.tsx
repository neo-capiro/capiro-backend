/*
 * The durable Meri conversation, rendered (Phase 2).
 *
 * Ported from the prototype's ChatThread: user messages right-aligned in an
 * accent bubble, Meri/system/Watch messages left-aligned behind a spark avatar,
 * attachment chips inside the user bubble, and a `Open "<step>"` button on a
 * reply that created exactly one step.
 *
 * Presentational only — it does not fetch, mutate, or decide what a message
 * means. The panel owns the query and the send.
 */
import { Icon } from './strategy-ui.js';
import type { StrategyChatAttachment, StrategyChatMessage } from './types.js';

/** A message that has not been acknowledged by the server yet (the user's own
 *  send, echoed immediately so the panel never looks like it dropped input). */
export interface PendingChatMessage {
  body: string;
  attachments: StrategyChatAttachment[];
}

export function StrategyChatThread({
  messages,
  pending,
  onOpenNode,
}: {
  messages: StrategyChatMessage[];
  pending?: PendingChatMessage | null;
  /** Selects the step and switches to its thread. Fires ONLY on click. */
  onOpenNode: (nodeId: string) => void;
}) {
  if (messages.length === 0 && !pending) return null;
  return (
    <div
      data-testid="sp-chat-thread"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        width: '100%',
        minWidth: 0,
        // A long thread must lengthen the scroll area, never squeeze the cards
        // and fields above it.
        flexShrink: 0,
      }}
    >
      {messages.map((m) =>
        m.role === 'user' ? (
          <UserBubble key={m.id} body={m.body} attachments={m.attachments} />
        ) : (
          <MeriBubble key={m.id} message={m} onOpenNode={onOpenNode} />
        ),
      )}
      {pending && (
        <UserBubble
          key="pending"
          body={pending.body}
          attachments={pending.attachments}
          pending
        />
      )}
    </div>
  );
}

function UserBubble({
  body,
  attachments,
  pending = false,
}: {
  body: string;
  attachments: StrategyChatAttachment[];
  pending?: boolean;
}) {
  return (
    <div
      data-testid="sp-chat-user"
      data-pending={pending ? 'true' : undefined}
      style={{
        alignSelf: 'flex-end',
        maxWidth: '86%',
        // A pasted URL or token with no spaces must wrap rather than force the
        // whole 344px panel to scroll sideways.
        overflowWrap: 'anywhere',
        background: 'var(--accent)',
        color: '#fff',
        borderRadius: '12px 12px 4px 12px',
        padding: '9px 12px',
        fontSize: 'var(--text-sm)',
        lineHeight: 1.45,
        // The only in-flight cue: the bubble stays exactly where it is and is
        // never replaced or removed when the reply lands.
        opacity: pending ? 0.72 : 1,
      }}
    >
      {body}
      {attachments.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
          {attachments.map((f) => (
            <span
              key={f.id}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                background: 'rgba(255,255,255,0.18)',
                borderRadius: 6,
                padding: '2px 7px',
                fontSize: 'var(--text-2xs)',
                fontWeight: 600,
              }}
            >
              <Icon name="paperclip" size={10} color="#fff" />
              {f.filename}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function MeriBubble({
  message,
  onOpenNode,
}: {
  message: StrategyChatMessage;
  onOpenNode: (nodeId: string) => void;
}) {
  const action = message.action;
  return (
    <div
      data-testid="sp-chat-meri"
      data-kind={message.kind}
      style={{ alignSelf: 'flex-start', maxWidth: '92%', display: 'flex', gap: 8 }}
    >
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: 'var(--accent-soft)',
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0,
          marginTop: 2,
        }}
      >
        <Icon name="spark" size={12} color="var(--accent)" />
      </span>
      <div
        style={{
          minWidth: 0,
          overflowWrap: 'anywhere',
          background: 'var(--bg-surface-2)',
          border: '1px solid var(--border-1)',
          borderRadius: '12px 12px 12px 4px',
          padding: '9px 12px',
          fontSize: 'var(--text-sm)',
          color: 'var(--ink-1)',
          lineHeight: 1.5,
        }}
      >
        {message.kind === 'watch_applied' && (
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 'var(--text-2xs)',
              fontWeight: 800,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--success)',
              marginBottom: 4,
            }}
          >
            <Icon name="check" size={11} color="var(--success)" /> Watch mode
          </div>
        )}
        {message.body}
        {action && (
          <button
            onClick={() => onOpenNode(action.nodeId)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              width: '100%',
              marginTop: 8,
              padding: '7px 9px',
              borderRadius: 7,
              border: '1px solid var(--border-2)',
              background: 'var(--bg-surface)',
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: 'var(--font-sans)',
            }}
          >
            <Icon name="arrow" size={12} color="var(--accent)" />
            <span
              style={{
                flex: 1,
                fontSize: 'var(--text-2xs)',
                fontWeight: 700,
                color: 'var(--accent-ink)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              Open “{action.title}”
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
