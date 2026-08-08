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
import { useMe } from './lib/me.js';
import { LockoutScreen } from './components/onboarding/LockoutScreen.js';
import { CapiroAdminPage } from './pages/capiro-admin/CapiroAdminPage.js';
import { ClientWorkspacePage } from './pages/clients/ClientWorkspacePage.js';
import { DirectoryPage } from './pages/directory/DirectoryPage.js';
import MemberDirectoryProfilePage from './pages/directory/MemberDirectoryProfilePage.js';
import StaffDirectoryProfilePage from './pages/directory/StaffDirectoryProfilePage.js';
import CommitteeDirectoryPage from './pages/directory/CommitteeDirectoryPage.js';
import StateLegislatorProfilePage from './pages/directory/StateLegislatorProfilePage.js';
import DistrictDetailPage from './pages/directory/DistrictDetailPage.js';
import { HelpPage } from './pages/help/HelpPage.js';
import { HomePage } from './pages/HomePage.js';
import { EngagementPage } from './pages/engagement/EngagementPage.js';
import { EngagementPreviewBoundary } from './pages/engagement/EngagementPreviewBoundary.js';
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
// Flag-aware bill link target (Bill 360 when enabled, Explorer otherwise).
import { useBillTarget } from './pages/bills/bill-target.js';

// Bill 360 full page (R2 §2.2). Lazy: the dossier body + its 7 tabs are only
// needed once a bill is actually opened full-page (the drawer path imports the
// same body directly, so both share one chunk).
const Bill360Page = lazy(async () =>
  import('./pages/bills/Bill360Page.js').then((m) => ({ default: m.Bill360Page })),
);

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

