/**
 * OnboardingGates — Phase 5 in-app gate chain for onboarding-v1 tenants.
 *
 * Mounted inside the authenticated shell (AppShell → Content), wrapping the
 * routed page content. For tenants whose `/api/billing/state` reports
 * `onboardingFlowVersion === 1` it runs, in order:
 *
 *   1. Firm setup gate — GET /onboard-api/setup/state. While the firm setup
 *      dashboard is incomplete, user_admins get a full-screen redirect card
 *      to the onboarding app and standard/portal users get a hold screen.
 *      Request failure or 404 is treated as complete (fail-open — the
 *      endpoint ships with Phase 4). capiro_admin bypasses (operators must
 *      never be locked out of a tenant).
 *   2. Personal email/calendar hard gate (Flow 2B.1–2B.3) — if the CURRENT
 *      USER has zero connected email integrations, the PersonalSetupGate
 *      modal renders over the dimmed app until a connection exists.
 *   3. Otherwise the app renders normally.
 *
 * LEGACY TENANTS SEE ZERO CHANGE: when `onboardingFlowVersion` is
 * null/undefined, or the billing-state query errors, children render
 * directly (no wrapper element, no extra queries beyond the billing state
 * AppShell already loads).
 *
 * Also hosts the first-login DashboardTour (Flow 2B.4): auto-launched on the
 * Dashboard route for onboarding-v1 users who haven't completed it, and
 * re-openable for ALL tenants via the sidebar "Help & product tour" entry.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';
import { useBillingState } from '../../lib/billing.js';
import { useMe, type MeResponse } from '../../lib/me.js';
import { DashboardTour } from './DashboardTour.js';
import { PersonalSetupGateModal } from './PersonalSetupGate.js';
import { ObBtn, ObCard } from './primitives.js';
import './ob-overlay.css';

/** Origin of the standalone onboarding app (setup dashboard). */
export const ONBOARDING_ORIGIN = 'https://onboarding.capiro.ai';

/** Window event that (re)starts the product tour at step 1. */
export const START_TOUR_EVENT = 'capiro:start-product-tour';

/** sessionStorage flag: the email/calendar gate was shown this session, so
 * the "You're connected." confirmation should follow the OAuth return. */
const GATE_SHOWN_KEY = 'ob-gate-was-shown';

/** Contract of GET /onboard-api/setup/state (Phase 4). */
interface SetupStateResponse {
  complete: boolean;
  tasks: {
    it_email: 'none' | 'waiting' | 'verifying' | 'done';
    import: 'none' | 'waiting' | 'verifying' | 'done';
    firm_ai: 'none' | 'waiting' | 'verifying' | 'done';
    invites: 'none' | 'waiting' | 'verifying' | 'done';
  };
}

/** Same shape IntegrationsPage / AppShell read from /api/engagement/integrations. */
interface IntegrationConnection {
  id: string;
  provider: 'microsoft_365' | 'google_workspace' | 'imap_caldav' | 'manual';
  accountEmail: string | null;
  displayName: string | null;
  status: 'needs_configuration' | 'connected' | 'error' | 'disabled';
  lastSyncAt: string | null;
}

