import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../lib/use-api.js';
import { useMe } from '../../lib/me.js';
import { setMeriSurfaceMode } from './chat-store.js';
import { ManagedMcpAppsProvider } from './managed-mcp-apps.js';
import {
  isMeriWorkspaceWindow,
  MERI_WINDOW_CLIENT_QUERY,
  MERI_WINDOW_PROMPT_QUERY,
} from './meri-window.js';
import { MeriWorkspaceConversation } from './MeriWorkspaceConversation.js';
import { MeriWorkspaceThreadRail } from './MeriWorkspaceThreadRail.js';
import type { MeriChatController } from './useMeriChatController.js';
import './meri-workspace-window.css';

const REASONING_MODES = [
  { mode: 'fast', label: 'Fast', description: 'Quick answers and direct lookups.' },
  { mode: 'standard', label: 'Standard', description: 'Balanced everyday reasoning.' },
  { mode: 'deep', label: 'Deep', description: 'More investigation for strategic work.' },
  { mode: 'max', label: 'Max', description: 'Highest configured reasoning tier.' },
] as const;

type ReasoningMode = (typeof REASONING_MODES)[number]['mode'];

function displayName(me: ReturnType<typeof useMe>['data']): string {
  const first = me?.user.firstName?.trim() ?? '';
  const last = me?.user.lastName?.trim() ?? '';
  const full = `${first} ${last}`.trim();
  return full || me?.user.email?.split('@')[0] || 'Capiro user';
}

