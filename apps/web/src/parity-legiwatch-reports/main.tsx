import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReportWorkspace } from '../vnext/pages/legiwatch/reports/ReportWorkspace.js';
import '../vnext/foundations/index.css';
import '../vnext/foundations/untitled-ui-tokens.css';
const client = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
ReactDOM.createRoot(document.getElementById('root')!).render(
  <div
    className="capiro-vnext-root capiro-vnext-uui"
    data-web-surface="vnext"
    style={{
      padding: 24,
      maxWidth: 1440,
      margin: 'auto',
      background: 'var(--capiro-color-bg-canvas)',
    }}
  >
    <p style={{ marginBottom: 16 }}>Interface qualification · synthetic data</p>
    <QueryClientProvider client={client}>
      <ReportWorkspace />
    </QueryClientProvider>
  </div>,
);
