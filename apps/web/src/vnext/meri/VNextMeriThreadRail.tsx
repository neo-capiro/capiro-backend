import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  removeConversation,
  useChatStore,
  type MeriConversation,
} from '../../components/chat/chat-store.js';
import { useApi } from '../../lib/use-api.js';
import { useCapiroToast } from '../components/feedback/toast.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { MeriIcon, type MeriIconName } from './meri-icons.js';
import {
  displayThreadTitle,
  sameLocalDay,
  threadKindIcon,
} from './meri-presentation.js';

interface HistorySearchResult {
  conversationId: string;
  title: string;
  clientId: string | null;
  messageId: string;
  snippet: string;
  createdAt: string;
  score: number | null;
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

function kindFor(conversation: MeriConversation): MeriIconName {
  const haystack = `${conversation.title} ${conversation.latestMessage?.body ?? ''}`.toLowerCase();
  return threadKindIcon({
    isNew: !conversation.latestMessage,
    isResearch: /research|markup|hearing/.test(haystack),
    hasArtifact: /memo|draft|artifact|brief/.test(haystack),
  });
}

interface VNextMeriThreadRailProps {
  controller: MeriChatController;
  historyError: string | null;
  onRetryHistory: () => void;
  onNewChat: () => void;
  onOpenIntegrations: () => void;
  onArchiveThread: (conversationId: string) => Promise<void>;
  onRenameThread: (conversationId: string, title: string) => Promise<void>;
  onRestoreThread: (conversationId: string) => Promise<void>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  searchInputRef: { current: HTMLInputElement | null };
  onOpenPalette: () => void;
}

export function VNextMeriThreadRail({
  controller,
  historyError,
  onRetryHistory,
  onNewChat,
  onOpenIntegrations,
  onArchiveThread,
  onRenameThread,
  onRestoreThread,
  searchQuery,
  onSearchQueryChange,
  searchInputRef,
  onOpenPalette,
}: VNextMeriThreadRailProps) {
  const navigate = useNavigate();
  const api = useApi();
  const toast = useCapiroToast();
  const { conversations, activeConversationId } = useChatStore();
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirmFor, setConfirmFor] = useState<MeriConversation | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [undoTarget, setUndoTarget] = useState<MeriConversation | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  const rowMenuRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQuery(searchQuery.trim()), 200);
    return () => window.clearTimeout(handle);
  }, [searchQuery]);

  const searchActive = debouncedQuery.length >= 2;
  const search = useQuery<HistorySearchResult[]>({
    queryKey: ['meri-conversation-search', debouncedQuery],
    queryFn: async () =>
      (
        await api.get<HistorySearchResult[]>('/api/clio/conversations/search', {
          params: { q: debouncedQuery, limit: 25 },
        })
      ).data,
    enabled: searchActive,
    staleTime: 30_000,
  });

  const localFiltered = useMemo(() => {
    const sorted = [...conversations].sort(
      (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
    );
    const query = searchQuery.trim().toLowerCase();
    if (!query) return sorted;
    return sorted.filter((conversation) =>
      [
        displayThreadTitle(conversation.title, conversation.latestMessage?.body),
        conversation.client?.name ?? '',
        threadMeta(conversation),
        conversation.latestMessage?.body ?? '',
      ].some((value) => value.toLowerCase().includes(query)),
    );
  }, [conversations, searchQuery]);

  const visible = useMemo(() => {
    if (!searchActive || !search.data) return localFiltered;
    const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
    const extra: MeriConversation[] = [];
    for (const hit of search.data) {
      const existing = byId.get(hit.conversationId);
      if (existing) {
        if (!localFiltered.some((row) => row.id === existing.id)) extra.push(existing);
        continue;
      }
      extra.push({
        id: hit.conversationId,
        title: hit.title,
        clientId: hit.clientId,
        client: null,
        latestMessage: { body: hit.snippet, createdAt: hit.createdAt },
        updatedAt: hit.createdAt,
      });
    }
    const merged = [...localFiltered];
    for (const row of extra) {
      if (!merged.some((item) => item.id === row.id)) merged.push(row);
    }
    return merged;
  }, [conversations, localFiltered, search.data, searchActive]);

  const groups = useMemo(() => {
    if (searchQuery.trim()) return [{ label: 'RESULTS', items: visible }];
    return [
      { label: 'TODAY', items: visible.filter((item) => sameLocalDay(item.updatedAt)) },
      { label: 'EARLIER', items: visible.filter((item) => !sameLocalDay(item.updatedAt)) },
    ].filter((group) => group.items.length > 0);
  }, [searchQuery, visible]);

  useEffect(() => {
    if (!menuFor) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuFor(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuFor]);

  useEffect(() => {
    if (!confirmFor) return;
    confirmCancelRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        const id = confirmFor.id;
        setConfirmFor(null);
        window.setTimeout(() => rowMenuRefs.current[id]?.focus(), 0);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [confirmFor]);

  const handleSelect = (conversationId: string) => {
    if (conversationId === activeConversationId) return;
    onSearchQueryChange('');
    navigate(`/meri/t/${encodeURIComponent(conversationId)}`);
  };

  const handleSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onSearchQueryChange('');
      searchInputRef.current?.focus();
    }
  };

  const commitRename = async () => {
    if (!renaming) return;
    const next = renaming.value.trim();
    const id = renaming.id;
    setRenaming(null);
    if (!next) return;
    try {
      await onRenameThread(id, next);
    } catch {
      toast.error('The chat could not be renamed.');
    }
  };

  const confirmDelete = async () => {
    if (!confirmFor) return;
    const target = confirmFor;
    setConfirmFor(null);
    removeConversation(target.id);
    try {
      await onArchiveThread(target.id);
      setUndoTarget(target);
      toast.success('Chat archived. It stays in the audit trail.');
      const remaining = conversations.filter((conversation) => conversation.id !== target.id);
      if (target.id === activeConversationId) {
        const next = remaining.sort(
          (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
        )[0];
        navigate(next ? `/meri/t/${encodeURIComponent(next.id)}` : '/meri/new');
      }
    } catch {
      toast.error('The chat could not be archived.');
    }
  };

  return (
    <aside className="vnext-meri__rail-left" data-meri-thread-rail aria-label="Meri conversations">
      <div className="vnext-meri__rail-left-top">
        <button type="button" className="vnext-meri__new-chat-btn" onClick={onNewChat}>
          <MeriIcon name="Plus" size={16} color="#ffffff" />
          New chat
        </button>
      </div>

      <div className="vnext-meri__rail-left-scroll">
        <section data-meri-rail-section="saved-prompts">
          <div className="vnext-meri__section-label-row">
            <span className="vnext-meri__section-label">SAVED PROMPTS</span>
          </div>
          <div className="vnext-meri__section-empty">
            <div className="vnext-meri__section-empty-label">NO SAVED PROMPTS</div>
            <div className="vnext-meri__section-empty-body">
              Saved prompts will appear here when the library is available.
            </div>
          </div>
        </section>

        <div className="vnext-meri__divider" />

        <section data-meri-rail-section="workspaces">
          <div className="vnext-meri__section-label-row">
            <span className="vnext-meri__section-label">WORKSPACES</span>
            <button
              type="button"
              className="vnext-meri__icon-btn vnext-meri__icon-btn--tiny"
              aria-label="Add workspace"
              title="Add workspace"
              onClick={onOpenIntegrations}
            >
              <MeriIcon name="Plus" size={13} color="#98A2B3" />
            </button>
          </div>
          <div className="vnext-meri__section-empty">
            <div className="vnext-meri__section-empty-label">NO WORKSPACES YET</div>
            <div className="vnext-meri__section-empty-body">
              Connected workspaces will appear here. Use the add control to open integrations.
            </div>
          </div>
        </section>

        <div className="vnext-meri__divider" />

        <section data-meri-rail-section="recent">
          <div className="vnext-meri__section-label-row">
            <span className="vnext-meri__section-label">RECENT</span>
            <button
              type="button"
              className="vnext-meri__section-label-link"
              onClick={onOpenPalette}
            >
              VIEW ALL
            </button>
          </div>

          <div className="vnext-meri__rail-search" data-meri-rail-search>
            <MeriIcon name="SearchLg" size={14} color="#98A2B3" />
            <input
              ref={searchInputRef}
              type="search"
              value={searchQuery}
              onChange={(event) => onSearchQueryChange(event.target.value)}
              onKeyDown={handleSearchKey}
              placeholder="Search chats…"
              aria-label="Search chats"
            />
            {searchQuery ? (
              <button
                type="button"
                className="vnext-meri__rail-search-clear"
                aria-label="Clear search"
                onClick={() => {
                  onSearchQueryChange('');
                  searchInputRef.current?.focus();
                }}
              >
                <MeriIcon name="XClose" size={12} color="#98A2B3" />
              </button>
            ) : null}
          </div>

          {historyError ? (
            <div className="vnext-meri__thread-empty" role="alert">
              <div className="vnext-meri__thread-empty-label">HISTORY UNAVAILABLE</div>
              <div className="vnext-meri__thread-empty-body">{historyError}</div>
              <button type="button" className="vnext-meri__section-label-link" onClick={onRetryHistory}>
                RETRY
              </button>
            </div>
          ) : visible.length === 0 && searchQuery.trim() ? (
            <div className="vnext-meri__thread-empty">
              <div className="vnext-meri__thread-empty-body">
                No chats match “{searchQuery.trim()}”.
              </div>
              <button type="button" className="vnext-meri__search-everything" onClick={onOpenPalette}>
                SEARCH EVERYTHING ⌘K
              </button>
            </div>
          ) : visible.length === 0 ? (
            <div className="vnext-meri__thread-empty">
              <div className="vnext-meri__thread-empty-label">NO THREADS YET</div>
              <div className="vnext-meri__thread-empty-body">
                Your first question starts the history. Threads can be scoped to a client and stay
                in this workspace.
              </div>
            </div>
          ) : (
            <div className="vnext-meri__thread-list">
              {groups.map((group, groupIndex) => (
                <div key={group.label}>
                  <div
                    className={`vnext-meri__thread-group-label${
                      groupIndex === 0 ? ' is-first' : ''
                    }`}
                  >
                    {group.label}
                  </div>
                  {group.items.map((conversation) => {
                    const active = conversation.id === activeConversationId;
                    const title = displayThreadTitle(
                      conversation.title,
                      conversation.latestMessage?.body,
                    );
                    return (
                      <div
                        key={conversation.id}
                        className={`vnext-meri__thread-item${active ? ' is-active' : ''}${
                          menuFor === conversation.id ? ' is-menu-open' : ''
                        }`}
                        data-meri-thread-row
                      >
                        {renaming?.id === conversation.id ? (
                          <form
                            className="vnext-meri__thread-rename"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void commitRename();
                            }}
                          >
                            <input
                              autoFocus
                              value={renaming.value}
                              aria-label="Rename chat"
                              onChange={(event) =>
                                setRenaming({ id: conversation.id, value: event.target.value })
                              }
                              onBlur={() => void commitRename()}
                              onKeyDown={(event) => {
                                if (event.key === 'Escape') {
                                  event.preventDefault();
                                  setRenaming(null);
                                }
                              }}
                            />
                          </form>
                        ) : (
                          <button
                            type="button"
                            className="vnext-meri__thread-item-main"
                            onClick={() => handleSelect(conversation.id)}
                            aria-current={active ? 'page' : undefined}
                          >
                            <span className="vnext-meri__thread-item-icon">
                              <MeriIcon
                                name={kindFor(conversation)}
                                size={11}
                                color={active ? '#101828' : '#667085'}
                              />
                            </span>
                            <span className="vnext-meri__thread-item-body">
                              <span className="vnext-meri__thread-item-title">{title}</span>
                              <span className="vnext-meri__thread-item-meta">
                                {threadMeta(conversation)}
                              </span>
                            </span>
                          </button>
                        )}
                        <button
                          type="button"
                          className="vnext-meri__row-menu-btn"
                          data-meri-row-menu
                          aria-label="Chat options"
                          aria-haspopup="menu"
                          aria-expanded={menuFor === conversation.id}
                          ref={(node) => {
                            rowMenuRefs.current[conversation.id] = node;
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            setMenuFor((current) =>
                              current === conversation.id ? null : conversation.id,
                            );
                          }}
                        >
                          <MeriIcon name="DotsHorizontal" size={14} color="#98A2B3" />
                        </button>
                        {menuFor === conversation.id ? (
                          <div
                            ref={menuRef}
                            className="vnext-meri__row-menu"
                            role="menu"
                            aria-label="Chat options"
                          >
                            <button
                              type="button"
                              role="menuitem"
                              className="vnext-meri__row-menu-item"
                              onClick={() => {
                                setMenuFor(null);
                                setRenaming({ id: conversation.id, value: title });
                              }}
                            >
                              <MeriIcon name="Edit01" size={14} color="#344054" />
                              Rename
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="vnext-meri__row-menu-item"
                              disabled
                              title="Duplicate context is not available yet."
                            >
                              <MeriIcon name="Copy01" size={14} color="#344054" />
                              Duplicate context to new chat
                            </button>
                            <span className="vnext-meri__row-menu-rule" />
                            <button
                              type="button"
                              role="menuitem"
                              className="vnext-meri__row-menu-item is-danger"
                              onClick={() => {
                                setMenuFor(null);
                                setConfirmFor(conversation);
                              }}
                            >
                              <MeriIcon name="Trash01" size={14} color="#B42318" />
                              Delete chat
                            </button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {undoTarget ? (
        <div className="vnext-meri__undo-bar" role="status">
          <span>Chat archived. It stays in the audit trail.</span>
          <button
            type="button"
            className="vnext-meri__section-label-link"
            onClick={() => {
              const target = undoTarget;
              setUndoTarget(null);
              void onRestoreThread(target.id).catch(() =>
                toast.error('The chat could not be restored.'),
              );
            }}
          >
            UNDO
          </button>
        </div>
      ) : null}

      {confirmFor ? (
        <div className="vnext-meri__confirm-scrim" role="presentation">
          <div
            className="vnext-meri__confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="meri-delete-title"
            aria-describedby="meri-delete-body"
          >
            <span className="vnext-meri__confirm-icon">
              <MeriIcon name="AlertTriangle" size={17} color="#B42318" />
            </span>
            <div id="meri-delete-title" className="vnext-meri__confirm-title">
              Delete this chat?
            </div>
            <div id="meri-delete-body" className="vnext-meri__confirm-body">
              “{displayThreadTitle(confirmFor.title, confirmFor.latestMessage?.body)}” is removed
              from your workspace. The thread, its messages and its context history stay in the
              audit trail.
            </div>
            <div className="vnext-meri__confirm-actions">
              <button
                type="button"
                className="vnext-meri__confirm-cancel"
                ref={confirmCancelRef}
                onClick={() => {
                  const id = confirmFor.id;
                  setConfirmFor(null);
                  window.setTimeout(() => rowMenuRefs.current[id]?.focus(), 0);
                }}
              >
                Cancel
              </button>
              <button type="button" className="vnext-meri__confirm-delete" onClick={() => void confirmDelete()}>
                Delete chat
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
