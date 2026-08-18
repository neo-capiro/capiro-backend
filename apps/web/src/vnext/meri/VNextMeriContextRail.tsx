import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useManagedMcpApps,
  type ManagedApp,
} from '../../components/chat/managed-mcp-apps.js';
import { useApi } from '../../lib/use-api.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import type { MeriCitation } from '../../components/chat/chat-store.js';
import { MeriSourceDetail } from './MeriSourceDetail.js';
import { MeriIcon, type MeriIconName } from './meri-icons.js';
import type { MeriContextSection } from './meri-prefs.js';
import { activeContextLabels, contextPacketSummary } from './meri-context-packet.js';
import { fetchLatestMeriContextPacket, type MeriContextPacket } from './meri-vnext-api.js';
import { MeriMemoryTab } from './MeriMemoryTab.js';
import { MeriPanelState } from './MeriPanelState.js';

interface ActiveSourceDetail {
  citations: MeriCitation[];
  index: number;
}

interface VNextMeriContextRailProps {
  controller: MeriChatController;
  collapsed: boolean;
  openSection: MeriContextSection | null;
  onToggle: () => void;
  onExpandSection: (section: MeriContextSection) => void;
  onSectionChange: (section: MeriContextSection | null) => void;
  onOpenIntegrations: () => void;
  onOpenContext: (packet: MeriContextPacket | null, loading: boolean, error: boolean) => void;
  /** Set when a citation's "View full source" was clicked; swaps out the normal section stack. */
  activeSourceDetail: ActiveSourceDetail | null;
  onCloseSourceDetail: () => void;
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
    return [{
      id: candidate.id,
      label: candidate.label,
      starterPrompt: candidate.starterPrompt,
      requiresClient: candidate.requiresClient === true,
    }];
  });
}

export interface MeriQuickAction {
  id: string;
  label: string;
  starterPrompt: string;
  requiresClient: boolean;
}

interface MeriSkillsResponse {
  version: 1;
  enabled: boolean;
  skills: unknown;
}

const QUICK_ACTION_ICONS: MeriIconName[] = ['SearchLg', 'File05', 'BarChart01', 'Grid01', 'Dataflow03'];

function actionIcon(index: number): MeriIconName {
  return QUICK_ACTION_ICONS[index] ?? 'DotsGrid';
}

function quickActionPrompt(action: MeriQuickAction, clientName: string | null): string {
  return action.starterPrompt.replaceAll('{{clientName}}', clientName?.trim() || 'the client selected in SCOPE');
}

/**
 * v4 collapses the rail's three sibling accordions into one Context panel whose
 * sections are always present, so the tab strip scrolls to a section rather than
 * swapping the panel out from under it.
 */
const PANEL_TABS: Array<{ key: MeriContextSection; icon: MeriIconName; label: string }> = [
  { key: 'context', icon: 'Sliders02', label: 'Active context' },
  { key: 'sources', icon: 'PuzzlePiece01', label: 'Connected sources' },
  { key: 'actions', icon: 'DotsGrid', label: 'Skills' },
  { key: 'memory', icon: 'Lightbulb02', label: 'Memory' },
];

const PANEL_TITLES: Record<MeriContextSection, string> = {
  context: 'CONTEXT',
  sources: 'CONTEXT',
  actions: 'CONTEXT',
  memory: 'CONTEXT',
};

const UNUSABLE_ATTACHMENT_STATES = new Set(['error', 'scanned', 'unsupported']);

function appStatus(app: ManagedApp): string {
  if (app.connected) return 'CONNECTED';
  if (app.status === 'needs_reauth') return 'RECONNECT';
  if (app.status === 'error') return 'ERROR';
  return app.available ? 'AVAILABLE' : 'UNAVAILABLE';
}

function statusTone(status: string): 'connected' | 'error' | 'idle' {
  if (status === 'CONNECTED') return 'connected';
  if (status === 'ERROR' || status === 'REVOKED' || status === 'RECONNECT') return 'error';
  return 'idle';
}

