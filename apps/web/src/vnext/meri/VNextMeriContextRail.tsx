import { useMemo, useState } from 'react';
import {
  useManagedMcpApps,
  type ManagedApp,
} from '../../components/chat/managed-mcp-apps.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { MeriIcon, type MeriIconName } from './meri-icons.js';
import type { MeriContextSection } from './meri-prefs.js';

interface VNextMeriContextRailProps {
  controller: MeriChatController;
  collapsed: boolean;
  openSection: MeriContextSection | null;
  onToggle: () => void;
  onExpandSection: (section: MeriContextSection) => void;
  onSectionChange: (section: MeriContextSection | null) => void;
  onOpenIntegrations: () => void;
}

const QUICK_ACTIONS: Array<{ icon: MeriIconName; label: string; prompt: string }> = [
  { icon: 'SearchLg', label: 'Search across clients', prompt: 'Search across my clients for what moved this week.' },
  { icon: 'File05', label: 'Draft a client update', prompt: 'Draft a client update on the highest-priority budget change.' },
  { icon: 'BarChart01', label: 'Compare budget marks', prompt: 'Compare the latest budget marks for this client.' },
];

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
}: VNextMeriContextRailProps) {
  const [ctxOpen, setCtxOpen] = useState(openSection !== 'sources' && openSection !== 'actions');
  const [srcOpen, setSrcOpen] = useState(openSection === 'sources');
  const [actOpen, setActOpen] = useState(openSection === 'actions');
  const managed = useManagedMcpApps();

  const contextItems = useMemo(() => {
    const items = new Map<string, { id: string; title: string; kind: string }>();
    for (const attachment of controller.stagedAttachments) {
      if (UNUSABLE_ATTACHMENT_STATES.has(attachment.status)) continue;
      const key = attachment.id || attachment.localId;
      items.set(key, {
        id: key,
        title: attachment.filename,
        kind:
          attachment.status === 'uploading'
            ? 'UPLOADING'
            : String(attachment.kind || 'file').replace(/_/g, ' ').toUpperCase(),
      });
    }
    for (const message of controller.messages) {
      for (const attachment of message.attachments ?? []) {
        if (UNUSABLE_ATTACHMENT_STATES.has(attachment.status)) continue;
        items.set(attachment.id, {
          id: attachment.id,
          title: attachment.filename,
          kind: String(attachment.kind || 'file').replace(/_/g, ' ').toUpperCase(),
        });
      }
    }
    return [...items.values()];
  }, [controller.messages, controller.stagedAttachments]);

  const connectedSources = managed?.apps ?? [];
  const connectedCount = connectedSources.filter((source) => source.connected).length;
  const visibleContext = contextItems.slice(0, 3);

  if (collapsed) {
    return (
      <aside
        className="vnext-meri__rail-right is-collapsed"
        data-meri-context-rail
        aria-label="Context panel (collapsed)"
      >
        <div className="vnext-meri__rail-collapsed">
          <button
            type="button"
            className="vnext-meri__rail-expand-btn"
            title="Expand context panel"
            onClick={onToggle}
          >
            <MeriIcon name="ChevronLeft" size={16} color="#98A2B3" />
          </button>
          <span className="vnext-meri__rail-collapsed-sep" />
          <button
            type="button"
            className="vnext-meri__rail-badge-btn"
            title="Active context"
            onClick={() => onExpandSection('context')}
          >
            <MeriIcon name="Sliders02" size={16} color="#475467" />
            <span className="vnext-meri__rail-badge">{contextItems.length}</span>
          </button>
          <button
            type="button"
            className="vnext-meri__rail-badge-btn"
            title="Connected sources"
            onClick={() => onExpandSection('sources')}
          >
            <MeriIcon name="PuzzlePiece01" size={16} color="#475467" />
            <span className="vnext-meri__rail-badge">{connectedCount}</span>
          </button>
          <button
            type="button"
            className="vnext-meri__rail-badge-btn"
            title="Quick actions"
            onClick={() => onExpandSection('actions')}
          >
            <MeriIcon name="DotsGrid" size={16} color="#475467" />
            <span className="vnext-meri__rail-badge">{QUICK_ACTIONS.length}</span>
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside
      className="vnext-meri__rail-right is-expanded"
      data-meri-context-rail
      aria-label="Context panel"
    >
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div className="vnext-meri__rail-section">
          <div className="vnext-meri__rail-section-head">
            <button
              type="button"
              className="vnext-meri__rail-collapse-btn"
              title="Collapse context panel"
              onClick={onToggle}
            >
              <MeriIcon name="ChevronRight" size={15} color="#98A2B3" />
            </button>
            <button
              type="button"
              className="vnext-meri__rail-section-toggle"
              onClick={() => {
                setCtxOpen((open) => {
                  const next = !open;
                  onSectionChange(next ? 'context' : null);
                  return next;
                });
              }}
              aria-expanded={ctxOpen}
            >
              <span className="vnext-meri__section-label">ACTIVE CONTEXT</span>
              <MeriIcon name={ctxOpen ? 'ChevronUp' : 'ChevronDown'} size={14} color="#98A2B3" />
            </button>
          </div>
          {ctxOpen ? (
            <div className="vnext-meri__rail-section-content">
              {visibleContext.length > 0 ? (
                <div className="vnext-meri__ctx-list">
                  {visibleContext.map((item) => (
                    <div key={item.id} className="vnext-meri__ctx-item">
                      <span className="vnext-meri__ctx-item-tile">
                        <MeriIcon name="File05" size={14} color="#101828" />
                      </span>
                      <div className="vnext-meri__ctx-item-body">
                        <span className="vnext-meri__ctx-item-title">{item.title}</span>
                        <span className="vnext-meri__ctx-item-kind">{item.kind}</span>
                      </div>
                      <span className="vnext-meri__ctx-item-dot" title="Included in this thread" />
                      <MeriIcon name="DotsVertical" size={14} color="#98A2B3" />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="vnext-meri__ctx-empty">
                  No context included. Meri will answer from client scope alone.
                </div>
              )}
              <button type="button" className="vnext-meri__rail-action-btn" disabled title="Context sheet is not wired yet.">
                <MeriIcon name="Sliders02" size={14} color="#344054" />
                Manage context
              </button>
            </div>
          ) : null}
        </div>

        <div className="vnext-meri__rail-section">
          <div className="vnext-meri__rail-section-head">
            <button
              type="button"
              className="vnext-meri__rail-section-toggle"
              onClick={() => {
                setSrcOpen((open) => {
                  const next = !open;
                  onSectionChange(next ? 'sources' : null);
                  return next;
                });
              }}
              aria-expanded={srcOpen}
            >
              <span className="vnext-meri__section-label">CONNECTED SOURCES</span>
              <MeriIcon name={srcOpen ? 'ChevronUp' : 'ChevronDown'} size={14} color="#98A2B3" />
            </button>
          </div>
          {srcOpen ? (
            <div className="vnext-meri__rail-section-content">
              {managed?.loading && connectedSources.length === 0 ? (
                <div className="vnext-meri__ctx-empty">Loading connected apps…</div>
              ) : connectedSources.length === 0 ? (
                <div className="vnext-meri__ctx-empty">
                  {managed?.error || 'No managed apps are configured for this tenant.'}
                </div>
              ) : (
                <div>
                  {connectedSources.map((source) => {
                    const status = appStatus(source);
                    const tone = statusTone(status);
                    return (
                      <button
                        type="button"
                        key={source.id}
                        className="vnext-meri__source-row"
                        onClick={onOpenIntegrations}
                      >
                        <span className="vnext-meri__source-tile">
                          {source.name.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="vnext-meri__source-name">{source.name}</span>
                        <span className={`vnext-meri__source-state is-${tone}`}>{status}</span>
                        <span className={`vnext-meri__source-dot is-${tone}`} />
                      </button>
                    );
                  })}
                </div>
              )}
              <button type="button" className="vnext-meri__rail-action-btn" onClick={onOpenIntegrations}>
                <MeriIcon name="PuzzlePiece01" size={14} color="#344054" />
                Manage integrations
              </button>
            </div>
          ) : null}
        </div>

        <div className="vnext-meri__rail-section">
          <button
            type="button"
            className="vnext-meri__rail-section-toggle"
            onClick={() => {
              setActOpen((open) => {
                const next = !open;
                onSectionChange(next ? 'actions' : null);
                return next;
              });
            }}
            aria-expanded={actOpen}
          >
            <span className="vnext-meri__section-label">QUICK ACTIONS</span>
            <MeriIcon name={actOpen ? 'ChevronUp' : 'ChevronDown'} size={14} color="#98A2B3" />
          </button>
          {actOpen ? (
            <div className="vnext-meri__rail-section-content">
              <div className="vnext-meri__actions-list">
                {QUICK_ACTIONS.map((action) => (
                  <button
                    type="button"
                    key={action.label}
                    className="vnext-meri__action-item"
                    disabled={controller.isStreaming}
                    onClick={() => void controller.sendMessage(action.prompt)}
                  >
                    <span className="vnext-meri__action-tile">
                      <MeriIcon name={action.icon} size={13} color="#101828" />
                    </span>
                    <span className="vnext-meri__action-label">{action.label}</span>
                    <MeriIcon name="ChevronRight" size={14} color="#98A2B3" />
                  </button>
                ))}
                <button
                  type="button"
                  className="vnext-meri__action-item vnext-meri__action-item--plain"
                  onClick={onOpenIntegrations}
                >
                  <span className="vnext-meri__action-label is-strong">View all actions</span>
                  <MeriIcon name="ChevronRight" size={14} color="#98A2B3" />
                </button>
              </div>
            </div>
          ) : null}
          <div className="vnext-meri__rail-footer">
            CONTEXT IS CLIENT-SCOPED · WRITES REQUIRE APPROVAL
          </div>
        </div>
      </div>
    </aside>
  );
}
