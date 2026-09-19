import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { VNextLegiWatchRoutes } from '../../pages/legiwatch/VNextLegiWatchRoutes.js';
import '../../foundations/index.css';
import '../../pages/legiwatch/legiwatch.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
});
const root = document.getElementById('root');
if (!root) throw new Error('Missing #root for LegiWatch QA harness');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <div className="capiro-vnext-root">
          <div className="capiro-vnext-uui">
            <main className="uui-content">
              <VNextLegiWatchRoutes />
            </main>
          </div>
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
