import { useMemo, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useChatStore,
  type MeriConversation,
} from '../../components/chat/chat-store.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';

function sameLocalDay(value: string, now = new Date()): boolean {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function threadMeta(conversation: MeriConversation): string {
  const date = new Date(conversation.updatedAt);
  const scope = (conversation.client?.name || 'General').toUpperCase();
  if (!Number.isFinite(date.getTime())) return `${scope} · DATE UNKNOWN`;
  const when = sameLocalDay(conversation.updatedAt)
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' }).toUpperCase();
  return `${scope} · ${when}`;
}

interface VNextMeriThreadRailProps {
  controller: MeriChatController;
  onNewChat: () => void;
  onOpenIntegrations: () => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  searchInputRef: RefObject<HTMLInputElement>;
}

export function VNextMeriThreadRail({
  controller,
  onNewChat,
  onOpenIntegrations,
  searchQuery,
  onSearchQueryChange,
  searchInputRef,
}: VNextMeriThreadRailProps) {
  const navigate = useNavigate();
  const { conversations, activeConversationId } = useChatStore();

  const groups = useMemo(() => {
    const sorted = [...conversations].sort(
      (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
    );
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      const items = sorted.filter((conversation) =>
        [
          conversation.title,
          conversation.client?.name ?? '',
          conversation.latestMessage?.body ?? '',
        ].some((value) => value.toLowerCase().includes(query)),
      );
      return [{ label: 'RESULTS', items }];
    }
    return [
      { label: 'TODAY', items: sorted.filter((item) => sameLocalDay(item.updatedAt)) },
      { label: 'EARLIER', items: sorted.filter((item) => !sameLocalDay(item.updatedAt)) },
    ].filter((group) => group.items.length > 0);
  }, [conversations, searchQuery]);

  const visibleThreadCount = groups.reduce((count, group) => count + group.items.length, 0);

  const handleSelect = (conversationId: string) => {
    if (conversationId === activeConversationId) return;
    onSearchQueryChange('');
    // Route first, then let the workspace hydrate transactionally. Mutating the
    // shared active id before messages were loaded briefly paired the new title
    // and client scope with the previous thread's transcript — and left a small
    // window where a Send could target the wrong durable session.
    navigate(`/meri/t/${encodeURIComponent(conversationId)}`);
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
        <input
          ref={searchInputRef}
          type="search"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          placeholder="Search threads"
          aria-label="Search Meri threads"
          style={{
            width: '100%',
            height: 36,
            marginTop: 10,
            padding: '0 11px',
            border: 0,
            borderRadius: 8,
            color: 'var(--meri-ink)',
            background: 'var(--meri-surface)',
            boxShadow: 'var(--meri-shadow-composer)',
          }}
        />
      </div>

      <div className="vnext-meri__rail-left-scroll">
        <div className="vnext-meri__section-label-row">
          <span className="vnext-meri__section-label">
            {searchQuery.trim() ? 'SEARCH' : 'RECENT'}
          </span>
          {searchQuery.trim() ? (
            <button
              type="button"
              className="vnext-meri__section-label-link"
              onClick={() => onSearchQueryChange('')}
            >
              CLEAR
            </button>
          ) : (
            <span className="vnext-meri__section-label">{visibleThreadCount} THREADS</span>
          )}
        </div>

        {visibleThreadCount === 0 ? (
          <div className="vnext-meri__thread-empty">
            <div className="vnext-meri__thread-empty-label">
              {searchQuery.trim() ? 'NO MATCHING THREADS' : 'NO THREADS YET'}
            </div>
            <div className="vnext-meri__thread-empty-body">
              {searchQuery.trim()
                ? 'Try a title, client name, or phrase from the latest message.'
                : 'Your first question starts the history. Threads can be scoped to a client and stay in this workspace.'}
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
              disabled={controller.isStreaming}
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
            className="vnext-meri__icon-btn vnext-meri__icon-btn--tiny"
            aria-label="Manage connected workspaces"
            title="Manage connected workspaces"
            onClick={onOpenIntegrations}
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
              <span className="vnext-meri__workspace-kind">CONNECTED APPS</span>
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
