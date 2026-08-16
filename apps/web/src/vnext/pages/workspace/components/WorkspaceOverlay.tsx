/**
 * Workspace overlay system (design-handoff §12).
 *
 * One shell — fixed backdrop, centered panel, kicker + title + close header,
 * scrolling body, footer with mono endpoint string + actions. The body composes
 * up to four optional blocks in order: note, diff, token, rows. Twenty-two
 * configs key into the same shell.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { WorkspaceIcon, type WorkspaceIconName } from './WorkspaceIcon.js';
import { WsButton } from './WorkspacePrimitives.js';

export interface WsOverlayRow {
  label: string;
  sub?: string;
  value?: string;
  dot?: string;
  strong?: boolean;
  action?: string;
  danger?: boolean;
  onAction?: () => void;
}

export type WsOverlayButtonKind = 'p' | 'd' | 's';

export interface WsOverlayButton {
  label: string;
  kind?: WsOverlayButtonKind;
  onClick?: () => void;
}

export interface WsOverlayConfig {
  width?: number;
  kicker: string;
  title: string;
  note?: ReactNode;
  diff?: { before: string; after: string };
  token?: string;
  rows?: WsOverlayRow[];
  endpoint?: string;
  actions: WsOverlayButton[];
}

export function WorkspaceOverlay({
  config,
  onClose,
}: {
  config: WsOverlayConfig;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div
      className="ws-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={config.title}
        tabIndex={-1}
        className="ws-overlay__panel"
        style={{ maxWidth: config.width ?? 520 }}
      >
        <header className="ws-overlay__header">
          <div className="ws-overlay__heading">
            <span className="ws-mono ws-mono--panel">{config.kicker}</span>
            <span className="ws-overlay__title">{config.title}</span>
          </div>
          <button
            type="button"
            className="ws-overlay__close"
            aria-label="Close"
            onClick={onClose}
          >
            <WorkspaceIcon name="XClose" size={17} color="currentColor" />
          </button>
        </header>

        <div className="ws-overlay__body">
          {config.note ? <p className="ws-overlay__note">{config.note}</p> : null}

          {config.diff ? (
            <div className="ws-overlay__diff">
              <div className="ws-overlay__diff-side ws-overlay__diff-side--before">
                <span className="ws-mono ws-mono--field ws-overlay__diff-label ws-overlay__diff-label--before">
                  Current
                </span>
                <p className="ws-overlay__diff-text">{config.diff.before}</p>
              </div>
              <div className="ws-overlay__diff-side ws-overlay__diff-side--after">
                <span className="ws-mono ws-mono--field ws-overlay__diff-label ws-overlay__diff-label--after">
                  Proposed
                </span>
                <p className="ws-overlay__diff-text">{config.diff.after}</p>
              </div>
            </div>
          ) : null}

          {config.token ? (
            <>
              <div className="ws-overlay__token">
                <span className="ws-overlay__token-value">{config.token}</span>
                <button
                  type="button"
                  className="ws-overlay__token-copy"
                  onClick={() => {
                    void navigator.clipboard?.writeText(config.token ?? '');
                  }}
                >
                  <WorkspaceIcon name="Copy01" size={13} color="#ffffff" />
                  Copy
                </button>
              </div>
              <p className="ws-overlay__token-warn">
                Shown once. Only the hash is stored — if this is lost, revoke
                the link and create a new one.
              </p>
            </>
          ) : null}

          {config.rows && config.rows.length > 0 ? (
            <div
              className="ws-overlay__rows"
              style={{
                marginTop:
                  config.note || config.diff || config.token ? 14 : 0,
              }}
            >
              {config.rows.map((row, index) => (
                <div className="ws-overlay__row" key={index}>
                  {row.dot ? (
                    <span
                      className="ws-overlay__row-dot"
                      style={{ background: row.dot }}
                    />
                  ) : null}
                  <span className="ws-overlay__row-main">
                    <span
                      className="ws-overlay__row-label"
                      style={{ fontWeight: row.strong ? 600 : 500 }}
                    >
                      {row.label}
                    </span>
                    {row.sub ? (
                      <span className="ws-overlay__row-sub">{row.sub}</span>
                    ) : null}
                  </span>
                  {row.value ? (
                    <span className="ws-overlay__row-value">{row.value}</span>
                  ) : null}
                  {row.action ? (
                    <button
                      type="button"
                      className={`ws-overlay__row-action ${row.danger ? 'ws-overlay__row-action--danger' : ''}`.trim()}
                      onClick={row.onAction ?? onClose}
                    >
                      {row.action}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <footer className="ws-overlay__footer">
          <span className="ws-overlay__endpoint">{config.endpoint ?? ''}</span>
          {config.actions.map((action, index) => (
            <WsButton
              key={index}
              variant={
                action.kind === 'p'
                  ? 'metal'
                  : action.kind === 'd'
                    ? 'danger'
                    : 'secondary'
              }
              size="md"
              onClick={action.onClick ?? onClose}
            >
              {action.label}
            </WsButton>
          ))}
        </footer>
      </div>
    </div>
  );
}
