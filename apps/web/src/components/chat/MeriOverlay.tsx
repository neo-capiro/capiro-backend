import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  CloseOutlined,
  ColumnWidthOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  HistoryOutlined,
  MinusOutlined,
  MoreOutlined,
  PlusOutlined,
  SelectOutlined,
} from '@ant-design/icons';
import { useMe } from '../../lib/me.js';
import { MeriLegacyDrawer } from './ChatDrawer.js';
import { ManagedMcpAppsProvider } from './managed-mcp-apps.js';
import { useMeriChatController, type MeriChatController } from './useMeriChatController.js';
import { SessionRail } from './SessionRail.js';
import { MeriWorkspaceWindow } from './MeriWorkspaceWindow.js';
import { isMeriWorkspaceWindow, openMeriWorkspaceWindow } from './meri-window.js';
import {
  raiseMeriSurface,
  setChatOpen,
  setMeriMaximized,
  setMeriPointerState,
  setMeriSideCollapsed,
  setMeriSurfaceMode,
  setMeriUndockedRect,
  toggleSessionRail,
  useChatStore,
} from './chat-store.js';
import {
  clampUndockedRect,
  defaultUndockedRect,
  maxUndockedRect,
  parsePersistedUndockedRect,
  resizeUndockedRect,
  type MeriRect,
  type MeriResizeEdge,
  type MeriViewport,
} from './meri-geometry.js';
import meriBubbleImage from '../../assets/chat/meri-bubble.png';
import './meri-overlay.css';

const RECT_STORAGE_KEY = 'capiro:meri-undocked-rect:v1';
const MOBILE_BREAKPOINT = 720;

interface MeriOverlayProps {
  selectedClientName?: string | null;
}

type PointerOperation = {
  kind: 'drag' | 'resize';
  edge?: MeriResizeEdge;
  startX: number;
  startY: number;
  rect: MeriRect;
};

function currentViewport(): MeriViewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

export function MeriOverlay({ selectedClientName }: MeriOverlayProps) {
  const controller = useMeriChatController({ selectedClientName });
  const me = useMe();
  const workspaceWindow = isMeriWorkspaceWindow();
  const meriv3Enabled = Boolean(me.data?.features.meriv3Chat);
  const { surfaceMode } = useChatStore();

  useEffect(() => {
    if (workspaceWindow && meriv3Enabled) setChatOpen(true);
  }, [meriv3Enabled, workspaceWindow]);

  if (workspaceWindow) {
    if (me.isLoading) {
      return (
        <div className="meri-v3-workspace-loading" role="status">
          Opening Meri…
        </div>
      );
    }
    if (!meriv3Enabled) {
      return (
        <div className="meri-v3-workspace-loading" role="alert">
          <strong>MeriV3 is not enabled for this tenant.</strong>
          <button type="button" onClick={() => window.close()}>
            Close window
          </button>
        </div>
      );
    }
    return <MeriWorkspaceWindow controller={controller} />;
  }

  const overlay = <MeriOverlaySurface controller={controller} openInBrowserWindow={meriv3Enabled} />;
  // Normally MeriV3 opens its own browser window, where MeriWorkspaceWindow
  // owns the connected-app provider. If that browser popup is blocked, the
  // launcher intentionally falls back to the large in-page UND0CKED surface.
  // Mount the same provider only after that fallback opens so the `+` menu is
  // identical without preloading app status while the launcher is closed.
  return meriv3Enabled && surfaceMode !== 'closed' ? (
    <ManagedMcpAppsProvider>{overlay}</ManagedMcpAppsProvider>
  ) : (
    overlay
  );
}

