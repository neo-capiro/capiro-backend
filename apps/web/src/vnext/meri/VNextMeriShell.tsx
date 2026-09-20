import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ManagedMcpAppsProvider } from '../../components/chat/managed-mcp-apps.js';
import { useApi } from '../../lib/use-api.js';
import { useMe } from '../../lib/me.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { mergeMeriRuntimeStatus } from '../../components/chat/meri-runtime-status.js';
import { messageMeriTurnScope } from '../../components/chat/meri-turn-scope.js';
import { useMeriSourceSelection } from './useMeriSourceSelection.js';
import { MERI_LOGO_SRC } from './meri-presentation.js';
import type { MeriContextSection, MeriWindowChrome } from './meri-prefs.js';
import { VNextMeriTopBar } from './VNextMeriTopBar.js';
import { VNextMeriThreadRail } from './VNextMeriThreadRail.js';
import { VNextMeriConversation } from './VNextMeriConversation.js';
import { VNextMeriContextRail, type ActiveTurnInspector } from './VNextMeriContextRail.js';
import { MeriContextSheet } from './MeriContextSheet.js';
import { MeriCommandPalette } from './MeriCommandPalette.js';
import type { MeriTurnInspectorData, MeriTurnInspectorTab } from './MeriTurnInspector.js';
import { meriTurnInspectorInitialTab } from './MeriTurnInspector.js';
import { buildDefaultTurnInspector } from './meri-default-inspector.js';
import { useMeriInstall } from './meri-install.js';
import {
  getMeriVNextPreferences,
  saveMeriVNextPreferences,
  type MeriContextPacket,
} from './meri-vnext-api.js';
import './vnext-meri.css';
// Right-rail inspector header tools — compact context-packet / Context-Memory
// controls. Loads after vnext-meri.css.
import './meri-inspector.css';
// Responsive (phone/tablet) overrides — MUST load after vnext-meri.css so the
// media queries below win over the desktop base at equal/greater specificity.
import './meri-responsive.css';

interface VNextMeriShellProps {
  controller: MeriChatController;
  historyError: string | null;
  onRetryHistory: () => void;
  onArchiveThread: (conversationId: string) => Promise<boolean>;
  onRenameThread: (conversationId: string, title: string) => Promise<void>;
  onRestoreThread: (conversationId: string) => Promise<boolean>;
}

function displayName(me: ReturnType<typeof useMe>['data']): string {
  const first = me?.user.firstName?.trim() ?? '';
  const last = me?.user.lastName?.trim() ?? '';
  const full = `${first} ${last}`.trim();
  return full || me?.user.email?.split('@')[0] || 'Capiro user';
}

function shortGreetingName(me: ReturnType<typeof useMe>['data']): string {
  return me?.user.firstName?.trim() || displayName(me);
}

function useMatchesWidth(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mediaQuery = window.matchMedia(query);
    const sync = () => setMatches(mediaQuery.matches);
    sync();
    mediaQuery.addEventListener('change', sync);
    return () => mediaQuery.removeEventListener('change', sync);
  }, [query]);

  return matches;
}

