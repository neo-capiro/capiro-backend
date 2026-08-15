import {
  ManagedMcpAppsProvider,
  useManagedMcpApps,
  type ManagedApp,
} from '../../components/chat/managed-mcp-apps.js';
import './vnext-meri-integrations.css';

export function VNextMeriIntegrations({ onBack }: { onBack: () => void }) {
  return (
    <ManagedMcpAppsProvider>
      <VNextMeriIntegrationsContent onBack={onBack} />
    </ManagedMcpAppsProvider>
  );
}

function VNextMeriIntegrationsContent({ onBack }: { onBack: () => void }) {
  const managed = useManagedMcpApps();
  if (!managed) return null;

  return (
    <main className="vnext-meri-integrations" aria-label="Meri integrations">
      <header className="vnext-meri-integrations__header">
        <div className="vnext-meri-integrations__brand">
          <span className="vnext-meri-integrations__ring" aria-hidden="true" />
          <span>Meri</span>
        </div>
        <button type="button" className="vnext-meri-integrations__back" onClick={onBack}>
          ← Back to Meri
        </button>
      </header>

      <section className="vnext-meri-integrations__content">
        <div className="vnext-meri-integrations__eyebrow">CONNECTED CONTEXT</div>
        <h1>Apps Meri can use</h1>
        <p className="vnext-meri-integrations__lede">
          Connect an approved account once. Meri can use its read-only context when it is relevant to
          your request; connection credentials and server configuration stay outside this workspace.
        </p>

        {managed.error ? (
          <div className="vnext-meri-integrations__error" role="alert">
            {managed.error}
          </div>
        ) : null}

        <div className="vnext-meri-integrations__grid" aria-live="polite">
          {managed.loading && managed.apps.length === 0 ? (
            <IntegrationSkeleton />
          ) : managed.apps.length === 0 ? (
            <div className="vnext-meri-integrations__empty">
              No managed apps are configured for this tenant.
            </div>
          ) : (
            managed.apps.map((app) => (
              <IntegrationCard
                key={app.id}
                app={app}
                busy={managed.busyAppId === app.id}
                onConnect={() => void managed.connect(app.id)}
                onDisconnect={() => void managed.disconnect(app.id)}
              />
            ))
          )}
        </div>

        <div className="vnext-meri-integrations__notice">
          Only apps returned by the MeriV3 capabilities service are shown here. Capiro does not expose
          server URLs, client secrets, or token configuration in this end-user flow.
        </div>
      </section>
    </main>
  );
}

function IntegrationCard({
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
  const status = app.connected
    ? 'Connected'
    : reconnect
      ? 'Reconnect required'
      : app.available
        ? 'Ready to connect'
        : 'Not configured';

  return (
    <article className={`vnext-meri-integration-card vnext-meri-integration-card--${app.id}`}>
      <div className="vnext-meri-integration-card__topline">
        <span className="vnext-meri-integration-card__logo" aria-hidden="true">
          {app.id === 'hubspot' ? 'H' : 'A'}
        </span>
        <span
          className={`vnext-meri-integration-card__status${app.connected ? ' is-connected' : ''}`}
        >
          {status}
        </span>
      </div>
      <h2>{app.name}</h2>
      <p>{app.description}</p>
      {app.lastError && reconnect ? (
        <div className="vnext-meri-integration-card__warning">{app.lastError}</div>
      ) : null}
      <div className="vnext-meri-integration-card__actions">
        {app.connected ? (
          <>
            <span className="vnext-meri-integration-card__connected">✓ Active</span>
            <button type="button" onClick={onDisconnect} disabled={busy}>
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="vnext-meri-integration-card__primary"
            onClick={onConnect}
            disabled={busy || !app.available}
          >
            {busy ? 'Opening sign-in…' : reconnect ? 'Reconnect' : 'Connect'}
          </button>
        )}
      </div>
    </article>
  );
}

function IntegrationSkeleton() {
  return (
    <>
      <div className="vnext-meri-integration-card is-loading" aria-label="Loading integrations" />
      <div className="vnext-meri-integration-card is-loading" aria-hidden="true" />
    </>
  );
}
