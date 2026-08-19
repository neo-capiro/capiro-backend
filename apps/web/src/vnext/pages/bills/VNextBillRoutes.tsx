import { Suspense, lazy } from 'react';
import { Route, Routes } from 'react-router-dom';

export { isVNextBillPath } from './bill-route-state.js';

/**
 * Bill 360 vNext — module router. Claims the deep-linkable dossier route
 * `/bills/:billId` (global, and client-scoped via `?client=<id>`), which the
 * vNext LegiWatch Bills tab links into from its drawer's "Open full page".
 *
 * Lazy, mirroring App.tsx's canonical mount: the dossier body + its 7 tabs are
 * only needed once a bill is actually opened full-page. The `bill_360`
 * fail-closed feature gate lives inside the page itself (same as canonical),
 * not here — the route is claimed unconditionally so no legacy UI can render
 * at this URL on the vNext surface.
 */
const Bill360PageVNext = lazy(async () => ({
  default: (await import('./Bill360PageVNext.js')).Bill360PageVNext,
}));

export function VNextBillRoutes() {
  return (
    <Routes>
      <Route
        path="/bills/:billId"
        element={
          <Suspense fallback={<div className="capiro-vnext-route-loading">Loading…</div>}>
            <Bill360PageVNext />
          </Suspense>
        }
      />
    </Routes>
  );
}
