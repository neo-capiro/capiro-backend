import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  removeConversation,
  getChatStateSnapshot,
  upsertConversation,
  useChatStore,
  type MeriConversation,
} from '../../components/chat/chat-store.js';
import {
  mayApplyIdentityResult,
  meriEffectiveIdentityKey,
} from '../../components/chat/meri-route-guards.js';
import { useApi } from '../../lib/use-api.js';
import { useImpersonation } from '../../state/impersonation.js';
import { useCapiroToast } from '../components/feedback/toast.js';
import { CapiroErrorState, CapiroSkeleton } from '../components/feedback/index.js';
import { CapiroModal } from '../components/overlays/index.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { MeriIcon } from './meri-icons.js';
import {
  createMeriWorkspace,
  assignMeriConversationWorkspace,
  deleteMeriWorkspace,
  listMeriWorkspaces,
} from './meri-vnext-api.js';
import {
  displayThreadTitle,
  railRelativeTime,
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

/** Per-row title/meta placeholder widths for the loading skeleton — varied so
 *  a run of rows doesn't read as one repeated block. Matches the v5 mockup's
 *  four-row pattern (`Capiro Meri v5 - Workspace.dc.html`, `skeletons` array). */
const SKELETON_ROW_WIDTHS: ReadonlyArray<readonly [string, string]> = [
  ['72%', '54%'],
  ['58%', '66%'],
  ['80%', '44%'],
  ['64%', '58%'],
];

function threadRowScope(conversation: MeriConversation): string {
  // v6 second line, leading segment: the recorded client name verbatim, or
  // "All clients" for portfolio threads.
  return conversation.client?.name?.trim() || 'All clients';
}

function workspaceError(reason: unknown): string {
  const error = reason as { response?: { data?: { message?: unknown } }; message?: string };
  const message = error?.response?.data?.message;
  return typeof message === 'string' ? message : error?.message || 'The workspace change could not be saved. Try again.';
}

interface VNextMeriThreadRailProps {
  controller: MeriChatController;
  historyError: string | null;
  onRetryHistory: () => void;
  onArchiveThread: (conversationId: string) => Promise<boolean>;
  onRenameThread: (conversationId: string, title: string) => Promise<void>;
  onRestoreThread: (conversationId: string) => Promise<boolean>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  searchInputRef: { current: HTMLInputElement | null };
  /** Hides the rail; the conversation header then shows the expand toggle. */
  onCollapse: () => void;
  onOpenPalette: () => void;
}

export function VNextMeriThreadRail({
  controller,
  historyError,
  onRetryHistory,
  onArchiveThread,
  onRenameThread,
  onRestoreThread,
  searchQuery,
  onSearchQueryChange,
  searchInputRef,
  onCollapse,
  onOpenPalette,
}: VNextMeriThreadRailProps) {
  const navigate = useNavigate();
  const api = useApi();
  const { orgId, userId } = useAuth();
  const { actAsTenantSlug } = useImpersonation();
  const queryClient = useQueryClient();
  const identityKey = meriEffectiveIdentityKey(actAsTenantSlug, orgId, userId);
  const toast = useCapiroToast();
  const { conversations, activeConversationId } = useChatStore();
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirmFor, setConfirmFor] = useState<MeriConversation | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [undoTarget, setUndoTarget] = useState<MeriConversation | null>(null);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [newWorkspaceClient, setNewWorkspaceClient] = useState('');
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<MeriConversation | null>(null);
  const [assignmentValue, setAssignmentValue] = useState('');
  const [workspaceSaving, setWorkspaceSaving] = useState(false);
  const [workspaceFailure, setWorkspaceFailure] = useState<string | null>(null);
  const workspaceMutationRef = useRef<AbortController | null>(null);
  const identityKeyRef = useRef(identityKey);
  identityKeyRef.current = identityKey;
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

  const previousIdentityKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const previousIdentityKey = previousIdentityKeyRef.current;
    if (previousIdentityKey === identityKey) return;
    previousIdentityKeyRef.current = identityKey;
    // Search must retain its canonical key, so remove stale results rather than
    // adding identity to it. Reset every local dialog/selection that can retain
    // a prior tenant's title or workspace choice before the rail paints.
    queryClient.removeQueries({ queryKey: ['meri-conversation-search'] });
    // Evict by predicate rather than by the previous key: the route remounts
    // this rail on an identity change, so `previousIdentityKey` is null exactly
    // when another tenant's library cache is the thing still sitting in memory.
    queryClient.removeQueries({
      predicate: (query) =>
        Array.isArray(query.queryKey) &&
        query.queryKey[0] === 'meri-vnext' &&
        query.queryKey[1] !== identityKey,
    });
    setDebouncedQuery('');
    setMenuFor(null);
    setConfirmFor(null);
    setRenaming(null);
    setUndoTarget(null);
    setWorkspaceDialogOpen(false);
    setNewWorkspaceName('');
    setNewWorkspaceClient('');
    setSelectedWorkspaceId(null);
    setAssigning(null);
    setWorkspaceFailure(null);
    workspaceMutationRef.current?.abort();
    workspaceMutationRef.current = null;
    setWorkspaceSaving(false);
  }, [identityKey, queryClient]);

  useEffect(() => () => workspaceMutationRef.current?.abort(), []);

  const workspaces = useQuery({
    queryKey: ['meri-vnext', identityKey, 'workspaces'],
    queryFn: () => listMeriWorkspaces(api),
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

  /**
   * v6 RECENT rows always carry the latest-message excerpt as the second
   * line's trailing segment. While a search query is active, server hits
   * carry their own matched excerpt; rows matched only locally fall back to
   * the conversation's latest message body, which is the same text the local
   * filter matched against.
   */
  const snippets = useMemo(() => {
    const map = new Map<string, string>();
    const query = searchQuery.trim();
    if (query) {
      for (const hit of search.data ?? []) {
        if (hit.snippet?.trim()) map.set(hit.conversationId, hit.snippet.trim());
      }
    }
    for (const conversation of conversations) {
      if (map.has(conversation.id)) continue;
      const body = conversation.latestMessage?.body?.trim();
      if (body) map.set(conversation.id, body);
    }
    return map;
  }, [conversations, search.data, searchQuery]);

  /**
   * v6 RECENT is one continuous, recency-sorted list (no TODAY/EARLIER
   * group headers). Active search keeps its RESULTS group. Workspace
   * filtering still applies on top.
   */
  const groups = useMemo(() => {
    const scoped = selectedWorkspaceId ? visible.filter((item) => item.workspaceId === selectedWorkspaceId) : visible;
    if (searchQuery.trim()) return [{ label: 'RESULTS', items: scoped }];
    return [{ label: 'RECENT', items: scoped }];
  }, [searchQuery, visible, selectedWorkspaceId]);
  const visibleCount = groups.reduce((sum, group) => sum + group.items.length, 0);
  const selectedWorkspace = workspaces.data?.find((item) => item.id === selectedWorkspaceId);
  const assignmentTarget = assigning ? conversations.find((item) => item.id === assigning.id) ?? assigning : null;
  const assignmentWorkspace = workspaces.data?.find((item) => item.id === assignmentValue);
  const incompatible = Boolean(assignmentWorkspace?.clientId && assignmentWorkspace.clientId !== assignmentTarget?.clientId);

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

  const invalidateLibrary = () => {
    void queryClient.invalidateQueries({ queryKey: ['meri-vnext', identityKey, 'workspaces'] });
  };

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
      const archived = await onArchiveThread(target.id);
      if (!archived) return;
      setUndoTarget(target);
      invalidateLibrary();
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

  const createWorkspace = async () => {
    const name = newWorkspaceName.trim();
    if (!name || workspaceMutationRef.current) return;
    const request = new AbortController();
    workspaceMutationRef.current = request;
    const requestIdentity = identityKey;
    setWorkspaceSaving(true); setWorkspaceFailure(null);
    try {
      await createMeriWorkspace(api, { name, clientId: newWorkspaceClient || null }, request.signal);
      if (request.signal.aborted || !mayApplyIdentityResult(requestIdentity, identityKeyRef.current)) return;
      setNewWorkspaceName('');
      setWorkspaceDialogOpen(false);
      invalidateLibrary();
      toast.success('Workspace created.');
    } catch (reason) {
      if (!request.signal.aborted && mayApplyIdentityResult(requestIdentity, identityKeyRef.current)) setWorkspaceFailure(workspaceError(reason));
    } finally {
      if (workspaceMutationRef.current === request) { workspaceMutationRef.current = null; setWorkspaceSaving(false); }
    }
  };

  const assignWorkspace = async (target: MeriConversation, workspaceId: string | null) => {
    if (workspaceMutationRef.current) return;
    const request = new AbortController();
    workspaceMutationRef.current = request;
    const requestIdentity = identityKey;
    setWorkspaceSaving(true); setWorkspaceFailure(null);
    try {
      const result = await assignMeriConversationWorkspace(api, target.id, workspaceId, request.signal);
      if (request.signal.aborted || !mayApplyIdentityResult(requestIdentity, identityKeyRef.current)) return;
      const current = getChatStateSnapshot().conversations.find((item) => item.id === target.id);
      const workspace = workspaces.data?.find((item) => item.id === result.workspaceId);
      if (current) upsertConversation({ ...current, workspaceId: result.workspaceId,
        workspace: workspace ? { id: workspace.id, name: workspace.name, clientId: workspace.clientId } : null });
      setAssigning(null); setMenuFor(null);
      invalidateLibrary(); onRetryHistory();
      toast.success(result.workspaceId ? 'Chat moved to workspace.' : 'Chat removed from workspace.');
    } catch (reason) {
      if (!request.signal.aborted && mayApplyIdentityResult(requestIdentity, identityKeyRef.current)) setWorkspaceFailure(workspaceError(reason));
    } finally {
      if (workspaceMutationRef.current === request) { workspaceMutationRef.current = null; setWorkspaceSaving(false); }
    }
  };

  const removeWorkspace = async (workspaceId: string) => {
    if (workspaceMutationRef.current) return;
    const request = new AbortController();
    workspaceMutationRef.current = request;
    const requestIdentity = identityKey;
    setWorkspaceSaving(true); setWorkspaceFailure(null);
    try {
      await deleteMeriWorkspace(api, workspaceId, request.signal);
      if (request.signal.aborted || !mayApplyIdentityResult(requestIdentity, identityKeyRef.current)) return;
      for (const row of getChatStateSnapshot().conversations) {
        if (row.workspaceId === workspaceId) upsertConversation({ ...row, workspaceId: null, workspace: null });
      }
      if (selectedWorkspaceId === workspaceId) setSelectedWorkspaceId(null);
      invalidateLibrary(); onRetryHistory();
    } catch (reason) {
      if (!request.signal.aborted && mayApplyIdentityResult(requestIdentity, identityKeyRef.current)) setWorkspaceFailure(workspaceError(reason));
    } finally {
      if (workspaceMutationRef.current === request) { workspaceMutationRef.current = null; setWorkspaceSaving(false); }
    }
  };

  return (
    <aside className="vnext-meri__rail-left" data-meri-thread-rail aria-label="Meri conversations">
      {/* v6 prototype: no reserved top row — the rail starts directly with
          WORKSPACES. The collapse control lives inside the section label row
          (handoff §"Three-column collapse rules" #2 still requires it to be
          reachable; the conversation header shows the expand toggle while
          collapsed). */}
      <div className="vnext-meri__rail-left-scroll">
        <section data-meri-rail-section="workspaces">
          <div className="vnext-meri__section-label-row">
            <span className="vnext-meri__section-label">WORKSPACES</span>
            <span className="vnext-meri__section-label-actions">
              <button
                type="button"
                className="vnext-meri__icon-btn vnext-meri__icon-btn--tiny"
                aria-label="Add workspace"
                title="Add workspace"
                disabled={workspaceSaving}
                onClick={() => { setWorkspaceFailure(null); setNewWorkspaceClient(controller.selectedClientValue || ''); setWorkspaceDialogOpen(true); }}
              >
                <MeriIcon name="Plus" size={13} color="#98A2B3" />
              </button>
              <button
                type="button"
                className="vnext-meri__icon-btn vnext-meri__icon-btn--tiny vnext-meri__rail-collapse-inline"
                aria-label="Hide thread rail"
                title="Hide thread rail"
                onClick={onCollapse}
              >
                <MeriIcon name="Menu02" size={13} color="#98A2B3" />
              </button>
            </span>
          </div>
          {workspaces.isLoading ? (
            <div className="vnext-meri__section-empty-body">Loading workspaces…</div>
          ) : workspaces.isError ? (
            <CapiroErrorState title="Workspaces could not be loaded" onRetry={() => void workspaces.refetch()} />
          ) : workspaces.data?.length ? (
            <div className="vnext-meri__workspace-list" role="list" aria-label="Meri workspaces">
              {workspaces.data.map((workspace) => {
                const threadCount = workspace.threadCount ?? conversations.filter(
                  (conversation) => conversation.workspaceId === workspace.id,
                ).length;
                const clientName = workspace.clientId
                  ? (controller.clients.find((client) => client.id === workspace.clientId)?.name ?? 'Client')
                  : null;
                const meta = `${clientName ?? 'All clients'} · ${threadCount} ${
                  threadCount === 1 ? 'thread' : 'threads'
                }`;
                return (
                  <div key={workspace.id} className="vnext-meri__workspace-row">
                    <button
                      type="button"
                      className="vnext-meri__workspace-item"
                      aria-label={`${workspace.name} ${meta}`}
                      aria-pressed={selectedWorkspaceId === workspace.id}
                      onClick={() => {
                        setSelectedWorkspaceId(workspace.id);
                        onSearchQueryChange('');
                      }}
                    >
                      <span className="vnext-meri__workspace-tile">
                        <MeriIcon
                          name={clientName ? 'Building01' : 'LayersThree01'}
                          size={15}
                          color="#98A2B3"
                        />
                      </span>
                      <span className="vnext-meri__workspace-body">
                        <span className="vnext-meri__workspace-name">{workspace.name}</span>
                        <span className="vnext-meri__workspace-kind">{meta}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="vnext-meri__workspace-delete"
                      aria-label={`Delete workspace ${workspace.name}`}
                      disabled={workspaceSaving}
                      onClick={() => void removeWorkspace(workspace.id)}
                    >
                      <MeriIcon name="Trash01" size={14} color="#98A2B3" />
                    </button>
                  </div>
                );
                })}
                {/* v6 reference: "No workspace" row beneath the workspace
                    list — moves the ACTIVE thread out of its workspace using
                    the existing unassign path (assignWorkspace(conversation,
                    null)), the same action the overflow dialog already
                    exposes. Disabled when there is no active thread, the
                    thread has no workspace, or a mutation is in flight. */}
                {!workspaces.isLoading && !workspaces.isError ? (
                  <NoWorkspaceRow
                    disabled={
                      workspaceSaving ||
                      !activeConversationId ||
                      !conversations.find((item) => item.id === activeConversationId)?.workspaceId
                    }
                    onClear={() => {
                      const active = conversations.find((item) => item.id === activeConversationId);
                      if (active) void assignWorkspace(active, null);
                    }}
                  />
                ) : null}
              </div>
            ) : (
                <div className="vnext-meri__section-empty">
                <div className="vnext-meri__section-empty-label">NO WORKSPACES YET</div>
                <div className="vnext-meri__section-empty-body">
                Create a workspace, then organize chats through their overflow menu.
              </div>
            </div>
          )}
          {workspaceFailure && !workspaceDialogOpen && !assigning ? <p role="alert" className="vnext-meri__section-empty-body">{workspaceFailure}</p> : null}
        </section>

        <section data-meri-rail-section="recent">
          <div className="vnext-meri__section-label-row">
            <span className="vnext-meri__section-label">{selectedWorkspace?.name ?? 'RECENT'}</span>
            {selectedWorkspaceId ? <button type="button" className="vnext-meri__search-everything" onClick={() => setSelectedWorkspaceId(null)}>All chats</button> : null}
          </div>

          <div className="vnext-meri__rail-search" data-meri-rail-search>
            <MeriIcon name="SearchLg" size={14} color="#98A2B3" />
            <input
              ref={searchInputRef}
              type="search"
              value={searchQuery}
              onChange={(event) => onSearchQueryChange(event.target.value)}
              onKeyDown={handleSearchKey}
              placeholder="Search chats and messages…"
              aria-label="Search chats and messages"
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
            <CapiroErrorState
              title="History unavailable"
              description={historyError}
              onRetry={onRetryHistory}
              retryLabel="Retry"
            />
          ) : searchActive && search.isLoading ? (
            <div className="vnext-meri__thread-skeleton-list" aria-label="Loading threads">
              {SKELETON_ROW_WIDTHS.map(([w1, w2], index) => (
                <div key={index} className="vnext-meri__thread-skeleton">
                  <CapiroSkeleton height={9} width={w1} />
                  <CapiroSkeleton height={8} width={w2} />
                </div>
              ))}
            </div>
          ) : visibleCount === 0 && searchQuery.trim() ? (
            <div className="vnext-meri__thread-empty">
              <div className="vnext-meri__thread-empty-body">No chats match “{searchQuery.trim()}”.</div>
              <button type="button" className="vnext-meri__search-everything" onClick={onOpenPalette}>
                SEARCH EVERYTHING ⌘K
              </button>
            </div>
          ) : visibleCount === 0 ? (
            <div className="vnext-meri__thread-empty">
              <div className="vnext-meri__thread-empty-label">NO THREADS YET</div>
              <div className="vnext-meri__thread-empty-body">
                {selectedWorkspaceId ? 'This workspace has no active chats. Choose All chats, then use a chat’s options to add it here.' : 'Ask Meri something, use a saved prompt, or create a workspace for your related chats.'}
              </div>
            </div>
          ) : (
            <div className="vnext-meri__thread-list">
              {groups.map((group, groupIndex) => (
                <div key={group.label}>
                  {group.label !== 'RECENT' ? (
                    <div className={`vnext-meri__thread-group-label${groupIndex === 0 ? ' is-first' : ''}`}>
                      {group.label}
                    </div>
                  ) : null}
                  {group.items.map((conversation) => {
                    const active = conversation.id === activeConversationId;
                    const title = displayThreadTitle(conversation.title, conversation.latestMessage?.body);
                    const snippet = snippets.get(conversation.id);
                    const stamp = railRelativeTime(conversation.updatedAt);
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
                              onChange={(event) => setRenaming({ id: conversation.id, value: event.target.value })}
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
                            <span className="vnext-meri__thread-item-body">
                              <span className="vnext-meri__thread-item-line">
                                <span className="vnext-meri__thread-item-title">{title}</span>
                                {stamp ? (
                                  <span className="vnext-meri__thread-item-time">{stamp}</span>
                                ) : null}
                              </span>
                              <span className="vnext-meri__thread-item-sub">
                                <span className="vnext-meri__thread-item-scope">
                                  {threadRowScope(conversation)}
                                </span>
                                {snippet ? (
                                  <span className="vnext-meri__thread-item-snippet">{snippet}</span>
                                ) : null}
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
                            setMenuFor((current) => (current === conversation.id ? null : conversation.id));
                          }}
                        >
                          <MeriIcon name="DotsVertical" size={15} color="#98A2B3" />
                        </button>
                        {menuFor === conversation.id ? (
                          <div ref={menuRef} className="vnext-meri__row-menu" role="menu" aria-label="Chat options">
                            <button
                              type="button"
                              role="menuitem"
                              className="vnext-meri__row-menu-item"
                              onClick={() => {
                                setMenuFor(null);
                                setRenaming({ id: conversation.id, value: title });
                              }}
                            >
                              <MeriIcon name="Edit01" size={15} color="#667085" />
                              Rename
                            </button>
                            <button
                              type="button" role="menuitem" className="vnext-meri__row-menu-item" disabled={workspaceSaving}
                              onClick={() => { setMenuFor(null); setAssigning(conversation); setAssignmentValue(conversation.workspaceId ?? ''); setWorkspaceFailure(null); }}
                            >
                              <MeriIcon name="LayersThree01" size={15} color="#667085" />
                              {conversation.workspaceId ? 'Move to workspace' : 'Add to workspace'}
                            </button>
                            {conversation.workspaceId ? <button
                              type="button" role="menuitem" className="vnext-meri__row-menu-item" disabled={workspaceSaving}
                              onClick={() => void assignWorkspace(conversation, null)}
                            >Remove from workspace</button> : null}
                            <button
                              type="button"
                              role="menuitem"
                              className="vnext-meri__row-menu-item"
                              onClick={() => {
                                setMenuFor(null);
                                setConfirmFor(conversation);
                              }}
                            >
                              <MeriIcon name="Archive" size={15} color="#667085" />
                              Archive
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
          <span>Chat archived.</span>
          <button
            type="button"
            className="vnext-meri__undo-bar-action"
            onClick={() => {
              void onRestoreThread(undoTarget.id)
                .then((restored) => {
                  if (!restored) return;
                  upsertConversation(undoTarget);
                  setUndoTarget(null);
                  invalidateLibrary();
                  toast.success('Chat restored.');
                })
                .catch(() => toast.error('The chat could not be restored.'));
            }}
          >
            UNDO
          </button>
        </div>
      ) : null}

      {/* v6 reference rail footer: opens the same command palette as the top
          bar's search button (onOpenPalette) — no new behavior. */}
      <div className="vnext-meri__rail-foot">
        <button
          type="button"
          className="vnext-meri__rail-foot-palette"
          onClick={onOpenPalette}
        >
          <MeriIcon name="Command" size={14} color="#667085" />
          Command palette
        </button>
        <span className="vnext-meri__rail-foot-hint">⌘K</span>
      </div>

      <CapiroModal
        open={workspaceDialogOpen}
        title="Create workspace"
        onClose={() => { if (!workspaceSaving) setWorkspaceDialogOpen(false); }}
      >
        <div className="vnext-meri__confirm-body">Group related chats. Client workspaces accept chats for that client; All clients can group chats across clients.</div>
        <input
          autoFocus
          value={newWorkspaceName}
          onChange={(event) => setNewWorkspaceName(event.target.value)}
          className="vnext-meri__workspace-input"
          placeholder="Workspace name"
          aria-label="Workspace name"
          maxLength={120}
          disabled={workspaceSaving}
        />
        <label htmlFor="meri-workspace-client">Workspace client</label>
        <select id="meri-workspace-client" className="vnext-meri__workspace-input" value={newWorkspaceClient} disabled={workspaceSaving} onChange={(event) => setNewWorkspaceClient(event.target.value)}>
          <option value="">All clients</option>
          {controller.clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
        </select>
        {workspaceFailure ? <p role="alert">{workspaceFailure}</p> : null}
        <div className="vnext-meri__confirm-actions">
          <button type="button" className="vnext-meri__confirm-cancel" disabled={workspaceSaving} onClick={() => setWorkspaceDialogOpen(false)}>Cancel</button>
          <button type="button" className="vnext-meri__confirm-delete" disabled={workspaceSaving || !newWorkspaceName.trim()} onClick={() => void createWorkspace()}>{workspaceSaving ? 'Creating…' : 'Create workspace'}</button>
        </div>
      </CapiroModal>

      <CapiroModal open={Boolean(assignmentTarget)} title="Move chat to workspace" onClose={() => { if (!workspaceSaving) setAssigning(null); }}>
        <p className="vnext-meri__confirm-body">{assignmentTarget?.title} · {assignmentTarget?.client?.name ?? 'General'}. Moving a chat preserves its client and previous answers.</p>
        <label htmlFor="meri-chat-workspace">Workspace</label>
        <select id="meri-chat-workspace" className="vnext-meri__workspace-input" value={assignmentValue} disabled={workspaceSaving || workspaces.isLoading} onChange={(event) => setAssignmentValue(event.target.value)}>
          <option value="">No workspace</option>
          {(workspaces.data ?? []).map((workspace) => <option key={workspace.id} value={workspace.id} disabled={Boolean(workspace.clientId && workspace.clientId !== assignmentTarget?.clientId)}>
            {workspace.name}{workspace.clientId && workspace.clientId !== assignmentTarget?.clientId ? ' — different client' : ''}
          </option>)}
        </select>
        <p className="vnext-meri__confirm-body">Choose this chat’s client workspace or an All clients workspace. Create a workspace with the + button in the sidebar.</p>
        {workspaces.isError ? <p role="alert">Workspaces could not be loaded. <button type="button" onClick={() => void workspaces.refetch()}>Retry</button></p> : null}
        {incompatible ? <p role="alert">This workspace is for a different client.</p> : null}
        {workspaceFailure ? <p role="alert">{workspaceFailure}</p> : null}
        <div className="vnext-meri__confirm-actions">
          <button type="button" className="vnext-meri__confirm-cancel" disabled={workspaceSaving} onClick={() => setAssigning(null)}>Cancel</button>
          <button type="button" className="vnext-meri__confirm-delete" disabled={workspaceSaving || workspaces.isLoading || incompatible || (assignmentTarget?.workspaceId ?? '') === assignmentValue || Boolean(assignmentValue && !assignmentWorkspace)}
            onClick={() => { if (assignmentTarget) void assignWorkspace(assignmentTarget, assignmentValue || null); }}>{workspaceSaving ? 'Saving…' : 'Save workspace'}</button>
        </div>
      </CapiroModal>

      {confirmFor ? (
        <div className="vnext-meri__confirm-scrim" role="presentation">
          <div className="vnext-meri__confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="meri-delete-title" aria-describedby="meri-delete-body">
            <span className="vnext-meri__confirm-icon"><MeriIcon name="Trash01" size={17} color="#B42318" /></span>
            <div id="meri-delete-title" className="vnext-meri__confirm-title">Archive chat?</div>
            <div id="meri-delete-body" className="vnext-meri__confirm-body">This removes the chat from your recent list. Its messages and context remain in the audit trail and can be restored.</div>
            <div className="vnext-meri__confirm-actions">
              <button ref={confirmCancelRef} type="button" className="vnext-meri__confirm-cancel" onClick={() => setConfirmFor(null)}>Cancel</button>
              <button type="button" className="vnext-meri__confirm-delete" onClick={() => void confirmDelete()}>Archive chat</button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

/**
 * The reference's "No workspace" row under the workspace list: unassigns the
 * active thread from its workspace via the existing assignWorkspace(id, null)
 * path. Presentation only — all state, error, and toast behavior stays in the
 * rail's existing mutation handler.
 */
function NoWorkspaceRow({ disabled, onClear }: { disabled: boolean; onClear: () => void }) {
  return (
    <button
      type="button"
      className="vnext-meri__workspace-none"
      aria-label="Remove this thread from its workspace"
      title="Remove this thread from its workspace"
      disabled={disabled}
      onClick={onClear}
    >
      <MeriIcon name="SlashCircle01" size={15} color="#98A2B3" />
      <span>No workspace</span>
    </button>
  );
}
