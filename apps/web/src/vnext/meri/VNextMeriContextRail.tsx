import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../../lib/use-api.js';
import { config } from '../../env.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import type { MeriCitation } from '../../components/chat/chat-store.js';
import { MeriSourceDetail } from './MeriSourceDetail.js';
import { MeriArtifactCanvas } from './MeriArtifactCanvas.js';
import type { CanvasArtifact } from '../../components/chat/MeriCanvas.js';
import { MeriIcon, type MeriIconName } from './meri-icons.js';
import type { MeriContextSection } from './meri-prefs.js';
import { activeContextLabels, contextPacketSummary } from './meri-context-packet.js';
import { fetchLatestMeriContextPacket, type MeriContextPacket } from './meri-vnext-api.js';
import { MeriMemoryTab, useMeriGovernedMemoryQueues } from './MeriMemoryTab.js';
import { MeriPanelState } from './MeriPanelState.js';
import {
  MeriTurnInspector,
  type MeriTurnInspectorData,
  type MeriTurnInspectorTab,
} from './MeriTurnInspector.js';

interface ActiveSourceDetail {
  citations: MeriCitation[];
  index: number;
}

/**
 * v6 turn inspector — a third override state alongside activeArtifact and
 * activeSourceDetail (see the block comment above PANEL_TABS). Turn-scoped,
 * so it is plain, un-persisted client state: unlike openSection, "which
 * turn's panel was open" is not something you would want restored days
 * later, and the backend's MeriVNextPreferenceInput.openSection enum
 * (apps/api/src/meri/meri-vnext-library.service.ts normalizePreference)
 * only accepts 'context' | 'sources' | 'actions' | 'memory' | null today —
 * these three new tab keys would 400 if pushed through that endpoint.
 */
export interface ActiveTurnInspector {
  activeTab: MeriTurnInspectorTab;
  data: MeriTurnInspectorData;
  approvingProposalId: string | null;
  onApprove: (proposalId: string) => void;
  onApproveAll: () => void;
  onDismiss: (proposalId: string) => void;
}

interface VNextMeriContextRailProps {
  controller: MeriChatController;
  collapsed: boolean;
  openSection: MeriContextSection | null;
  onToggle: () => void;
  onExpandSection: (section: MeriContextSection) => void;
  onOpenContext: (
    packet: MeriContextPacket | null,
    loading: boolean,
    error: boolean,
    focusItemId?: string | null,
  ) => void;
  /** Set when a citation's "View full source" was clicked; swaps out the normal section stack. */
  activeSourceDetail: ActiveSourceDetail | null;
  onCloseSourceDetail: () => void;
  /** Set while a streamed document is open; swaps out the normal section stack. */
  activeArtifact: CanvasArtifact | null;
  onCloseArtifact: () => void;
  /**
   * Set while a turn's Thinking/Evidence/Approvals panel is open; swaps out
   * the normal section stack. Optional and un-wired by the shell today — the
   * integration that focuses a turn and supplies real data is a follow-up
   * step; every existing caller of this component keeps compiling unchanged.
   */
  activeTurnInspector?: ActiveTurnInspector | null;
  onChangeTurnInspectorTab?: (tab: MeriTurnInspectorTab) => void;
  onCloseTurnInspector?: () => void;
}

export function normalizeMeriQuickActionCatalog(value: unknown): MeriQuickAction[] {
  if (!value || typeof value !== 'object') return [];
  const row = value as { enabled?: unknown; skills?: unknown };
  if (row.enabled !== true || !Array.isArray(row.skills)) return [];
  return row.skills.flatMap((skill): MeriQuickAction[] => {
    if (!skill || typeof skill !== 'object') return [];
    const candidate = skill as Record<string, unknown>;
    if (
      typeof candidate.id !== 'string' ||
      typeof candidate.label !== 'string' ||
      typeof candidate.starterPrompt !== 'string' ||
      candidate.quickAction !== true
    ) {
      return [];
    }
    const description =
      typeof candidate.description === 'string' && candidate.description.trim()
        ? candidate.description.trim()
        : null;
    return [{
      id: candidate.id,
      label: candidate.label.trim() || candidate.id,
      description,
      starterPrompt: candidate.starterPrompt,
      requiresClient: candidate.requiresClient === true,
    }];
  });
}

export interface MeriQuickAction {
  id: string;
  label: string;
  description: string | null;
  starterPrompt: string;
  requiresClient: boolean;
}

/**
 * v4's rail is an exclusive one-of switcher — Context or Memory, full panel,
 * not sibling accordions. Connected Sources and Skills are sections *inside*
 * the Context panel, not their own tabs; Artifact and Source Detail are
 * reached only as overrides (an active artifact/citation), never as an
 * always-present tab, since there's no real "browse past artifacts" data to
 * back a tab that's clickable when nothing is loaded.
 */
