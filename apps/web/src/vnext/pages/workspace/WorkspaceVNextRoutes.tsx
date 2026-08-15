/**
 * Exact route ownership for Workspace vNext.
 *
 * Static legacy Workspace routes must continue to fall through to the existing
 * application. Dynamic vNext draft routes are UUID-only so strings such as
 * "library", "draft" and "preview" can never be mistaken for draft IDs.
 */
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { installWorkspaceTransportBridge } from './api/transport-bridge.js';
import { getTwoStepDraftCapability } from './creation/intake-client.js';
import './styles/workspace.css';
import './styles/workspace-audit.css';
import './styles/workspace-editor-audit.css';

const WorkspaceLibraryVNext = lazy(() =>
  import('./library/WorkspaceLibraryVNext.js').then((module) => ({
    default: module.WorkspaceLibraryVNext,
  })),
);
// The new two-step Max draft intake — only shown when the tenant capability is ON.
const WorkspaceQuickDraftIntake = lazy(() =>
  import('./creation/WorkspaceQuickDraftCreation.js').then((module) => ({
    default: module.WorkspaceQuickDraftCreation,
  })),
);
// The stable creation flow — shown when the tenant capability is OFF (default).
const WorkspaceCreationStabilized = lazy(() =>
  import('./creation/WorkspaceCreationStabilized.js').then((module) => ({
    default: module.WorkspaceCreationStabilized,
  })),
);
const WorkspaceEditorVNext = lazy(() =>
  import('./editor/WorkspaceEditorStabilized.js').then((module) => ({
    default: module.WorkspaceEditorStabilized,
  })),
);
const WorkspaceStudioVNext = lazy(() =>
  import('./studio/WorkspaceStudioVNext.js').then((module) => ({
    default: module.WorkspaceStudioVNext,
  })),
);

const UUID_SOURCE =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
const DRAFT_ROUTE = new RegExp(`^/workspace/(${UUID_SOURCE})/?$`);
const RUN_ROUTE = new RegExp(`^/workspace/(${UUID_SOURCE})/run/?$`);
const STUDIO_EDITOR_ROUTE = new RegExp(
  `^/workspace/studio/(${UUID_SOURCE})/(${UUID_SOURCE})/?$`,
);

const STATIC_VNEXT_ROUTES = new Set([
  '/workspace',
  '/workspace/',
  '/workspace/new',
  '/workspace/new/',
  '/workspace/shares',
  '/workspace/shares/',
  '/workspace/studio',
  '/workspace/studio/',
]);

function normalizePath(pathname: string): string {
  if (!pathname.startsWith('/')) return `/${pathname}`;
  return pathname;
}

export function isWorkspaceVNextRoute(pathname: string): boolean {
  const path = normalizePath(pathname);
  return (
    STATIC_VNEXT_ROUTES.has(path) ||
    DRAFT_ROUTE.test(path) ||
    RUN_ROUTE.test(path) ||
    STUDIO_EDITOR_ROUTE.test(path)
  );
}

function WorkspaceApiBoundary({ children }: { children: ReactNode }) {
  const client = useApi();
  useLayoutEffect(
    () => installWorkspaceTransportBridge(client),
    [client],
  );
  return children;
}

function WorkspaceLoading() {
  return (
    <div className="ws-vnext" role="status" aria-busy="true">
      <div className="ws-vnext-empty">
        <div className="ws-vnext-skeleton-row" style={{ width: '45%' }} />
        <div className="ws-vnext-skeleton-row" style={{ width: '75%' }} />
        <div className="ws-vnext-skeleton-row" style={{ width: '62%' }} />
      </div>
    </div>
  );
}

function SharesIndex() {
  return (
    <div className="ws-vnext-library">
      <header className="ws-vnext-library__header">
        <div className="ws-vnext-library__title-block">
          <h1>Client shares</h1>
          <p>
            Share management is available from a document after delivery
            preflight.
          </p>
        </div>
      </header>
      <div className="ws-vnext-attention-card">
        <div className="ws-vnext-attention-card__label">
          Open a document to manage its client links
        </div>
        <div className="ws-vnext-attention-card__desc">
          Workspace does not yet expose a tenant-wide share-link listing route.
          Existing links remain revocable from the document that created them.
        </div>
      </div>
    </div>
  );
}

function CreationRoute() {
  const [capability, setCapability] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    getTwoStepDraftCapability()
      .then((cap) => {
        if (!cancelled) setCapability(cap.enabled);
      })
      .catch(() => {
        if (!cancelled) setCapability(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (capability === null) {
    return <WorkspaceLoading />;
  }
  if (capability) {
    return <WorkspaceQuickDraftIntake />;
  }
  return <WorkspaceCreationStabilized />;
}

function RoutedWorkspaceContent({ pathname }: { pathname: string }) {
  const path = normalizePath(pathname);

  if (path === '/workspace' || path === '/workspace/') {
    return <WorkspaceLibraryVNext />;
  }
  if (path === '/workspace/new' || path === '/workspace/new/') {
    return <CreationRoute />;
  }
  if (path === '/workspace/shares' || path === '/workspace/shares/') {
    return <SharesIndex />;
  }
  if (path === '/workspace/studio' || path === '/workspace/studio/') {
    return <WorkspaceStudioVNext />;
  }

  const studioMatch = STUDIO_EDITOR_ROUTE.exec(path);
  if (studioMatch?.[1] && studioMatch[2]) {
    return (
      <WorkspaceStudioVNext
        blueprintId={studioMatch[1]}
        versionId={studioMatch[2]}
      />
    );
  }

  const runMatch = RUN_ROUTE.exec(path);
  if (runMatch?.[1]) {
    return <WorkspaceEditorVNext draftId={runMatch[1]} isRunView />;
  }

  const draftMatch = DRAFT_ROUTE.exec(path);
  if (draftMatch?.[1]) {
    return <WorkspaceEditorVNext draftId={draftMatch[1]} />;
  }

  return null;
}

export function WorkspaceVNextRoutes({ pathname }: { pathname?: string } = {}) {
  const location = useLocation();
  return (
    <WorkspaceApiBoundary>
      <Suspense fallback={<WorkspaceLoading />}>
        <RoutedWorkspaceContent pathname={pathname ?? location.pathname} />
      </Suspense>
    </WorkspaceApiBoundary>
  );
}
