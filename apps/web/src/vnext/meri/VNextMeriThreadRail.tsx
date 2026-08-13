import { useMemo } from 'react';
import {
  setActiveConversation,
  useChatStore,
  type MeriConversation,
} from '../../components/chat/chat-store.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';

function sameLocalDay(value: string, now = new Date()): boolean {
  const date = new Date(value);
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function threadMeta(conversation: MeriConversation): string {
  const date = new Date(conversation.updatedAt);
  const scope = (conversation.client?.name || 'General').toUpperCase();
  const when = sameLocalDay(conversation.updatedAt)
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    : date.toLocaleDateString([], { weekday: 'short' }).toUpperCase();
  return `${scope} · ${when}`;
}

interface VNextMeriThreadRailProps {
  controller: MeriChatController;
  onNewChat: () => void;
  onOpenIntegrations: () => void;
}

export function VNextMeriThreadRail({
  controller,
  onNewChat,
  onOpenIntegrations,
}: VNextMeriThreadRailProps) {
  const { conversations, activeConversationId } = useChatStore();

  const groups = useMemo(() => {
    const sorted = [...conversations].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    return [
      { label: 'TODAY', items: sorted.filter((item) => sameLocalDay(item.updatedAt)) },
      { label: 'EARLIER', items: sorted.filter((item) => !sameLocalDay(item.updatedAt)) },
    ].filter((group) => group.items.length > 0);
  }, [conversations]);

  const handleSelect = (conversationId: string) => {
    setActiveConversation(conversationId);
  };

  return (
    <aside className="vnext-meri__rail-left" aria-label="Meri conversations">
      <div className="vnext-meri__rail-left-top">
        <button
          type="button"
          className="vnext-meri__new-chat-btn"
          onClick={onNewChat}
        >
          + New chat
        </button>
      </div>

      <div className="vnext-meri__rail-left-scroll">
        <div className="vnext-meri__section-label-row">
          <span className="vnext-meri__section-label">RECENT</span>
          <button type="button" className="vnext-meri__section-label-link">
            VIEW ALL
          </button>
        </div>

        {groups.length === 0 ? (
          <div className="vnext-meri__thread-empty">
            <div className="vnext-meri__thread-empty-label">NO THREADS YET</div>
            <div className="vnext-meri__thread-empty-body">
              Your first question starts the history. Threads are scoped to a client and stay in
              this workspace.
            </div>
          </div>
        ) : (
          <div className="vnext-meri__thread-list">
            {groups.map((group) => (
              <div key={group.label}>
                <div
                  className="vnext-meri__section-label"
                  style={{ padding: '6px 0 6px' }}
                >
                  {group.label}
                </div>
                {group.items.map((conversation) => {
                  const active = conversation.id === activeConversationId;
                  return (
                    <button
                      type="button"
                      key={conversation.id}
                      className={`vnext-meri__thread-item${active ? ' is-active' : ''}`}
                      onClick={() => handleSelect(conversation.id)}
                      aria-current={active ? 'page' : undefined}
                    >
                      <span className="vnext-meri__thread-item-icon">●</span>
                      <span className="vnext-meri__thread-item-body">
                        <span className="vnext-meri__thread-item-title">
                          {conversation.title}
                        </span>
                        <span className="vnext-meri__thread-item-meta">
                          {threadMeta(conversation)}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        <div className="vnext-meri__divider" />

        <div className="vnext-meri__section-label" style={{ paddingBottom: '10px' }}>
          SAVED PROMPTS
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {SAVED_PROMPTS.map((prompt) => (
            <button
              type="button"
              key={prompt}
              className="vnext-meri__saved-prompt"
              onClick={() => void controller.sendMessage(prompt)}
            >
              <span style={{ color: 'var(--meri-text-faint)' }}>◆</span>
              <span className="vnext-meri__saved-prompt-label">{prompt}</span>
            </button>
          ))}
        </div>

        <div className="vnext-meri__divider" />

        <div className="vnext-meri__section-label-row">
          <span className="vnext-meri__section-label">WORKSPACES</span>
          <button
            type="button"
            className="vnext-meri__icon-btn"
            style={{ width: 20, height: 20, borderRadius: 5 }}
            aria-label="Add workspace"
          >
            +
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <button
            type="button"
            className="vnext-meri__workspace-item"
            onClick={onOpenIntegrations}
          >
            <span className="vnext-meri__workspace-tile">C</span>
            <span className="vnext-meri__workspace-body">
              <span className="vnext-meri__workspace-name">Capiro Context</span>
              <span className="vnext-meri__workspace-kind">CONNECTED</span>
            </span>
          </button>
        </div>
      </div>
    </aside>
  );
}

const SAVED_PROMPTS = [
  'Monday brief — what moved last week',
  'Prep me for the next markup',
  'Conflict check on my latest ask',
];
