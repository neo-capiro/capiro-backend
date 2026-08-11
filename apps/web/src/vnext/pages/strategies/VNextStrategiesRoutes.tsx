import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useMe } from '../../../lib/me.js';
import { StrategyEditorPage } from '../../../pages/strategy/StrategyEditorPage.js';
import { StewardReview } from '../../../pages/strategy/context/StewardReview.js';
import { ReviewQueue } from '../../../pages/strategy/agents/ReviewQueue.js';
import { ExecutionReview } from '../../../pages/strategy/agents/ExecutionReview.js';
import { StrategyContextDocumentVNext } from './StrategyContextDocumentVNext.js';
import { StrategyContextLibraryVNext } from './StrategyContextLibraryVNext.js';
import { StrategyLibraryVNext } from './StrategyLibraryVNext.js';
import '../../../pages/strategy/strategy-ds.css';
import './strategies.css';
import './strategy-context.css';
import './strategy-context-document.css';
import './strategy-governance.css';
import './strategy-shell-bridge.css';

export function VNextStrategiesRoutes() {
  const me = useMe();
  if (me.isLoading) return <div className="vnext-strategy-loading">Loading strategies…</div>;
  if (!me.data?.features.strategyPlanner) return <Navigate to="/" replace />;
  const agentic = Boolean(me.data.features.agenticMeri);

  return (
    <div className="vnext-strategies sp-root" data-figma-page="842:2502">
      <Routes>
        <Route index element={<StrategyLibraryVNext />} />
        <Route path="context" element={agentic ? <StrategyContextLibraryVNext /> : <Navigate to="/strategies" replace />} />
        <Route
          path="context/steward"
          element={agentic ? (
            <GovernanceSurface
              figmaNode="843:3292"
              chips={[['Context', 'Governance'], ['Review', 'Steward']]}
              gate="Human decision required"
            >
              <StewardReview />
            </GovernanceSurface>
          ) : <Navigate to="/strategies" replace />}
        />
        <Route path="context/:id" element={agentic ? <StrategyContextDocumentVNext /> : <Navigate to="/strategies" replace />} />
        <Route
          path="agents/review"
          element={agentic ? (
            <GovernanceSurface
              figmaNode="843:3450"
              chips={[['Agent', 'Watcher'], ['Review', 'Change sets']]}
              gate="Approval required"
            >
              <ReviewQueue />
            </GovernanceSurface>
          ) : <Navigate to="/strategies" replace />}
        />
        <Route
          path="agents/execution"
          element={agentic ? (
            <GovernanceSurface
              figmaNode="843:3608"
              chips={[['Agent', 'Execution'], ['Review', 'Runs'], ['Send', 'Disabled']]}
              gate="Security gate · Stage H"
              dangerGate
            >
              <ExecutionReview />
            </GovernanceSurface>
          ) : <Navigate to="/strategies" replace />}
        />
        <Route path=":id" element={<StrategyEditorPage />} />
        <Route path="*" element={<Navigate to="/strategies" replace />} />
      </Routes>
    </div>
  );
}

function GovernanceSurface({
  figmaNode,
  chips,
  gate,
  dangerGate = false,
  children,
}: {
  figmaNode: string;
  chips: Array<[label: string, value: string]>;
  gate: string;
  dangerGate?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="vnext-strategy-governance" data-figma-node={figmaNode}>
      <div className="vnext-strategy-governance__contextbar">
        {chips.map(([label, value]) => (
          <span className="vnext-strategy-governance__chip" key={`${label}-${value}`}>
            <small>{label}</small>
            <strong>{value}</strong>
          </span>
        ))}
        <span className={`vnext-strategy-governance__gate${dangerGate ? ' is-danger' : ''}`}>{gate}</span>
      </div>
      <div className="vnext-strategy-governance__legacy">{children}</div>
    </div>
  );
}
