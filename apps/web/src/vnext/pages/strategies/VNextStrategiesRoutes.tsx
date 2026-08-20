/*
 * Strategies vNext — module router (STRATEGIES-HANDOFF §6).
 *
 * Every tab, filter, horizon, layer toggle and overlay is a URL; browser
 * back/forward works everywhere. An overlay route renders its caller beneath it;
 * a hard refresh on an overlay route renders the caller then the overlay. Closing
 * an overlay returns to the caller route, not the module root.
 *
 * This module is a complete native rebuild: NO old strategy component is imported
 * (the prior bridge that re-rendered pages/strategy/* is gone). Only the server
 * contract (types) and the shared backend endpoints are reused.
 */
import { Component, Suspense, lazy, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useMe } from '../../../lib/me.js';
import { CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import { StrategyLibraryVNext } from './StrategyLibraryVNext.js';
import { StrategyEditorVNext } from './StrategyEditorVNext.js';
import './strategies-tokens.css';
import './strategies.css';

/* Context, Agents and Overlays are built as sibling components; lazy-imported so
 * the module compiles and the core (library + editor) works while they land. */
const ContextLibraryVNext = lazy(() =>
  import('./context/ContextLibraryVNext.js').then((m) => ({ default: m.ContextLibraryVNext })),
);
const ContextDocumentVNext = lazy(() =>
  import('./context/ContextDocumentVNext.js').then((m) => ({ default: m.ContextDocumentVNext })),
);
const StewardReviewVNext = lazy(() =>
  import('./context/StewardReviewVNext.js').then((m) => ({ default: m.StewardReviewVNext })),
);
const AgentsTabsVNext = lazy(() =>
  import('./agents/AgentsTabsVNext.js').then((m) => ({ default: m.AgentsTabsVNext })),
);
const NewStrategyOverlay = lazy(() =>
  import('./overlays/NewStrategyOverlay.js').then((m) => ({ default: m.NewStrategyOverlay })),
);
const FirmPhasesOverlay = lazy(() =>
  import('./overlays/FirmPhasesOverlay.js').then((m) => ({ default: m.FirmPhasesOverlay })),
);
const ExportOverlay = lazy(() =>
  import('./overlays/ExportOverlay.js').then((m) => ({ default: m.ExportOverlay })),
);
const HistoryOverlay = lazy(() =>
  import('./overlays/HistoryOverlay.js').then((m) => ({ default: m.HistoryOverlay })),
);
const UploadContextOverlay = lazy(() =>
  import('./overlays/UploadContextOverlay.js').then((m) => ({ default: m.UploadContextOverlay })),
);
const ResolveConflictOverlay = lazy(() =>
  import('./overlays/ResolveConflictOverlay.js').then((m) => ({ default: m.ResolveConflictOverlay })),
);

function Loading() {
  return (
    <div className="st-page">
      <CapiroSkeleton height={420} />
    </div>
  );
}

/**
 * Module error boundary. The strategies subtree is lazy-loaded; a render throw
 * (or a failed lazy chunk) with no boundary unmounts the whole route tree to
 * the raw Suspense in App.tsx — leaving a bare, unstyled white page with no
 * shell. Catch it here so the user gets a styled, in-module error with a way
 * back instead. The shell (sidebar/topbar) lives above this and stays mounted.
 */
class StrategiesErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }
  override componentDidCatch(error: unknown): void {
    // Surface to the console for diagnostics; the UI shows the recovery state.
    console.error('[strategies] render error boundary caught', error);
  }
  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="st-page">
          <CapiroErrorState
            title="This strategy screen hit an unexpected error"
            description="The page failed to render. Your data is intact — reload to try again."
            onRetry={() => window.location.reload()}
          />
        </div>
      );
    }
    return this.props.children;
  }
}

export function VNextStrategiesRoutes() {
  const me = useMe();
  if (me.isLoading) {
    return (
      <div className="capiro-strategies st-page">
        <CapiroSkeleton height={420} />
      </div>
    );
  }
  if (!me.data?.features.strategyPlanner) return <Navigate to="/" replace />;
  const agentic = Boolean(me.data.features.agenticMeri);

  return (
    <div className="capiro-strategies" data-module="strategies">
      <StrategiesErrorBoundary>
        <Suspense fallback={<Loading />}>
          {/* Absolute paths throughout, deliberately: this <Routes> has no
           * ancestor <Route>+<Outlet> chain (VNextRouter renders it as a
           * plain component off a `location.pathname` check, same as every
           * other vNext module), so there is no relative "remaining path"
           * context to consume — react-router matches these against the
           * full browser pathname. A relative `index`/`":strategyId"` here
           * previously matched bare "/strategies" itself as strategyId
           * "strategies" (one path segment, matched with no /strategies
           * prefix to strip), taking down the whole module. */}
          <Routes>
          {/* Library + its overlays. */}
          <Route path="/strategies" element={<StrategyLibraryVNext />} />
          <Route path="/strategies/new" element={<Overlay caller={<StrategyLibraryVNext />}><NewStrategyOverlay /></Overlay>} />
          <Route path="/strategies/phases" element={<Overlay caller={<StrategyLibraryVNext />}><FirmPhasesOverlay /></Overlay>} />

          {/* Editor + its overlays. */}
          <Route path="/strategies/:strategyId" element={<StrategyEditorVNext />} />
          <Route path="/strategies/:strategyId/history" element={<Overlay caller={<StrategyEditorVNext />}><HistoryOverlay /></Overlay>} />
          <Route path="/strategies/:strategyId/export" element={<Overlay caller={<StrategyEditorVNext />}><ExportOverlay /></Overlay>} />

          {/* Context library + overlays. */}
          <Route
            path="/strategies/context"
            element={agentic ? <ContextLibraryVNext /> : <Navigate to="/strategies" replace />}
          />
          <Route
            path="/strategies/context/upload"
            element={agentic ? <Overlay caller={<ContextLibraryVNext />}><UploadContextOverlay /></Overlay> : <Navigate to="/strategies" replace />}
          />
          <Route
            path="/strategies/context/steward"
            element={agentic ? <StewardReviewVNext /> : <Navigate to="/strategies" replace />}
          />
          <Route
            path="/strategies/context/steward/:conflictId"
            element={agentic ? <Overlay caller={<StewardReviewVNext />}><ResolveConflictOverlay /></Overlay> : <Navigate to="/strategies" replace />}
          />
          <Route
            path="/strategies/context/:documentId"
            element={agentic ? <ContextDocumentVNext /> : <Navigate to="/strategies" replace />}
          />

          {/* Agents — one surface, two tabs, two routes (§4.1 #1). */}
          <Route
            path="/strategies/agents/proposals"
            element={agentic ? <AgentsTabsVNext tab="proposals" /> : <Navigate to="/strategies" replace />}
          />
          <Route
            path="/strategies/agents/runs"
            element={agentic ? <AgentsTabsVNext tab="runs" /> : <Navigate to="/strategies" replace />}
          />

          <Route path="*" element={<Navigate to="/strategies" replace />} />
          </Routes>
        </Suspense>
      </StrategiesErrorBoundary>
    </div>
  );
}

/** Renders the caller beneath an overlay; closing returns to the caller route. */
function Overlay({ caller, children }: { caller: React.ReactNode; children: React.ReactNode }) {
  return (
    <>
      {caller}
      {children}
    </>
  );
}
