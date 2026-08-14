import React, { Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ClerkProvider } from '@clerk/clerk-react';
import { App as AntApp, ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';
import { config } from './env.js';
import { ANTD_THEME, CLERK_APPEARANCE } from './theme-antd.js';
import './theme.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
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
  return (
    <ConfigProvider theme={ANTD_THEME}>
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>{children}</BrowserRouter>
        </QueryClientProvider>
      </AntApp>
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