const PANEL_TABS: Array<{ key: MeriContextSection; icon: MeriIconName; label: string }> = [
  { key: 'context', icon: 'Sliders02', label: 'Context' },
  { key: 'memory', icon: 'Database01', label: 'Memory' },
];

/**
 * The turn inspector's own exclusive switcher — Thinking / Evidence /
 * Approvals — reusing the exact tab-strip classes PANEL_TABS renders with
 * (meri-rail-panel-structure.test.ts pins those classes, not the tab keys
 * themselves, so this second switcher costs no new header CSS). It replaces
 * the Context/Memory strip only while a turn is focused, the same way
 * activeArtifact/activeSourceDetail replace the whole section stack.
 */
const TURN_TABS: Array<{ key: MeriTurnInspectorTab; icon: MeriIconName; label: string }> = [
  { key: 'thinking', icon: 'CpuChip01', label: 'Thinking' },
  { key: 'evidence', icon: 'ShieldTick', label: 'Evidence' },
  { key: 'approvals', icon: 'Lock01', label: 'Approvals' },
];


const UNUSABLE_ATTACHMENT_STATES = new Set(['error', 'scanned', 'unsupported']);

export function VNextMeriContextRail({
  controller,
  collapsed,
  openSection,
  onToggle,
  onExpandSection,
  onOpenContext,
  activeSourceDetail,
  onCloseSourceDetail,
  activeArtifact,
  onCloseArtifact,
  activeTurnInspector,
  onChangeTurnInspectorTab,
  onCloseTurnInspector,
}: VNextMeriContextRailProps) {
  const api = useApi();
  const [packet, setPacket] = useState<MeriContextPacket | null>(null);
  const [packetLoading, setPacketLoading] = useState(false);
  const [packetError, setPacketError] = useState(false);

  useEffect(() => {
    const conversationId = controller.activeConversationId;
    if (!conversationId || controller.isStreaming) {
      setPacket(null);
      setPacketLoading(false);
      setPacketError(false);
      return;
    }
    let cancelled = false;
    setPacketLoading(true);
    setPacketError(false);
    void fetchLatestMeriContextPacket(api, conversationId)
      .then((next) => {
        if (!cancelled) setPacket(next);
      })
      .catch(() => {
        if (!cancelled) {
          setPacket(null);
          setPacketError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setPacketLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, controller.activeConversationId, controller.isStreaming]);

  const pendingAttachments = useMemo(() => {
    const items = new Map<string, { id: string; title: string; kind: string }>();
    for (const attachment of controller.stagedAttachments) {
      if (UNUSABLE_ATTACHMENT_STATES.has(attachment.status)) continue;
      const key = attachment.id || attachment.localId;
      items.set(key, {
        id: key,
        title: attachment.filename,
        kind: attachment.status === 'uploading' ? 'UPLOADING' : String(attachment.kind || 'file').replace(/_/g, ' ').toUpperCase(),
      });
    }
    return [...items.values()];
  }, [controller.stagedAttachments]);

  const contextItems = useMemo(() => activeContextLabels(packet), [packet]);

  const { reviewCount, pendingProposalCount } = useMeriGovernedMemoryQueues();
  const pendingMemoryCount = reviewCount + pendingProposalCount;

  const badgeFor = (section: MeriContextSection): number => {
    if (section === 'context') return contextItems.length;
    if (section === 'memory') return pendingMemoryCount;
    return 0;
  };

  if (collapsed) {
    return (
      <aside className="vnext-meri__rail-right is-collapsed" data-meri-context-rail aria-label="Context panel (collapsed)">
        <div className="vnext-meri__rail-collapsed">
          <button type="button" className="vnext-meri__rail-expand-btn" title="Expand panel" aria-label="Expand panel" onClick={onToggle}>
            <MeriIcon name="Expand01" size={16} color="#667085" />
          </button>
          <span className="vnext-meri__rail-collapsed-label">BEHIND THE ANSWER</span>
        </div>
      </aside>
    );
  }

  const isMemoryPanel = openSection === 'memory';
  // v6 prototype: the right rail's title is always "Behind the answer" —
  // both the Context and Memory tabs live under it.
  const panelTitle = 'Behind the answer';
  const selectedClient = controller.clients.find((client) => client.id === controller.selectedClientValue) ?? null;
  const scopeLabel = selectedClient ? selectedClient.name : 'Portfolio — all clients';

  if (activeArtifact) {
    return (
      <aside className="vnext-meri__rail-right is-expanded" data-meri-context-rail aria-label="Artifact">
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div className="vnext-meri__rail-panel-head">
            <span className="vnext-meri__rail-panel-title">ARTIFACT CANVAS</span>
            <button type="button" className="vnext-meri__rail-panel-collapse" title="Collapse panel" aria-label="Collapse panel" onClick={onToggle}>
              <MeriIcon name="ChevronRight" size={15} color="#98A2B3" />
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <MeriArtifactCanvas
              artifact={activeArtifact}
              onClose={onCloseArtifact}
              apiBaseUrl={config.apiBaseUrl}
              getAuthHeaders={controller.authHeaders}
            />
          </div>
        </div>
      </aside>
    );
  }

  if (activeSourceDetail) {
    return (
      <aside className="vnext-meri__rail-right is-expanded" data-meri-context-rail aria-label="Source detail">
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div className="vnext-meri__rail-panel-head">
            <span className="vnext-meri__rail-panel-title">SOURCE DETAIL</span>
            <button type="button" className="vnext-meri__rail-panel-collapse" title="Collapse panel" aria-label="Collapse panel" onClick={onToggle}>
              <MeriIcon name="ChevronRight" size={15} color="#98A2B3" />
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <MeriSourceDetail
              citations={activeSourceDetail.citations}
              initialIndex={activeSourceDetail.index}
              scopeLabel={scopeLabel}
              onClose={onCloseSourceDetail}
            />
          </div>
        </div>
      </aside>
    );
  }

  if (activeTurnInspector) {
    const turnActiveTab = activeTurnInspector.activeTab;
    return (
      <aside className="vnext-meri__rail-right is-turn-inspector" data-meri-context-rail aria-label="Turn inspector">
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div className="vnext-meri__rail-panel-head">
            <span className="vnext-meri__rail-panel-title-group">
              <span className="vnext-meri__rail-panel-title">Behind the answer</span>
              <span className="vnext-meri__rail-panel-eyebrow">{scopeLabel.toUpperCase()}</span>
            </span>
            <div className="vnext-meri__rail-panel-tabs">
              {TURN_TABS.map((tab) => {
                const active = turnActiveTab === tab.key;
                const badge =
                  tab.key === 'evidence'
                    ? activeTurnInspector.data.evidence.sources.length
                    : tab.key === 'approvals'
                      ? activeTurnInspector.data.approvals.filter(
                          (proposal) => proposal.status === 'proposed' || proposal.status === 'failed_retryable',
                        ).length
                      : 0;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    className={`vnext-meri__rail-panel-tab${active ? ' is-active' : ''}`}
                    title={tab.label}
                    aria-label={tab.label}
                    aria-pressed={active}
                    onClick={() => onChangeTurnInspectorTab?.(tab.key)}
                  >
                    <span>{tab.label.toUpperCase()}</span>
                    {badge > 0 ? <span className="vnext-meri__rail-panel-tab-badge">{badge}</span> : null}
                  </button>
                );
              })}
            </div>
            <button type="button" className="vnext-meri__rail-panel-collapse" title="Collapse panel" aria-label="Collapse panel" onClick={onToggle}>
              <MeriIcon name="ChevronRight" size={15} color="#98A2B3" />
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <MeriTurnInspector
              data={activeTurnInspector.data}
              activeTab={turnActiveTab}
              onClose={() => onCloseTurnInspector?.()}
              approvingProposalId={activeTurnInspector.approvingProposalId}
              onApprove={activeTurnInspector.onApprove}
              onApproveAll={activeTurnInspector.onApproveAll}
              onDismiss={activeTurnInspector.onDismiss}
            />
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="vnext-meri__rail-right is-expanded" data-meri-context-rail aria-label="Context panel">
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div className="vnext-meri__rail-panel-head">
          <span className="vnext-meri__rail-panel-title-group">
            <span className="vnext-meri__rail-panel-title">{panelTitle}</span>
            <span className="vnext-meri__rail-panel-eyebrow">{scopeLabel.toUpperCase()}</span>
          </span>
          <div className="vnext-meri__rail-panel-tabs">
            {PANEL_TABS.map((tab) => {
              const active = (openSection ?? 'context') === tab.key;
              const badge = badgeFor(tab.key);
              return (
                <button key={tab.key} type="button" className={`vnext-meri__rail-panel-tab${active ? ' is-active' : ''}`} title={tab.label} aria-label={tab.label} aria-pressed={active} onClick={() => onExpandSection(tab.key)}>
                  <span>{tab.label.toUpperCase()}</span>
                  {badge > 0 ? <span className="vnext-meri__rail-panel-tab-badge">{badge}</span> : null}
                </button>
              );
            })}
          </div>
          <button type="button" className="vnext-meri__rail-panel-collapse" title="Collapse panel" aria-label="Collapse panel" onClick={onToggle}>
            <MeriIcon name="ChevronRight" size={15} color="#98A2B3" />
          </button>
        </div>

        {isMemoryPanel ? (
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <div className="vnext-meri__rail-section">
              <MeriMemoryTab packet={packet} />
              <div className="vnext-meri__rail-footer">INSTITUTIONAL MEMORY · GOVERNED BY SCOPE AND REVIEW</div>
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <div className="vnext-meri__rail-section">
              <div className="vnext-meri__rail-footer" style={{ marginTop: 0, marginBottom: 14 }}>
                CONTEXT IS CLIENT-SCOPED · WRITES REQUIRE APPROVAL
              </div>
              {packet?.degraded ? (
                <div className="vnext-meri__ctx-degraded" role="status">
                  <MeriIcon name="AlertTriangle" size={15} color="#B54708" />
                  <span className="vnext-meri__ctx-degraded-text">
                    {packet.degradedReason ?? 'Context provenance is degraded for this thread.'}
                  </span>
                </div>
              ) : null}
              <div className="vnext-meri__rail-section-head">
                <span className="vnext-meri__section-label">ACTIVE CONTEXT{contextItems.length ? ` · ${contextItems.length}` : ''}</span>
                <MeriIcon name="ChevronUp" size={14} color="#98A2B3" />
              </div>
              <div className="vnext-meri__rail-section-content">
                {packetLoading ? <MeriPanelState tone="loading">Loading compiled context…</MeriPanelState> : null}
                {packetError ? <MeriPanelState tone="error">Context provenance could not be loaded.</MeriPanelState> : null}
                {contextItems.length ? (
                  <div className="vnext-meri__ctx-list">
                    {contextItems.slice(0, 5).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="vnext-meri__ctx-item"
                        title={`Preview ${item.title}`}
                        onClick={() => onOpenContext(packet, packetLoading, packetError, item.id)}
                      >
                        <span className="vnext-meri__ctx-item-tile"><MeriIcon name="File05" size={14} color="#101828" /></span>
                        <div className="vnext-meri__ctx-item-body">
                          <span className="vnext-meri__ctx-item-title">{item.title}</span>
                          <span className="vnext-meri__ctx-item-kind">{item.kind}</span>
                        </div>
                        <span className="vnext-meri__ctx-item-dot" title="Included by the server-side context compiler" />
                      </button>
                    ))}
                  </div>
                ) : !packetLoading && !packetError ? <MeriPanelState tone="empty">{contextPacketSummary(packet)}</MeriPanelState> : null}
                {packet && packet.exclusions.length ? (
                  <div className="vnext-meri__ctx-list" aria-label="Context not included">
                    <span className="vnext-meri__section-label">NOT INCLUDED · {packet.exclusions.length}</span>
                    {packet.exclusions.slice(0, 5).map((exclusion, index) => (
                      <div key={exclusion.id ?? `${exclusion.label}-${index}`} className="vnext-meri__ctx-exclusion">
                        <MeriIcon name="File05" size={13} color="#98A2B3" />
                        <div className="vnext-meri__ctx-exclusion-body">
                          <span className="vnext-meri__ctx-exclusion-label">{exclusion.label}</span>
                          <span className="vnext-meri__ctx-exclusion-reason">{exclusion.reason.replace(/[-_]/g, ' ').toUpperCase()}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
                {pendingAttachments.length ? (
                  <div className="vnext-meri__ctx-list" aria-label="Pending attachments">
                    <span className="vnext-meri__section-label">PENDING ATTACHMENTS</span>
                    {pendingAttachments.slice(0, 5).map((attachment) => (
                      <div key={attachment.id} className="vnext-meri__ctx-item">
                        <span className="vnext-meri__ctx-item-tile"><MeriIcon name="File05" size={14} color="#101828" /></span>
                        <div className="vnext-meri__ctx-item-body">
                          <span className="vnext-meri__ctx-item-title">{attachment.title}</span>
                          <span className="vnext-meri__ctx-item-kind">{attachment.kind} · ADDED WHEN SENT</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
                <button type="button" className="vnext-meri__rail-action-btn" onClick={() => onOpenContext(packet, packetLoading, packetError)} disabled={!controller.activeConversationId} title={!controller.activeConversationId ? 'Create or open a thread to inspect its context.' : undefined}>
                  <MeriIcon name="Sliders02" size={14} color="#344054" />
                  Open context packet
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
