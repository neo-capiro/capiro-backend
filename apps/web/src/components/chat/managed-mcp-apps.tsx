import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useApi } from '../../lib/use-api.js';

export const MANAGED_APP_IDS = ['hubspot', 'airtable', 'monday', 'google-drive'] as const;
export type ManagedAppId = (typeof MANAGED_APP_IDS)[number];
export type ManagedAppConnectionStatus =
  | 'connected'
  | 'disconnected'
  | 'pending'
  | 'needs_reauth'
  | 'error';

export interface ManagedApp {
  id: ManagedAppId;
  name: string;
  description: string;
  status: ManagedAppConnectionStatus;
  connected: boolean;
  available: boolean;
  needsReauth: boolean;
  lastError: string | null;
}

interface ManagedAppsContextValue {
  apps: ManagedApp[];
  loading: boolean;
  busyAppId: ManagedAppId | null;
  error: string | null;
  refresh: () => Promise<ManagedApp[]>;
  connect: (appId: ManagedAppId) => Promise<void>;
  disconnect: (appId: ManagedAppId) => Promise<void>;
}

const ManagedAppsContext = createContext<ManagedAppsContextValue | null>(null);
const POLL_MS = 1_250;
const POLL_TIMEOUT_MS = 5 * 60_000;

function popupFeatures(): string {
  const width = 560;
  const height = 720;
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
  return [
    'popup=yes',
    'resizable=yes',
    'scrollbars=yes',
    `width=${width}`,
    `height=${height}`,
    `left=${left}`,
    `top=${top}`,
  ].join(',');
}

