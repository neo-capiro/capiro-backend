import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';
import type React from 'react';
import { useAuth } from '@clerk/clerk-react';
import { config } from '../../env.js';
import { useImpersonation } from '../../state/impersonation.js';
import {
  appendChatMessage,
  clearChatSession,
  setActiveConversation,
  setChatSession,
  setConversations,
  useChatStore,
  type MeriConversation,
} from './chat-store.js';

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

export function MeriWorkspaceThreadRail({
  searchInputRef,
}: {
  searchInputRef?: RefObject<HTMLInputElement | null>;
}) {
  const { conversations, activeConversationId } = useChatStore();
  const { getToken } = useAuth();
  const { actAsTenantSlug } = useImpersonation();
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  const authHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const token = await getToken({ template: 'capiro' });
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(actAsTenantSlug ? { 'x-capiro-impersonate-tenant': actAsTenantSlug } : {}),
    };
  }, [actAsTenantSlug, getToken]);

  const fetchConversations = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`${config.apiBaseUrl}/api/clio/conversations`, {
        headers: await authHeaders(),
      });
      if (!response.ok) return;
      const body = await response.json();
      setConversations(Array.isArray(body) ? body : []);
    } catch {
      // The rail is navigation only. A failed refresh must not break the active chat.
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  useEffect(() => {
    void fetchConversations();
  }, [fetchConversations]);

  const loadConversation = useCallback(
    async (conversationId: string) => {
      clearChatSession();
      setActiveConversation(conversationId);
      setChatSession(conversationId);
      try {
        const response = await fetch(
          `${config.apiBaseUrl}/api/clio/conversations/${conversationId}/messages`,
          { headers: await authHeaders() },
        );
        if (!response.ok) return;
        const messages = await response.json();
        if (!Array.isArray(messages)) return;
        for (const message of messages) {
          const rawAttachments = Array.isArray(message?.metadata?.attachments)
            ? message.metadata.attachments
            : [];
          const attachments = rawAttachments
            .filter(
              (item: unknown): item is Record<string, unknown> =>
                Boolean(item) && typeof item === 'object',
            )
            .map((item: Record<string, unknown>) => ({
              id: String(item.id ?? ''),
              filename: String(item.filename ?? ''),
              kind: String(item.kind ?? 'text'),
              status: String(item.status ?? 'parsed'),
            }))
            .filter((item: { id: string }) => Boolean(item.id));
          const rawArtifacts = Array.isArray(message?.artifacts) ? message.artifacts : [];
          const chartArtifacts = rawArtifacts
            .filter(
              (item: unknown): item is Record<string, unknown> =>
                Boolean(item) && typeof item === 'object',
            )
            .filter(
              (item: Record<string, unknown>) =>
                item.kind === 'analysis_chart' && typeof item.id === 'string',
            )
            .map((item: Record<string, unknown>) => ({
              id: String(item.id),
              title: String(item.title ?? '').trim() || 'Analysis chart',
            }));
          appendChatMessage({
            id: message.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            role: message.role === 'user' ? 'user' : 'assistant',
            content: message.body || '',
            createdAt: new Date(message.createdAt),
            ...(attachments.length ? { attachments } : {}),
            ...(chartArtifacts.length ? { chartArtifacts } : {}),
          });
        }
      } catch {
        // Keep the selected conversation even if history cannot be hydrated.
      }
    },
    [authHeaders],
  );

  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = [...conversations]
      .filter((conversation) => !query || conversation.title.toLowerCase().includes(query))
      .sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    return [
      { label: 'TODAY', items: filtered.filter((item) => sameLocalDay(item.updatedAt)) },
      { label: 'EARLIER', items: filtered.filter((item) => !sameLocalDay(item.updatedAt)) },
    ].filter((group) => group.items.length > 0);
  }, [conversations, search]);

  return (
    <div className="meri-v3-thread-navigation">
      <div className="meri-v3-thread-search">
        <span aria-hidden="true">⌕</span>
        <input
          ref={searchInputRef as React.RefObject<HTMLInputElement> | undefined}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="SEARCH THREADS"
          aria-label="Search threads"
        />
      </div>

      <div className="meri-v3-thread-list" aria-label="Conversation history">
        {loading && conversations.length === 0 ? (
          <div className="meri-v3-thread-state">LOADING THREADS…</div>
        ) : groups.length === 0 ? (
          <div className="meri-v3-thread-state">
            {search.trim() ? 'NO THREADS MATCH' : 'NO THREADS YET'}
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.label} className="meri-v3-thread-group">
              <div className="meri-v3-thread-group-label">{group.label}</div>
              <div className="meri-v3-thread-group-items">
                {group.items.map((conversation) => {
                  const active = conversation.id === activeConversationId;
                  return (
                    <button
                      type="button"
                      key={conversation.id}
                      className={`meri-v3-thread-item${active ? ' is-active' : ''}`}
                      onClick={() => void loadConversation(conversation.id)}
                      aria-current={active ? 'page' : undefined}
                    >
                      <span className="meri-v3-thread-title">{conversation.title}</span>
                      <span className="meri-v3-thread-meta">{threadMeta(conversation)}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
