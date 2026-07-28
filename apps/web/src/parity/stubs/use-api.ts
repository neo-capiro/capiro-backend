/*
 * Phase 7 parity harness — the ONLY stubbed layer: the axios-like transport.
 *
 * Every strategy hook in api.ts (plus useMe, clients-lite, members,
 * client-targets-lite) gets its client from `useApi()`, so replacing this one
 * module makes the whole data layer deterministic while the hooks, the query
 * cache, the normalizers and the components stay exactly production's.
 *
 * The route table is deliberately small and explicit: an unrouted request
 * REJECTS loudly rather than resolving empty, so a missing fixture shows up as
 * an error in the harness instead of a silently blank capture that would be
 * mistaken for a parity failure.
 *
 * `?hang=<substr>` makes any matching request never settle — that is how the
 * "Re-checking" state (a pending accept/revalidate) is captured.
 */
import { parityState } from '../state.js';
import * as fx from '../fixtures.js';

type Res<T> = Promise<{ data: T }>;

function params(): URLSearchParams {
  return new URLSearchParams(location.search);
}

function hangs(url: string): boolean {
  const hang = params().get('hang');
  return Boolean(hang && url.includes(hang));
}

const never = new Promise<never>(() => {});

function ok<T>(data: T): Res<T> {
  // One microtask-plus tick, so components render their loading frame the same
  // way they do against a real network rather than resolving synchronously.
  return new Promise((resolve) => setTimeout(() => resolve({ data }), 10));
}

function route(url: string): unknown {
  const s = parityState();

  if (url === '/api/me') {
    return {
      user: {
        id: 'user_parity',
        clerkUserId: 'user_parity',
        email: 'neo@capiro.ai',
        firstName: 'Neo',
        lastName: 'Martinez',
        title: 'Sr. Government Affairs Lead',
        emailSignatureEnabled: false,
        hasEmailSignature: false,
        tourCompleted: true,
      },
      tenant: { id: 'tenant-parity', slug: 'capiro-internal', name: 'Capiro' },
      role: 'user_admin',
      billingAdmin: true,
      features: {
        meetingsV2: false,
        meriDockUndockUi: true,
        strategyPlanner: true,
        strategyPlannerMeri: s.meri,
        agenticMeri: s.agentic,
        strategyWatcher: s.watcher,
        contextSteward: true,
      },
    };
  }
  if (url === '/api/clients') return fx.CLIENTS;
  if (url === '/api/tenant-members') return fx.MEMBERS;
  if (url.startsWith('/api/clients/') && url.endsWith('/targets')) return [];

  if (url === '/strategy-api/strategies') return fx.LIST;
  if (url === '/strategy-api/firm-phases') return fx.FIRM_PHASES;
  if (url === '/strategy-api/reference-calendars') return fx.REFERENCE;
  if (url.startsWith('/strategy-api/agents/missions')) return s.agentic ? fx.MISSIONS : [];
  if (url === '/strategy-api/agents/watch/pending-counts') {
    return s.watcher ? { [fx.SID]: fx.PROPOSALS.length } : {};
  }
  if (url === `/strategy-api/agents/watch/strategies/${fx.SID}`) return s.watch;
  if (url.startsWith('/strategy-api/agents/change-sets')) return [];
  if (url === `/strategy-api/strategies/${fx.SID}`) return s.detail;
  if (url.startsWith(`/strategy-api/strategies/${fx.SID}/conversations`)) {
    const nodeId = new URLSearchParams(url.split('?')[1] ?? '').get('nodeId');
    return nodeId ? s.threads[nodeId] ?? [] : s.threads.strategy ?? [];
  }
  if (url.startsWith(`/strategy-api/strategies/${fx.SID}/versions`)) {
    return { rows: [], nextCursor: null };
  }
  throw new Error(`parity harness: unrouted request ${url}`);
}

export function useApi() {
  return {
    get: <T,>(url: string): Res<T> => (hangs(url) ? never : (ok(route(url)) as Res<T>)),
    // Writes are not part of a visual-parity capture; they resolve with the
    // current read state so an accidental click cannot blank the screen. The
    // one exception that matters is `hang`, which is how the pending/disabled
    // treatments get captured.
    post: <T,>(url: string): Res<T> => {
      if (hangs(url)) return never;
      const s = parityState();
      if (url.endsWith('/revalidate') || url.endsWith('/dismiss')) return ok(s.watch) as Res<T>;
      if (url.includes('/accept')) {
        return ok({ strategy: s.detail, state: s.watch, recheck: { state: 'complete', elapsedMs: 20, unchanged: [], updated: [], dropped: [] } }) as Res<T>;
      }
      return ok(s.detail) as Res<T>;
    },
    patch: <T,>(url: string): Res<T> => (hangs(url) ? never : (ok(parityState().detail) as Res<T>)),
    delete: <T,>(url: string): Res<T> => (hangs(url) ? never : (ok(parityState().detail) as Res<T>)),
  };
}
