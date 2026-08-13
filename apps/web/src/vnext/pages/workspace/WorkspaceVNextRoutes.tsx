/**
 * Workspace vNext route interception.
 *
 * Intercepts /workspace, /workspace/new, /workspace/:draftId, /workspace/:draftId/run,
 * /workspace/studio, /workspace/studio/:blueprintId/:versionId and /share/:token.
 *
 * Falls through to the canonical Outlet for any workspace route that doesn't
 * have a vNext presentation yet, preserving existing app.capiro.ai behaviour.
 */

import { lazy, Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';

const WorkspaceLibraryVNext = lazy(async () => ({
  default: (await import('./library/WorkspaceLibraryVNext.js')).WorkspaceLibraryVNext,
}));

const WorkspaceCreationVNext = lazy(async () => ({
  default: (await import('./creation/WorkspaceCreationVNext.js')).WorkspaceCreationVNext,
}));

const WorkspaceEditorVNext = lazy(async () => ({
  default: (await import('./editor/WorkspaceEditorVNext.js')).WorkspaceEditorVNext,
}));

const WorkspaceStudioVNext = lazy(async () => ({
  default: (await import('./studio/WorkspaceStudioVNext.js')).WorkspaceStudioVNext,
}));

const WorkspaceShareView = lazy(async () => ({
  default: (await import('./share/WorkspaceShareView.js')).WorkspaceShareView,
}));

function isWorkspaceVNextPath(pathname: string): boolean {
  if (pathname === '/workspace') return true;
  if (pathname === '/workspace/new') return true;
  if (pathname.startsWith('/workspace/studio')) return true;
  // /workspace/:draftId and /workspace/:draftId/run — but NOT /workspace/studio
  if (pathname.startsWith('/workspace/')) {
    const rest = pathname.slice('/workspace/'.length);
    // Exclude 'studio' (handled above) and any sub-paths
    if (rest === 'studio' || rest.startsWith('studio/')) return true; // already handled
    // It's a draftId — could be /workspace/:draftId or /workspace/:draftId/run
    return true;
  }
  // Public share — unauthenticated, no shell
  if (pathname.startsWith('/share/')) return true;
  return false;
}

export function isWorkspaceVNextRoute(pathname: string): boolean {
  return isWorkspaceVNextPath(pathname);
}

export function WorkspaceVNextRoutes() {
  const location = useLocation();
  const { pathname } = location;

  // Public share route — separate bundle, no shell
  if (pathname.startsWith('/share/')) {
    const token = pathname.slice('/share/'.length);
    return (
      <Suspense fallback={<div style={{ minHeight: '100vh', background: '#f9fafb' }} />}>
        <WorkspaceShareView token={token} />
      </Suspense>
    );
  }

  if (pathname === '/workspace') {
    return (
      <Suspense fallback={<div className="capiro-vnext-route-loading">Loading…</div>}>
        <WorkspaceLibraryVNext />
      </Suspense>
    );
  }

  if (pathname === '/workspace/new') {
    return (
      <Suspense fallback={<div className="capiro-vnext-route-loading">Loading…</div>}>
        <WorkspaceCreationVNext />
      </Suspense>
    );
  }

  if (pathname.startsWith('/workspace/studio')) {
    return (
      <Suspense fallback={<div className="capiro-vnext-route-loading">Loading…</div>}>
        <WorkspaceStudioVNext />
      </Suspense>
    );
  }

  // /workspace/:draftId or /workspace/:draftId/run
  if (pathname.startsWith('/workspace/') && pathname !== '/workspace') {
    const rest = pathname.slice('/workspace/'.length);
    const draftId = rest.split('/')[0] || '';
    const isRun = rest.includes('/run');

    return (
      <Suspense fallback={<div className="capiro-vnext-route-loading">Loading…</div>}>
        <WorkspaceEditorVNext draftId={draftId} isRunView={isRun} />
      </Suspense>
    );
  }

  return <Outlet />;
}
