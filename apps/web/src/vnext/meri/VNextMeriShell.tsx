import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ManagedMcpAppsProvider } from '../../components/chat/managed-mcp-apps.js';
import { useApi } from '../../lib/use-api.js';
import { useMe } from '../../lib/me.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { MERI_LOGO_SRC } from './meri-presentation.js';
import type { MeriContextSection, MeriWindowChrome } from './meri-prefs.js';
import { VNextMeriTopBar } from './VNextMeriTopBar.js';
import { VNextMeriThreadRail } from './VNextMeriThreadRail.js';
import { VNextMeriConversation } from './VNextMeriConversation.js';
import { VNextMeriContextRail } from './VNextMeriContextRail.js';
import { MeriContextSheet } from './MeriContextSheet.js';
import {
  getMeriVNextPreferences,
  saveMeriVNextPreferences,
  type MeriContextPacket,
} from './meri-vnext-api.js';
import './vnext-meri.css';

interface VNextMeriShellProps {
  controller: MeriChatController;
  historyError: string | null;
  onRetryHistory: () => void;
  onArchiveThread: (conversationId: string) => Promise<void>;
  onRenameThread: (conversationId: string, title: string) => Promise<void>;
  onRestoreThread: (conversationId: string) => Promise<void>;
}

function displayName(me: ReturnType<typeof useMe>['data']): string {
  const first = me?.user.firstName?.trim() ?? '';
  const last = me?.user.lastName?.trim() ?? '';
  const full = `${first} ${last}`.trim();
  return full || me?.user.email?.split('@')[0] || 'Capiro user';
}

function shortGreetingName(me: ReturnType<typeof useMe>['data']): string {
  return me?.user.firstName?.trim() || displayName(me);
}

function useMatchesWidth(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mediaQuery = window.matchMedia(query);
    const sync = () => setMatches(mediaQuery.matches);
    sync();
    mediaQuery.addEventListener('change', sync);
    return () => mediaQuery.removeEventListener('change', sync);
  }, [query]);

  return matches;
}

export function VNextMeriShell({
  controller,
  historyError,
  onRetryHistory,
  onArchiveThread,
  onRenameThread,
  onRestoreThread,
}: VNextMeriShellProps) {
  const me = useMe();
  const api = useApi();
  const navigate = useNavigate();
  const [windowChrome, setWindowChrome] = useState<MeriWindowChrome>('undocked');
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [openSection, setOpenSection] = useState<MeriContextSection | null>(null);
  const [preferencesHydrated, setPreferencesHydrated] = useState(false);
  const skipInitialPreferenceSaveRef = useRef(true);
  const [threadSearch, setThreadSearch] = useState('');
  const [contextSheet, setContextSheet] = useState<{
    open: boolean;
    packet: MeriContextPacket | null;
    loading: boolean;
    error: boolean;
  }>({ open: false, packet: null, loading: false, error: false });
  const threadSearchRef = useRef<HTMLInputElement>(null);

  const isTabletDown = useMatchesWidth('(max-width: 1179px)');
  const lastBandRef = useRef<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getMeriVNextPreferences(api)
      .then((preferences) => {
        if (cancelled) return;
        setWindowChrome(preferences.windowChrome);
        setRailCollapsed(preferences.railCollapsed);
        setOpenSection(preferences.openSection);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setPreferencesHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (lastBandRef.current === isTabletDown) return;
    lastBandRef.current = isTabletDown;
    if (!isTabletDown) return;
    setRailCollapsed(true);
  }, [isTabletDown]);

  useEffect(() => {
    if (!preferencesHydrated) return;
    if (skipInitialPreferenceSaveRef.current) {
      skipInitialPreferenceSaveRef.current = false;
      return;
    }
    void saveMeriVNextPreferences(api, { windowChrome, railCollapsed, openSection }).catch(() => undefined);
  }, [api, openSection, preferencesHydrated, railCollapsed, windowChrome]);

  const greetingName = shortGreetingName(me.data);
  const tenantName = me.data?.tenant.name ?? 'Capiro';

  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Meri — Capiro';
    return () => {
      document.title = previousTitle;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setRailCollapsed(false);
        window.setTimeout(() => threadSearchRef.current?.focus(), 0);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleNewChat = () => {
    setThreadSearch('');
    void controller.handleNewSession();
  };

  const handleOpenIntegrations = () => {
    navigate('/meri/integrations');
  };

  const expandSection = (section: MeriContextSection) => {
    setRailCollapsed(false);
    setOpenSection(section);
  };

  if (windowChrome === 'docked') {
    return (
      <div className="vnext-meri-page" data-meri-page>
        <button
          type="button"
          className="vnext-meri-docked"
          onClick={() => setWindowChrome('undocked')}
        >
          <span className="vnext-meri-docked__mark">
            <img src={MERI_LOGO_SRC} alt="" width={13} height={13} />
          </span>
          <span className="vnext-meri-docked__copy">
            <span className="vnext-meri-docked__title">Meri is docked</span>
            <span className="vnext-meri-docked__hint">CLICK TO REOPEN THE WORKSPACE</span>
          </span>
        </button>
      </div>
    );
  }

  return (
    <ManagedMcpAppsProvider>
      <div
        className={`vnext-meri-page${windowChrome === 'maximized' ? ' is-maximized' : ''}`}
        data-meri-page
      >
        <div className="vnext-meri" data-meri-window aria-label="Meri workspace">
          <VNextMeriTopBar
            controller={controller}
            me={me.data}
            windowChrome={windowChrome}
            onNewChat={handleNewChat}
            onSearch={() => {
              setRailCollapsed(false);
              window.setTimeout(() => threadSearchRef.current?.focus(), 0);
            }}
            onDock={() => setWindowChrome('docked')}
            onToggleMaximize={() =>
              setWindowChrome((current) => (current === 'maximized' ? 'undocked' : 'maximized'))
            }
            onClose={() => navigate('/')}
          />

          <div className="vnext-meri__body">
            <VNextMeriThreadRail
              controller={controller}
              historyError={historyError}
              onRetryHistory={onRetryHistory}
              onNewChat={handleNewChat}
              onOpenIntegrations={handleOpenIntegrations}
              onArchiveThread={onArchiveThread}
              onRenameThread={onRenameThread}
              onRestoreThread={onRestoreThread}
              searchQuery={threadSearch}
              onSearchQueryChange={setThreadSearch}
              searchInputRef={threadSearchRef}
              onOpenPalette={() => {
                setRailCollapsed(false);
                window.setTimeout(() => threadSearchRef.current?.focus(), 0);
              }}
            />

            <VNextMeriConversation
              controller={controller}
              greetingName={greetingName}
              tenantName={tenantName}
              onOpenIntegrations={handleOpenIntegrations}
            />

            <VNextMeriContextRail
              controller={controller}
              collapsed={railCollapsed}
              openSection={openSection}
              onToggle={() => setRailCollapsed((collapsed) => !collapsed)}
              onExpandSection={expandSection}
              onSectionChange={setOpenSection}
              onOpenIntegrations={handleOpenIntegrations}
              onOpenContext={(packet, loading, error) => setContextSheet({ open: true, packet, loading, error })}
            />
          </div>
        </div>
      </div>
      <MeriContextSheet
        open={contextSheet.open}
        packet={contextSheet.packet}
        loading={contextSheet.loading}
        error={contextSheet.error}
        onClose={() => setContextSheet((current) => ({ ...current, open: false }))}
      />
    </ManagedMcpAppsProvider>
  );
}