function shortGreetingName(me: ReturnType<typeof useMe>['data']): string {
  return me?.user.firstName?.trim() || displayName(me);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'CU';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}`.toUpperCase();
}

function roleLabel(role: string | undefined, title: string | null | undefined): string {
  if (title?.trim()) return title.trim().toUpperCase();
  return String(role ?? 'standard_user')
    .replace(/_/g, ' ')
    .toUpperCase();
}

function readContextRequest(): { prompt: string; clientId: string | null } | null {
  if (!isMeriWorkspaceWindow()) return null;
  const params = new URLSearchParams(window.location.search);
  const prompt = params.get(MERI_WINDOW_PROMPT_QUERY)?.trim() ?? '';
  if (!prompt) return null;
  return {
    prompt,
    clientId: params.get(MERI_WINDOW_CLIENT_QUERY)?.trim() || null,
  };
}

function clearContextRequestFromUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete(MERI_WINDOW_PROMPT_QUERY);
  url.searchParams.delete(MERI_WINDOW_CLIENT_QUERY);
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

export function MeriWorkspaceWindow({ controller }: { controller: MeriChatController }) {
  const api = useApi();
  const me = useMe();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [tipOpen, setTipOpen] = useState(false);
  const [reasoningMode, setReasoningMode] = useState<ReasoningMode>('standard');
  const [savingMode, setSavingMode] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const [, setContextSetupTick] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const contextRequestRef = useRef<ReturnType<typeof readContextRequest>>(readContextRequest());
  const contextHandledRef = useRef(false);
  const contextNewThreadAttemptedRef = useRef(false);
  const contextNewThreadInFlightRef = useRef(false);
  const contextScopeAttemptedRef = useRef(false);
  const contextScopeInFlightRef = useRef(false);
  const activeConversationId = controller.activeConversationId;
  const isNewThread = controller.messages.length === 0;
  const selectedClient =
    controller.clients.find((client) => client.id === controller.selectedClientValue) ?? null;

  const personName = displayName(me.data);
  const greetingName = shortGreetingName(me.data);
  const tenantName = me.data?.tenant.name ?? 'Capiro';
  const tenantQualifier = me.data?.tenant.slug
    ? `${tenantName} · ${me.data.tenant.slug}`.toUpperCase()
    : tenantName.toUpperCase();
  const userRole = roleLabel(me.data?.role, me.data?.user.title);
  const sessionTitle = isNewThread
    ? 'New thread'
    : controller.sessionTitle.trim() || 'Untitled thread';

  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Meri — Capiro';
    document.documentElement.classList.add('meri-v3-window-document');
    document.body.classList.add('meri-v3-window-document');
    return () => {
      document.title = previousTitle;
      document.documentElement.classList.remove('meri-v3-window-document');
      document.body.classList.remove('meri-v3-window-document');
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSidebarOpen(true);
        window.setTimeout(() => searchInputRef.current?.focus(), 20);
      }
      if (event.key === 'Escape') setTipOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!tipOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!tipRef.current?.contains(event.target as Node)) setTipOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [tipOpen]);

  useEffect(() => {
    if (!activeConversationId) {
      setReasoningMode('standard');
      return;
    }
    let cancelled = false;
    void api
      .get<{ reasoningMode: ReasoningMode }>(
        `/api/clio/v3/conversations/${activeConversationId}/reasoning-mode`,
      )
      .then(({ data }) => {
        if (!cancelled) setReasoningMode(data.reasoningMode ?? 'standard');
      })
      .catch(() => {
        if (!cancelled) setReasoningMode('standard');
      });
    return () => {
      cancelled = true;
    };
  }, [activeConversationId, api]);

  /**
   * A contextual "Ask Meri" from another product surface opens this separate
   * window with a one-time prompt in the URL.
   *
   * If the reusable window was already sitting on an unrelated thread, create a
   * fresh conversation first. Then establish any requested client scope and wait
   * for that PATCH to settle before sending. The query parameters are removed
   * immediately before execution so refresh/back cannot duplicate the turn.
   */
  useEffect(() => {
    const request = contextRequestRef.current;
    if (!request || contextHandledRef.current || controller.isStreaming) return;

    if (!isNewThread) {
      if (contextNewThreadAttemptedRef.current || contextNewThreadInFlightRef.current) return;
      contextNewThreadAttemptedRef.current = true;
      contextNewThreadInFlightRef.current = true;
      void controller.handleNewSession().finally(() => {
        contextNewThreadInFlightRef.current = false;
        setContextSetupTick((value) => value + 1);
      });
      return;
    }

    if (contextNewThreadInFlightRef.current || !activeConversationId) return;

    if (request.clientId) {
      const clientExists = controller.clients.some((client) => client.id === request.clientId);
      if (!clientExists) return;

      if (controller.selectedClientValue !== request.clientId) {
        if (contextScopeAttemptedRef.current || contextScopeInFlightRef.current) return;
        contextScopeAttemptedRef.current = true;
        contextScopeInFlightRef.current = true;
        void controller.changeSessionClient(request.clientId).finally(() => {
          contextScopeInFlightRef.current = false;
          setContextSetupTick((value) => value + 1);
        });
        return;
      }

      if (contextScopeInFlightRef.current) return;
    }

    contextHandledRef.current = true;
    clearContextRequestFromUrl();
    void controller.sendMessage(request.prompt);
  }, [
    activeConversationId,
    controller.changeSessionClient,
    controller.clients,
    controller.handleNewSession,
    controller.isStreaming,
    controller.messages.length,
    controller.selectedClientValue,
    controller.sendMessage,
    isNewThread,
  ]);

  const changeReasoningMode = useCallback(
    async (next: ReasoningMode) => {
      if (!activeConversationId || savingMode || next === reasoningMode) return;
      const previous = reasoningMode;
      setReasoningMode(next);
      setSavingMode(true);
      setModeError(null);
      try {
        await api.patch(`/api/clio/v3/conversations/${activeConversationId}/reasoning-mode`, {
          reasoningMode: next,
        });
      } catch {
        setReasoningMode(previous);
        setModeError('The reasoning mode could not be saved.');
      } finally {
        setSavingMode(false);
      }
    },
    [activeConversationId, api, reasoningMode, savingMode],
  );

  const minimize = useCallback(() => {
    if (isMeriWorkspaceWindow()) {
      window.close();
      return;
    }
    setMeriSurfaceMode('closed');
  }, []);

  const headerChips = useMemo(() => {
    const chips: string[] = [];
    if (selectedClient) chips.push(`SCOPED · ${selectedClient.name.toUpperCase()}`);
    return chips;
  }, [selectedClient]);

  return (
    <ManagedMcpAppsProvider>
      <section
        className={`meri-v3-workspace${sidebarOpen ? '' : ' meri-v3-workspace--railless'}`}
        aria-label="Meri workspace"
      >
        {sidebarOpen ? (
          <aside className="meri-v3-workspace-sidebar" aria-label="Meri conversations">
            <div className="meri-v3-workspace-brand">
              <div className="meri-v3-brand-row">
                <span className="meri-v3-brand-ring" aria-hidden="true" />
                <span className="meri-v3-brand-name">Meri</span>
                <span className="meri-v3-brand-kbd" aria-hidden="true">
                  ⌘K
                </span>
              </div>
              <div className="meri-v3-brand-firm">{tenantQualifier}</div>
            </div>

            <div className="meri-v3-sidebar-command">
              <button
                type="button"
                className="meri-v3-new-thread"
                onClick={() => void controller.handleNewSession()}
              >
                + New thread
              </button>
              <MeriWorkspaceThreadRail searchInputRef={searchInputRef} />
            </div>

            <div className="meri-v3-sidebar-footer">
              <span className="meri-v3-user-initials" aria-hidden="true">
                {initials(personName)}
              </span>
              <span className="meri-v3-user-copy">
                <strong>{personName}</strong>
                <small>{userRole}</small>
              </span>
            </div>
          </aside>
        ) : null}

        <main className="meri-v3-workspace-main">
          <header className="meri-v3-workspace-header">
            <button
              type="button"
              className="meri-v3-sidebar-toggle"
              onClick={() => setSidebarOpen((open) => !open)}
              aria-label="Toggle sidebar"
              aria-expanded={sidebarOpen}
            >
              <span aria-hidden="true" />
              <span aria-hidden="true" />
              <span aria-hidden="true" />
            </button>

            <div className="meri-v3-header-thread">
              <strong>{sessionTitle}</strong>
              {!isNewThread && activeConversationId ? (
                <div className="meri-v3-header-chips">
                  {headerChips.map((chip) => (
                    <span className="meri-v3-header-chip" key={chip}>
                      {chip}
                    </span>
                  ))}
                  <ReasoningChip
                    value={reasoningMode}
                    disabled={savingMode}
                    error={modeError}
                    onChange={(mode) => void changeReasoningMode(mode)}
                  />
                </div>
              ) : null}
            </div>

            <div className="meri-v3-header-actions">
              <div className="meri-v3-tip" ref={tipRef}>
                <button
                  type="button"
                  className={`meri-v3-tip-trigger${tipOpen ? ' is-open' : ''}`}
                  onClick={() => setTipOpen((open) => !open)}
                  aria-haspopup="dialog"
                  aria-expanded={tipOpen}
                >
                  <span aria-hidden="true" /> PRO TIP
                </button>
                {tipOpen ? <ProTip onClose={() => setTipOpen(false)} /> : null}
              </div>
              <button
                type="button"
                className="meri-v3-minimize"
                onClick={minimize}
                aria-label="Minimize window"
                title="Minimize window"
              >
                <span aria-hidden="true" />
              </button>
            </div>
          </header>

          <div className="meri-v3-header-fade" aria-hidden="true" />

          {controller.metaError ? (
            <div className="meri-v3-workspace-error" role="alert">
              {controller.metaError}
            </div>
          ) : null}

          <MeriWorkspaceConversation
            controller={controller}
            userLabel={personName}
            greetingName={greetingName}
            tenantName={tenantName}
          />
        </main>
      </section>
    </ManagedMcpAppsProvider>
  );
}

function ProTip({ onClose }: { onClose: () => void }) {
  return (
    <div className="meri-v3-tip-panel" role="dialog" aria-label="Get more out of Meri">
      <header>
        <span>GET MORE OUT OF MERI</span>
        <button type="button" onClick={onClose}>
          CLOSE ⎋
        </button>
      </header>
      <div className="meri-v3-tip-content">
        <section>
          <div className="meri-v3-tip-title">
            <span>01</span>
            <strong>Tell Meri to remember things</strong>
          </div>
          <p>
            Say it plainly in the thread — “remember that this principal prefers one-page briefs” —
            and Meri proposes it as institutional memory. You approve it before it sticks, and future
            answers for that client can use it.
          </p>
          <blockquote>“Remember: we never cite draft RFP language with clients.”</blockquote>
        </section>
        <section>
          <div className="meri-v3-tip-title">
            <span>02</span>
            <strong>Turn a routine into a skill</strong>
          </div>
          <p>
            Describe a workflow you repeat, in your own words, and Meri can save it as a named skill
            you can call again. No server configuration belongs in this workspace.
          </p>
          <blockquote>
            “Create a skill called Monday Brief: for each client, list what moved last week, what
            needs a decision, and the sources.”
          </blockquote>
          <small>THEN JUST SAY: RUN MONDAY BRIEF</small>
        </section>
      </div>
    </div>
  );
}

function ReasoningChip({
  value,
  disabled,
  error,
  onChange,
}: {
  value: ReasoningMode;
  disabled: boolean;
  error: string | null;
  onChange: (mode: ReasoningMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = REASONING_MODES.find((mode) => mode.mode === value) ?? REASONING_MODES[1];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="meri-v3-mode-chip" ref={ref}>
      <button
        type="button"
        className="meri-v3-header-chip meri-v3-header-chip--button"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        MODE · {selected.label.toUpperCase()} ▾
      </button>
      {open ? (
        <div className="meri-v3-mode-menu" role="menu" aria-label="Reasoning mode">
          {REASONING_MODES.map((mode) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={mode.mode === value}
              key={mode.mode}
              onClick={() => {
                onChange(mode.mode);
                setOpen(false);
              }}
            >
              <span>
                <strong>{mode.label}</strong>
                <small>{mode.description}</small>
              </span>
              <i>{mode.mode === value ? '✓' : ''}</i>
            </button>
          ))}
        </div>
      ) : null}
      {error ? <div className="meri-v3-mode-error">{error}</div> : null}
    </div>
  );
}
