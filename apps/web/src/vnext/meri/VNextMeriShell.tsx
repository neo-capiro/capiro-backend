import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ManagedMcpAppsProvider } from '../../components/chat/managed-mcp-apps.js';
import { useMe } from '../../lib/me.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { VNextMeriTopBar } from './VNextMeriTopBar.js';
import { VNextMeriThreadRail } from './VNextMeriThreadRail.js';
import { VNextMeriConversation } from './VNextMeriConversation.js';
import { VNextMeriContextRail } from './VNextMeriContextRail.js';
import './vnext-meri.css';

interface VNextMeriShellProps {
  controller: MeriChatController;
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

/**
 * Mirrors `useIsMobile` in adapters/legacy/useDashboardVNextModel.ts, pinned to
 * a canonical vNext breakpoint (foundations/responsive.css). Meri needs the
 * boundary in JS, not only in CSS: the context rail's collapsed and expanded
 * presentations are two different trees in VNextMeriContextRail, so a media
 * query could only squeeze the expanded tree, never swap it for the icon strip.
 */
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

export function VNextMeriShell({ controller }: VNextMeriShellProps) {
  const me = useMe();
  const navigate = useNavigate();
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [threadSearch, setThreadSearch] = useState('');
  const threadSearchRef = useRef<HTMLInputElement>(null);

  // The context rail defaults to the icon strip at tablet and below, where two
  // full rails would leave the transcript narrower than either of them. This
  // only fires when the boundary is actually crossed, so an explicit expand or
  // collapse by the user still stands within a band.
  const isTabletDown = useMatchesWidth('(max-width: 1179px)');
  const lastBandRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (lastBandRef.current === isTabletDown) return;
    lastBandRef.current = isTabletDown;
    setRailCollapsed(isTabletDown);
  }, [isTabletDown]);

  const personName = displayName(me.data);
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
        threadSearchRef.current?.focus();
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

  return (
    <ManagedMcpAppsProvider>
      <div className="vnext-meri" aria-label="Meri workspace">
        <VNextMeriTopBar
          controller={controller}
          me={me.data}
          onNewChat={handleNewChat}
          onSearch={() => threadSearchRef.current?.focus()}
        />

        <div className="vnext-meri__body">
          <VNextMeriThreadRail
            controller={controller}
            onNewChat={handleNewChat}
            onOpenIntegrations={handleOpenIntegrations}
            searchQuery={threadSearch}
            onSearchQueryChange={setThreadSearch}
            searchInputRef={threadSearchRef}
          />

          <VNextMeriConversation
            controller={controller}
            userLabel={personName}
            greetingName={greetingName}
            tenantName={tenantName}
            onOpenIntegrations={handleOpenIntegrations}
          />

          <VNextMeriContextRail
            controller={controller}
            collapsed={railCollapsed}
            onToggle={() => setRailCollapsed((collapsed) => !collapsed)}
            onOpenIntegrations={handleOpenIntegrations}
          />
        </div>
      </div>
    </ManagedMcpAppsProvider>
  );
}
