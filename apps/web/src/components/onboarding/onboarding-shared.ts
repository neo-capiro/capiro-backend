/**
 * onboarding-shared — UI-free constants + API contracts behind the
 * onboarding-v1 gate chain, shared by BOTH shells.
 *
 * The legacy shell mounts components/onboarding/OnboardingGates + TrialBanner
 * (prototype pixel-ports, ob-overlay.css); the vNext shell mounts the
 * re-skins under vnext/app/onboarding/**. Gating logic, endpoints, event
 * names and copy must be identical on both surfaces — only presentation
 * differs — so the pure parts live here (no react, no CSS). OnboardingGates
 * and DashboardTour re-export what legacy consumers already import from them.
 */

/** Origin of the standalone onboarding app (setup dashboard). */
export const ONBOARDING_ORIGIN = 'https://onboarding.capiro.ai';

/** Window event that (re)starts the product tour at step 1. */
export const START_TOUR_EVENT = 'capiro:start-product-tour';

/** sessionStorage flag: the email/calendar gate was shown this session, so
 * the "You're connected." confirmation should follow the OAuth return. */
export const GATE_SHOWN_KEY = 'ob-gate-was-shown';

/** Contract of GET /onboard-api/setup/state (Phase 4). */
export interface SetupStateResponse {
  complete: boolean;
  tasks: {
    it_email: 'none' | 'waiting' | 'verifying' | 'done';
    import: 'none' | 'waiting' | 'verifying' | 'done';
    firm_ai: 'none' | 'waiting' | 'verifying' | 'done';
    invites: 'none' | 'waiting' | 'verifying' | 'done';
  };
}

/** Same shape IntegrationsPage / AppShell read from /api/engagement/integrations. */
export interface IntegrationConnection {
  id: string;
  provider: 'microsoft_365' | 'google_workspace' | 'imap_caldav' | 'manual';
  accountEmail: string | null;
  displayName: string | null;
  status: 'needs_configuration' | 'connected' | 'error' | 'disabled';
  lastSyncAt: string | null;
}

/** Tour steps — copy is EXACTLY the prototype's OB_TOUR array. */
export const OB_TOUR: Array<{ nav: string; h: string; s: string }> = [
  {
    nav: 'Dashboard',
    h: 'Your Dashboard, Tailored to You',
    s: "A quick view of what's critical in the coming days. Data gets more in-depth the more you use the platform.",
  },
  {
    nav: 'Meri',
    h: 'Meri, Your AI Assistant',
    s: 'Meri pulls context from your connected inbox, calendar, and clients to serve as your "AI Chief of Staff." Ask Meri to perform research, update you on legislation, draft documents, and more.',
  },
  {
    nav: 'Engagement',
    h: 'Your Client Relationship CRM',
    s: 'Prep for meetings, draft tailored email campaigns, and view auto-generated reports in the Engagement manager.',
  },
  {
    nav: 'Portfolio',
    h: "Your Organization's Client List",
    s: "Your org's client profiles live here, along with key information and tailored insights for each one.",
  },
  {
    nav: 'Workspace',
    h: 'Draft Key Documents with Meri',
    s: 'Meri can help you quickly draft personalized memos, white papers, requests, and more.',
  },
  {
    nav: 'Directory',
    h: 'Your Congressional Directory',
    s: 'View and search the full congressional directory of members, staffers, and key insights.',
  },
  {
    nav: 'Intelligence',
    h: 'Intel Tailored for You',
    s: "Explore intelligence tools. LegiWatch surfaces critical insights and alerts you when relevant bills move or your clients' interests are mentioned in hearings. Data Explorer searches Capiro's full federal data records. Program Elements gives you key budget data.",
  },
];
