import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { PlannerPage } from '../../pages/planner/PlannerPage.js';
import '../../foundations/index.css';
import './planner-qa-api.js';

const client = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <div className="capiro-vnext-root" style={{ background: '#f8f9fc', minHeight: '100vh' }}>
          <div
            style={{ padding: '8px 36px', fontSize: 11, color: '#8a809d', background: '#f0edf9' }}
          >
            LOCAL QA · Synthetic Planner data · No live Asana or Capiro records
          </div>
          <PlannerPage />
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
