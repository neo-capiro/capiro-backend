import { Navigate, Route, Routes } from 'react-router-dom';
import { useMe } from '../../lib/me.js';
import { StrategyLibraryPage } from './StrategyLibraryPage.js';
import { StrategyEditorPage } from './StrategyEditorPage.js';
import './strategy-ds.css';

/**
 * Strategy Planner feature router. Everything is wrapped in `.sp-root` so the
 * ported prototype tokens/inline styles resolve. Gated per-tenant by the /me
 * feature flag so deep-links to /strategies respect it (nav hides the entry
 * when off; the api-strategy service also 403s — this is the UI belt).
 */
export function StrategyRoutes() {
  const me = useMe();

  if (me.isLoading) {
    return (
      <div className="sp-root" style={{ padding: 40, color: 'var(--ink-3)' }}>
        Loading…
      </div>
    );
  }
  if (!me.data?.features?.strategyPlanner) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="sp-root" style={{ height: '100%', overflow: 'hidden' }}>
      <Routes>
        <Route index element={<StrategyLibraryPage />} />
        <Route path=":id" element={<StrategyEditorPage />} />
        <Route path="*" element={<Navigate to="/strategies" replace />} />
      </Routes>
    </div>
  );
}
