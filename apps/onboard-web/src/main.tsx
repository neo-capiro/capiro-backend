import React from 'react';
import ReactDOM from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ConfigContext } from './useConfig';
import { fetchConfig, type OnboardConfig } from './config';
import './styles/global.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

function renderFatal(message: string) {
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML = `<div style="min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;color:#4F525A;background:#F4F2EC"><div style="text-align:center"><b style="color:#15161A">Capiro onboarding is briefly unavailable.</b><br/><span style="font-size:13px">${message} — please refresh, or email support@capiro.ai.</span></div></div>`;
  }
}

async function boot() {
  let config: OnboardConfig;
  try {
    config = await fetchConfig();
  } catch {
    renderFatal('Could not load configuration');
    return;
  }
  if (!config.clerkPublishableKey) {
    renderFatal('Sign-in is not configured');
    return;
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ConfigContext.Provider value={config}>
        <ClerkProvider publishableKey={config.clerkPublishableKey}>
          <QueryClientProvider client={queryClient}>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </QueryClientProvider>
        </ClerkProvider>
      </ConfigContext.Provider>
    </React.StrictMode>,
  );
}

void boot();
