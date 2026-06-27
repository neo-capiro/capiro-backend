import { Navigate, Route, Routes } from 'react-router-dom';
import './workspace-ds.css';
import './workspace.css';
import { LibraryPage } from './LibraryPage.js';
import { DocumentsPage } from './DocumentsPage.js';
import { SetupPage } from './SetupPage.js';
import { ContextBuilderPage } from './ContextBuilderPage.js';
import { EditorPage } from './EditorPage.js';
import { PreviewPage } from './PreviewPage.js';
import { CollabPage } from './CollabPage.js';

/**
 * Workspace feature router. Mounted at /workspace/* in App.tsx (inside the
 * AppShell + BillingGate). The engine API lives at /workspace-api/* (separate
 * ECR/Fargate service); these are the UI pages that consume it.
 *
 * Flow: Library → Documents | Setup → Build context → Draft (editor) → Preview.
 */
export function WorkspaceRoutes() {
  return (
    <div className="ws-root">
      <Routes>
        <Route index element={<LibraryPage />} />
        <Route path="library" element={<LibraryPage />} />
        <Route path="documents" element={<DocumentsPage />} />
        <Route path="setup" element={<SetupPage />} />
        <Route path="setup/:draftId" element={<SetupPage />} />
        <Route path="context/:draftId" element={<ContextBuilderPage />} />
        <Route path="draft/:draftId" element={<EditorPage />} />
        <Route path="collab/:draftId" element={<CollabPage />} />
        <Route path="preview/:draftId" element={<PreviewPage />} />
        <Route path="*" element={<Navigate to="/workspace" replace />} />
      </Routes>
    </div>
  );
}
