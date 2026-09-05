import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { useChatStore } from '../../components/chat/chat-store.js';
import { useApi } from '../../lib/use-api.js';
import { MeriIcon } from './meri-icons.js';
import { displayThreadTitle } from './meri-presentation.js';

/**
 * MeriCommandPalette — full-surface ⌘K palette over the user's own threads and
 * clients. Pixel-parity port of the v6 prototype's `palOpen` shadcn `Command`
 * overlay (`onPalKey`/`vOverlays` in the dc script): a THREADS group, an
 * optional separator, a CLIENTS · CHANGE SCOPE group, an empty state and a
 * footer hint row — one continuous highlighted index spans both groups.
 *
 * Threads come from the loaded conversation list, message hits from the same
 * `/api/clio/conversations/search` endpoint the thread rail uses (merged into
 * the THREADS group — the prototype has no separate message tier), and
 * clients from the controller's client list. Nothing here is synthesised: an
 * empty result set renders the empty state rather than placeholder rows.
 */

interface PaletteThreadRow {
  key: string;
  title: string;
  sub: string;
  conversationId: string;
}

interface PaletteClientRow {
  key: string;
  name: string;
  clientId: string;
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
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQuery(query.trim()), 200);
    return () => window.clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [debouncedQuery]);

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
    setActiveIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  // THREADS group — up to 5, matching the prototype's `palT` slice. Message
  // hits from conversations not already loaded are merged in by snippet, same
  // as the thread rail's own search merge.
  const threadRows = useMemo<PaletteThreadRow[]>(() => {
    const q = debouncedQuery.toLowerCase();
    const known = [...conversations]
      .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
      .filter((conversation) => {
        if (!q) return true;
        return [
          displayThreadTitle(conversation.title, conversation.latestMessage?.body),
          conversation.client?.name ?? '',
          conversation.latestMessage?.body ?? '',
        ].some((value) => value.toLowerCase().includes(q));
      })
      .map((conversation) => ({
        key: `thread:${conversation.id}`,
        title: displayThreadTitle(conversation.title, conversation.latestMessage?.body),
        sub: conversation.client?.name ?? 'All clients',
        conversationId: conversation.id,
      }));

    const knownIds = new Set(conversations.map((conversation) => conversation.id));
    const messageRows = (searchActive ? (messageSearch.data ?? []) : [])
      .filter((hit) => !knownIds.has(hit.conversationId))
      .map((hit) => ({
        key: `message:${hit.messageId}`,
        title: displayThreadTitle(hit.title, hit.snippet),
        sub: hit.snippet || 'All clients',
        conversationId: hit.conversationId,
      }));

    return [...known, ...messageRows].slice(0, 5);
  }, [conversations, debouncedQuery, messageSearch.data, searchActive]);

  // CLIENTS · CHANGE SCOPE group — up to 4, matching the prototype's `palC`.
  const clientRows = useMemo<PaletteClientRow[]>(() => {
    const q = debouncedQuery.toLowerCase();
    return controller.clients
      .filter((client) => !q || client.name.toLowerCase().includes(q))
      .slice(0, 4)
      .map((client) => ({ key: `client:${client.id}`, name: client.name, clientId: client.id }));
  }, [controller.clients, debouncedQuery]);

  const itemCount = threadRows.length + clientRows.length;
  const clampedIndex = itemCount ? Math.min(activeIndex, itemCount - 1) : 0;

  const runIndex = (index: number) => {
    onOpenChange(false);
    if (index < threadRows.length) {
      const thread = threadRows[index];
      if (thread) onOpenThread(thread.conversationId);
      return;
    }
    const client = clientRows[index - threadRows.length];
    if (client) onSelectClient(client.clientId);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!itemCount) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => (Math.min(current, itemCount - 1) + 1) % itemCount);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => (Math.min(current, itemCount - 1) - 1 + itemCount) % itemCount);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(itemCount - 1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      runIndex(clampedIndex);
    }
  };

  if (!open) return null;

  const activeDomId = `meri-cmd-${clampedIndex}`;
  const isEmpty = itemCount === 0;

  return (
    <div
      className="vnext-meri__palette-scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="vnext-meri__palette-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="vnext-meri__palette-header">
          <MeriIcon name="SearchLg" size={17} color="#98A2B3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search threads and clients…"
            role="combobox"
            aria-expanded="true"
            aria-controls="meri-command-list"
            aria-activedescendant={activeDomId}
            aria-label="Search threads and clients"
            className="vnext-meri__palette-input"
          />
          <button type="button" onClick={() => onOpenChange(false)} className="vnext-meri__palette-esc">
            ESC
          </button>
        </div>
        <div
          id="meri-command-list"
          role="listbox"
          aria-label="Threads and clients"
          className="vnext-meri__palette-body"
        >
          {isEmpty ? (
            <div role="status" className="vnext-meri__palette-empty">
              {messageSearch.isFetching
                ? 'Searching…'
                : debouncedQuery
                  ? `Nothing matches "${debouncedQuery}".`
                  : 'No threads yet. Ask Meri something to start one.'}
            </div>
          ) : null}
          {threadRows.length > 0 ? (
            <div role="group" aria-labelledby="meri-cmd-threads">
              <div id="meri-cmd-threads" className="vnext-meri__palette-group-heading">
                THREADS
              </div>
              {threadRows.map((row, index) => (
                <button
                  type="button"
                  key={row.key}
                  id={`meri-cmd-${index}`}
                  role="option"
                  aria-selected={index === clampedIndex}
                  onClick={() => runIndex(index)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`vnext-meri__palette-row${index === clampedIndex ? ' is-active' : ''}`}
                >
                  <MeriIcon name="MessageTextSquare01" size={15} color="#98A2B3" />
                  <span className="vnext-meri__palette-row-title">{row.title}</span>
                  <span className="vnext-meri__palette-row-sub">{row.sub}</span>
                </button>
              ))}
            </div>
          ) : null}
          {threadRows.length > 0 && clientRows.length > 0 ? (
            <div className="vnext-meri__palette-separator" />
          ) : null}
          {clientRows.length > 0 ? (
            <div role="group" aria-labelledby="meri-cmd-clients">
              <div id="meri-cmd-clients" className="vnext-meri__palette-group-heading">
                CLIENTS · CHANGE SCOPE
              </div>
              {clientRows.map((row, offset) => {
                const index = threadRows.length + offset;
                return (
                  <button
                    type="button"
                    key={row.key}
                    id={`meri-cmd-${index}`}
                    role="option"
                    aria-selected={index === clampedIndex}
                    onClick={() => runIndex(index)}
                    onMouseEnter={() => setActiveIndex(index)}
                    className={`vnext-meri__palette-row${index === clampedIndex ? ' is-active' : ''}`}
                  >
                    <MeriIcon name="Building01" size={15} color="#98A2B3" />
                    <span className="vnext-meri__palette-row-title">{row.name}</span>
                    <span className="vnext-meri__palette-row-set-scope">SET SCOPE</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        <div className="vnext-meri__palette-footer">
          <span>↑↓ NAVIGATE</span>
          <span>↵ OPEN</span>
          <span>ESC CLOSE</span>
        </div>
      </div>
    </div>
  );
}
