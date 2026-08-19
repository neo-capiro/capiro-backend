/**
 * Admin + misc vNext — module router (purge Phase 3).
 *
 * Claims the six canonical routes listed in admin-misc-routes.ts at their
 * existing URLs. Every page is lazy: none of these surfaces is a hot path
 * (three are capiro_admin consoles, the other three are shallow deep-link
 * pages), so nothing here should cost the entry bundle a byte.
 *
 * Route-registration semantics mirror App.tsx exactly:
 *   - all six routes register unconditionally; the two capiro_admin consoles
 *     gate IN-PAGE (403 state), exactly like their canonical pages — the
 *     server's RolesGuard on every endpoint remains the security boundary;
 *   - /admin, /admin/<other>, /capiro-admin and /portal/* are NOT claimed —
 *     they keep resolving through the canonical <Navigate> redirects.
 *
 * The wildcard fallback renders nothing but should be unreachable: VNextRouter
 * only mounts this module when isVNextAdminMiscPath already matched.
 */
import { Suspense, lazy } from 'react';
import { Route, Routes } from 'react-router-dom';
import { CapiroSkeleton } from '../../components/feedback/index.js';
import '../settings/settings-vnext.css';
import './admin-misc-vnext.css';

const VNextAnalystConsolePage = lazy(async () => ({
  default: (await import('./VNextAnalystConsolePage.js')).VNextAnalystConsolePage,
}));
const VNextPeReconciliationPage = lazy(async () => ({
  default: (await import('./VNextPeReconciliationPage.js')).VNextPeReconciliationPage,
}));
const VNextProgramMatchQueuePage = lazy(async () => ({
  default: (await import('./VNextProgramMatchQueuePage.js')).VNextProgramMatchQueuePage,
}));
const VNextActionBoardPage = lazy(async () => ({
  default: (await import('./VNextActionBoardPage.js')).VNextActionBoardPage,
}));
const VNextReviewQueuePage = lazy(async () => ({
  default: (await import('./VNextReviewQueuePage.js')).VNextReviewQueuePage,
}));
const VNextHelpPage = lazy(async () => ({
  default: (await import('./VNextHelpPage.js')).VNextHelpPage,
}));

function Loading() {
  return (
    <div className="settings-vnext amx" aria-busy="true">
      <div className="stv-body">
        <CapiroSkeleton height={22} width="30%" />
        <CapiroSkeleton height={16} />
        <CapiroSkeleton height={16} width="70%" />
      </div>
    </div>
  );
}

function page(element: React.ReactNode) {
  return <Suspense fallback={<Loading />}>{element}</Suspense>;
}

export function VNextAdminMiscRoutes() {
  return (
    <Routes>
      <Route path="/admin/analyst-console" element={page(<VNextAnalystConsolePage />)} />
      <Route
        path="/admin/program-element/reconciliation"
        element={page(<VNextPeReconciliationPage standalone />)}
      />
      <Route
        path="/admin/program-element/match-queue"
        element={page(<VNextProgramMatchQueuePage standalone />)}
      />
      <Route path="/actions" element={page(<VNextActionBoardPage />)} />
      <Route path="/reviews" element={page(<VNextReviewQueuePage />)} />
      <Route path="/help" element={page(<VNextHelpPage />)} />
      {/* Unreachable when mounted via VNextRouter (predicate-gated). */}
      <Route path="*" element={null} />
    </Routes>
  );
}
