import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { useChatStore } from '../../components/chat/chat-store.js';
import { useApi } from '../../lib/use-api.js';
import { MeriIcon, type MeriIconName } from './meri-icons.js';
import { displayThreadTitle } from './meri-presentation.js';

/**
 * MeriCommandPalette — full-surface ⌘K palette over the user's own threads and
 * clients. Pixel-parity port of the design prototype's `paletteOpen` overlay.
 *
 * Threads come from the loaded conversation list, message hits from the same
 * `/api/clio/conversations/search` endpoint the thread rail uses, and clients
 * from the controller's client list. Nothing here is synthesised: an empty
 * result set renders the empty state rather than placeholder rows.
 */

const MONO = "var(--meri-font-mono, 'IBM Plex Mono', monospace)";

type PaletteResultKind = 'THREAD' | 'MESSAGE' | 'CLIENT';

interface PaletteResult {
  key: string;
  icon: MeriIconName;
  title: string;
  sub: string;
  kind: PaletteResultKind;
  conversationId?: string;
  clientId?: string;
}

interface HistorySearchResult {
  conversationId: string;
  title: string;
  clientId: string | null;
  messageId: string;
  snippet: string;
  createdAt: string;
  score: number | null;
}

interface MeriCommandPaletteProps {
  controller: MeriChatController;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenThread: (conversationId: string) => void;
  onSelectClient: (clientId: string) => void;
}

export function MeriCommandPalette({
  controller,
  open,
  onOpenChange,
  onOpenThread,
  onSelectClient,
}: MeriCommandPaletteProps) {
  const api = useApi();
  const { conversations } = useChatStore();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQuery(query.trim()), 200);
    return () => window.clearTimeout(handle);
  }, [query]);

  const searchActive = open && debouncedQuery.length >= 2;
  const messageSearch = useQuery<HistorySearchResult[]>({
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

  // ⌘K / Ctrl+K opens; Escape closes. Registered for the whole workspace while
  // the palette is mounted.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        onOpenChange(!open);
        return;
      }
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        onOpenChange(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange]);

  // Autofocus + reset the query each time the palette opens.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHoveredKey(null);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const results = useMemo<PaletteResult[]>(() => {
    const q = debouncedQuery.toLowerCase();
    const threadRows: PaletteResult[] = [...conversations]
      .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
      .filter((conversation) => {
        if (!q) return true;
        return [
          displayThreadTitle(conversation.title, conversation.latestMessage?.body),
          conversation.client?.name ?? '',
          conversation.latestMessage?.body ?? '',
        ].some((value) => value.toLowerCase().includes(q));
      })
      .slice(0, 8)
      .map((conversation) => ({
        key: `thread:${conversation.id}`,
        icon: 'MessageTextSquare01',
        title: displayThreadTitle(conversation.title, conversation.latestMessage?.body),
        sub: conversation.client?.name ?? 'All clients · Portfolio',
        kind: 'THREAD',
        conversationId: conversation.id,
      }));

    const knownIds = new Set(conversations.map((conversation) => conversation.id));
    const messageRows: PaletteResult[] = (searchActive ? (messageSearch.data ?? []) : [])
      .filter((hit) => !knownIds.has(hit.conversationId) || hit.snippet)
      .slice(0, 8)
      .map((hit) => ({
        key: `message:${hit.messageId}`,
        icon: 'SearchLg',
        title: hit.snippet || displayThreadTitle(hit.title, hit.snippet),
        sub: displayThreadTitle(hit.title, hit.snippet),
        kind: 'MESSAGE',
        conversationId: hit.conversationId,
      }));

    const clientRows: PaletteResult[] = (q ? controller.clients : [])
      .filter((client) => client.name.toLowerCase().includes(q))
      .slice(0, 5)
      .map((client) => ({
        key: `client:${client.id}`,
        icon: 'Building01',
        title: client.name,
        sub: 'Set conversation scope to this client',
        kind: 'CLIENT',
        clientId: client.id,
      }));

    return [...threadRows, ...messageRows, ...clientRows];
  }, [conversations, controller.clients, debouncedQuery, messageSearch.data, searchActive]);

  if (!open) return null;

  const pick = (result: PaletteResult) => {
    onOpenChange(false);
    if (result.conversationId) {
      onOpenThread(result.conversationId);
      return;
    }
    if (result.clientId) onSelectClient(result.clientId);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(12,17,29,.55)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 96,
        zIndex: 80,
        animation: 'vnext-meri-rise .12s ease',
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <div
        role="dialog"
        aria-label="Command palette"
        style={{
          width: 640,
          maxWidth: 'calc(100% - 48px)',
          borderRadius: 14,
          background: '#ffffff',
          boxShadow: '0px 24px 48px -12px rgba(16,24,40,.3)',
          overflow: 'hidden',
          animation: 'vnext-meri-rise .16s ease',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 11,
            padding: '14px 16px',
            borderBottom: '1px solid #E8E5DF',
          }}
        >
          <MeriIcon name="SearchLg" size={17} color="#98A2B3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search threads, messages, context, sources and actions…"
            aria-label="Search threads, messages, context, sources and actions"
            style={{
              flex: 1,
              minWidth: 0,
              background: 'none',
              border: 0,
              outline: 'none',
              fontSize: 15,
              color: '#101828',
            }}
          />
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            style={{
              fontFamily: MONO,
              fontSize: 10,
              fontWeight: 500,
              letterSpacing: '.09em',
              color: '#667085',
            }}
          >
            ESC
          </button>
        </div>
        <div style={{ maxHeight: 400, overflowY: 'auto', padding: 8 }}>
          {results.length === 0 ? (
            <div
              role="status"
              style={{
                margin: 6,
                padding: '16px 14px',
                borderRadius: 10,
                background: '#FAF9F6',
                border: '1px solid #E8E5DF',
                fontSize: 13,
                lineHeight: '19px',
                color: '#475467',
              }}
            >
              {messageSearch.isFetching
                ? 'Searching…'
                : debouncedQuery
                  ? `Nothing matches “${debouncedQuery}”.`
                  : 'No threads yet. Ask Meri something to start one.'}
            </div>
          ) : null}
          {results.map((result) => (
            <button
              type="button"
              key={result.key}
              onClick={() => pick(result)}
              onMouseEnter={() => setHoveredKey(result.key)}
              onMouseLeave={() => setHoveredKey(null)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 11,
                width: '100%',
                padding: '10px 12px',
                borderRadius: 8,
                background: hoveredKey === result.key ? '#FAF9F6' : 'transparent',
              }}
            >
              <span
                style={{
                  flex: '0 0 auto',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 26,
                  height: 26,
                  borderRadius: 7,
                  background: '#F2F0EB',
                }}
              >
                <MeriIcon name={result.icon} size={13} color="#101828" />
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                <span
                  style={{
                    fontSize: 13.5,
                    lineHeight: '19px',
                    color: '#101828',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {result.title}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    lineHeight: '17px',
                    color: '#667085',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {result.sub}
                </span>
              </span>
              <span
                style={{
                  flex: '0 0 auto',
                  fontFamily: MONO,
                  fontSize: 9,
                  fontWeight: 500,
                  letterSpacing: '.08em',
                  color: '#667085',
                }}
              >
                {result.kind}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
