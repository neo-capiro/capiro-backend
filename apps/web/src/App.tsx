import { Navigate, Route, Routes, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { SignIn, SignUp, useAuth } from '@clerk/clerk-react';
import { TicketSignUpPage } from './pages/auth/TicketSignUpPage.js';
import { config } from './env.js';
import { AppShell } from './components/AppShell.js';
import { PlaceholderPage } from './pages/PlaceholderPage.js';
import { SettingsLayout } from './pages/settings/SettingsLayout.js';
import { PersonalPage } from './pages/settings/PersonalPage.js';
import { ContactInfoPage } from './pages/settings/ContactInfoPage.js';
import { MemorySettingsPage } from './pages/settings/MemorySettingsPage.js';
import { TeamPage } from './pages/admin/TeamPage.js';
import { BrandingPage } from './pages/admin/BrandingPage.js';
import { ClientsPage } from './pages/admin/ClientsPage.js';
import { BillingPage } from './pages/admin/BillingPage.js';
import { CustomersPage } from './pages/admin/CustomersPage.js';
import { SubscribePage } from './pages/onboarding/SubscribePage.js';
import { useBillingState } from './lib/billing.js';
import { LockoutScreen } from './components/onboarding/LockoutScreen.js';
import { CapiroAdminPage } from './pages/capiro-admin/CapiroAdminPage.js';
import { ClientWorkspacePage } from './pages/clients/ClientWorkspacePage.js';
import { DirectoryPage } from './pages/directory/DirectoryPage.js';
import { HelpPage } from './pages/help/HelpPage.js';
import { HomePage } from './pages/HomePage.js';
import { EngagementPage } from './pages/engagement/EngagementPage.js';
import { IntegrationsPage } from './pages/settings/IntegrationsPage.js';
import { AiUsagePage } from './pages/settings/AiUsagePage.js';
import { ComingSoonIntelligence } from './pages/intelligence/ComingSoonIntelligence.js';
import { ChangesInboxPage } from './pages/intelligence/ChangesInboxPage.js';
import { KnowledgeGraphPage } from './pages/intelligence/KnowledgeGraphPage.js';
import { LiveHearingRoomPage } from './pages/intelligence/LiveHearingRoomPage.js';
import { RadarPage } from './pages/radar/RadarPage.js';
import { IntelligenceMappingsPage } from './pages/settings/IntelligenceMappingsPage.js';
import { SkillsPage } from './pages/settings/SkillsPage.js';
import { IssueLeaderboardPage } from './pages/intelligence/IssueLeaderboardPage.js';
import { DataExplorerPage } from './pages/explorer/DataExplorerPage.js';
import { ActionBoardPage } from './pages/actions/ActionBoardPage.js';
import { ReviewQueuePage } from './pages/reviews/ReviewQueuePage.js';

const ProgramElementWatchPage = lazy(async () =>
  import('./pages/program-element/ProgramElementWatchPage.js').then((m) => ({
    default: m.ProgramElementWatchPage,
  })),
);

const MarkupMonitorPage = lazy(async () =>
  import('./pages/program-element/MarkupMonitorPage.js').then((m) => ({
    default: m.MarkupMonitorPage,
  })),
);

const ProgramElementFinderPage = lazy(async () =>
  import('./pages/program-element/ProgramElementFinderPage.js').then((m) => ({
    default: m.ProgramElementFinderPage,
  })),
);

const PersonCandidatesPage = lazy(async () =>
  import('./pages/program-element/PersonCandidatesPage.js').then((m) => ({
    default: m.PersonCandidatesPage,
  })),
);

const PeReconciliationPage = lazy(async () =>
  import('./pages/admin/PeReconciliationPage.js').then((m) => ({
    default: m.PeReconciliationPage,
  })),
);

const ProgramMatchQueuePage = lazy(async () =>
  import('./pages/program-element/ProgramMatchQueuePage.js').then((m) => ({
    default: m.ProgramMatchQueuePage,
  })),
);

const AnalystConsolePage = lazy(async () =>
  import('./pages/admin/AnalystConsolePage.js').then((m) => ({
    default: m.AnalystConsolePage,
  })),
);

const WorkspaceRoutes = lazy(async () =>
  import('./pages/workspace/WorkspaceRoutes.js').then((m) => ({
    default: m.WorkspaceRoutes,
  })),
);

export function App() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) {
    if (import.meta.env.DEV) {
      const waitInfo = config.clerkPublishableKey.startsWith('pk_test_')
        ? `Waiting for Clerk session on ${config.clerkPublishableKey.split('_').at(-1) ?? 'unknown'}`
        : 'Waiting for Clerk session...';
      return <PlaceholderPage title="Loading" description={waitInfo} />;
    }
    return <PlaceholderPage title="Loading" description="Please wait..." />;
  }

  return (
    <Routes>
      <Route path="/sign-in/*" element={<AuthPage mode="sign-in" />} />
      <Route path="/sign-up/*" element={<AuthPage mode="sign-up" />} />
      {/* Welcome / paywall. Signed-in but standalone (outside AppShell + the
          BillingGate) so it never redirect-loops with the gate. */}
      <Route
        path="/onboarding/subscribe"
        element={isSignedIn ? <SubscribePage /> : <Navigate to="/sign-in" replace />}
      />
      <Route element={isSignedIn ? <BillingGate /> : <Navigate to="/sign-in" replace />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/clients" element={<ClientWorkspacePage />} />
        <Route path="/engagement/*" element={<EngagementPage />} />
        {/* Workspace — standalone document-builder engine (own ECR/Fargate
            service at /workspace-api/*; this is the SPA UI). */}
        <Route
          path="/workspace/*"
          element={
            <Suspense
              fallback={<PlaceholderPage title="Loading Workspace" description="Please wait..." />}
            >
              <WorkspaceRoutes />
            </Suspense>
          }
        />
        <Route path="/explorer" element={<DataExplorerPage />} />
        {/* LegiWatch (Radar renamed) — Feed · Bills · Hearings · Configure,
            unifying the Bill Tracker + Hearing Watch surfaces under one
            destination. Canonical path is /legiwatch; /radar is kept as a
            query-preserving redirect for live alert-email deep-links. */}
        <Route path="/legiwatch" element={<RadarPage />} />
        <Route path="/radar" element={<LegacyRadarRedirect />} />
        <Route path="/actions" element={<ActionBoardPage />} />
        <Route path="/reviews" element={<ReviewQueuePage />} />
        <Route
          path="/program-elements"
          element={
            <Suspense
              fallback={
                <PlaceholderPage title="Loading program elements" description="Please wait..." />
              }
            >
              <ProgramElementFinderPage />
            </Suspense>
          }
        />
        {/* Static segment must precede the dynamic :peCode route. */}
        <Route
          path="/program-elements/mark-up-monitor"
          element={
            <Suspense
              fallback={
                <PlaceholderPage title="Loading mark-up monitor" description="Please wait..." />
              }
            >
              <MarkupMonitorPage />
            </Suspense>
          }
        />
        <Route
          path="/program-elements/contacts"
          element={
            <Suspense
              fallback={<PlaceholderPage title="Loading contacts" description="Please wait..." />}
            >
              <PersonCandidatesPage />
            </Suspense>
          }
        />
        <Route
          path="/program-elements/:peCode"
          element={
            <Suspense
              fallback={
                <PlaceholderPage title="Loading program element" description="Please wait..." />
              }
            >
              <ProgramElementWatchPage />
            </Suspense>
          }
        />
        <Route
          path="/admin/program-element/reconciliation"
          element={
            <Suspense
              fallback={
                <PlaceholderPage
                  title="Loading reconciliation queue"
                  description="Please wait..."
                />
              }
            >
              <PeReconciliationPage />
            </Suspense>
          }
        />
        <Route
          path="/admin/program-element/match-queue"
          element={
            <Suspense
              fallback={
                <PlaceholderPage title="Loading program match queue" description="Please wait..." />
              }
            >
              <ProgramMatchQueuePage />
            </Suspense>
          }
        />
        {/* Step 3.5 — Unified analyst console (capiro_admin). Gated client-side by
            the page itself; every endpoint it calls enforces RolesGuard server-side.
            Must precede the /admin/* catch-all redirect below. */}
        <Route
          path="/admin/analyst-console"
          element={
            <Suspense
              fallback={
                <PlaceholderPage title="Loading analyst console" description="Please wait..." />
              }
            >
              <AnalystConsolePage />
            </Suspense>
          }
        />
        {/* Intelligence routes kept for legacy URLs, the page renames itself
            to "Intelligence Center" in the sidebar, but ChangesInbox + IssueLeaderboard
            stay reachable for now. The main /intelligence path redirects. */}
        <Route path="/intelligence" element={<Navigate to="/explorer" replace />} />
        <Route path="/intelligence/changes" element={<ChangesInboxPage />} />
        <Route path="/intelligence/graph" element={<KnowledgeGraphPage />} />
        {/* Hearing Watch's list surface moved into LegiWatch's Hearings tab; the
            live hearing room keeps its deep-linkable route. */}
        <Route
          path="/intelligence/hearing-watch"
          element={<Navigate to="/legiwatch?tab=hearings" replace />}
        />
        <Route path="/intelligence/hearing-watch/:id" element={<LiveHearingRoomPage />} />
        <Route path="/intelligence/issues/:code" element={<IssueLeaderboardPage />} />
        <Route path="/intelligence/bills/:bill" element={<BillDetailRedirectRoute />} />
        <Route path="/intelligence/client/:clientId" element={<Navigate to="/clients" replace />} />
        <Route
          path="/intelligence/client/:clientId/graph"
          element={<Navigate to="/clients" replace />}
        />
        <Route path="/intelligence/*" element={<Navigate to="/explorer" replace />} />
        <Route path="/intelligence-center" element={<ComingSoonIntelligence />} />
        <Route path="/directory" element={<DirectoryPage />} />
        <Route path="/help" element={<HelpPage />} />
        <Route path="/portal/*" element={<Navigate to="/clients" replace />} />

        {/* Settings hosts personal + admin + capiro-admin tabs. Tabs are
            role-filtered in SettingsLayout; the API enforces RolesGuard
            on every endpoint as the security boundary. */}
        <Route path="/settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="/settings/personal" replace />} />
          <Route path="personal" element={<PersonalPage />} />
          <Route path="contact" element={<ContactInfoPage />} />
          <Route path="memory" element={<MemorySettingsPage />} />
          <Route path="team" element={<TeamPage />} />
          <Route path="branding" element={<BrandingPage />} />
          <Route path="clients" element={<ClientsPage />} />
          <Route path="integrations" element={<IntegrationsPage />} />
          <Route path="billing" element={<BillingPage />} />
          <Route path="customers" element={<CustomersPage />} />
          <Route path="ai-usage" element={<AiUsagePage />} />
          <Route path="intelligence-mappings" element={<IntelligenceMappingsPage />} />
          <Route path="skills" element={<SkillsPage />} />
          <Route path="tenants" element={<CapiroAdminPage />} />
        </Route>

        {/* Back-compat: old /admin/* and /capiro-admin URLs redirect into Settings. */}
        <Route path="/admin" element={<Navigate to="/settings/team" replace />} />
        <Route path="/admin/*" element={<Navigate to="/settings/team" replace />} />
        <Route path="/capiro-admin" element={<Navigate to="/settings/tenants" replace />} />

        <Route
          path="*"
          element={
            <PlaceholderPage title="Not found" description="404 - this page doesn't exist." />
          }
        />
      </Route>
    </Routes>
  );
}