export function VNextMeriShell({
  controller,
  historyError,
  onRetryHistory,
  onArchiveThread,
  onRenameThread,
  onRestoreThread,
}: VNextMeriShellProps) {
  const me = useMe();
  const api = useApi();
  const navigate = useNavigate();
  const install = useMeriInstall();
  const [windowChrome, setWindowChrome] = useState<MeriWindowChrome>('undocked');
  const [railCollapsed, setRailCollapsed] = useState(false);
  /**
   * Thread-rail collapse (handoff §"Three-column collapse rules" #2: "The
   * thread rail collapses behind a toggle button that appears at the left of
   * the conversation header").
   *
   * Client state, not a persisted preference: the vNext preferences contract
   * (`/api/clio/vnext/preferences`) validates exactly three keys and rejects
   * anything else, and the handoff only requires the *side panel*'s collapsed
   * state to persist per user. Logged in docs/handoff/GAPS.md rather than
   * silently widening the API payload.
   */
  const [threadRailCollapsed, setThreadRailCollapsed] = useState(false);
  const [openSection, setOpenSection] = useState<MeriContextSection | null>(null);
  const [preferencesHydrated, setPreferencesHydrated] = useState(false);
  const skipInitialPreferenceSaveRef = useRef(true);
  const [threadSearch, setThreadSearch] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const sourceSelection = useMeriSourceSelection({
    tenantId: me.data?.tenant.id, userId: me.data?.user.id,
    conversationId: controller.activeConversationId, messages: controller.messages,
  });
  const [contextSheet, setContextSheet] = useState<{
    open: boolean;
    packet: MeriContextPacket | null;
    loading: boolean;
    error: boolean;
    focusItemId?: string | null;
  }>({ open: false, packet: null, loading: false, error: false, focusItemId: null });
  const threadSearchRef = useRef<HTMLInputElement>(null);

  /**
   * v6 turn inspector (Thinking/Evidence/Approvals). Plain, un-persisted
   * client state — see the ActiveTurnInspector doc comment in
   * VNextMeriContextRail.tsx for why this deliberately does not go through
   * openSection/the vnext preferences endpoint. `turnInspectorData` is
   * supplied by whichever caller opens the panel (VNextMeriMessage already
   * computes its own per-message thinking/evidence view models for the old
   * inline tray; this reuses that same shaping rather than recomputing it
   * here) — Shell only owns which tab is active and the shared
   * approve/dismiss action plumbing, since Approvals is not actually
   * turn-scoped in the real data model (PendingApproval carries no
   * turn/message id) and must be shared with the aggregate notice mounted
   * once per conversation, not per message.
   */
  const [turnInspectorData, setTurnInspectorData] = useState<MeriTurnInspectorData | null>(null);
  const [turnInspectorTab, setTurnInspectorTab] = useState<MeriTurnInspectorTab>('thinking');
  /**
   * Which surface the right rail shows. The reference default is the turn
   * inspector (Thinking/Evidence/Approvals) for the latest assistant turn;
   * Context/Memory remain reachable as a compact overlay the user explicitly
   * opens and can leave again. `'inspector'` is the default; the Context and
   * Memory values reuse MeriContextSection so the existing section machinery
   * and its persisted `openSection` preference keep working unchanged.
   */
  const [railView, setRailView] = useState<'inspector' | MeriContextSection>('inspector');
  /**
   * True once the user has explicitly picked a tab this conversation — after
   * that their choice wins and the default-tab rule (Approvals when pending,
   * else Thinking) stops re-applying on incoming data.
   */
  const tabUserSelectedRef = useRef(false);

  const isTabletDown = useMatchesWidth('(max-width: 1179px)');
  const lastBandRef = useRef<boolean | null>(null);
  const lastLeftRailBandRef = useRef<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getMeriVNextPreferences(api)
      .then((preferences) => {
        if (cancelled) return;
        setWindowChrome(preferences.windowChrome);
        setRailCollapsed(preferences.railCollapsed);
        setOpenSection(preferences.openSection);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setPreferencesHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (lastBandRef.current === isTabletDown) return;
    lastBandRef.current = isTabletDown;
    if (!isTabletDown) return;
    setRailCollapsed(true);
  }, [isTabletDown]);

  /**
   * Auto-collapse the LEFT thread rail on entering the tablet/phone band
   * (<=1179px). At these widths the 282px rail plus a usable chat column
   * cannot share the row. This is client state (threadRailCollapsed is never
   * persisted — see the state comment above), so a saved desktop preference
   * can never re-expand it here and make the small layout unusable again. It
   * fires only on the transition INTO the band: once collapsed, the existing
   * "Show thread rail" header/landing control stays available and the user
   * may open/dismiss the rail freely without this effect overriding them.
   * On the way back to desktop the rail is left as the user last had it.
   */
  useEffect(() => {
    if (lastLeftRailBandRef.current === isTabletDown) return;
    lastLeftRailBandRef.current = isTabletDown;
    if (!isTabletDown) return;
    setThreadRailCollapsed(true);
  }, [isTabletDown]);

  // Restore the selected source after authenticated message hydration.
  useEffect(() => {
    if (sourceSelection.active) setRailCollapsed(false);
  }, [sourceSelection.active?.citations, sourceSelection.active?.index, preferencesHydrated]);

  // A streamed document should surface immediately even if the rail was collapsed.
  useEffect(() => {
    if (controller.activeArtifact) setRailCollapsed(false);
  }, [controller.activeArtifact]);

  // A turn-inspector view pins to one turn; switching threads must not leave
  // a stale panel referencing the previous thread's data (same reasoning as
  // the source selection's conversation-bound locator). Also reset the rail
  // back to its default inspector surface and clear the user-tab flag so the
  // new conversation picks its own default tab (Approvals when pending, else
  // Thinking) rather than inheriting the last thread's selection.
  useEffect(() => {
    setTurnInspectorData(null);
    setRailView('inspector');
    tabUserSelectedRef.current = false;
  }, [controller.activeConversationId]);

  useEffect(() => {
    if (!preferencesHydrated) return;
    if (skipInitialPreferenceSaveRef.current) {
      skipInitialPreferenceSaveRef.current = false;
      return;
    }
    void saveMeriVNextPreferences(api, { windowChrome, railCollapsed, openSection }).catch(() => undefined);
  }, [api, openSection, preferencesHydrated, railCollapsed, windowChrome]);

  const greetingName = shortGreetingName(me.data);
  const tenantName = me.data?.tenant.name ?? 'Capiro';

  useEffect(() => {
    const previousTitle = document.title;
    document.title = install.isStandalone ? 'Meri' : 'Meri — Capiro';
    return () => {
      document.title = previousTitle;
    };
  }, [install.isStandalone]);

  // ⌘K opening is owned by MeriCommandPalette while it is mounted.

  const handleNewChat = () => {
    setThreadSearch('');
    void controller.handleNewSession();
  };

  const handleOpenIntegrations = () => {
    navigate('/meri/integrations');
  };

  const expandSection = (section: MeriContextSection) => {
    setRailCollapsed(false);
    setOpenSection(section);
    // Opening Context/Memory is an explicit choice to leave the inspector;
    // the pinned turn (if any) is kept so the inspector's return control can
    // bring the user straight back without losing their place.
    setRailView(section);
  };

  /** Returns the rail to the default inspector surface (latest turn). */
  const showInspector = () => {
    setRailCollapsed(false);
    setRailView('inspector');
  };

  /** Opens the turn inspector pinned to a specific turn (Show work), called by VNextMeriMessage/VNextMeriConversation. */
  const openTurnInspector = (data: MeriTurnInspectorData, tab: MeriTurnInspectorTab) => {
    setRailCollapsed(false);
    setTurnInspectorData(data);
    setTurnInspectorTab(tab);
    setRailView('inspector');
    // An explicit "Show work" pick also counts as the user choosing a tab.
    tabUserSelectedRef.current = true;
  };

  /**
   * Opens straight to Approvals from the transcript's aggregate "Review it"
   * notice. Approvals are not turn-scoped in the real data (PendingApproval
   * carries no turn/message id — see the ActiveTurnInspector doc comment),
   * so there is no real per-turn Thinking/Evidence to show alongside them
   * here; those tabs honestly render their own empty state if the user
   * switches to them, rather than fabricating a turn association.
   */
  const openApprovalsPanel = () => {
    openTurnInspector(
      {
        turnId: 'pending-approvals',
        thinking: { plan: '', steps: [], intent: null, tier: null },
        evidence: { sources: [], verifyStats: [], claims: [], groundingCaveat: null, retrieval: null },
        approvals: controller.pendingApprovals,
      },
      'approvals',
    );
  };

  /**
   * MeriApprovalsTab (piece 2) already owns its own confirm-dialog gate
   * internally — local confirmFor/bulkOpen state, its own
   * MeriActionConfirm/MeriBulkActionConfirm — and only calls onApprove/
   * onApproveAll from inside that dialog's onConfirm. So these three are the
   * POST-confirmation actions, wired straight to the controller, the same as
   * what the dialogs themselves ultimately call; Shell does not gate them a
   * second time.
   */
  /**
   * The default inspector: the latest assistant turn, derived from real
   * message/controller data. Always present (even for an empty/new thread the
   * reference rail still shows the 3 tabs with honest empty states and any
   * conversation-level pending approvals). A user-pinned turn (Show work)
   * takes priority over this default until the conversation changes. Default
   * Evidence sources open the existing source-detail UI with the turn's
   * captured scope and citation index.
   */
  const defaultInspector = buildDefaultTurnInspector(controller, (citations, index, message) => {
    sourceSelection.open(citations, index, messageMeriTurnScope(message));
    setRailCollapsed(false);
  });
  const effectiveInspectorData = turnInspectorData ?? defaultInspector;

  /**
   * Default-tab rule: Approvals when the (conversation-level) approvals
   * contain one awaiting a decision, else Thinking. Applied only until the
   * user picks a tab themselves this conversation; after that their selection
   * is preserved and incoming data never steals it.
   */
  useEffect(() => {
    if (tabUserSelectedRef.current) return;
    const next = meriTurnInspectorInitialTab(effectiveInspectorData.approvals);
    setTurnInspectorTab((current) => (current === next ? current : next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveInspectorData.turnId, effectiveInspectorData.approvals, controller.activeConversationId]);

  const inspectedMessage = controller.messages.find((message) => message.id === effectiveInspectorData?.turnId);
  const inspectedRuntime = inspectedMessage?.runtimeStatus
    ? mergeMeriRuntimeStatus(effectiveInspectorData?.thinking.runtimeStatus, inspectedMessage.runtimeStatus)
    : effectiveInspectorData?.thinking.runtimeStatus;
  const activeTurnInspector: ActiveTurnInspector | null =
    effectiveInspectorData && railView === 'inspector'
      ? {
          activeTab: turnInspectorTab,
          data: {
            ...effectiveInspectorData,
            // Reopened/rehydrated execution state belongs to the exact message;
            // preserve the inspector's captured client scope and evidence.
            thinking: { ...effectiveInspectorData.thinking, runtimeStatus: inspectedRuntime },
            approvals: controller.pendingApprovals,
          },
          approvingProposalId: controller.approvingProposalId,
          onApprove: (proposalId: string) => void controller.handleApprovePending(proposalId),
          onApproveAll: () => void controller.handleApproveAll(),
          onDismiss: (proposalId: string) => void controller.handleDismissPending(proposalId),
        }
      : null;

  // An installed Meri app is already its own OS window. Always present the
  // workspace edge-to-edge there, even if the browser-mode preference was
  // previously saved as docked; do not overwrite that browser preference.
  const effectiveWindowChrome: MeriWindowChrome = install.isStandalone
    ? 'maximized'
    : windowChrome;

  if (effectiveWindowChrome === 'docked') {
    return (
      <div className="vnext-meri-page" data-meri-page>
        <button
          type="button"
          className="vnext-meri-docked"
          onClick={() => setWindowChrome('undocked')}
        >
          <span className="vnext-meri-docked__mark">
            <img src={MERI_LOGO_SRC} alt="" width={13} height={13} />
          </span>
          <span className="vnext-meri-docked__copy">
            <span className="vnext-meri-docked__title">Meri is docked</span>
            <span className="vnext-meri-docked__hint">CLICK TO REOPEN THE WORKSPACE</span>
          </span>
        </button>
      </div>
    );
  }

  return (
    <ManagedMcpAppsProvider>
      <div
        className={`vnext-meri-page${effectiveWindowChrome === 'maximized' ? ' is-maximized' : ''}`}
        data-meri-page
      >
        <div className="vnext-meri" data-meri-window aria-label="Meri workspace">
          <VNextMeriTopBar
            controller={controller}
            me={me.data}
            windowChrome={effectiveWindowChrome}
            onNewChat={handleNewChat}
            onSearch={() => setPaletteOpen(true)}
            onDock={() => setWindowChrome('docked')}
            onToggleMaximize={() =>
              setWindowChrome((current) => (current === 'maximized' ? 'undocked' : 'maximized'))
            }
            onClose={() => navigate('/')}
            showWindowControls={!install.isStandalone}
          />

          <div className="vnext-meri__body">
            {threadRailCollapsed ? null : (
              <VNextMeriThreadRail
                controller={controller}
                historyError={historyError}
                onRetryHistory={onRetryHistory}
                onArchiveThread={onArchiveThread}
                onRenameThread={onRenameThread}
                onRestoreThread={onRestoreThread}
                searchQuery={threadSearch}
                onSearchQueryChange={setThreadSearch}
                searchInputRef={threadSearchRef}
                onOpenPalette={() => setPaletteOpen(true)}
                onCollapse={() => setThreadRailCollapsed(true)}
              />
            )}

            <VNextMeriConversation
              controller={controller}
              greetingName={greetingName}
              tenantName={tenantName}
              onOpenIntegrations={handleOpenIntegrations}
              onOpenMemory={() => expandSection('memory')}
              threadRailCollapsed={threadRailCollapsed}
              onExpandThreadRail={() => setThreadRailCollapsed(false)}
              onOpenSourceDetail={(citations, index, turnScope) => {
                sourceSelection.open(citations, index, turnScope);
                setRailCollapsed(false);
              }}
              onOpenTurnInspector={openTurnInspector}
              onOpenApprovals={openApprovalsPanel}
            />

            <VNextMeriContextRail
              controller={controller}
              collapsed={railCollapsed}
              openSection={openSection}
              onToggle={() => setRailCollapsed((collapsed) => !collapsed)}
              onExpandSection={expandSection}
              onOpenContext={(packet, loading, error, focusItemId) =>
                setContextSheet({ open: true, packet, loading, error, focusItemId: focusItemId ?? null })
              }
              activeSourceDetail={sourceSelection.active}
              onCloseSourceDetail={sourceSelection.close}
              onSourceIndexChange={sourceSelection.changeIndex}
              activeArtifact={controller.activeArtifact}
              onCloseArtifact={() => controller.setActiveArtifact(null)}
              activeTurnInspector={activeTurnInspector}
              onChangeTurnInspectorTab={(tab) => {
                tabUserSelectedRef.current = true;
                setTurnInspectorTab(tab);
              }}
              onCloseTurnInspector={() => setTurnInspectorData(null)}
              onShowInspector={showInspector}
            />
          </div>
        </div>
      </div>
      <MeriContextSheet
        open={contextSheet.open}
        packet={contextSheet.packet}
        loading={contextSheet.loading}
        error={contextSheet.error}
        focusItemId={contextSheet.focusItemId}
        onClose={() => setContextSheet((current) => ({ ...current, open: false }))}
      />
      <MeriCommandPalette
        controller={controller}
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onOpenThread={(conversationId) =>
          navigate(`/meri/t/${encodeURIComponent(conversationId)}`)
        }
        onSelectClient={(clientId) => void controller.changeSessionClient(clientId)}
      />
      {/*
        No confirm dialogs mounted here: MeriApprovalsTab (the rail's
        Approvals tab) already owns MeriActionConfirm/MeriBulkActionConfirm
        internally, gating its own onApprove/onApproveAll calls on them.
        Duplicating that gate at Shell level would show the confirmation
        twice in sequence — see the doc comment on activeTurnInspector above.
      */}
    </ManagedMcpAppsProvider>
  );
}
