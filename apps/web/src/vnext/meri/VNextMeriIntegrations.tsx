import {
  ManagedMcpAppsProvider,
  useManagedMcpApps,
  managedAppStatusLabel,
  type ManagedApp,
} from '../../components/chat/managed-mcp-apps.js';
import { ConnectorMark } from './meri-connector-logos.js';
import { MeriIcon } from './meri-icons.js';
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
      <section className="vnext-meri-integrations__content">
        <div className="vnext-meri-integrations__header">
          <button type="button" className="vnext-meri-integrations__back" onClick={onBack}>
            <MeriIcon name="ArrowLeft" size={15} />
            Back to Meri
          </button>
        </div>

        <div className="vnext-meri-integrations__eyebrow">CONNECTED CONTEXT</div>
        <h1>Meri integrations</h1>
        <p className="vnext-meri-integrations__lede">
          Apps Meri can use. Your draft and any staged attachments are held while you are here.
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
          <MeriIcon name="InfoCircle" size={16} color="#98A2B3" />
          <span>
            Connect your account to let Meri search and read information you can access.
            You can disconnect any app here.
          </span>
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
  const status = managedAppStatusLabel(app);
  const statusTone = app.connected ? 'is-connected' : reconnect ? 'is-warning' : '';

  return (
    <article className={`vnext-meri-integration-card vnext-meri-integration-card--${app.id}`}>
      <span className="vnext-meri-integration-card__logo" aria-hidden="true">
        <ConnectorMark id={app.id} size={20} />
      </span>
      <div className="vnext-meri-integration-card__body">
        <div className="vnext-meri-integration-card__topline">
          <h2>{app.name}</h2>
          <span className={`vnext-meri-integration-card__status ${statusTone}`}>
            {status}
          </span>
        </div>
        <p>{app.description}</p>
        {app.lastError ? (
          <div className="vnext-meri-integration-card__warning">{app.lastError}</div>
        ) : null}
      </div>
      <div className="vnext-meri-integration-card__actions">
        {app.connected || app.status === 'connected' ? (
          <button type="button" onClick={onDisconnect} disabled={busy}>
            {busy ? 'Disconnecting…' : 'Disconnect'}
          </button>
        ) : (
          <button
            type="button"
            className="vnext-meri-integration-card__primary"
            onClick={onConnect}
            disabled={busy || !app.available}
          >
            {busy ? 'Connecting…' : app.status === 'error' ? 'Try again' : reconnect ? 'Reconnect' : 'Connect'}
          </button>
        )}
        {!app.connected && app.status !== 'connected' && app.status !== 'disconnected' ? (
          <button type="button" onClick={onDisconnect} disabled={busy}>Disconnect</button>
        ) : null}
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