export function OnboardingGates({ children }: { children: ReactNode }) {
  const api = useApi();
  const me = useMe();
  const billing = useBillingState();

  // Fail-open version check: null/undefined flow version OR a billing-state
  // error leaves isV1 false and the app renders exactly as today.
  const isV1 = billing.data?.onboardingFlowVersion === 1;

  // ── Stage 1: firm setup state ────────────────────────────────────────────
  const setup = useQuery<SetupStateResponse>({
    queryKey: ['onboarding', 'setup-state'],
    queryFn: async () => (await api.get<SetupStateResponse>('/onboard-api/setup/state')).data,
    enabled: isV1,
    retry: false,
    staleTime: 30_000,
  });
  const setupResolved = !isV1 || setup.isSuccess || setup.isError;
  // Failure or 404 → complete:true (fail-open — endpoint ships with Phase 4).
  const setupComplete = !isV1 || setup.isError || (setup.data?.complete ?? true);
  const role = me.data?.role;
  const setupGateActive =
    isV1 && setupResolved && !setupComplete && role !== undefined && role !== 'capiro_admin';

  // ── Stage 2: personal email/calendar hard gate ───────────────────────────
  const emailGateEnabled =
    isV1 && setupResolved && setupComplete && Boolean(me.data) && role !== 'client_portal_user';

  const [gateWasShown, setGateWasShown] = useState(
    () => typeof sessionStorage !== 'undefined' && sessionStorage.getItem(GATE_SHOWN_KEY) === '1',
  );
  const [dismissed, setDismissed] = useState(false);

  const connections = useQuery<IntegrationConnection[]>({
    // Same key AppShell + IntegrationsPage use, so the cache is shared and the
    // gate re-evaluates the instant the OAuth return invalidates it.
    queryKey: ['engagement-integrations'],
    queryFn: async () =>
      (await api.get<IntegrationConnection[]>('/api/engagement/integrations')).data,
    enabled: emailGateEnabled,
    staleTime: 30_000,
    // Poll every 5s while the modal is up so finishing OAuth in another tab
    // (or the same tab's redirect return) dismisses the gate promptly.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!emailGateEnabled || data === undefined) return false;
      const connected = data.some((c) => c.status === 'connected');
      return !connected || (gateWasShown && !dismissed) ? 5_000 : false;
    },
  });

  const hasConnected = (connections.data ?? []).some((c) => c.status === 'connected');
  // Only a DEFINITIVE zero shows the modal — while the query loads the app
  // renders dimmed with no modal (no flicker); on query error we fail open.
  const zeroConnected = connections.data !== undefined && !hasConnected;
  const emailGateLoading =
    emailGateEnabled && connections.data === undefined && !connections.isError;
  const showGateModal = emailGateEnabled && zeroConnected;
  const showConnectedModal =
    emailGateEnabled &&
    connections.data !== undefined &&
    hasConnected &&
    gateWasShown &&
    !dismissed;

  // Once the hard gate has been shown, remember it for the session so the
  // post-OAuth return lands on the "You're connected." confirmation. Users
  // who were already connected never get the flag — and never see the modal.
  useEffect(() => {
    if (showGateModal && !gateWasShown) {
      sessionStorage.setItem(GATE_SHOWN_KEY, '1');
      setGateWasShown(true);
    }
  }, [showGateModal, gateWasShown]);

  // Reuse IntegrationsPage's start flow: POST …/microsoft/start (reusing a
  // not-yet-connected connection record when one exists) → redirect to authUrl.
  const startMicrosoft = useMutation({
    mutationFn: async () => {
      const reusableId = (connections.data ?? []).find(
        (c) => c.provider === 'microsoft_365' && c.status !== 'connected',
      )?.id;
      return (
        await api.post<{ authUrl: string; connectionId: string }>(
          '/api/engagement/integrations/microsoft/start',
          reusableId ? { connectionId: reusableId } : {},
        )
      ).data;
    },
    onSuccess: ({ authUrl }) => {
      window.location.href = authUrl;
    },
  });

  // Same pattern for Google — the engagement integration has been live since
  // Phase 1 (Settings → Integrations already exposes this exact call); this
  // hard gate previously hardcoded Google as "Coming soon", which went stale
  // once that shipped.
  const startGoogle = useMutation({
    mutationFn: async () => {
      const reusableId = (connections.data ?? []).find(
        (c) => c.provider === 'google_workspace' && c.status !== 'connected',
      )?.id;
      return (
        await api.post<{ authUrl: string; connectionId: string }>(
          '/api/engagement/integrations/google/start',
          reusableId ? { connectionId: reusableId } : {},
        )
      ).data;
    },
    onSuccess: ({ authUrl }) => {
      window.location.href = authUrl;
    },
  });

  const closeEmailGate = () => {
    sessionStorage.removeItem(GATE_SHOWN_KEY);
    setGateWasShown(false);
    setDismissed(true);
  };

  // ── Decision chain ───────────────────────────────────────────────────────
  let content: ReactNode = children;
  let gatesCleared = true;

  if (isV1) {
    if (setupGateActive) {
      gatesCleared = false;
      content = role === 'user_admin' ? <AdminSetupRedirect /> : <SetupHoldScreen />;
    } else if (emailGateLoading) {
      // Integrations still loading: dimmed app, NO modal (definitive zero only).
      gatesCleared = false;
      content = <DimmedApp>{children}</DimmedApp>;
    } else if (showGateModal || showConnectedModal) {
      gatesCleared = false;
      content = (
        <>
          <DimmedApp>{children}</DimmedApp>
          <PersonalSetupGateModal
            connected={showConnectedModal}
            connecting={
              startMicrosoft.isPending ||
              startMicrosoft.isSuccess ||
              startGoogle.isPending ||
              startGoogle.isSuccess
            }
            email={me.data?.user.email ?? null}
            tenantName={me.data?.tenant.name ?? 'your firm'}
            onConnectMicrosoft={() => startMicrosoft.mutate()}
            onConnectGoogle={() => startGoogle.mutate()}
            onContinue={closeEmailGate}
          />
        </>
      );
    }
  }

  return (
    <>
      {content}
      <OnboardingTourHost gatesCleared={gatesCleared} />
    </>
  );
}

