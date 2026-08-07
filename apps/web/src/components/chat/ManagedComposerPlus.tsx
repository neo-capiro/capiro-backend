import { useEffect, useRef, useState } from 'react';
import {
  CheckCircleFilled,
  LoadingOutlined,
  PaperClipOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { useManagedMcpApps, type ManagedApp } from './managed-mcp-apps.js';
import './managed-mcp-apps.css';

export function ManagedComposerPlus({
  disabled,
  onUpload,
}: {
  disabled?: boolean;
  onUpload: () => void;
}) {
  const managed = useManagedMcpApps();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
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

  // Outside the MeriV3 provider, preserve the established paperclip behavior.
  if (!managed) {
    return (
      <button
        type="button"
        className="chat-attach-btn"
        onClick={onUpload}
        disabled={disabled}
        aria-label="Attach files"
        title="Attach files (PDF, Word, text, images)"
      >
        <PaperClipOutlined />
      </button>
    );
  }

  return (
    <div className="meri-app-plus" ref={rootRef}>
      <button
        type="button"
        className={`chat-attach-btn meri-app-plus-trigger${open ? ' is-open' : ''}`}
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-label="Add files or connected apps"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Add files or apps"
      >
        <PlusOutlined />
      </button>

      {open ? (
        <div className="meri-app-menu" role="menu" aria-label="Add to Meri">
          <button
            type="button"
            className="meri-app-menu-row meri-app-menu-upload"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onUpload();
            }}
          >
            <span className="meri-app-menu-icon meri-app-menu-icon--file">
              <PaperClipOutlined />
            </span>
            <span>
              <strong>Upload files</strong>
              <small>PDF, Word, text, or images</small>
            </span>
          </button>

          <div className="meri-app-menu-divider" />
          <div className="meri-app-menu-heading">Apps</div>

          {managed.loading && managed.apps.length === 0 ? (
            <div className="meri-app-menu-loading">
              <LoadingOutlined spin /> Loading apps…
            </div>
          ) : (
            managed.apps.map((app) => (
              <ManagedAppRow
                key={app.id}
                app={app}
                busy={managed.busyAppId === app.id}
                onConnect={() => void managed.connect(app.id)}
                onDisconnect={() => void managed.disconnect(app.id)}
              />
            ))
          )}

          {managed.error ? (
            <div className="meri-app-menu-error" role="alert">
              {managed.error}
            </div>
          ) : null}
          <div className="meri-app-menu-footnote">
            Meri uses connected apps only when they are relevant to your request.
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ManagedAppRow({
  app,
  busy,
  onConnect,
  onDisconnect,
}: {
  app: ManagedApp;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const reconnect = app.status === 'needs_reauth' || app.status === 'error';
  return (
    <div className={`meri-app-menu-row meri-app-row meri-app-row--${app.id}`} role="group">
      <span className={`meri-app-menu-icon meri-app-brand meri-app-brand--${app.id}`} aria-hidden="true">
        {app.id === 'hubspot' ? 'H' : 'A'}
      </span>
      <span className="meri-app-row-copy">
        <strong>{app.name}</strong>
        <small>
          {app.connected
            ? 'Connected'
            : reconnect
              ? 'Reconnect required'
              : app.available
                ? 'Connect your account'
                : 'Not configured'}
        </small>
      </span>
      {busy ? (
        <span className="meri-app-row-action meri-app-row-action--busy" aria-label="Connecting">
          <LoadingOutlined spin />
        </span>
      ) : app.connected ? (
        <span className="meri-app-connected-actions">
          <span className="meri-app-connected-label">
            <CheckCircleFilled /> Connected
          </span>
          <button type="button" onClick={onDisconnect} className="meri-app-disconnect">
            Disconnect
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="meri-app-connect"
          disabled={!app.available}
          onClick={onConnect}
        >
          {reconnect ? 'Reconnect' : 'Connect'}
        </button>
      )}
    </div>
  );
}
