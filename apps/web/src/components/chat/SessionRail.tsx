import { useCallback, useEffect, useState } from 'react';
import {
  UserOutlined,
  MessageOutlined,
  DownOutlined,
  RightOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useAuth } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import { Input } from 'antd';
import { config } from '../../env.js';
import { useApi } from '../../lib/use-api.js';
import { useImpersonation } from '../../state/impersonation.js';
import {
  MeriConversation,
  setConversations,
  setActiveConversation,
  setChatSession,
  clearChatSession,
  appendChatMessage,
  removeConversation,
  useChatStore,
} from './chat-store.js';

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

interface ClientGroup {
  clientId: string | null;
  clientName: string;
  conversations: MeriConversation[];
}

/** One row from GET /api/clio/conversations/search (assistant-parity F2). */
interface HistorySearchResult {
  conversationId: string;
  title: string;
  clientId: string | null;
  messageId: string;
  snippet: string;
  createdAt: string;
  score: number | null;
}

const SEARCH_DEBOUNCE_MS = 350;
const SEARCH_MIN_CHARS = 2;

export function SessionRail({ forceOpen = false }: { forceOpen?: boolean } = {}) {
  const { conversations, activeConversationId, sessionRailOpen } = useChatStore();
  const railOpen = forceOpen || sessionRailOpen;
  const { getToken } = useAuth();
  const api = useApi();
  const { actAsTenantSlug } = useImpersonation();
  const [expandedClients, setExpandedClients] = useState<Set<string>>(new Set(['__general__']));
  const [loading, setLoading] = useState(false);
  // History search (F2): raw input debounced into the query that actually
  // fires; while >= 2 chars are active the grouped list is replaced by hits.
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(
      () => setSearchQuery(searchInput.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const searchActive = searchQuery.length >= SEARCH_MIN_CHARS;
  const search = useQuery<HistorySearchResult[]>({
    queryKey: ['meri-conversation-search', searchQuery],
    queryFn: async () =>
      (
        await api.get<HistorySearchResult[]>('/api/clio/conversations/search', {
          params: { q: searchQuery, limit: 10 },
        })
      ).data,
    enabled: railOpen && searchActive,
    staleTime: 30_000,
  });

  const authHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const token = await getToken({ template: 'capiro' });
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(actAsTenantSlug ? { 'x-capiro-impersonate-tenant': actAsTenantSlug } : {}),
    };
  }, [getToken, actAsTenantSlug]);

  const fetchConversations = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${config.apiBaseUrl}/api/clio/conversations`, {
        headers: await authHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setConversations(Array.isArray(data) ? data : []);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [authHeaders]);

  useEffect(() => {
    if (railOpen) void fetchConversations();
  }, [railOpen, fetchConversations]);

  const loadConversation = useCallback(async (conversationId: string) => {
    clearChatSession();
    setActiveConversation(conversationId);
    setChatSession(conversationId);
    try {
      const res = await fetch(
        `${config.apiBaseUrl}/api/clio/conversations/${conversationId}/messages`,
        { headers: await authHeaders() },
      );
      if (res.ok) {
        const msgs = await res.json();
        if (Array.isArray(msgs)) {
          for (const m of msgs) {
            // Persisted attachment chips live in metadata.attachments
            // as [{ id, filename, kind, status }].
            const rawAttachments = Array.isArray(m?.metadata?.attachments)
              ? m.metadata.attachments
              : null;
            const attachments = rawAttachments
              ? rawAttachments
                  .filter(
                    (a: unknown): a is Record<string, unknown> =>
                      Boolean(a) && typeof a === 'object',
                  )
                  .map((a: Record<string, unknown>) => ({
                    id: String(a.id ?? ''),
                    filename: String(a.filename ?? ''),
                    kind: String(a.kind ?? 'text'),
                    status: String(a.status ?? 'parsed'),
                  }))
                  .filter((a: { id: string }) => Boolean(a.id))
              : [];
            // Persisted analysis charts (F4) ride on each message's artifacts
            // relation as rows with { id, title, kind: 'analysis_chart' };
            // the inline card fetches the PNG body by id.
            const rawArtifacts = Array.isArray(m?.artifacts) ? m.artifacts : null;
            const chartArtifacts = rawArtifacts
              ? rawArtifacts
                  .filter(
                    (a: unknown): a is Record<string, unknown> =>
                      Boolean(a) && typeof a === 'object',
                  )
                  .filter(
                    (a: Record<string, unknown>) => a.kind === 'analysis_chart' && Boolean(a.id),
                  )
                  .map((a: Record<string, unknown>) => ({
                    id: String(a.id),
                    title: String(a.title ?? '').trim() || 'Analysis chart',
                  }))
              : [];
            appendChatMessage({
              id: m.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
              role: m.role === 'user' ? 'user' : 'assistant',
              content: m.body || '',
              createdAt: new Date(m.createdAt),
              ...(attachments.length > 0 ? { attachments } : {}),
              ...(chartArtifacts.length > 0 ? { chartArtifacts } : {}),
            });
          }
        }
      }
    } catch { /* ignore */ }
  }, [authHeaders]);

  const archiveConversation = useCallback(async (conversationId: string) => {
    try {
      const res = await fetch(`${config.apiBaseUrl}/api/clio/conversations/${conversationId}/archive`, {
        method: 'PATCH',
        headers: await authHeaders(),
      });
      if (res.ok) {
        removeConversation(conversationId);
      }
    } catch {
      // ignore
    }
  }, [authHeaders]);

  if (!railOpen) return null;

  // Group conversations by client
  const groups: ClientGroup[] = [];
  const clientMap = new Map<string, ClientGroup>();

  for (const conv of conversations) {
    const key = conv.clientId || '__general__';
    let group = clientMap.get(key);
    if (!group) {
      group = {
        clientId: conv.clientId,
        clientName: conv.client?.name || 'General',
        conversations: [],
      };
      clientMap.set(key, group);
      groups.push(group);
    }
    group.conversations.push(conv);
  }

  const toggleClient = (key: string) => {
    setExpandedClients((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const searchResults = search.data ?? [];

  return (
    <div className="meri-session-rail">
      <div className="meri-rail-search">
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined className="meri-rail-search-icon" />}
          placeholder="Search conversations..."
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          aria-label="Search conversation history"
        />
      </div>
      {searchActive ? (
        <div className="meri-rail-search-results" aria-label="Search results">
          {search.isLoading && <div className="meri-rail-loading">Searching...</div>}
          {!search.isLoading && searchResults.length === 0 && (
            <div className="meri-rail-empty">No conversations match.</div>
          )}
          {searchResults.map((hit) => (
            <button
              key={hit.conversationId}
              type="button"
              className={`meri-rail-search-result${
                hit.conversationId === activeConversationId
                  ? ' meri-rail-search-result--active'
                  : ''
              }`}
              onClick={() => void loadConversation(hit.conversationId)}
            >
              <MessageOutlined className="meri-rail-item-icon" />
              <span className="meri-rail-search-result-content">
                <span className="meri-rail-search-result-title">{hit.title}</span>
                {hit.snippet ? (
                  <span className="meri-rail-search-result-snippet">{hit.snippet}</span>
                ) : null}
              </span>
              <span className="meri-rail-item-time">{relativeTime(hit.createdAt)}</span>
            </button>
          ))}
        </div>
      ) : null}
      {!searchActive && loading && (
        <div className="meri-rail-loading">Loading conversations...</div>
      )}
      {!searchActive && !loading && groups.length === 0 && (
        <div className="meri-rail-empty">No conversations yet. Start chatting!</div>
      )}
      {!searchActive &&
        groups.map((group) => {
          const key = group.clientId || '__general__';
          const isExpanded = expandedClients.has(key);
          return (
            <div key={key} className="meri-rail-group">
              <button
                type="button"
                className="meri-rail-group-header"
                onClick={() => toggleClient(key)}
              >
                <span className="meri-rail-group-icon">
                  {isExpanded ? <DownOutlined /> : <RightOutlined />}
                </span>
                <UserOutlined style={{ marginRight: 6, opacity: 0.5 }} />
                <span className="meri-rail-group-name">{group.clientName}</span>
                <span className="meri-rail-group-count">{group.conversations.length}</span>
              </button>
              {isExpanded && (
                <div className="meri-rail-group-items">
                  {group.conversations.map((conv) => (
                    <div
                      key={conv.id}
                      className={`meri-rail-item${conv.id === activeConversationId ? ' meri-rail-item--active' : ''}`}
                    >
                      <button
                        type="button"
                        className="meri-rail-item-main"
                        onClick={() => void loadConversation(conv.id)}
                      >
                        <MessageOutlined className="meri-rail-item-icon" />
                        <div className="meri-rail-item-content">
                          <div className="meri-rail-item-title">{conv.title}</div>
                          {conv.latestMessage && (
                            <div className="meri-rail-item-snippet">
                              {conv.latestMessage.body.slice(0, 60)}
                              {conv.latestMessage.body.length > 60 ? '...' : ''}
                            </div>
                          )}
                        </div>
                        <span className="meri-rail-item-time">
                          {relativeTime(conv.updatedAt)}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="meri-rail-item-archive"
                        title="Archive conversation"
                        aria-label={`Archive ${conv.title}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          void archiveConversation(conv.id);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}