export function VNextMeriContextRail({
  controller,
  collapsed,
  openSection,
  onToggle,
  onExpandSection,
  onSectionChange,
  onOpenIntegrations,
  onOpenContext,
  activeSourceDetail,
  onCloseSourceDetail,
}: VNextMeriContextRailProps) {
  const api = useApi();
  const [ctxOpen, setCtxOpen] = useState(true);
  const [srcOpen, setSrcOpen] = useState(true);
  const [actOpen, setActOpen] = useState(true);
  const [memOpen, setMemOpen] = useState(true);
  const sectionRefs = useRef<Partial<Record<MeriContextSection, HTMLDivElement | null>>>({});
  const [packet, setPacket] = useState<MeriContextPacket | null>(null);
  const [packetLoading, setPacketLoading] = useState(false);
  const [packetError, setPacketError] = useState(false);
  const [quickActions, setQuickActions] = useState<MeriQuickAction[]>([]);
  const [quickActionsLoading, setQuickActionsLoading] = useState(false);
  const [quickActionsError, setQuickActionsError] = useState(false);
  const managed = useManagedMcpApps();

  useEffect(() => {
    if (!openSection) return;
    if (openSection === 'context') setCtxOpen(true);
    if (openSection === 'sources') setSrcOpen(true);
    if (openSection === 'actions') setActOpen(true);
    if (openSection === 'memory') setMemOpen(true);
    const node = sectionRefs.current[openSection];
    if (node) node.scrollIntoView({ block: 'nearest' });
  }, [openSection]);

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

  useEffect(() => {
    let cancelled = false;
    setQuickActionsLoading(true);
    setQuickActionsError(false);
    void api
      .get<MeriSkillsResponse>('/api/clio/v3/skills')
      .then(({ data }) => {
        if (!cancelled) setQuickActions(normalizeMeriQuickActionCatalog(data));
      })
      .catch(() => {
        if (!cancelled) {
          setQuickActions([]);
          setQuickActionsError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setQuickActionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

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

  const connectedSources = managed?.apps ?? [];
  const connectedCount = connectedSources.filter((source) => source.connected).length;

  const pendingMemoryCount = controller.learnedMemories.filter(
    (memory) => memory.state === 'pending_review',
  ).length;

  const badgeFor = (section: MeriContextSection): number => {
    if (section === 'context') return contextItems.length;
    if (section === 'sources') return connectedCount;
    if (section === 'memory') return pendingMemoryCount;
    return 0;
  };

  if (collapsed) {
    return (
      <aside className="vnext-meri__rail-right is-collapsed" data-meri-context-rail aria-label="Context panel (collapsed)">
        <div className="vnext-meri__rail-collapsed">
          <button type="button" className="vnext-meri__rail-expand-btn" title="Expand panel" onClick={onToggle}>
            <MeriIcon name="ChevronLeft" size={16} color="#98A2B3" />
          </button>
          <span className="vnext-meri__rail-collapsed-sep" />
          {PANEL_TABS.map((tab) => (
            <button key={tab.key} type="button" className="vnext-meri__rail-badge-btn" title={tab.label} onClick={() => onExpandSection(tab.key)}>
              <MeriIcon name={tab.icon} size={16} color="#475467" />
              {badgeFor(tab.key) > 0 ? <span className="vnext-meri__rail-badge">{badgeFor(tab.key)}</span> : null}
            </button>
          ))}
        </div>
      </aside>
    );
  }

  const panelTitle = PANEL_TITLES[openSection ?? 'context'];
  const selectedClient = controller.clients.find((client) => client.id === controller.selectedClientValue) ?? null;
  const scopeLabel = selectedClient ? selectedClient.name : 'Portfolio — all clients';

  if (activeSourceDetail) {
    return (
      <aside className="vnext-meri__rail-right is-expanded" data-meri-context-rail aria-label="Source detail">
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div className="vnext-meri__rail-panel-head">
            <span className="vnext-meri__rail-panel-title">SOURCE</span>
            <span style={{ flex: 1 }} />
            <button type="button" className="vnext-meri__rail-panel-collapse" title="Collapse panel" onClick={onToggle}>
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

  return (
    <aside className="vnext-meri__rail-right is-expanded" data-meri-context-rail aria-label="Context panel">
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div className="vnext-meri__rail-panel-head">
          <span className="vnext-meri__rail-panel-title">{panelTitle}</span>
          <div className="vnext-meri__rail-panel-tabs">
            {PANEL_TABS.map((tab) => {
              const active = (openSection ?? 'context') === tab.key;
              const badge = badgeFor(tab.key);
              return (
                <button key={tab.key} type="button" className={`vnext-meri__rail-panel-tab${active ? ' is-active' : ''}`} title={tab.label} aria-label={tab.label} aria-pressed={active} onClick={() => onExpandSection(tab.key)}>
                  <MeriIcon name={tab.icon} size={15} />
                  {badge > 0 ? <span className="vnext-meri__rail-panel-tab-badge">{badge}</span> : null}
                </button>
              );
            })}
          </div>
          <button type="button" className="vnext-meri__rail-panel-collapse" title="Collapse panel" onClick={onToggle}>
            <MeriIcon name="ChevronRight" size={15} color="#98A2B3" />
          </button>
        </div>

        <div
          className="vnext-meri__rail-section"
          ref={(node) => {
            sectionRefs.current.context = node;
          }}
        >
          <div className="vnext-meri__rail-section-head">
            <button type="button" className="vnext-meri__rail-section-toggle" onClick={() => {
              setCtxOpen((open) => {
                const next = !open;
                onSectionChange(next ? 'context' : null);
                return next;
              });
            }} aria-expanded={ctxOpen}>
              <span className="vnext-meri__section-label">ACTIVE CONTEXT{contextItems.length ? ` · ${contextItems.length}` : ''}</span>
              <MeriIcon name={ctxOpen ? 'ChevronUp' : 'ChevronDown'} size={14} color="#98A2B3" />
            </button>
          </div>
          {ctxOpen ? (
            <div className="vnext-meri__rail-section-content">
              {packetLoading ? <MeriPanelState tone="loading">Loading compiled context…</MeriPanelState> : null}
              {packetError ? <MeriPanelState tone="error">Context provenance could not be loaded.</MeriPanelState> : null}
              {contextItems.length ? (
                <div className="vnext-meri__ctx-list">
                  {contextItems.slice(0, 5).map((item) => (
                    <div key={item.id} className="vnext-meri__ctx-item">
                      <span className="vnext-meri__ctx-item-tile"><MeriIcon name="File05" size={14} color="#101828" /></span>
                      <div className="vnext-meri__ctx-item-body">
                        <span className="vnext-meri__ctx-item-title">{item.title}</span>
                        <span className="vnext-meri__ctx-item-kind">{item.kind}</span>
                      </div>
                      <span className="vnext-meri__ctx-item-dot" title="Included by the server-side context compiler" />
                    </div>
                  ))}
                </div>
              ) : !packetLoading && !packetError ? <MeriPanelState tone="empty">{contextPacketSummary(packet)}</MeriPanelState> : null}
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
                Manage context
              </button>
            </div>
          ) : null}
        </div>

        <div
          className="vnext-meri__rail-section"
          ref={(node) => {
            sectionRefs.current.sources = node;
          }}
        >
          <div className="vnext-meri__rail-section-head">
            <button type="button" className="vnext-meri__rail-section-toggle" onClick={() => {
              setSrcOpen((open) => {
                const next = !open;
                onSectionChange(next ? 'sources' : null);
                return next;
              });
            }} aria-expanded={srcOpen}>
              <span className="vnext-meri__section-label">CONNECTED SOURCES</span>
              <MeriIcon name={srcOpen ? 'ChevronUp' : 'ChevronDown'} size={14} color="#98A2B3" />
            </button>
          </div>
          {srcOpen ? (
            <div className="vnext-meri__rail-section-content">
              {managed?.loading && connectedSources.length === 0 ? <MeriPanelState tone="loading">Loading connected apps…</MeriPanelState> : null}
              {!managed?.loading && connectedSources.length === 0 ? <MeriPanelState tone={managed?.error ? 'error' : 'empty'}>{managed?.error || 'No managed apps are configured for this tenant.'}</MeriPanelState> : null}
              {connectedSources.length ? <div>{connectedSources.map((source) => {
                const status = appStatus(source);
                const tone = statusTone(status);
                return (
                  <button type="button" key={source.id} className="vnext-meri__source-row" onClick={onOpenIntegrations}>
                    <span className="vnext-meri__source-tile">{source.name.slice(0, 1).toUpperCase()}</span>
                    <span className="vnext-meri__source-name">{source.name}</span>
                    <span className={`vnext-meri__source-state is-${tone}`}>{status}</span>
                    <span className={`vnext-meri__source-dot is-${tone}`} />
                  </button>
                );
              })}</div> : null}
              <button type="button" className="vnext-meri__rail-action-btn" onClick={onOpenIntegrations}>
                <MeriIcon name="PuzzlePiece01" size={14} color="#344054" />
                Manage connections
              </button>
            </div>
          ) : null}
        </div>

        <div
          className="vnext-meri__rail-section"
          ref={(node) => {
            sectionRefs.current.actions = node;
          }}
        >
          <div className="vnext-meri__rail-section-head">
            <button type="button" className="vnext-meri__rail-section-toggle" onClick={() => {
              setActOpen((open) => {
                const next = !open;
                onSectionChange(next ? 'actions' : null);
                return next;
              });
            }} aria-expanded={actOpen}>
              <span className="vnext-meri__section-label">SKILLS</span>
              <MeriIcon name={actOpen ? 'ChevronUp' : 'ChevronDown'} size={14} color="#98A2B3" />
            </button>
          </div>
          {actOpen ? (
            <div className="vnext-meri__rail-section-content">
              {quickActionsLoading ? <MeriPanelState tone="loading">Loading available actions…</MeriPanelState> : null}
              {quickActionsError ? <MeriPanelState tone="error">Quick actions could not be loaded.</MeriPanelState> : null}
              {!quickActionsLoading && !quickActionsError && quickActions.length === 0 ? (
                <MeriPanelState tone="empty">No quick actions are available for this tenant.</MeriPanelState>
              ) : null}
              <div className="vnext-meri__actions-list">
                {quickActions.map((action, index) => (
                  <button
                    type="button"
                    key={action.id}
                    className="vnext-meri__action-item"
                    disabled={controller.isStreaming || (action.requiresClient === true && !controller.selectedClientValue)}
                    title={action.requiresClient === true && !controller.selectedClientValue ? 'Select a client scope before using this action.' : undefined}
                    onClick={() => {
                      const prompt = quickActionPrompt(
                        action,
                        controller.clients.find((client) => client.id === controller.selectedClientValue)?.name ?? null,
                      );
                      window.dispatchEvent(new CustomEvent('meri-fill-draft', { detail: prompt }));
                    }}
                  >
                    <span className="vnext-meri__action-tile"><MeriIcon name={actionIcon(index)} size={13} color="#101828" /></span>
                    <span className="vnext-meri__action-label">{action.label}</span>
                    <MeriIcon name="ChevronRight" size={14} color="#98A2B3" />
                  </button>
                ))}
              </div>
              <div className="vnext-meri__ctx-empty vnext-meri__ctx-note">Select an action to prepare editable composer text. Nothing is sent until you press Send.</div>
            </div>
          ) : null}
        </div>

        <div
          className="vnext-meri__rail-section"
          ref={(node) => {
            sectionRefs.current.memory = node;
          }}
        >
          <div className="vnext-meri__rail-section-head">
            <button type="button" className="vnext-meri__rail-section-toggle" onClick={() => {
              setMemOpen((open) => {
                const next = !open;
                onSectionChange(next ? 'memory' : null);
                return next;
              });
            }} aria-expanded={memOpen}>
              <span className="vnext-meri__section-label">
                MEMORY{controller.learnedMemories.length ? ` · ${controller.learnedMemories.length}` : ''}
              </span>
              <MeriIcon name={memOpen ? 'ChevronUp' : 'ChevronDown'} size={14} color="#98A2B3" />
            </button>
          </div>
          {memOpen ? (
            <MeriMemoryTab
              memories={controller.learnedMemories}
              forgotten={controller.forgottenMemories}
              onSave={controller.saveMemoryEdit}
              onForget={controller.forgetMemory}
              onUndo={controller.undoForgetMemory}
              onSuggestCorrection={controller.suggestMemoryCorrection}
            />
          ) : null}
          <div className="vnext-meri__rail-footer">CONTEXT IS CLIENT-SCOPED · WRITES REQUIRE APPROVAL</div>
        </div>
      </div>
    </aside>
  );
}