/**
 * Wraps the authenticated app shell with a billing paywall. A tenant whose
 * subscription is missing or canceled is routed to the welcome/subscribe screen
 * before it can use the product. Uses the role-safe /api/billing/state read
 * (the full summary is billing-admin-only under onboarding v1). Fails OPEN:
 * any state error renders the app normally — only a definitive non-entitled
 * status from the server gates. comped/active/trialing pass through.
 */
function BillingGate() {
  const billing = useBillingState();
  if (billing.isLoading) {
    return <PlaceholderPage title="Loading" description="Please wait..." />;
  }
  const data = billing.data;
  // Only paywall when billing is actually enabled (BILLING_ENFORCED). While
  // dormant, billingEnabled is false → the app behaves exactly as before.
  if (data?.billingEnabled && (data.status === 'none' || data.status === 'canceled')) {
    return <Navigate to="/onboarding/subscribe" replace />;
  }
  // Wire/ACH lockout (Gherkin bridge): all access suspended until the open
  // invoice is paid — the lifecycle cron clears locked when payment lands.
  if (data?.billingEnabled && data.locked) {
    return <LockoutScreen />;
  }
  return <AppShell />;
}

function BillDetailRedirectRoute() {
  const { bill } = useParams<{ bill: string }>();
  const encodedBill = bill ? encodeURIComponent(bill) : '';
  const target = encodedBill ? `/explorer?bill=${encodedBill}` : '/explorer';
  return <Navigate to={target} replace />;
}

// Radar was renamed to LegiWatch; /radar → /legiwatch, preserving the query
// string so live alert-email deep-links (?tab=…&client=…) keep working.
function LegacyRadarRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/legiwatch${search}`} replace />;
}

function AuthPage({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  // Invitation links carry Clerk's ticket param; those get the custom
  // confirm-password form (onboarding v1 — the hosted component asks for the
  // password only once). Ticket-less sign-up keeps the hosted component,
  // preserving the invitation-only posture on this surface.
  const [params] = useSearchParams();
  const ticket = params.get('__clerk_ticket');
  return (
    <main className="auth-page">
      <section className="auth-shell" aria-label={mode === 'sign-in' ? 'Sign in' : 'Sign up'}>
        <img src="/logo.png" alt="Capiro" className="auth-logo" />
        <div className="auth-clerk-frame">
          {mode === 'sign-in' ? (
            <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" fallbackRedirectUrl="/" />
          ) : ticket ? (
            <TicketSignUpPage ticket={ticket} />
          ) : (
            <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" fallbackRedirectUrl="/" />
          )}
        </div>
      </section>
    </main>
  );
}
