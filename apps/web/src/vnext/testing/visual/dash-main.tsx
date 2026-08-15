import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import '../../foundations/index.css';
import '../../foundations/untitled-ui-tokens.css';
import { DashboardVNextView } from '../../pages/dashboard/DashboardVNext.js';
import { DASHBOARD_VISUAL_FIXTURE } from '../fixtures/dashboard.js';
import { ShellOverlayProvider } from '../../shell/overlay-manager.js';

/**
 * Dashboard v2 pixel fixture harness. Renders the real DashboardVNextView
 * against the shared fixture, inside the real `.capiro-vnext-root` + the shell
 * overlay provider (needed for focus/Escape layering), but WITHOUT AppShellUui
 * because that shell's TopBar NotificationBell hooks the live Clerk-backed
 * notifications feed, which cannot mount in this Clerk-free harness. The
 * dashboard body is the pixel-parity target of Dashboard v2.
 */
const root = document.getElementById('root');
if (!root) throw new Error('Missing #root for vNext dashboard visual fixture');

const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <ShellOverlayProvider>
          <div className="capiro-vnext-root">
            <div className="capiro-vnext-uui">
              <DashboardVNextView model={DASHBOARD_VISUAL_FIXTURE} />
            </div>
          </div>
        </ShellOverlayProvider>
      </MemoryRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
