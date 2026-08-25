import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ManagedMcpAppsProvider } from '../../components/chat/managed-mcp-apps.js';
import { useApi } from '../../lib/use-api.js';
import { useMe } from '../../lib/me.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import type { MeriCitation } from '../../components/chat/chat-store.js';
import { MERI_LOGO_SRC } from './meri-presentation.js';
import type { MeriContextSection, MeriWindowChrome } from './meri-prefs.js';
import { VNextMeriTopBar } from './VNextMeriTopBar.js';
import { VNextMeriThreadRail } from './VNextMeriThreadRail.js';
import { VNextMeriConversation } from './VNextMeriConversation.js';
import { VNextMeriContextRail, type ActiveTurnInspector } from './VNextMeriContextRail.js';
import { MeriContextSheet } from './MeriContextSheet.js';
import { MeriCommandPalette } from './MeriCommandPalette.js';
import { MeriActionConfirm, MeriBulkActionConfirm } from './MeriActionConfirm.js';
import type { MeriTurnInspectorData, MeriTurnInspectorTab } from './MeriTurnInspector.js';
import type { PendingApproval } from '../../components/chat/useMeriChatController.js';
import {
  getMeriVNextPreferences,
  saveMeriVNextPreferences,
  type MeriContextPacket,
} from './meri-vnext-api.js';
import './vnext-meri.css';

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
  const [activeSourceDetail, setActiveSourceDetail] = useState<{
    citations: MeriCitation[];
    index: number;
  } | null>(null);
  const [contextSheet, setContextSheet] = useState<{
    open: boolean;
    packet: MeriContextPacket | null;
    loading: boolean;
    error: boolean;
  }>({ open: false, packet: null, loading: false, error: false });
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
  // Informed-consent gate, lifted from the old per-conversation
  // PendingApprovalsInline: a governed write only leaves the tenant after
  // the operator confirms this exact payload in the dialog. Lives here, not
  // in VNextMeriConversation, because both the transcript's "Review it" link
  // and the rail's Approvals tab need to trigger the same dialog.
  const [confirmFor, setConfirmFor] = useState<PendingApproval | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  const isTabletDown = useMatchesWidth('(max-width: 1179px)');
  const lastBandRef = useRef<boolean | null>(null);
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

  // A source-detail view pins to one turn's citations; switching threads
  // must not leave a stale panel referencing the previous thread's sources.
  useEffect(() => {
    setActiveSourceDetail(null);
  }, [controller.activeConversationId]);

  // A streamed document should surface immediately even if the rail was collapsed.
  useEffect(() => {
    if (controller.activeArtifact) setRailCollapsed(false);
  }, [controller.activeArtifact]);

  // A turn-inspector view pins to one turn; switching threads must not leave
  // a stale panel referencing the previous thread's data (same reasoning as
  // the activeSourceDetail reset above).
  useEffect(() => {
    setTurnInspectorData(null);
  }, [controller.activeConversationId]);

  // Drop a held confirm dialog if the server retires the proposal underneath
  // it — moved here verbatim from the old per-conversation
  // PendingApprovalsInline, which owned the same effect locally.
  useEffect(() => {
    if (!confirmFor) return;
    const live = controller.pendingApprovals.find(
      (proposal) => proposal.proposalId === confirmFor.proposalId,
    );
    if (!live) setConfirmFor(null);
    else if (live !== confirmFor) setConfirmFor(live);
  }, [confirmFor, controller.pendingApprovals]);

  const proposedApprovals = controller.pendingApprovals.filter(
    (proposal) => proposal.status === 'proposed',
  );
  useEffect(() => {
    if (bulkOpen && proposedApprovals.length === 0) setBulkOpen(false);
  }, [bulkOpen, proposedApprovals.length]);

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
    document.title = 'Meri — Capiro';
    return () => {
      document.title = previousTitle;
    };
  }, []);

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
  };

  /** Opens the turn inspector, called by VNextMeriMessage/VNextMeriConversation with the data view model for the turn being inspected. */
  const openTurnInspector = (data: MeriTurnInspectorData, tab: MeriTurnInspectorTab) => {
    setRailCollapsed(false);
    setTurnInspectorData(data);
    setTurnInspectorTab(tab);
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

  const activeTurnInspector: ActiveTurnInspector | null = turnInspectorData
    ? {
        activeTab: turnInspectorTab,
        data: { ...turnInspectorData, approvals: controller.pendingApprovals },
        approvingProposalId: controller.approvingProposalId,
        onApprove: (proposalId: string) => {
          const target = controller.pendingApprovals.find((p) => p.proposalId === proposalId);
          if (target) setConfirmFor(target);
        },
        onApproveAll: () => setBulkOpen(true),
        onDismiss: (proposalId: string) => void controller.handleDismissPending(proposalId),
      }
    : null;

  if (windowChrome === 'docked') {
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
        className={`vnext-meri-page${windowChrome === 'maximized' ? ' is-maximized' : ''}`}
        data-meri-page
      >
        <div className="vnext-meri" data-meri-window aria-label="Meri workspace">
          <VNextMeriTopBar
            controller={controller}
            me={me.data}
            windowChrome={windowChrome}
            onNewChat={handleNewChat}
            onSearch={() => setPaletteOpen(true)}
            onDock={() => setWindowChrome('docked')}
            onToggleMaximize={() =>
              setWindowChrome((current) => (current === 'maximized' ? 'undocked' : 'maximized'))
            }
            onClose={() => navigate('/')}
          />

          <div className="vnext-meri__body">
            {threadRailCollapsed ? null : (
              <VNextMeriThreadRail
                controller={controller}
                historyError={historyError}
                onRetryHistory={onRetryHistory}
                onNewChat={handleNewChat}
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
              onOpenSourceDetail={(citations, index) => {
                setActiveSourceDetail({ citations, index });
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
              onOpenIntegrations={handleOpenIntegrations}
              onOpenContext={(packet, loading, error) => setContextSheet({ open: true, packet, loading, error })}
              activeSourceDetail={activeSourceDetail}
              onCloseSourceDetail={() => setActiveSourceDetail(null)}
              activeArtifact={controller.activeArtifact}
              onCloseArtifact={() => controller.setActiveArtifact(null)}
              activeTurnInspector={activeTurnInspector}
              onChangeTurnInspectorTab={setTurnInspectorTab}
              onCloseTurnInspector={() => setTurnInspectorData(null)}
            />
          </div>
        </div>
      </div>
      <MeriContextSheet
        open={contextSheet.open}
        packet={contextSheet.packet}
        loading={contextSheet.loading}
        error={contextSheet.error}
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
        Lifted from the old per-conversation PendingApprovalsInline: both the
        transcript's aggregate "Review it" notice and the rail's Approvals
        tab trigger these same two dialogs, so they live once here rather
        than duplicated per caller.
      */}
      <MeriActionConfirm
        proposal={confirmFor}
        busy={Boolean(controller.approvingProposalId)}
        onCancel={() => setConfirmFor(null)}
        onConfirm={() => {
          const target = confirmFor;
          setConfirmFor(null);
          if (target) void controller.handleApprovePending(target.proposalId);
        }}
      />
      <MeriBulkActionConfirm
        proposals={proposedApprovals}
        open={bulkOpen}
        busy={Boolean(controller.approvingProposalId)}
        onCancel={() => setBulkOpen(false)}
        onConfirm={() => {
          setBulkOpen(false);
          void controller.handleApproveAll();
        }}
      />
    </ManagedMcpAppsProvider>
  );
}
