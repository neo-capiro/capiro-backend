import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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

export function VNextMeriShell({ controller }: VNextMeriShellProps) {
  const me = useMe();
  const navigate = useNavigate();
  const [railCollapsed, setRailCollapsed] = useState(false);

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

  // ⌘K shortcut — could open a palette in the future
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        // Command palette is a future milestone; for now, focus is a no-op.
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleNewChat = () => {
    void controller.handleNewSession();
  };

  const handleOpenIntegrations = () => {
    navigate('/meri/integrations');
  };

  return (
    <div className="vnext-meri" aria-label="Meri workspace">
      <VNextMeriTopBar controller={controller} me={me.data} onNewChat={handleNewChat} />

      <div className="vnext-meri__body">
        <VNextMeriThreadRail
          controller={controller}
          onNewChat={handleNewChat}
          onOpenIntegrations={handleOpenIntegrations}
        />

        <VNextMeriConversation
          controller={controller}
          userLabel={personName}
          greetingName={greetingName}
          tenantName={tenantName}
        />

        <VNextMeriContextRail
          controller={controller}
          collapsed={railCollapsed}
          onToggle={() => setRailCollapsed((collapsed) => !collapsed)}
          onOpenIntegrations={handleOpenIntegrations}
        />
      </div>
    </div>
  );
}
