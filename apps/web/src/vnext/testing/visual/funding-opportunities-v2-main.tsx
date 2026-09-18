import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { CapiroToastProvider } from '../../components/feedback/toast.js';
import { AppShellUuiView } from '../../shell/AppShellUui/index.js';
import { VNEXT_ROUTE_MANIFEST } from '../../adapters/routes/routeManifest.js';
import { FOUNDATION_MAILBOX_STATES } from '../fixtures/foundation.js';
import { FundingOpportunitiesPage } from '../../pages/funding-opportunities/FundingOpportunitiesPage.js';
import { fundingOpportunitiesV2PreviewTarget } from './funding-opportunities-v2-fixture-api.js';
import '../../foundations/index.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity }, mutations: { retry: false } } });
const navigation = { primary: VNEXT_ROUTE_MANIFEST.filter((route) => route.id !== 'settings'), settings: VNEXT_ROUTE_MANIFEST.find((route) => route.id === 'settings') ?? null, loading: false };
const identity = { loading: false, unavailable: false, name: 'Neo Martinez', role: 'Government Affairs', email: 'neo@capiro.ai', initials: 'NM', imageUrl: null };
const notifications = { loading: false, unavailable: false, unread: 2, showBadge: true, badgeLabel: '2' };
function PreviewEntryRedirect() {
  const location = useLocation();
  return <Navigate to={fundingOpportunitiesV2PreviewTarget(location.search)} replace />;
}
function PreviewFallbackRedirect() {
  const location = useLocation();
  return <Navigate to={fundingOpportunitiesV2PreviewTarget(location.search)} replace />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <CapiroToastProvider>
        <div className="capiro-vnext-root">
          <AppShellUuiView navigation={navigation} identity={identity} notifications={notifications} mailboxStatus={FOUNDATION_MAILBOX_STATES[0]} scopeLabel="Overland AI" globalSearchPlaceholder="Search opportunities, agencies, references…" fundingSourceHealth={{ degradedCount: 1, label: '1 source degraded', details: ['DLA BID BOARD · 6H AGO'] }} onNavigate={() => undefined} onSignOut={() => undefined} onOpenProfile={() => undefined}>
            <Routes>
              <Route path="/intelligence/opportunities" element={<FundingOpportunitiesPage />} />
              <Route path="/intelligence/opportunities/:source/:sourceRecordId" element={<FundingOpportunitiesPage />} />
              <Route path="/funding-opportunities-v2-preview.html" element={<PreviewEntryRedirect />} />
              <Route path="*" element={<PreviewFallbackRedirect />} />
            </Routes>
          </AppShellUuiView>
        </div>
      </CapiroToastProvider>
    </BrowserRouter>
  </QueryClientProvider>,
);