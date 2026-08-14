import { useMemo, useState } from 'react';
import {
  useManagedMcpApps,
  type ManagedApp,
} from '../../components/chat/managed-mcp-apps.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';

interface VNextMeriContextRailProps {
  controller: MeriChatController;
  collapsed: boolean;
  onToggle: () => void;
  onOpenIntegrations: () => void;
}

const QUICK_ACTIONS = [
  { icon: 'S', label: 'Search across clients' },
  { icon: 'D', label: 'Draft a client update' },
  { icon: 'C', label: 'Compare budget marks' },
];

const UNUSABLE_ATTACHMENT_STATES = new Set(['error', 'scanned', 'unsupported']);

function appStatus(app: ManagedApp): string {
  if (app.connected) return 'CONNECTED';
  if (app.status === 'needs_reauth') return 'RECONNECT';
  if (app.status === 'error') return 'ERROR';
  return app.available ? 'AVAILABLE' : 'UNAVAILABLE';
}

export function VNextMeriContextRail({
  controller,
  collapsed,
  onToggle,
  onOpenIntegrations,
}: VNextMeriContextRailProps) {
  const [ctxOpen, setCtxOpen] = useState(true);
  const [srcOpen, setSrcOpen] = useState(true);
  const [actOpen, setActOpen] = useState(true);
  const managed = useManagedMcpApps();

  // The previous rail always displayed zero active context even when files were
  // staged or restored with a durable message. Derive the list from the same
  // controller payload that is actually sent to Meri and deduplicate by server
  // attachment id (falling back to the local upload id while a file is pending).
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

  if (collapsed) {
    return (
      <aside
        className="vnext-meri__rail-right is-collapsed"
        aria-label="Context panel (collapsed)"
      >
        <div className="vnext-meri__rail-collapsed">
          <button
            type="button"
            className="vnext-meri__rail-expand-btn"
            title="Expand context panel"
            onClick={onToggle}
          >
            ›
          </button>
          <span className="vnext-meri__rail-collapsed-sep" />
          <button
            type="button"
            className="vnext-meri__rail-badge-btn"
            title="Active context"
            onClick={onToggle}
          >
            ▣
            <span className="vnext-meri__rail-badge">{contextItems.length}</span>
          </button>
          <button
            type="button"
            className="vnext-meri__rail-badge-btn"
            title="Connected sources"
            onClick={onToggle}
          >
            🔗
            <span className="vnext-meri__rail-badge">{connectedCount}</span>
          </button>
          <button
            type="button"
            className="vnext-meri__rail-badge-btn"
            title="Quick actions"
            onClick={onToggle}
          >
            ⚡
            <span className="vnext-meri__rail-badge">{QUICK_ACTIONS.length}</span>
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside
      className="vnext-meri__rail-right is-expanded"
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
              ›
            </button>
            <button
              type="button"
              className="vnext-meri__rail-section-toggle"
              onClick={() => setCtxOpen((open) => !open)}
              aria-expanded={ctxOpen}
            >
              <span className="vnext-meri__section-label">ACTIVE CONTEXT</span>
              <span style={{ color: 'var(--meri-text-faint)' }}>{ctxOpen ? '▾' : '▸'}</span>
            </button>
          </div>
          {ctxOpen ? (
            <div className="vnext-meri__rail-section-content">
              {contextItems.length > 0 ? (
                <div className="vnext-meri__ctx-list">
                  {contextItems.map((item) => (
                    <div key={item.id} className="vnext-meri__ctx-item">
                      <span className="vnext-meri__ctx-item-tile">●</span>
                      <div className="vnext-meri__ctx-item-body">
                        <span className="vnext-meri__ctx-item-title">{item.title}</span>
                        <span className="vnext-meri__ctx-item-kind">{item.kind}</span>
                      </div>
                      <span className="vnext-meri__ctx-item-dot" title="Included in this thread" />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="vnext-meri__ctx-empty">
                  No files are included. Add a file from the composer when this thread needs
                  document-specific context.
                </div>
              )}
            </div>
          ) : null}
        </div>

        <div className="vnext-meri__rail-section">
          <div className="vnext-meri__rail-section-head">
            <button
              type="button"
              className="vnext-meri__rail-section-toggle"
              onClick={() => setSrcOpen((open) => !open)}
              aria-expanded={srcOpen}
            >
              <span className="vnext-meri__section-label">CONNECTED SOURCES</span>
              <span style={{ color: 'var(--meri-text-faint)' }}>{srcOpen ? '▾' : '▸'}</span>
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
                  {connectedSources.map((source) => (
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
                      <span
                        className={`vnext-meri__source-state${source.connected ? ' is-connected' : ''}`}
                      >
                        {appStatus(source)}
                      </span>
                      <span
                        className={`vnext-meri__source-dot${source.connected ? ' is-connected' : ''}`}
                      />
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                className="vnext-meri__rail-action-btn"
                onClick={onOpenIntegrations}
              >
                🔌 Manage integrations
              </button>
            </div>
          ) : null}
        </div>

        <div className="vnext-meri__rail-section">
          <button
            type="button"
            className="vnext-meri__rail-section-toggle"
            onClick={() => setActOpen((open) => !open)}
            aria-expanded={actOpen}
          >
            <span className="vnext-meri__section-label">QUICK ACTIONS</span>
            <span style={{ color: 'var(--meri-text-faint)' }}>{actOpen ? '▾' : '▸'}</span>
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
                    onClick={() => void controller.sendMessage(action.label)}
                  >
                    <span className="vnext-meri__action-tile">{action.icon}</span>
                    <span className="vnext-meri__action-label">{action.label}</span>
                    <span style={{ color: 'var(--meri-text-faint)' }}>›</span>
                  </button>
                ))}
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
