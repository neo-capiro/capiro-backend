/**
 * Meri vNext workspace visual harness — dev/test only.
 *
 * Mounts the REAL VNextMeriShell against a contract-valid controller stub and
 * a seeded chat store. Active-artifact is stateful here (fixture state only,
 * no backend) so the saved-document card exercises its real open/close
 * callbacks; the composer owns its own draft. Served from
 * /vnext-meri-visual.html under vite.meri-visual.config.ts. The production
 * default right panel (Thinking/Evidence/Approvals turn inspector) mounts
 * exactly as it does in the app — no fixture-side auto-clicking.
 *
 * Screens (?screen=):
 *   thread         — populated thread + approval notice (default)
 *   new-thread     — empty landing
 *   streaming      — in-flight turn ("Meri is responding" + Stop)
 */
import React, { useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../../foundations/index.css';
import {
  setConversations,
  setActiveConversation,
  setChatSession,
  claimMeriIdentity,
} from '../../../components/chat/chat-store.js';
import { VNextMeriShell } from '../../meri/VNextMeriShell.js';
import { CapiroToastProvider } from '../../components/feedback/toast.js';
import { createMeriShellVisualController } from './meri-visual-controller.js';
import {
  FIXTURE_CONVERSATIONS,
  FIXTURE_ME,
  FIXTURE_ACTIVE_CONVERSATION_ID,
} from './meri-visual-fixture.js';
import type { MeriChatController } from '../../../components/chat/useMeriChatController.js';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root for Meri visual fixture');

const params = new URLSearchParams(window.location.search);
const screen = params.get('screen') ?? 'thread';

claimMeriIdentity('org-fixture:user-fixture');
const isLanding = screen === 'new-thread';
setConversations(FIXTURE_CONVERSATIONS);
setActiveConversation(isLanding ? null : FIXTURE_ACTIVE_CONVERSATION_ID);
setChatSession(isLanding ? null : FIXTURE_ACTIVE_CONVERSATION_ID);

function MeriVisualApp() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
  );
  queryClient.setQueryData(['me'], FIXTURE_ME);

  // Fixture-only interactive state: the open artifact. The composer owns its
  // own draft internally — no controller field exists for it, and the
  // follow-up chips fill it through the existing custom event.
  const base = useMemo(() => createMeriShellVisualController(), []);
  const [activeArtifact, setActiveArtifact] = useState<MeriChatController['activeArtifact']>(null);

  const controller = useMemo<MeriChatController>(() => {
    const next: MeriChatController = {
      ...base,
      activeArtifact,
      setActiveArtifact,
    };
    if (isLanding) {
      next.messages = [];
      next.sessionId = null;
      next.activeConversationId = null;
      next.pendingApprovals = [];
      next.sessionTitle = 'New thread';
    }
    if (screen === 'streaming') {
      next.isStreaming = true;
    }
    return next;
  }, [base, activeArtifact]);

  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={[isLanding ? '/meri/new' : `/meri/t/${FIXTURE_ACTIVE_CONVERSATION_ID}`]}
      >
        <div className="capiro-vnext-root">
          <div className="capiro-vnext-uui">
            <CapiroToastProvider>
              <VNextMeriShell
                controller={controller}
                historyError={null}
                onRetryHistory={() => undefined}
                onArchiveThread={async () => true}
                onRenameThread={async () => undefined}
                onRestoreThread={async () => true}
              />
            </CapiroToastProvider>
          </div>
        </div>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <MeriVisualApp />
  </React.StrictMode>,
);
