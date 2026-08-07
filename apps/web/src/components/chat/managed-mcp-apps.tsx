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

export type ManagedAppId = 'hubspot' | 'airtable';
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
  const [apps, setApps] = useState<ManagedApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyAppId, setBusyAppId] = useState<ManagedAppId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    // React development StrictMode intentionally runs setup → cleanup → setup
    // once to detect unsafe effects. Reset the ref on every setup so the first
    // synthetic cleanup cannot permanently disable polling/state updates.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<ManagedApp[]> => {
    try {
      const { data } = await api.get<{ apps: ManagedApp[] }>('/api/clio/v3/apps');
      const next = Array.isArray(data.apps) ? data.apps : [];
      if (mounted.current) {
        setApps(next);
        setError(null);
      }
      return next;
    } catch (err) {
      if (mounted.current) {
        setError(err instanceof Error ? err.message : 'Connected apps could not be loaded.');
      }
      return [];
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const connect = useCallback(
    async (appId: ManagedAppId): Promise<void> => {
      if (busyAppId) return;
      // Open synchronously inside the click gesture. Waiting for the API before
      // window.open would let browser popup blockers turn a one-click OAuth flow
      // into a technical setup problem.
      const popup = window.open('about:blank', `capiro-meri-connect-${appId}`, popupFeatures());
      if (!popup) {
        setError('Your browser blocked the sign-in window. Allow popups for Capiro and try again.');
        return;
      }
      try {
        popup.document.title = 'Connecting to Capiro';
        popup.document.body.innerHTML =
          '<div style="font:14px system-ui;padding:28px;color:#374151">Opening secure sign-in…</div>';
      } catch {
        // about:blank may already have navigated; this is cosmetic only.
      }

      setBusyAppId(appId);
      setError(null);
      try {
        const { data } = await api.post<{
          authUrl: string | null;
          alreadyConnected: boolean;
        }>(`/api/clio/v3/apps/${appId}/connect`, {});
        if (data.alreadyConnected || !data.authUrl) {
          popup.close();
          await refresh();
          return;
        }
        popup.location.replace(data.authUrl);
        popup.focus();

        const startedAt = Date.now();
        while (mounted.current && Date.now() - startedAt < POLL_TIMEOUT_MS) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, POLL_MS));
          const next = await refresh();
          const app = next.find((item) => item.id === appId);
          if (app?.connected) {
            popup.close();
            return;
          }
          if (app?.status === 'error' || app?.status === 'needs_reauth') {
            popup.close();
            setError(app.lastError || `${app.name} sign-in did not complete.`);
            return;
          }
          if (popup.closed) {
            // The provider window may close itself. Give the callback one final
            // chance to persist before returning the UI to idle.
            await new Promise<void>((resolve) => window.setTimeout(resolve, POLL_MS));
            await refresh();
            return;
          }
        }
        popup.close();
        setError('Sign-in took too long. Try connecting again.');
      } catch (err) {
        popup.close();
        setError(err instanceof Error ? err.message : 'Could not start sign-in.');
        await refresh();
      } finally {
        if (mounted.current) setBusyAppId(null);
      }
    },
    [api, busyAppId, refresh],
  );

  const disconnect = useCallback(
    async (appId: ManagedAppId): Promise<void> => {
      if (busyAppId) return;
      setBusyAppId(appId);
      setError(null);
      try {
        await api.post(`/api/clio/v3/apps/${appId}/disconnect`, {});
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not disconnect the app.');
      } finally {
        if (mounted.current) setBusyAppId(null);
      }
    },
    [api, busyAppId, refresh],
  );

  const value = useMemo<ManagedAppsContextValue>(
    () => ({ apps, loading, busyAppId, error, refresh, connect, disconnect }),
    [apps, loading, busyAppId, error, refresh, connect, disconnect],
  );

  return <ManagedAppsContext.Provider value={value}>{children}</ManagedAppsContext.Provider>;
}

export function useManagedMcpApps(): ManagedAppsContextValue | null {
  return useContext(ManagedAppsContext);
}