// Program Elements v2 (capiro-internal only — see ProgramElementV2Gate).
const ProgramElementsV2Page = lazy(async () =>
  import('./pages/program-element/ProgramElementsV2Page.js').then((m) => ({
    default: m.ProgramElementsV2Page,
  })),
);
const ProgramElementV2ProfilePage = lazy(async () =>
  import('./pages/program-element/ProgramElementV2ProfilePage.js').then((m) => ({
    default: m.ProgramElementV2ProfilePage,
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

const StrategyRoutes = lazy(async () =>
  import('./pages/strategy/StrategyRoutes.js').then((m) => ({
    default: m.StrategyRoutes,
  })),
);

// District Nexus (WS-G) — MapLibre is a real GPU-rendering dependency that
// must never reach the initial or client-profile bundles; lazy is the only
// chunk-splitting mechanism this repo has (same pattern as the other
// heavy-dependency routes above). Gated in-page by district_nexus_v2
// (HearingWatchPage precedent) — the route itself registers unconditionally.
const DistrictNexusPage = lazy(async () =>
  import('./pages/intelligence/district-nexus/DistrictNexusPage.js').then((m) => ({
    default: m.DistrictNexusPage,
  })),
);

// Federal Spending & Market Intelligence. Kept in its own chunk because the
// four explorer tables are independent from the generic Data Explorer and from
// District Nexus. All provider-backed rows are local reads; this page never
// calls MakeGov/Tango directly.
const FederalSpendingPage = lazy(async () =>
  import('./pages/intelligence/federal-spending/FederalSpendingPage.js').then((m) => ({
    default: m.FederalSpendingPage,
  })),
);

// Funding Opportunities. Lazy for the same chunk-splitting reason as the routes
// above — it is a large page with its own card/CSS surface that nothing else
// needs, and it must never reach the initial bundle. Gated IN-PAGE by
// `funding_opportunities` (HearingWatchPage / DistrictNexusPage precedent); the
// route itself registers unconditionally so a deep link resolves and the page
// decides what to show.
const FundingOpportunitiesPage = lazy(async () =>
  import('./pages/intelligence/opportunities/FundingOpportunitiesPage.js').then((m) => ({
    default: m.FundingOpportunitiesPage,
  })),
);
// Funding Opportunities v2 (capiro-internal only — see FundingOpportunitiesV2Gate).
const FundingOpportunitiesV2Page = lazy(async () =>
  import('./pages/intelligence/opportunities/v2/FundingOpportunitiesV2Page.js').then((m) => ({
    default: m.FundingOpportunitiesV2Page,
  })),
);
// The deep-linkable opportunity detail. A SEPARATE lazy chunk from the list page:
// the two are reached independently (a detail link pasted into a ticket does not
// go via the inbox), and bundling them would make either one pay for the other.
const FundingOpportunityDetailPage = lazy(async () =>
  import('./pages/intelligence/opportunities/FundingOpportunityDetail.js').then((m) => ({
    default: m.FundingOpportunityDetailPage,
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
    <>
      {/* Internal Engagement API preview switch (Phase 3). Renders nothing and
          is inert unless ?engagement-api-preview= is present. Mounted beside
          the route table, not inside /engagement/*, because the mode is
          session-wide — /settings/integrations is an Engagement consumer too. */}
      <EngagementPreviewBoundary />
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
        {/* Strategy Planner (PPBE) — own ECR/Fargate service at /strategy-api/*;
            gated per-tenant by /me features.strategyPlanner (StrategyRoutes
            redirects home when off, so deep-links respect the flag). */}
        <Route
          path="/strategies/*"
          element={
            <Suspense
              fallback={<PlaceholderPage title="Loading Strategies" description="Please wait..." />}
            >
              <StrategyRoutes />
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
        {/* Bill 360 (R2 §2.2) — the one deep-linkable bill dossier. `?client=<id>`
            adds that client's context; a bare URL is the public dossier. Every
            bill entry point (board card, feed, hearing, PE timeline, Explorer
            redirect, copied link) resolves here or to the same body in a drawer. */}
        <Route path="/bills/:billId" element={<Bill360Page />} />
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
              <ProgramElementFinderGate />
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
              <ProgramElementWatchGate />
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
        {/* District Nexus (WS-G) — feature-flagged (district_nexus_v2), gated
            in-page; the route itself is registered unconditionally (house
            pattern) so a direct deep-link always resolves to the flag-off
            guide rather than a 404. */}
        <Route
          path="/intelligence/district-nexus"
          element={
            <Suspense
              fallback={<PlaceholderPage title="Loading District Nexus" description="Loading map and district data..." />}
            >
              <DistrictNexusPage />
            </Suspense>
          }
        />
        {/* Federal Spending & Market Intelligence — local first-party awards and
            provider-labelled Tango subawards, vehicles, and forecasts. This
            literal route must precede the `/intelligence/*` catch-all. */}
        <Route
          path="/intelligence/federal-spending"
          element={
            <Suspense
              fallback={
                <PlaceholderPage
                  title="Loading Federal Spending"
                  description="Loading awards, subawards, vehicles, and forecasts..."
                />
              }
            >
              <FederalSpendingPage />
            </Suspense>
          }
        />
        {/* Funding Opportunities — Grants.gov + SAM.gov contract opportunities.
            Registered BEFORE the catch-all `/intelligence/*` redirect below,
            which would otherwise swallow it and bounce the user to /explorer. */}
        <Route
          path="/intelligence/opportunities"
          element={
            <Suspense
              fallback={
                <PlaceholderPage
                  title="Loading Funding Opportunities"
                  description="Loading grant and contract opportunities..."
                />
              }
            >
              <FundingOpportunitiesV2Gate />
            </Suspense>
          }
        />
        {/* One opportunity, for one client. Registered AFTER the list route (which
            is a literal, so order between the two is not actually load-bearing) and
            BEFORE the `/intelligence/*` catch-all, which would otherwise swallow it
            and bounce every pasted detail link to /explorer.

            `:sourceRecordId` is a single segment: Grants.gov opportunity numbers and
            SAM notice ids are both opaque strings the page encodes on the way in. */}
        <Route
          path="/intelligence/opportunities/:source/:sourceRecordId"
          element={
            <Suspense
              fallback={
                <PlaceholderPage
                  title="Loading opportunity"
                  description="Loading the opportunity detail..."
                />
              }
            >
              <FundingOpportunityDetailPage />
            </Suspense>
          }
        />
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
        {/* Deep-linkable directory profiles + committee dictionary (static segments precede :params). */}
        <Route path="/directory/members/:memberId" element={<MemberDirectoryProfilePage />} />
        <Route path="/directory/staff/:staffId" element={<StaffDirectoryProfilePage />} />
        <Route path="/directory/committees/:committeeId" element={<CommitteeDirectoryPage />} />
        <Route path="/directory/state-legislators/:id" element={<StateLegislatorProfilePage />} />
        <Route path="/directory/districts/:state/:districtNo" element={<DistrictDetailPage />} />
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
    </>
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
/**
 * Program Elements v2 — capiro-internal visual refinement (branch
 * ui/pe-v2-refinement). The mockup workspace replaces the finder/profile only
 * for the internal tenant; every other tenant keeps the legacy pages untouched.
 */
function ProgramElementFinderGate() {
  const me = useMe();
  if (me.data?.tenant.slug === 'capiro-internal') return <ProgramElementsV2Page />;
  return <ProgramElementFinderPage />;
}

function ProgramElementWatchGate() {
  const me = useMe();
  if (me.data?.tenant.slug === 'capiro-internal') return <ProgramElementV2ProfilePage />;
  return <ProgramElementWatchPage />;
}

/**
 * Funding Opportunities v2 gate. capiro-internal renders the DS v2 workspace; every
 * other tenant keeps the legacy Ant Design surface. The route registers
 * unconditionally — only the page swaps, so the flag/role gates and the master
 * feature check inside each page still decide whether anything renders at all.
 */
function FundingOpportunitiesV2Gate() {
  const me = useMe();
  if (me.data?.tenant.slug === 'capiro-internal') return <FundingOpportunitiesV2Page />;
  return <FundingOpportunitiesPage />;
}

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

/**
 * Legacy `/intelligence/bills/:bill` deep-links (live alert emails still carry
 * them) resolve to Bill 360 (R2 §2.5) for a tenant that HAS Bill 360, and keep
 * resolving to the Explorer drill-in for a tenant that does not — `useBillTarget`
 * owns that decision. Routing every tenant to `/bills/:id` would land the
 * un-enabled ones on a "not enabled" page instead of the view their existing links
 * open today. Without a bill id there is nothing to open — Explorer, as before.
 */
function BillDetailRedirectRoute() {
  const { bill } = useParams<{ bill: string }>();
  const billTarget = useBillTarget();
  return <Navigate to={bill ? billTarget(bill) : '/explorer'} replace />;
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
