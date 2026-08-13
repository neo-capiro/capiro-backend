import {
  useCallback,
  useEffect,
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
  setConversations,
  setMeriSurfaceMode,
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
  mapPersistedAttachments,
  mapPersistedCharts,
  newestConversation,
  normalizeConversation,
  threadIdFromPath,
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

/**
 * vNext route adapter for the existing MeriV3 conversation runtime.
 *
 * The canonical controller remains untouched. This adapter owns durable URL
 * semantics and one deliberate lifecycle difference: `/meri/new` stays
 * record-free until the first user Send. The existing controller still owns
 * creation, streaming, stop/abort, attachments, research, actions and memory.
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
  const [routeError, setRouteError] = useState<string | null>(null);
  const pendingSendRef = useRef<SendArgs | null>(null);
  const bootSequenceRef = useRef(0);

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
    async (conversationId: string): Promise<void> => {
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

      // Atomic: clear messages AND set sessionId in one store update so there
      // is never a render where sessionId is null while isOpen is true (which
      // would trigger the controller's auto-create-session effect and race
      // with this hydration, clearing the loaded messages).
      replaceChatSession(conversationId);
      setActiveConversation(conversationId);
      for (const message of hydrated) appendChatMessage(message);
      setMeriSurfaceMode('undocked');
    },
    [authHeaders],
  );

  const prepareRecordFreeNewThread = useCallback(
    async (replace = false) => {
      pendingSendRef.current = null;
      setRouteReady(false);
      controller.handleStop();
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
    [controller.handleStop, controller.setSessionTitle, location.pathname, navigate],
  );

  // Bootstrap each URL from server-authoritative thread/client state.
  useEffect(() => {
    const sequence = ++bootSequenceRef.current;
    let cancelled = false;
    setRouteReady(false);
    setRouteError(null);

    void (async () => {
      try {
        const [clients, history] = await Promise.all([loadClients(), loadConversations()]);
        if (cancelled || sequence !== bootSequenceRef.current) return;
        setRouteClients(clients);
        setConversations(history);

        if (isIntegrationsRoute) {
          // Integrations is addressable but must not select/create a conversation
          // merely because the settings screen was opened.
          setMeriSurfaceMode('closed');
          setRouteReady(true);
          return;
        }

        if (isNewRoute) {
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
            await hydrateConversation(requestedThreadId);
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
          await hydrateConversation(recent.id);
          if (cancelled || sequence !== bootSequenceRef.current) return;
          navigate(`/meri/t/${encodeURIComponent(recent.id)}`, { replace: true });
          return;
        }

        navigate('/meri', { replace: true });
      } catch (error) {
        if (cancelled || sequence !== bootSequenceRef.current) return;
        setMeriSurfaceMode('closed');
        setRouteError(error instanceof Error ? error.message : 'Meri could not be opened.');
        setRouteReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    controller.setSessionTitle,
    hydrateConversation,
    isIntegrationsRoute,
    isNewRoute,
    isRootRoute,
    loadClients,
    loadConversations,
    navigate,
    requestedThreadId,
  ]);

  // First Send is the durable creation boundary for `/meri/new`.
  const sendMessage = useCallback(
    async (...args: SendArgs) => {
      if (controller.sessionId) {
        setMeriSurfaceMode('undocked');
        await controller.sendMessage(...args);
        return;
      }
      if (pendingSendRef.current) return;
      pendingSendRef.current = args;
      setRouteError(null);
      await controller.handleNewSession();
      if (!getChatStateSnapshot().sessionId) {
        pendingSendRef.current = null;
        setRouteError('Meri could not create the thread. Nothing was sent.');
      }
    },
    [controller.handleNewSession, controller.sendMessage, controller.sessionId],
  );

  useEffect(() => {
    const pending = pendingSendRef.current;
    if (!pending || !controller.sessionId) return;
    pendingSendRef.current = null;
    setMeriSurfaceMode('undocked');
    const target = `/meri/t/${encodeURIComponent(controller.sessionId)}`;
    if (location.pathname !== target) navigate(target, { replace: true });
    void controller.sendMessage(...pending);
  }, [controller.sendMessage, controller.sessionId, location.pathname, navigate]);

  // The shared thread rail writes the selected durable conversation into the
  // store. Reflect successful selection in the URL so Back/Forward/refresh keep
  // the same thread. Integrations remains independent of thread selection.
  useEffect(() => {
    if (!routeReady || !activeConversationId || isIntegrationsRoute || isNewRoute) return;
    const target = `/meri/t/${encodeURIComponent(activeConversationId)}`;
    if (location.pathname !== target) navigate(target, { replace: false });
  }, [
    activeConversationId,
    isIntegrationsRoute,
    isNewRoute,
    location.pathname,
    navigate,
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

  const changeSessionClient = useCallback(
    async (clientId: string) => {
      if (!getChatStateSnapshot().activeConversationId) {
        setSelectedClientId(clientId || null);
        return;
      }
      await controller.changeSessionClient(clientId);
    },
    [controller.changeSessionClient, setSelectedClientId],
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
        sendMessage,
        handleNewSession,
        archiveConversation,
        changeSessionClient,
      }) as MeriChatController,
    [
      archiveConversation,
      changeSessionClient,
      controller,
      effectiveClients,
      effectiveSelectedClient,
      handleNewSession,
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
    const recent = newestConversation(conversations);
    return recent ? `/meri/t/${encodeURIComponent(recent.id)}` : '/meri/new';
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
      <VNextMeriShell controller={vnextController} />
    </>
  );
}