export function ManagedMcpAppsProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const scope = useMemo(() => ({}), [api]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const mounted = useRef(true);
  const sequence = useRef(0);
  const [snapshot, setSnapshot] = useState({ scope, apps: [] as ManagedApp[], loading: true, error: null as string | null });
  const [action, setAction] = useState({ scope, busy: null as ManagedAppId | null, error: null as string | null });
  const active = useRef<{ scope: object; popup?: Window; appId: ManagedAppId } | null>(null);
  const isCurrent = useCallback(() => mounted.current && currentScope.current === scope, [scope]);

  const refresh = useCallback(async (): Promise<ManagedApp[]> => {
    if (!isCurrent()) return [];
    const request = ++sequence.current;
    try {
      const { data } = await api.get<{ apps: ManagedApp[] }>('/api/clio/v3/apps');
      if (!isCurrent() || request !== sequence.current) return [];
      const apps = Array.isArray(data.apps) ? data.apps : [];
      setSnapshot({ scope, apps, loading: false, error: null });
      return apps;
    } catch {
      if (isCurrent() && request === sequence.current) {
        setSnapshot((previous) => ({
          scope,
          apps: previous.scope === scope ? previous.apps : [],
          loading: false,
          error: 'Connected apps could not be loaded. Please try again.',
        }));
      }
      return [];
    }
  }, [api, scope, isCurrent]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      mounted.current = false;
      ++sequence.current;
      window.removeEventListener('focus', onFocus);
      if (active.current?.scope === scope) {
        active.current.popup?.close();
        active.current = null;
      }
    };
  }, [scope, refresh]);

  const connect = useCallback(async (appId: ManagedAppId): Promise<void> => {
    if (active.current || !isCurrent()) return;
    const operation = { scope, appId, popup: undefined as Window | undefined };
    active.current = operation; // Synchronous guard also covers rapid double clicks.
    setAction({ scope, busy: appId, error: null });
    const fail = (message: string) => {
      if (isCurrent()) setAction({ scope, busy: appId, error: message });
    };
    const cancelPending = async () => {
      if (!isCurrent()) return;
      try {
        await api.post('/api/clio/v3/apps/' + appId + '/cancel', {});
        await refresh();
      } catch {
        fail('Sign-in did not finish. Return to this app in Meri integrations and try again.');
      }
    };
    let popup: Window | null = null;
    try {
      popup = window.open('about:blank', 'capiro-meri-connect-' + appId, popupFeatures());
      operation.popup = popup ?? undefined;
      if (!popup) {
        fail('Your browser blocked sign-in. Allow popups for Capiro and try again.');
        return;
      }
      try {
        popup.document.title = 'Connecting to Capiro';
        popup.document.body.textContent = 'Opening secure sign-in…';
      } catch { /* Cosmetic; the popup may already have navigated. */ }
      const { data } = await api.post<{ authUrl: string | null; alreadyConnected: boolean }>(
        '/api/clio/v3/apps/' + appId + '/connect', {},
      );
      if (!isCurrent()) return;
      if (data.alreadyConnected) {
        await refresh();
        return;
      }
      if (!data.authUrl || new URL(data.authUrl).protocol !== 'https:') {
        fail('Sign-in could not start. Please try again.');
        await cancelPending();
        return;
      }
      popup.location.replace(data.authUrl);
      popup.focus();
      const started = Date.now();
      while (isCurrent() && Date.now() - started < POLL_TIMEOUT_MS) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, POLL_MS));
        if (!isCurrent()) return;
        const apps = await refresh();
        const app = apps.find((item) => item.id === appId);
        if (app?.connected) return;
        if (app?.status === 'error' || app?.status === 'needs_reauth') {
          fail(app.lastError || 'Sign-in did not complete. Please try again.');
          return;
        }
        if (popup.closed) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, POLL_MS));
          if (!isCurrent()) return;
          const finalApps = await refresh();
          if (!finalApps.find((item) => item.id === appId)?.connected) {
            fail('Sign-in was closed before it finished. You can try again.');
            await cancelPending();
          }
          return;
        }
      }
      if (isCurrent()) {
        fail('Sign-in took too long. Please try again.');
        await cancelPending();
      }
    } catch {
      fail('Could not complete sign-in. Please try again.');
      await cancelPending(); // Refresh must not erase the action error.
    } finally {
      popup?.close();
      if (active.current === operation) {
        active.current = null;
        if (isCurrent()) setAction((previous) => ({ ...previous, busy: null }));
      }
    }
  }, [api, scope, refresh, isCurrent]);

  const disconnect = useCallback(async (appId: ManagedAppId): Promise<void> => {
    if (active.current || !isCurrent()) return;
    const operation = { scope, appId };
    active.current = operation;
    setAction({ scope, busy: appId, error: null });
    try {
      await api.post('/api/clio/v3/apps/' + appId + '/disconnect', {});
      await refresh();
    } catch {
      if (isCurrent()) setAction({ scope, busy: null, error: 'Could not disconnect the app. Please try again.' });
    } finally {
      if (active.current === operation) {
        active.current = null;
        if (isCurrent()) setAction((previous) => ({ ...previous, busy: null }));
      }
    }
  }, [api, scope, refresh, isCurrent]);

  // Render empty state immediately on identity change, before effects run.
  const apps = snapshot.scope === scope ? snapshot.apps : [];
  const loading = snapshot.scope === scope ? snapshot.loading : true;
  const busyAppId = action.scope === scope ? action.busy : null;
  const error = (action.scope === scope ? action.error : null) ??
    (snapshot.scope === scope ? snapshot.error : null);
  const value = useMemo<ManagedAppsContextValue>(
    () => ({ apps, loading, busyAppId, error, refresh, connect, disconnect }),
    [apps, loading, busyAppId, error, refresh, connect, disconnect],
  );
  return <ManagedAppsContext.Provider value={value}>{children}</ManagedAppsContext.Provider>;
}

export function useManagedMcpApps(): ManagedAppsContextValue | null {
  return useContext(ManagedAppsContext);
}

export function managedAppStatusLabel(app: ManagedApp): string {
  if (!app.available) return 'Temporarily unavailable';
  if (app.connected) return 'Connected';
  if (app.status === 'pending') return 'Connecting…';
  if (app.status === 'needs_reauth') return 'Reconnect';
  if (app.status === 'error') return 'Try again';
  return 'Connect';
}
