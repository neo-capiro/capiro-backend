import { Navigate, Route, Routes } from 'react-router-dom';
import { useMe } from '../../lib/me.js';
import { StrategyLibraryPage } from './StrategyLibraryPage.js';
import { StrategyEditorPage } from './StrategyEditorPage.js';
import { ContextLibrary } from './context/ContextLibrary.js';
import { ContextDocumentView } from './context/ContextDocumentView.js';
import { StewardReview } from './context/StewardReview.js';
import { ReviewQueue } from './agents/ReviewQueue.js';
import { ExecutionReview } from './agents/ExecutionReview.js';
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

  // Stage D agentic surface: the context-document browser only exists when the
  // tenant's agenticMeri flag (env-ANDed server-side) is on — deep-links
  // bounce back to the library, matching the api-strategy AgenticGuard 403.
  const agentic = Boolean(me.data.features.agenticMeri);

  return (
    <div className="sp-root" style={{ height: '100%', minWidth: 0, overflow: 'hidden' }}>
      <Routes>
        <Route index element={<StrategyLibraryPage />} />
        <Route
          path="context"
          element={agentic ? <ContextLibrary /> : <Navigate to="/strategies" replace />}
        />
        {/* Stage E: Steward review — static segment, registered before context/:id. */}
        <Route
          path="context/steward"
          element={agentic ? <StewardReview /> : <Navigate to="/strategies" replace />}
        />
        <Route
          path="context/:id"
          element={agentic ? <ContextDocumentView /> : <Navigate to="/strategies" replace />}
        />
        {/* Stage F: agent ChangeSet review queue — static two-segment path,
            registered before :id. The server additionally enforces the
            Watcher flag; this is the agenticMeri UI belt. */}
        <Route
          path="agents/review"
          element={agentic ? <ReviewQueue /> : <Navigate to="/strategies" replace />}
        />
        {/* Stage G: Execution review — static two-segment path, before :id. The
            server enforces the per-intent executionAgent flags; agenticMeri is
            the UI belt (matching the other agent surfaces). */}
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
