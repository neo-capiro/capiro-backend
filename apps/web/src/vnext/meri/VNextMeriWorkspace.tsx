import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { config } from '../../env.js';
import { useMe } from '../../lib/me.js';
import { useClientFilter } from '../../state/client-filter.js';
import { useImpersonation } from '../../state/impersonation.js';
import {
  appendChatMessage,
  getChatStateSnapshot,
  replaceChatSession,
  setActiveConversation,
  setChatSession,
  setConversations,
  setMeriSurfaceMode,
  upsertConversation,
  useChatStore,
  type ChatMessage,
  type MeriConversation,
} from '../../components/chat/chat-store.js';
import {
  useMeriChatController,
  type MeriChatController,
} from '../../components/chat/useMeriChatController.js';
import { VNextMeriIntegrations } from './VNextMeriIntegrations.js';
import { VNextMeriShell } from './VNextMeriShell.js';
import {
  mayApplyRecordFreeCreation,
  mayDispatchPendingRecordFreeSend,
  mayCommitRouteHydration,
  shouldDiscardStagedAttachmentsForScopeChange,
  ownsFirstSend,
  type FirstSendToken,
} from '../../components/chat/meri-route-guards.js';
import {
  mapPersistedAttachments,
  mapPersistedCharts,
  meriContextRequest,
  newestConversation,
  normalizeConversation,
  threadIdFromPath,
  withoutMeriContext,
  type PersistedMessage,
} from './meri-route-state.js';

interface ClientOption {
  id: string;
  name: string;
}

type SendArgs = Parameters<MeriChatController['sendMessage']>;

function historyMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as PersistedMessage;
  const attachments = mapPersistedAttachments(message);
  const chartArtifacts = mapPersistedCharts(message);
  return {
    id: message.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role: message.role === 'user' ? 'user' : 'assistant',
    content: message.body || '',
    createdAt: message.createdAt ? new Date(message.createdAt) : new Date(),
    ...(attachments.length ? { attachments } : {}),
    ...(chartArtifacts.length ? { chartArtifacts } : {}),
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * vNext route adapter for the existing MeriV3 conversation runtime.
 *
 * The canonical controller remains untouched. This adapter owns durable URL
 * semantics and one deliberate lifecycle difference: `/meri/new` stays
 * record-free until the first user Send. The existing controller still owns
 * streaming, stop/abort, attachments, research, actions and memory.
 */
export function VNextMeriWorkspace() {
  const me = useMe();
  const { getToken } = useAuth();
  const { actAsTenantSlug } = useImpersonation();
  const { selectedClientId, setSelectedClientId } = useClientFilter();
  const location = useLocation();
  const navigate = useNavigate();
  const controller = useMeriChatController({ selectedClientName: null });
  const { activeConversationId, conversations } = useChatStore();
  const requestedThreadId = threadIdFromPath(location.pathname);
  const isNewRoute = location.pathname === '/meri/new';
  const isRootRoute = location.pathname === '/meri';
  const isIntegrationsRoute = location.pathname === '/meri/integrations';

  const [routeReady, setRouteReady] = useState(false);
  const [routeClients, setRouteClients] = useState<ClientOption[]>([]);
  const [routeClientsError, setRouteClientsError] = useState<string | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyEpoch, setHistoryEpoch] = useState(0);
  const [isCreatingThread, setIsCreatingThread] = useState(false);
  const pendingSendRef = useRef<SendArgs | null>(null);
  const pendingSendEpochRef = useRef<number | null>(null);
  const pendingSendSessionIdRef = useRef<string | null>(null);
  // Incremented on every real route transition. First-send creation has no
  // abortable client request, so its completion must prove it still belongs to
  // the same `/meri/new` intent before it can select a session or dispatch text.
  const firstSendEpochRef = useRef(0);
  // Unique immutable ownership token per first-send intent. When A→B→C occurs,
  // A's stale continuation/finally cleanup can still execute against shared
  // refs (pendingSendRef, isCreatingThread, etc.). A numeric epoch alone cannot
  // distinguish A's stale continuation from C's active one — the token id does.
  const activeFirstSendTokenRef = useRef<FirstSendToken | null>(null);
  const handledContextRef = useRef<string | null>(null);
  const bootSequenceRef = useRef(0);
  const previousRoutePathRef = useRef<string | null>(null);

  // This runs at the route boundary, before the asynchronous client/history
  // bootstrap begins. Waiting for that bootstrap left a window where an old SSE
  // stream or approval completion could still mutate a newly selected thread.
  // Integrations is a transient detour: retain the current thread/draft's staged
  // turn state when returning to that SAME context, but never retain it when the
  // destination is a different durable thread or a fresh draft.
  useLayoutEffect(() => {
    const previousPath = previousRoutePathRef.current;
    previousRoutePathRef.current = location.pathname;
    bootSequenceRef.current += 1;
    firstSendEpochRef.current += 1;

    // A deferred record-free send is only valid for the route that initiated
    // creation. Once the URL changes, clear its payload before any destination
    // hydration can publish a session id.
    if (previousPath !== null && previousPath !== location.pathname) {
      pendingSendRef.current = null;
      pendingSendEpochRef.current = null;
      pendingSendSessionIdRef.current = null;
      setIsCreatingThread(false);
      // Clear the active first-send token: the new route's first-send flow
      // (if any) will mint its own. A stale continuation from the prior
      // route checks this ref and returns without touching shared state.
      activeFirstSendTokenRef.current = null;
    }

    const snapshot = getChatStateSnapshot();
    const nextThreadId = threadIdFromPath(location.pathname);
    const returningFromIntegrations = previousPath === '/meri/integrations';
    const returnsToSameThread =
      Boolean(nextThreadId) && snapshot.activeConversationId === nextThreadId;
    const returnsToSameDraft = isNewRoute && snapshot.activeConversationId === null;

    // First Send creates the row under `/meri/new`, then the pending turn moves
    // the URL to that exact session. The same rule covers `/meri` resolving to
    // its newest thread. Those are URL canonicalizations of the CURRENT session,
    // not ownership transitions: aborting here would cancel the turn that just
    // started or clear the freshly hydrated transcript.
    if (returnsToSameThread) return;

    if (isIntegrationsRoute || (returningFromIntegrations && returnsToSameDraft)) {
      controller.invalidateRouteStream();
    } else {
      controller.discardRouteState();
    }
  }, [
    controller.discardRouteState,
    controller.invalidateRouteStream,
    isIntegrationsRoute,
    isNewRoute,
    location.pathname,
  ]);

  const authHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const token = await getToken({ template: 'capiro' });
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(actAsTenantSlug ? { 'x-capiro-impersonate-tenant': actAsTenantSlug } : {}),
    };
  }, [actAsTenantSlug, getToken]);

  const loadClients = useCallback(async (): Promise<ClientOption[]> => {
    const response = await fetch(`${config.apiBaseUrl}/api/clients`, {
      headers: await authHeaders(),
    });
    if (!response.ok) throw new Error(`Client scope could not be loaded (${response.status}).`);
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) throw new Error('Client scope returned an unexpected response.');
    return body
      .filter(
        (item: unknown): item is Record<string, unknown> =>
          Boolean(item) && typeof item === 'object',
      )
      .map((item) => ({ id: String(item.id ?? ''), name: String(item.name ?? '') }))
      .filter((item) => Boolean(item.id && item.name));
  }, [authHeaders]);

  const loadConversations = useCallback(async (): Promise<MeriConversation[]> => {
    const response = await fetch(`${config.apiBaseUrl}/api/clio/conversations`, {
      headers: await authHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Conversation history could not be loaded (${response.status}).`);
    }
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) {
      throw new Error('Conversation history returned an unexpected response.');
    }
    return body.map(normalizeConversation).filter((item): item is MeriConversation => Boolean(item));
  }, [authHeaders]);

  /**
   * Transactional hard-link hydration: fetch + validate first, then commit the
   * selected thread into the shared store. A 404/403/bad payload therefore
   * cannot replace a good active thread with a broken id.
   */
  const hydrateConversation = useCallback(
    async (conversationId: string, sequence: number): Promise<boolean> => {
      // The layout-effect route boundary already invalidated the prior session
      // synchronously. Do not discard here: an older B bootstrap that reaches
      // this function after C was selected must be a no-op, not a second
      // invalidation that could disturb C.
      if (
        !mayCommitRouteHydration(
          { sequence, threadId: conversationId },
          bootSequenceRef.current,
          threadIdFromPath(window.location.pathname),
        )
      ) {
        return false;
      }
      const response = await fetch(
        `${config.apiBaseUrl}/api/clio/conversations/${encodeURIComponent(conversationId)}/messages`,
        { headers: await authHeaders() },
      );
      if (!response.ok) {
        throw new Error(`This Meri thread could not be loaded (${response.status}).`);
      }
      const body = (await response.json()) as unknown;
      if (!Array.isArray(body)) {
        throw new Error('This Meri thread returned an unexpected response.');
      }
      const hydrated = body.map(historyMessage).filter((item): item is ChatMessage => Boolean(item));

      // The request may complete after a newer Back/Forward or rail navigation.
      // Validate immediately before the shared-store commit: cancelling the
      // effect after this function returns is too late to protect the visible
      // transcript or the session Send will target.
      if (
        !mayCommitRouteHydration(
          { sequence, threadId: conversationId },
          bootSequenceRef.current,
          threadIdFromPath(window.location.pathname),
        )
      ) {
        return false;
      }

      // Atomic: clear messages AND set sessionId in one store update so there
      // is never a render where sessionId is null while isOpen is true (which
      // would trigger the controller's auto-create-session effect and race
      // with this hydration, clearing the loaded messages).
      replaceChatSession(conversationId);
      setActiveConversation(conversationId);
      for (const message of hydrated) appendChatMessage(message);
      setMeriSurfaceMode('undocked');
      return true;
    },
    [authHeaders],
  );

  /**
   * Create the durable row at the vNext first-Send boundary without calling the
   * canonical `handleNewSession` reset. That reset intentionally clears staged
   * attachments; invoking it after the user had already uploaded files made the
   * first turn lose those files. This uses the same endpoint and store contract
   * as the controller while leaving the controller's staged payload intact for
   * its subsequent `sendMessage` call.
   */
  const createRecordFreeSession = useCallback(async (token: FirstSendToken): Promise<string | null> => {
    const firstSendEpoch = firstSendEpochRef.current;
    const response = await fetch(`${config.apiBaseUrl}/api/clio/conversations`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({
        clientId: selectedClientId || undefined,
        title: 'Chat session',
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(text || `Conversation creation failed (${response.status}).`);
    }
    const data = (await response.json()) as {
      id?: unknown;
      title?: unknown;
      clientId?: unknown;
      updatedAt?: unknown;
    };
    if (typeof data.id !== 'string' || !data.id) {
      throw new Error('Conversation creation returned an unexpected response.');
    }

    // Creation can complete after the user has selected another thread or
    // backed out of `/meri/new`. The server row may exist, but this stale UI
    // action must not select it, redirect to it, or send its pending prompt.
    // Check BOTH the route epoch and the first-send token id: the token
    // distinguishes A's stale continuation from C's active one even when
    // both captured the same epoch value at different times.
    if (
      !mayApplyRecordFreeCreation(
        firstSendEpoch,
        firstSendEpochRef.current,
        window.location.pathname,
      ) || !ownsFirstSend(token, activeFirstSendTokenRef.current)
    ) {
      return null;
    }

    const createdClientId = typeof data.clientId === 'string' ? data.clientId : null;
    const availableClients = controller.clients.length > 0 ? controller.clients : routeClients;
    const createdClient = createdClientId
      ? (availableClients.find((client) => client.id === createdClientId) ?? null)
      : null;
    upsertConversation({
      id: data.id,
      title:
        typeof data.title === 'string' && data.title.trim() ? data.title : 'Chat session',
      clientId: createdClientId,
      client: createdClient,
      latestMessage: null,
      updatedAt:
        typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
    });
    pendingSendSessionIdRef.current = data.id;
    setChatSession(data.id);
    setActiveConversation(data.id);
    return data.id;
  }, [authHeaders, controller.clients, routeClients, selectedClientId]);

  const prepareRecordFreeNewThread = useCallback(
    async (replace = false) => {
      pendingSendRef.current = null;
      pendingSendEpochRef.current = null;
      pendingSendSessionIdRef.current = null;
      setIsCreatingThread(false);
      setRouteReady(false);
      // New Chat is a real session ownership transition. Unlike integrations,
      // invalidate non-abortable approval completions as well as the stream
      // before clearing the old draft/thread state.
      controller.discardRouteState();
      // A deliberate New Chat must not carry staged files or mode state from the
      // previous thread. Integrations navigation does not call this reset, so a
      // user can still configure an app and return to an in-progress new turn.
      for (const attachment of controller.stagedAttachments) {
        controller.removeStagedAttachment(attachment.localId);
      }
      controller.setWriteMode(false);
      controller.setResearchMode(false);
      controller.setResearchAwaitingAnswers(false);
      controller.setResearchQuestions([]);
      controller.researchSessionRef.current = null;
      controller.setActiveArtifact(null);
      // Close first. Otherwise the canonical controller's established
      // "open + no session => create" effect could race the state clear below.
      setMeriSurfaceMode('closed');
      replaceChatSession(null);
      setActiveConversation(null);
      controller.setSessionTitle('');
      setRouteError(null);
      if (location.pathname !== '/meri/new') navigate('/meri/new', { replace });
      else setRouteReady(true);
    },
    [
      controller.discardRouteState,
      controller.removeStagedAttachment,
      controller.researchSessionRef,
      controller.setActiveArtifact,
      controller.setResearchAwaitingAnswers,
      controller.setResearchMode,
      controller.setResearchQuestions,
      controller.setSessionTitle,
      controller.setWriteMode,
      controller.stagedAttachments,
      location.pathname,
      navigate,
    ],
  );

  // Bootstrap each URL from server-authoritative thread/client state. A client
  // roster outage must not block a general Meri thread, while conversation
  // history remains required for durable route resolution.
  useEffect(() => {
    const sequence = ++bootSequenceRef.current;
    let cancelled = false;
    setRouteReady(false);
    setRouteError(null);
    setHistoryError(null);
    setRouteClientsError(null);

    void (async () => {
      try {
        const [clientsResult, historyResult] = await Promise.allSettled([
          loadClients(),
          loadConversations(),
        ]);
        if (cancelled || sequence !== bootSequenceRef.current) return;
        if (historyResult.status === 'rejected') {
          const message = errorMessage(historyResult.reason, 'Conversation history could not be loaded.');
          setHistoryError(message);
          setConversations([]);
          if (isNewRoute || isIntegrationsRoute) {
            setRouteReady(true);
            return;
          }
          throw historyResult.reason;
        }

        const clients = clientsResult.status === 'fulfilled' ? clientsResult.value : [];
        setRouteClients(clients);
        setRouteClientsError(
          clientsResult.status === 'rejected'
            ? errorMessage(clientsResult.reason, 'Client scope could not be loaded.')
            : null,
        );
        setConversations(historyResult.value);
        const history = historyResult.value;

        if (isIntegrationsRoute) {
          // Integrations is addressable but must not select/create a conversation
          // merely because the settings screen was opened. The return path stays
          // on the same draft or durable thread, so only the in-flight stream is
          // stopped; staged files remain with their original pending turn.
          controller.invalidateRouteStream();
          setMeriSurfaceMode('closed');
          setRouteReady(true);
          return;
        }

        if (isNewRoute) {
          // A durable thread → new route is a hard boundary. Returning from
          // integrations to an already-record-free draft is not: its staged
          // attachment remains part of that pending first turn.
          if (getChatStateSnapshot().activeConversationId) controller.discardRouteState();
          else controller.invalidateRouteStream();
          setMeriSurfaceMode('closed');
          replaceChatSession(null);
          setActiveConversation(null);
          controller.setSessionTitle('');
          setRouteReady(true);
          return;
        }

        if (requestedThreadId) {
          if (!history.some((conversation) => conversation.id === requestedThreadId)) {
            throw new Error('This Meri thread is not available in your conversation history.');
          }
          const snapshot = getChatStateSnapshot();
          if (
            snapshot.activeConversationId !== requestedThreadId ||
            snapshot.sessionId !== requestedThreadId
          ) {
            const committed = await hydrateConversation(requestedThreadId, sequence);
            if (!committed || cancelled || sequence !== bootSequenceRef.current) return;
          } else {
            setMeriSurfaceMode('undocked');
          }
          if (!cancelled && sequence === bootSequenceRef.current) setRouteReady(true);
          return;
        }

        if (isRootRoute) {
          const recent = newestConversation(history);
          if (!recent) {
            navigate('/meri/new', { replace: true });
            return;
          }
          const committed = await hydrateConversation(recent.id, sequence);
          if (!committed || cancelled || sequence !== bootSequenceRef.current) return;
          navigate(`/meri/t/${encodeURIComponent(recent.id)}`, { replace: true });
          return;
        }

        navigate('/meri', { replace: true });
      } catch (error) {
        if (cancelled || sequence !== bootSequenceRef.current) return;
        setMeriSurfaceMode('closed');
        setRouteError(errorMessage(error, 'Meri could not be opened.'));
        setRouteReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    controller.discardRouteState,
    controller.invalidateRouteStream,
    controller.setSessionTitle,
    hydrateConversation,
    isIntegrationsRoute,
    isNewRoute,
    isRootRoute,
    loadClients,
    loadConversations,
    navigate,
    requestedThreadId,
    historyEpoch,
  ]);

  // First Send is the durable creation boundary for `/meri/new`. A synchronous
  // ref lock closes the double-click gap before React can publish the busy state.
  const sendMessage = useCallback(
    async (...args: SendArgs) => {
      if (controller.sessionId) {
        setMeriSurfaceMode('undocked');
        await controller.sendMessage(...args);
        return;
      }
      if (pendingSendRef.current || isCreatingThread) {
        throw new Error('Meri is still creating this thread. Your message was not duplicated.');
      }

      // Mint a unique immutable ownership token for this first-send intent.
      // Every async continuation from this flow captures `token`. Before ANY
      // mutation of pendingSendRef, isCreatingThread, or related state, the
      // continuation checks ownsFirstSend(token, activeFirstSendTokenRef.current).
      // If false, it returns without touching shared first-send state.
      const token: FirstSendToken = {
        id: crypto.randomUUID(),
        routeEpoch: firstSendEpochRef.current,
      };
      activeFirstSendTokenRef.current = token;

      pendingSendRef.current = args;
      pendingSendEpochRef.current = firstSendEpochRef.current;
      pendingSendSessionIdRef.current = null;
      setIsCreatingThread(true);
      setRouteError(null);
      try {
        const createdSessionId = await createRecordFreeSession(token);
        // TOKEN CHECK: if A's stale creation resolves after C has already
        // minted a new token, A must be a complete no-op. Do not clear C's
        // pending send, epoch, or busy state.
        if (!ownsFirstSend(token, activeFirstSendTokenRef.current)) {
          return;
        }
        if (!createdSessionId) {
          pendingSendRef.current = null;
          pendingSendEpochRef.current = null;
          pendingSendSessionIdRef.current = null;
          setIsCreatingThread(false);
          return;
        }
      } catch (error) {
        // TOKEN CHECK: a stale A error must not clear C's refs or set C's
        // route error. Only the current token owner may mutate shared state.
        if (!ownsFirstSend(token, activeFirstSendTokenRef.current)) {
          return;
        }
        pendingSendRef.current = null;
        pendingSendEpochRef.current = null;
        pendingSendSessionIdRef.current = null;
        setIsCreatingThread(false);
        const message = errorMessage(error, 'Meri could not create the thread. Nothing was sent.');
        setRouteError(message);
        throw new Error(message);
      }

      // TOKEN CHECK: a stale A success must not proceed against C's state.
      if (!ownsFirstSend(token, activeFirstSendTokenRef.current)) {
        return;
      }

      if (!getChatStateSnapshot().sessionId) {
        pendingSendRef.current = null;
        pendingSendEpochRef.current = null;
        pendingSendSessionIdRef.current = null;
        setIsCreatingThread(false);
        const message = 'Meri could not create the thread. Nothing was sent.';
        setRouteError(message);
        throw new Error(message);
      }
    },
    [controller.sendMessage, controller.sessionId, createRecordFreeSession, isCreatingThread],
  );

  useEffect(() => {
    const pending = pendingSendRef.current;
    const pendingEpoch = pendingSendEpochRef.current;
    const pendingSessionId = pendingSendSessionIdRef.current;
    if (!pending || pendingEpoch === null || !pendingSessionId || !controller.sessionId) return;

    if (
      !mayDispatchPendingRecordFreeSend(
        pendingEpoch,
        firstSendEpochRef.current,
        pendingSessionId,
        controller.sessionId,
      )
    ) {
      pendingSendRef.current = null;
      pendingSendEpochRef.current = null;
      pendingSendSessionIdRef.current = null;
      setIsCreatingThread(false);
      return;
    }

    pendingSendRef.current = null;
    pendingSendEpochRef.current = null;
    pendingSendSessionIdRef.current = null;
    setMeriSurfaceMode('undocked');
    const target = `/meri/t/${encodeURIComponent(controller.sessionId)}`;
    if (location.pathname !== target) navigate(target, { replace: true });
    void controller.sendMessage(...pending).catch((error) => {
      setRouteError(errorMessage(error, 'Meri could not send this message.'));
    });
    setIsCreatingThread(false);
  }, [controller.sendMessage, controller.sessionId, location.pathname, navigate]);

  // Consume contextual vNext launches exactly once. Client scope is validated
  // before the URL is cleared or a turn is sent; an unavailable client fails
  // closed rather than silently sending the prompt across the whole portfolio.
  useEffect(() => {
    if (!routeReady || !isNewRoute) return;
    const request = meriContextRequest(location.search);
    if (!request) {
      handledContextRef.current = null;
      return;
    }
    const requestKey = `${request.prompt}\u0000${request.clientId ?? ''}`;
    if (handledContextRef.current === requestKey) return;

    // A contextual client launch is authorized only by the route bootstrap's
    // fresh `/api/clients` response. The controller roster can belong to the
    // previously selected thread, so it is not sufficient evidence for this
    // one-time client-scoped request.
    const availableClients = routeClients;
    if (request.clientId) {
      if (routeClientsError || availableClients.length === 0) {
        handledContextRef.current = requestKey;
        navigate(
          { pathname: location.pathname, search: withoutMeriContext(location.search) },
          { replace: true },
        );
        setRouteError('Client scope could not be verified. Nothing was sent.');
        return;
      }
      if (!availableClients.some((client) => client.id === request.clientId)) {
        handledContextRef.current = requestKey;
        navigate(
          { pathname: location.pathname, search: withoutMeriContext(location.search) },
          { replace: true },
        );
        setRouteError('The selected client is no longer available. Nothing was sent.');
        return;
      }
      if (selectedClientId !== request.clientId) {
        setSelectedClientId(request.clientId);
        return;
      }
    }

    handledContextRef.current = requestKey;
    navigate(
      { pathname: location.pathname, search: withoutMeriContext(location.search) },
      { replace: true },
    );
    if (!request.prompt) return;
    void sendMessage(request.prompt).catch((error) => {
      setRouteError(errorMessage(error, 'Meri could not send the contextual request.'));
    });
  }, [
    controller.clients,
    isNewRoute,
    location.pathname,
    location.search,
    navigate,
    routeClients,
    routeClientsError,
    routeReady,
    selectedClientId,
    sendMessage,
    setSelectedClientId,
  ]);

  // Keep store-driven selections addressable, but never override a deliberate
  // route-first thread switch while the new URL is still hydrating. Without the
  // requested-id guard, the previous active id could immediately navigate the
  // browser back to the old thread before the bootstrap effect completed.
  useEffect(() => {
    if (!routeReady || !activeConversationId || isIntegrationsRoute || isNewRoute) return;
    if (requestedThreadId && requestedThreadId !== activeConversationId) return;
    const target = `/meri/t/${encodeURIComponent(activeConversationId)}`;
    if (location.pathname !== target) navigate(target, { replace: false });
  }, [
    activeConversationId,
    isIntegrationsRoute,
    isNewRoute,
    location.pathname,
    navigate,
    requestedThreadId,
    routeReady,
  ]);

  const handleNewSession = useCallback(async () => {
    await prepareRecordFreeNewThread(false);
  }, [prepareRecordFreeNewThread]);

  const archiveConversation = useCallback(async () => {
    setMeriSurfaceMode('closed');
    await controller.archiveConversation();
    await prepareRecordFreeNewThread(true);
  }, [controller.archiveConversation, prepareRecordFreeNewThread]);

  const archiveThread = useCallback(
    async (conversationId: string) => {
      const response = await fetch(
        `${config.apiBaseUrl}/api/clio/conversations/${encodeURIComponent(conversationId)}/archive`,
        { method: 'PATCH', headers: await authHeaders() },
      );
      if (!response.ok) throw new Error(`Archive failed (${response.status}).`);
    },
    [authHeaders],
  );

  const restoreThread = useCallback(
    async (conversationId: string) => {
      const response = await fetch(
        `${config.apiBaseUrl}/api/clio/conversations/${encodeURIComponent(conversationId)}/restore`,
        { method: 'PATCH', headers: await authHeaders() },
      );
      if (!response.ok) throw new Error(`Restore failed (${response.status}).`);
      setHistoryEpoch((value) => value + 1);
    },
    [authHeaders],
  );

  const renameThread = useCallback(
    async (conversationId: string, title: string) => {
      const response = await fetch(
        `${config.apiBaseUrl}/api/clio/conversations/${encodeURIComponent(conversationId)}`,
        {
          method: 'PATCH',
          headers: await authHeaders(),
          body: JSON.stringify({ title }),
        },
      );
      if (!response.ok) throw new Error(`Rename failed (${response.status}).`);
      const existing = conversations.find((conversation) => conversation.id === conversationId);
      if (existing) upsertConversation({ ...existing, title });
      if (conversationId === activeConversationId) controller.setSessionTitle(title);
    },
    [activeConversationId, authHeaders, controller, conversations],
  );

  const changeSessionClient = useCallback(
    async (clientId: string) => {
      const currentConversation = activeConversationId
        ? conversations.find((conversation) => conversation.id === activeConversationId) ?? null
        : null;
      const currentClientId = activeConversationId
        ? controller.selectedClientValue || currentConversation?.clientId || null
        : selectedClientId || null;
      const nextClientId = clientId || null;
      if (
        shouldDiscardStagedAttachmentsForScopeChange(
          currentClientId,
          nextClientId,
          controller.stagedAttachments.length,
        )
      ) {
        for (const attachment of controller.stagedAttachments) {
          controller.removeStagedAttachment(attachment.localId);
        }
        setRouteError('Attachments were removed because the client scope changed.');
      }
      if (!getChatStateSnapshot().activeConversationId) {
        setSelectedClientId(nextClientId);
        return;
      }
      await controller.changeSessionClient(clientId);
    },
    [
      activeConversationId,
      controller.changeSessionClient,
      conversations,
      controller.removeStagedAttachment,
      controller.selectedClientValue,
      controller.stagedAttachments,
      selectedClientId,
      setSelectedClientId,
    ],
  );

  const activeConversation =
    conversations.find((conversation) => conversation.id === activeConversationId) ?? null;
  const effectiveClients = controller.clients.length > 0 ? controller.clients : routeClients;
  const effectiveSelectedClient = activeConversationId
    ? controller.selectedClientValue || activeConversation?.clientId || ''
    : selectedClientId || '';

  const vnextController = useMemo(
    () =>
      ({
        ...controller,
        clients: effectiveClients,
        selectedClientValue: effectiveSelectedClient,
        isStreaming: controller.isStreaming || isCreatingThread,
        sendMessage,
        handleNewSession,
        archiveConversation,
        changeSessionClient,
        scopePersistStatus: controller.scopePersistStatus,
      }) as MeriChatController,
    [
      archiveConversation,
      changeSessionClient,
      controller,
      effectiveClients,
      effectiveSelectedClient,
      handleNewSession,
      isCreatingThread,
      sendMessage,
    ],
  );

  const integrationsBackPath = useMemo(() => {
    if (
      activeConversationId &&
      conversations.some((conversation) => conversation.id === activeConversationId)
    ) {
      return `/meri/t/${encodeURIComponent(activeConversationId)}`;
    }
    // Integrations must return a record-free draft to `/meri/new` when no
    // durable thread was active. Sending a staged file to the newest unrelated
    // thread would cross both turn and client boundaries.
    return '/meri/new';
  }, [activeConversationId, conversations]);

  useEffect(
    () => () => {
      controller.handleStop();
      setMeriSurfaceMode('closed');
    },
    [controller.handleStop],
  );

  if (me.isLoading || !routeReady) {
    return <div className="meri-v3-workspace-loading">Opening Meri…</div>;
  }

  if (me.data?.features?.meriv3Chat === false) {
    return (
      <div className="meri-v3-workspace-loading">
        <strong>MeriV3 is not enabled for this tenant.</strong>
      </div>
    );
  }

  if (isIntegrationsRoute) {
    return <VNextMeriIntegrations onBack={() => navigate(integrationsBackPath)} />;
  }

  // A failed durable deep link must never reveal an unrelated active thread
  // under the requested URL. The old store value is intentionally left intact
  // for recovery, but the route itself fails closed.
  if (routeError && requestedThreadId) {
    return (
      <div className="meri-v3-workspace-loading" role="alert">
        <strong>Meri could not open this thread.</strong>
        <span>{routeError}</span>
        <button type="button" onClick={() => navigate('/meri', { replace: true })}>
          Open Meri
        </button>
      </div>
    );
  }

  if (routeError && !isNewRoute && !activeConversationId) {
    return (
      <div className="meri-v3-workspace-loading" role="alert">
        <strong>Meri could not be opened.</strong>
        <span>{routeError}</span>
        <button type="button" onClick={() => navigate('/meri/new', { replace: true })}>
          Start a new thread
        </button>
      </div>
    );
  }

  return (
    <>
      {routeError ? <div className="vnext-meri__route-error" role="alert">{routeError}</div> : null}
      <VNextMeriShell
        controller={vnextController}
        historyError={historyError}
        onRetryHistory={() => setHistoryEpoch((value) => value + 1)}
        onArchiveThread={archiveThread}
        onRenameThread={renameThread}
        onRestoreThread={restoreThread}
      />
    </>
  );
}
