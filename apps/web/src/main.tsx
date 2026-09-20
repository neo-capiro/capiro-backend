import React, { Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ClerkProvider } from '@clerk/clerk-react';
import { App as AntApp, ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';
import { config, isVNextSurface } from './env.js';
import { ANTD_THEME, CLERK_APPEARANCE } from './theme-antd.js';
import { shouldRetryQuery } from './lib/query-retry.js';
import { initializeMeriInstallExperience } from './vnext/meri/meri-install.js';

// theme.css is the LEGACY surface's global stylesheet. One bundle serves two
// surfaces (see env.ts): app.capiro.ai still renders antd and needs it;
// os.capiro.ai is fully vNext-native (no-legacy-ui.contract.test.ts holds the
// allowlist at zero) and must not have legacy selectors repainting its DOM.
// Loaded dynamically so the vNext surface never fetches or applies it.
if (!isVNextSurface) {
  void import('./theme.css');
} else {
  initializeMeriInstallExperience();
  // AuthPage (App.tsx) is shared by both surfaces and renders before either
  // ClerkAuth or BillingGate mounts VNextApp — its vNext styling has to load
  // here rather than being carried in by any lazy vNext route.
  void import('./vnext/app/auth/vnext-auth.css');
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: shouldRetryQuery },
  },
});

const publicShareMatch =
  /^\/share\/([^/]+)\/?$/.exec(window.location.pathname);
const PublicWorkspaceShare = React.lazy(() =>
  import('./vnext/pages/workspace/share/WorkspaceShareView.js').then(
    (module) => ({ default: module.WorkspaceShareView }),
  ),
);

function FoundationProviders({ children }: { children: React.ReactNode }) {
  const core = (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>{children}</BrowserRouter>
    </QueryClientProvider>
  );

  // The antd theme context and <App> chrome exist for the legacy surface
  // only. On os.capiro.ai nothing antd renders (guard test), so the vNext
  // tree mounts without them — no .ant-app wrapper, no antd message/modal
  // context, no antd theme tokens.
  if (isVNextSurface) return core;

  return (
    <ConfigProvider theme={ANTD_THEME}>
      <AntApp>{core}</AntApp>
    </ConfigProvider>
  );
}

function PublicShareEntry({ token }: { token: string }) {
  return (
    <FoundationProviders>
      <Suspense
        fallback={
          <div
            role="status"
            style={{
              minHeight: '100vh',
              display: 'grid',
              placeItems: 'center',
              color: '#667085',
              background: '#f9fafb',
              fontFamily: 'Inter, sans-serif',
            }}
          >
            Loading shared document…
          </div>
        }
      >
        <PublicWorkspaceShare token={token} />
      </Suspense>
    </FoundationProviders>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root')!);

if (publicShareMatch?.[1]) {
  // Public Workspace shares intentionally mount outside Clerk, billing,
  // tenant context and the authenticated vNext shell.
  root.render(
    <React.StrictMode>
      <PublicShareEntry token={decodeURIComponent(publicShareMatch[1])} />
    </React.StrictMode>,
  );
} else {
  root.render(
    <React.StrictMode>
      <ClerkProvider
        publishableKey={config.clerkPublishableKey}
        signInUrl="/sign-in"
        signUpUrl="/sign-up"
        signInFallbackRedirectUrl="/"
        signUpFallbackRedirectUrl="/"
        appearance={CLERK_APPEARANCE}
      >
        <FoundationProviders>
          <App />
        </FoundationProviders>
      </ClerkProvider>
    </React.StrictMode>,
  );
}
