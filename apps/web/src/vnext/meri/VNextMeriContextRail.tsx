import { useState } from 'react';
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

export function VNextMeriContextRail({
  controller,
  collapsed,
  onToggle,
  onOpenIntegrations,
}: VNextMeriContextRailProps) {
  const [ctxOpen, setCtxOpen] = useState(true);
  const [srcOpen, setSrcOpen] = useState(true);
  const [actOpen, setActOpen] = useState(true);

  // Context items: derived from the controller's staged attachments and
  // active conversation. The context store is not yet wired from the
  // orchestrator (see GAPS.md), so we show the explicit empty state rather
  // than fabricating items.
  const contextItems: { title: string; kind: string }[] = [];

  // Connected sources: the managed MCP apps hook is available through the
  // integrations page, but for the rail we show a static representation of
  // what the tenant has. A gap exists for live source count (GAPS.md).
  const connectedSources = [
    { letter: 'H', name: 'HubSpot', connected: false },
    { letter: 'A', name: 'Airtable', connected: false },
  ];

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
            <span className="vnext-meri__rail-badge">{connectedSources.length}</span>
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
        {/* Active Context */}
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
            >
              <span className="vnext-meri__section-label">ACTIVE CONTEXT</span>
              <span style={{ color: 'var(--meri-text-faint)' }}>{ctxOpen ? '▾' : '▸'}</span>
            </button>
          </div>
          {ctxOpen ? (
            <div className="vnext-meri__rail-section-content">
              {contextItems.length > 0 ? (
                <div className="vnext-meri__ctx-list">
                  {contextItems.map((item, i) => (
                    <div key={i} className="vnext-meri__ctx-item">
                      <span className="vnext-meri__ctx-item-tile">●</span>
                      <div className="vnext-meri__ctx-item-body">
                        <span className="vnext-meri__ctx-item-title">{item.title}</span>
                        <span className="vnext-meri__ctx-item-kind">{item.kind}</span>
                      </div>
                      <span className="vnext-meri__ctx-item-dot" title="Verified" />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="vnext-meri__ctx-empty">
                  No context included. Meri will answer from client scope alone.
                </div>
              )}
              <button
                type="button"
                className="vnext-meri__rail-action-btn"
              >
                ⚙ Manage context
              </button>
            </div>
          ) : null}
        </div>

        {/* Connected Sources */}
        <div className="vnext-meri__rail-section">
          <div className="vnext-meri__rail-section-head">
            <button
              type="button"
              className="vnext-meri__rail-section-toggle"
              onClick={() => setSrcOpen((open) => !open)}
            >
              <span className="vnext-meri__section-label">CONNECTED SOURCES</span>
              <span style={{ color: 'var(--meri-text-faint)' }}>{srcOpen ? '▾' : '▸'}</span>
            </button>
          </div>
          {srcOpen ? (
            <div className="vnext-meri__rail-section-content">
              <div>
                {connectedSources.map((source) => (
                  <button
                    type="button"
                    key={source.name}
                    className="vnext-meri__source-row"
                    onClick={onOpenIntegrations}
                  >
                    <span className="vnext-meri__source-tile">{source.letter}</span>
                    <span className="vnext-meri__source-name">{source.name}</span>
                    <span
                      className={`vnext-meri__source-state${source.connected ? ' is-connected' : ''}`}
                    >
                      {source.connected ? 'CONNECTED' : 'AVAILABLE'}
                    </span>
                    <span
                      className={`vnext-meri__source-dot${source.connected ? ' is-connected' : ''}`}
                    />
                  </button>
                ))}
              </div>
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

        {/* Quick Actions */}
        <div className="vnext-meri__rail-section">
          <button
            type="button"
            className="vnext-meri__rail-section-toggle"
            onClick={() => setActOpen((open) => !open)}
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