/** Prototype AppFrame `dimmed` treatment (04-app-env3.jsx): content at 0.55
 * opacity with pointer events off. Only mounted while a gate is active, so
 * the normal render path adds no wrapper element. */
function DimmedApp({ children }: { children: ReactNode }) {
  return (
    <div aria-hidden style={{ opacity: 0.55, pointerEvents: 'none' }}>
      {children}
    </div>
  );
}

/** Full-screen redirect card for user_admins while firm setup is incomplete. */
function AdminSetupRedirect() {
  return (
    <SetupScreenFrame>
      <h2
        style={{
          margin: 0,
          fontFamily: 'var(--font-serif)',
          fontWeight: 500,
          fontSize: 24,
          letterSpacing: '-0.015em',
        }}
      >
        Your firm is still setting up
      </h2>
      <p style={{ margin: '10px 0 22px', fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.55 }}>
        Finish the setup dashboard before using Capiro.
      </p>
      <ObBtn variant="primary" onClick={() => window.location.assign(`${ONBOARDING_ORIGIN}/setup`)}>
        Open the setup dashboard
      </ObBtn>
    </SetupScreenFrame>
  );
}

/** Friendly hold screen for non-admin users while firm setup is incomplete. */
function SetupHoldScreen() {
  return (
    <SetupScreenFrame>
      <h2
        style={{
          margin: 0,
          fontFamily: 'var(--font-serif)',
          fontWeight: 500,
          fontSize: 24,
          letterSpacing: '-0.015em',
        }}
      >
        Your firm is still setting up
      </h2>
      <p style={{ margin: '10px 0 0', fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.55 }}>
        You'll get access as soon as your admins finish setup. Check back soon.
      </p>
    </SetupScreenFrame>
  );
}

/** Warm-canvas full-screen frame with a centered Card (prototype visual language). */
function SetupScreenFrame({ children }: { children: ReactNode }) {
  return (
    <div
      className="ob-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--bg-canvas)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 1190,
        padding: 24,
      }}
    >
      <ObCard style={{ width: '100%', maxWidth: 440, textAlign: 'center', padding: '44px 36px' }}>
        {children}
      </ObCard>
    </div>
  );
}

/**
 * Hosts the DashboardTour. Auto-launches on the Dashboard route ('/') for
 * onboarding-v1 users who haven't completed it once the gate chain is clear;
 * ALWAYS listens for the sidebar "Help & product tour" event (all tenants).
 * Finish/Skip persists PATCH /api/me { tourCompleted: true } with an
 * optimistic ['me'] cache update.
 */
function OnboardingTourHost({ gatesCleared }: { gatesCleared: boolean }) {
  const api = useApi();
  const qc = useQueryClient();
  const me = useMe();
  const billing = useBillingState();
  const location = useLocation();
  const [step, setStep] = useState<number | null>(null);
  const autoLaunched = useRef(false);

  const isV1 = billing.data?.onboardingFlowVersion === 1;
  const shouldAutoLaunch =
    isV1 &&
    gatesCleared &&
    location.pathname === '/' &&
    me.data !== undefined &&
    !me.data.user.tourCompleted;

  useEffect(() => {
    if (step === null && shouldAutoLaunch && !autoLaunched.current) {
      autoLaunched.current = true;
      setStep(0);
    }
  }, [shouldAutoLaunch, step]);

  // "Help & product tour" sidebar entry (AppShell) — starts at step 1 after
  // navigating to the Dashboard. Available to every tenant.
  useEffect(() => {
    const handler = () => setStep(0);
    window.addEventListener(START_TOUR_EVENT, handler);
    return () => window.removeEventListener(START_TOUR_EVENT, handler);
  }, []);

  const finish = () => {
    setStep(null);
    autoLaunched.current = true;
    const prev = qc.getQueryData<MeResponse>(['me']);
    if (prev && !prev.user.tourCompleted) {
      // Optimistic: flip the cache immediately, reconcile with the server's
      // full me response (PATCH /api/me returns the complete shape).
      qc.setQueryData<MeResponse>(['me'], {
        ...prev,
        user: { ...prev.user, tourCompleted: true },
      });
      void api
        .patch<MeResponse>('/api/me', { tourCompleted: true })
        .then((res) => qc.setQueryData(['me'], res.data))
        .catch(() => {
          // Keep the optimistic value; the next /api/me refetch reconciles.
        });
    }
  };

  if (step === null) return null;
  return <DashboardTour step={step} setStep={setStep} end={finish} />;
}