export function MeriOverlaySurface({
  controller,
  historySidebar,
  showEmbeddedSessionRail = true,
  openInBrowserWindow = false,
}: {
  controller: MeriChatController;
  historySidebar?: ReactNode;
  showEmbeddedSessionRail?: boolean;
  openInBrowserWindow?: boolean;
}) {
  const {
    surfaceMode,
    maximized,
    sideCollapsed,
    undockedRect,
    dragging,
    resizing,
    zOrder,
    alertsBadge,
  } = useChatStore();
  const [viewport, setViewport] = useState<MeriViewport>(() => currentViewport());
  const [detailsOpen, setDetailsOpen] = useState(false);
  const operationRef = useRef<PointerOperation | null>(null);
  const viewportRef = useRef(viewport);
  const undockedRectRef = useRef(undockedRect);
  viewportRef.current = viewport;
  undockedRectRef.current = undockedRect;
  const isMobile = viewport.width <= MOBILE_BREAKPOINT;

  useEffect(() => {
    if (undockedRect) return;
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(RECT_STORAGE_KEY);
    } catch {
      // Storage can be blocked by privacy policy; geometry still works in-memory.
    }
    const persisted = parsePersistedUndockedRect(raw, viewport);
    setMeriUndockedRect(persisted ?? defaultUndockedRect(viewport));
  }, [undockedRect, viewport]);

  useEffect(() => {
    if (!undockedRect) return;
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(RECT_STORAGE_KEY, JSON.stringify(undockedRect));
      } catch {
        // Non-fatal: preserve the current-session rect in the store.
      }
    }, 150);
    return () => window.clearTimeout(timer);
  }, [undockedRect]);

  useEffect(() => {
    const onResize = () => {
      const nextViewport = currentViewport();
      setViewport(nextViewport);
      if (undockedRectRef.current) {
        setMeriUndockedRect(clampUndockedRect(undockedRectRef.current, nextViewport));
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const finishPointerOperation = useCallback(() => {
    operationRef.current = null;
    setMeriPointerState({ dragging: false, resizing: false });
  }, []);

  const movePointerOperation = useCallback((event: PointerEvent) => {
    const operation = operationRef.current;
    if (!operation) return;
    const deltaX = event.clientX - operation.startX;
    const deltaY = event.clientY - operation.startY;
    const next =
      operation.kind === 'resize' && operation.edge
        ? resizeUndockedRect(operation.rect, operation.edge, deltaX, deltaY, viewportRef.current)
        : clampUndockedRect(
            { ...operation.rect, x: operation.rect.x + deltaX, y: operation.rect.y + deltaY },
            viewportRef.current,
          );
    setMeriUndockedRect(next);
  }, []);

  useEffect(() => {
    window.addEventListener('pointermove', movePointerOperation);
    window.addEventListener('pointerup', finishPointerOperation);
    window.addEventListener('pointercancel', finishPointerOperation);
    return () => {
      window.removeEventListener('pointermove', movePointerOperation);
      window.removeEventListener('pointerup', finishPointerOperation);
      window.removeEventListener('pointercancel', finishPointerOperation);
      finishPointerOperation();
    };
  }, [finishPointerOperation, movePointerOperation]);

  const beginPointerOperation = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      kind: PointerOperation['kind'],
      edge?: MeriResizeEdge,
    ) => {
      if (event.button !== 0 || maximized || isMobile || !undockedRect) return;
      event.preventDefault();
      operationRef.current = {
        kind,
        edge,
        startX: event.clientX,
        startY: event.clientY,
        rect: undockedRect,
      };
      setMeriPointerState({ dragging: kind === 'drag', resizing: kind === 'resize' });
      raiseMeriSurface();
    },
    [isMobile, maximized, undockedRect],
  );

  const shellRect = useMemo(() => {
    if (maximized || isMobile) return maxUndockedRect(viewport);
    return undockedRect ?? defaultUndockedRect(viewport);
  }, [isMobile, maximized, undockedRect, viewport]);

  const openDocked = () => setMeriSurfaceMode('docked');
  const undock = () => {
    if (!undockedRect) setMeriUndockedRect(defaultUndockedRect(viewport));
    setMeriSurfaceMode('undocked');
    raiseMeriSurface();
  };
  const openPrimarySurface = () => {
    if (openInBrowserWindow) {
      const popup = openMeriWorkspaceWindow();
      if (popup) {
        setMeriSurfaceMode('closed');
        return;
      }
      // A popup blocker must not force the canary back into the skinny drawer.
      undock();
      return;
    }
    openDocked();
  };
  const redock = () => setMeriSurfaceMode('docked');
  const close = () => controller.handleClose();
  const toggleMaximized = () => setMeriMaximized(!maximized);

  if (surfaceMode === 'closed') {
    if (controller.hideMeriFab) return null;
    return (
      <button
        type="button"
        className="meri-launcher"
        onClick={openPrimarySurface}
        aria-label={`${openInBrowserWindow ? 'Open Meri workspace window' : 'Open Meri'}${
          alertsBadge > 0 ? `, ${alertsBadge} pending briefings` : ''
        }`}
        title={openInBrowserWindow ? 'Open Meri workspace' : 'Meri'}
        data-tour="Meri"
      >
        <img src={meriBubbleImage} alt="" className="meri-launcher-logo" />
        <span className="meri-launcher-presence" aria-hidden="true" />
        {alertsBadge > 0 && (
          <span className="meri-launcher-badge" aria-hidden="true">
            {alertsBadge}
          </span>
        )}
        <span className="meri-launcher-tooltip" role="tooltip">
          Ask Meri
        </span>
      </button>
    );
  }

  const shellStyle =
    surfaceMode === 'undocked' && !isMobile
      ? {
          left: shellRect.x,
          top: shellRect.y,
          width: shellRect.width,
          height: shellRect.height,
          zIndex: zOrder,
        }
      : undefined;

  return (
    <section
      className={`meri-overlay meri-overlay--${surfaceMode}${
        sideCollapsed ? ' meri-overlay--sidebar-collapsed' : ''
      }${dragging || resizing ? ' meri-overlay--pointer-active' : ''}${
        isMobile ? ' meri-overlay--mobile' : ''
      }${detailsOpen ? ' meri-overlay--details-open' : ''}`}
      style={shellStyle}
      aria-label="Meri assistant"
      onPointerDown={raiseMeriSurface}
    >
      {surfaceMode === 'docked' ? (
        <DockedHeader controller={controller} onUndock={undock} onClose={close} />
      ) : (
        <UndockedTitlebar
          maximized={maximized}
          sideCollapsed={sideCollapsed}
          onClose={close}
          onMinimize={close}
          onMaximize={toggleMaximized}
          onRedock={redock}
          onToggleSidebar={() => setMeriSideCollapsed(!sideCollapsed)}
          onPointerDown={(event) => beginPointerOperation(event, 'drag')}
        />
      )}

      {surfaceMode === 'undocked' ? (
        <div className="meri-overlay-undocked-body">
          <aside className="meri-overlay-sidebar" aria-label="Conversation history">
            {historySidebar ?? <SessionRail forceOpen />}
          </aside>
          <main className="meri-overlay-main">
            <UndockedConversationHeader
              controller={controller}
              detailsOpen={detailsOpen}
              onToggleDetails={() => setDetailsOpen((current) => !current)}
            />
            <MeriLegacyDrawer
              controller={controller}
              embedded
              surface="undocked"
              showSessionRail={false}
            />
          </main>
        </div>
      ) : (
        <MeriLegacyDrawer
          controller={controller}
          embedded
          surface="docked"
          showSessionRail={showEmbeddedSessionRail}
        />
      )}

      {surfaceMode === 'undocked' && !maximized && !isMobile && (
        <>
          {(['n', 's', 'e', 'w', 'se', 'sw'] as MeriResizeEdge[]).map((edge) => (
            <div
              key={edge}
              className={`meri-resize-handle meri-resize-handle--${edge}`}
              onPointerDown={(event) => beginPointerOperation(event, 'resize', edge)}
              aria-hidden="true"
            />
          ))}
        </>
      )}
    </section>
  );
}

function DockedHeader({
  controller,
  onUndock,
  onClose,
}: {
  controller: MeriChatController;
  onUndock: () => void;
  onClose: () => void;
}) {
  return (
    <header className="meri-docked-header">
      <span className="meri-docked-identity">
        <span className="meri-docked-avatar">
          <img src={meriBubbleImage} alt="" />
          <span aria-hidden="true" />
        </span>
        <span>
          <strong>Meri</strong>
          <small>Workspace assistant · online</small>
        </span>
      </span>
      <span className="meri-docked-actions">
        <IconButton label="Conversation history" onClick={toggleSessionRail}>
          <HistoryOutlined />
        </IconButton>
        <IconButton label="Undock — open as a window" accent onClick={onUndock}>
          <SelectOutlined />
        </IconButton>
        <IconButton
          label="Start new conversation"
          onClick={() => void controller.handleNewSession()}
        >
          <PlusOutlined />
        </IconButton>
        <IconButton label="Close Meri" onClick={onClose}>
          <CloseOutlined />
        </IconButton>
      </span>
    </header>
  );
}

function UndockedTitlebar({
  maximized,
  sideCollapsed,
  onClose,
  onMinimize,
  onMaximize,
  onRedock,
  onToggleSidebar,
  onPointerDown,
}: {
  maximized: boolean;
  sideCollapsed: boolean;
  onClose: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onRedock: () => void;
  onToggleSidebar: () => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  return (
    <header className="meri-titlebar" onPointerDown={onPointerDown} onDoubleClick={onMaximize}>
      <span className="meri-traffic-lights" onPointerDown={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="meri-light meri-light--red"
          onClick={onClose}
          aria-label="Close Meri"
          title="Close"
        >
          <CloseOutlined />
        </button>
        <button
          type="button"
          className="meri-light meri-light--amber"
          onClick={onMinimize}
          aria-label="Minimize Meri"
          title="Minimize"
        >
          <MinusOutlined />
        </button>
        <button
          type="button"
          className="meri-light meri-light--green"
          onClick={onMaximize}
          aria-label={maximized ? 'Restore Meri window' : 'Maximize Meri window'}
          title={maximized ? 'Restore' : 'Maximize'}
        >
          {maximized ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
        </button>
      </span>
      <span className="meri-titlebar-title">
        <span className="meri-titlebar-avatar">
          <img src={meriBubbleImage} alt="" />
        </span>
        <strong>Meri</strong>
        <span className="meri-titlebar-tag">Chief of Staff</span>
      </span>
      <span className="meri-titlebar-actions" onPointerDown={(event) => event.stopPropagation()}>
        <IconButton
          label={sideCollapsed ? 'Expand conversation history' : 'Collapse conversation history'}
          active={!sideCollapsed}
          onClick={onToggleSidebar}
        >
          <ColumnWidthOutlined />
        </IconButton>
        <IconButton label="Re-dock Meri to the corner" onClick={onRedock}>
          <SelectOutlined rotate={180} />
        </IconButton>
      </span>
    </header>
  );
}

function UndockedConversationHeader({
  controller,
  detailsOpen,
  onToggleDetails,
}: {
  controller: MeriChatController;
  detailsOpen: boolean;
  onToggleDetails: () => void;
}) {
  return (
    <div className="meri-conversation-header">
      <strong>{controller.sessionTitle.trim() || 'New chat'}</strong>
      <MeriModePicker controller={controller} />
      <button
        type="button"
        className="meri-conversation-more"
        onClick={onToggleDetails}
        aria-label="Conversation settings"
        aria-expanded={detailsOpen}
        title="Conversation settings"
      >
        <MoreOutlined />
      </button>
    </div>
  );
}

function MeriModePicker({ controller }: { controller: MeriChatController }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const mode = controller.researchMode ? 'research' : controller.writeMode ? 'write' : 'standard';
  const labels = { standard: 'Standard', research: 'Research', write: 'Write' } as const;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const select = (next: keyof typeof labels) => {
    controller.setResearchMode(next === 'research');
    controller.setWriteMode(next === 'write');
    if (next !== 'research') {
      controller.researchSessionRef.current = null;
      controller.setResearchAwaitingAnswers(false);
      controller.setResearchQuestions([]);
    }
    setOpen(false);
  };

  return (
    <div className="meri-mode-picker" ref={ref}>
      <button
        type="button"
        className="meri-mode-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span aria-hidden="true" /> Meri · {labels[mode]} <small>⌄</small>
      </button>
      {open && (
        <div className="meri-mode-menu" role="listbox" aria-label="Meri mode">
          {(
            [
              ['standard', 'Everyday questions and analysis'],
              ['research', 'Plan and run cited deep research'],
              ['write', 'Draft or update the current page'],
            ] as const
          ).map(([key, description]) => (
            <button
              key={key}
              type="button"
              role="option"
              aria-selected={mode === key}
              onClick={() => select(key)}
            >
              <span>
                <strong>{labels[key]}</strong>
                <small>{description}</small>
              </span>
              {mode === key ? '✓' : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function IconButton({
  label,
  children,
  onClick,
  accent = false,
  active = false,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
  accent?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      className={`meri-icon-button${accent ? ' meri-icon-button--accent' : ''}${active ? ' meri-icon-button--active' : ''}`}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}
