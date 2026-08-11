import { Navigate, Route, Routes } from 'react-router-dom';
import { useMe } from '../../../lib/me.js';
import { StrategyEditorPage } from '../../../pages/strategy/StrategyEditorPage.js';
import { ContextLibrary } from '../../../pages/strategy/context/ContextLibrary.js';
import { ContextDocumentView } from '../../../pages/strategy/context/ContextDocumentView.js';
import { StewardReview } from '../../../pages/strategy/context/StewardReview.js';
import { ReviewQueue } from '../../../pages/strategy/agents/ReviewQueue.js';
import { ExecutionReview } from '../../../pages/strategy/agents/ExecutionReview.js';
import { StrategyLibraryVNext } from './StrategyLibraryVNext.js';
import '../../../pages/strategy/strategy-ds.css';
import './strategies.css';

/**
 * os.capiro.ai Strategy presentation router.
 *
 * Canonical routes, feature gates and logic match pages/strategy/StrategyRoutes;
 * only the presentation boundary changes. The implementation maps the Figma
 * Strategy surface set 843:2502 → 854:3870 while retaining the production
 * editor/context/agent components and their existing mutations.
 */
export function VNextStrategiesRoutes() {
  const me = useMe();
  if (me.isLoading) {
    return <div className="vnext-strategy-loading">Loading strategies…</div>;
  }
  if (!me.data?.features.strategyPlanner) return <Navigate to="/" replace />;

  const agentic = Boolean(me.data.features.agenticMeri);
  return (
    <div className="vnext-strategies sp-root" data-figma-page="842:2502">
      <Routes>
        <Route index element={<StrategyLibraryVNext />} />
        <Route
          path="context"
          element={agentic ? <ContextLibrary /> : <Navigate to="/strategies" replace />}
        />
        <Route
          path="context/steward"
          element={agentic ? <StewardReview /> : <Navigate to="/strategies" replace />}
        />
        <Route
          path="context/:id"
          element={agentic ? <ContextDocumentView /> : <Navigate to="/strategies" replace />}
        />
        <Route
          path="agents/review"
          element={agentic ? <ReviewQueue /> : <Navigate to="/strategies" replace />}
        />
        <Route
          path="agents/execution"
          element={agentic ? <ExecutionReview /> : <Navigate to="/strategies" replace />}
        />
        <Route path=":id" element={<StrategyEditorPage />} />
        <Route path="*" element={<Navigate to="/strategies" replace />} />
      </Routes>
    </div>
  );
}
