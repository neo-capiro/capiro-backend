/**
 * PR D / LW-QA-010 — application-level recovery for lazy-route chunk failures.
 *
 * Wraps the vNext route tree. On a chunk-class failure from a lazy() dynamic
 * import it decides via the state machine in chunk-recovery.ts:
 *   - first failure for this build → sessionStorage marker + one location.reload()
 *   - repeat failure on the same build → visible recovery surface
 *     (Retry / Go to Dashboard) with concise error copy incl. build ID + route.
 *
 * Ordinary React render errors rethrow into the app's normal error-boundary
 * path — they are never swallowed here and never trigger a reload.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import {
  chunkFailureAction,
  clearReloadMarker,
  currentBuildId,
  reloadOnce,
} from './chunk-recovery.js';

interface LazyRouteErrorBoundaryProps {
  children: ReactNode;
  /** Route path for telemetry/recovery copy. */
  routePath?: string;
}

interface LazyRouteErrorBoundaryState {
  error: unknown | null;
  /** Set after the automatic reload was suppressed (repeat failure). */
  recovery: boolean;
}

export class LazyRouteErrorBoundary extends Component<
  LazyRouteErrorBoundaryProps,
  LazyRouteErrorBoundaryState
> {
  state: LazyRouteErrorBoundaryState = { error: null, recovery: false };

  static getDerivedStateFromError(error: unknown): Partial<LazyRouteErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const buildId = currentBuildId();
    const action = chunkFailureAction(error, buildId, readAttempted());
    // eslint-disable-next-line no-console
    console.warn('[chunk-recovery]', {
      buildId: buildId || 'unknown',
      route: this.props.routePath ?? window.location.pathname,
      component: info.componentStack?.split('\n')[1]?.trim() ?? 'unknown',
      action,
    });
    if (action === 'reload') {
      // Marks the build, then reloads exactly once per build ID.
      reloadOnce(buildId);
      return;
    }
    this.setState({ recovery: true });
  }

  private handleRetry = (): void => {
    const buildId = currentBuildId();
    clearReloadMarker(buildId);
    this.setState({ error: null, recovery: false });
  };

  private handleHome = (): void => {
    window.location.assign('/');
  };

  render(): ReactNode {
    if (this.state.recovery) {
      const buildId = currentBuildId() || 'unknown';
      return (
        <div role="alert" className="chunk-recovery" style={{ padding: 32, maxWidth: 560, margin: '80px auto', textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, marginBottom: 8 }}>This page could not finish loading</h1>
          <p style={{ fontSize: 14, color: '#555' }}>
            A new deployment may have replaced part of the application while this page was open.
            The route ({this.props.routePath ?? window.location.pathname}) failed to load on build
            {' '}<code>{buildId}</code>.
          </p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 20 }}>
            <button
              type="button"
              onClick={this.handleRetry}
              style={{ padding: '8px 18px', cursor: 'pointer' }}
            >
              Retry
            </button>
            <button
              type="button"
              onClick={this.handleHome}
              style={{ padding: '8px 18px', cursor: 'pointer' }}
            >
              Go to Dashboard
            </button>
          </div>
        </div>
      );
    }
    if (this.state.error) {
      // Q08 (evidence #129-133): an error has been caught but we have not
      // (yet) settled into the `recovery` UI above — either we are in the
      // single-instant window between getDerivedStateFromError setting
      // `error` and componentDidCatch deciding reload vs recover, or we
      // ordered a `reload` and are waiting for window.location.reload() to
      // actually unload the page (NOT synchronous — the JS thread keeps
      // running and React keeps rendering in the meantime). Previously this
      // branch didn't exist, so render() fell through to `this.props.children`
      // — the SAME still-broken lazy-loaded component. React.lazy() memoizes
      // a rejected import promise permanently, so re-rendering the identical
      // children threw again immediately, and that second synchronous throw
      // produced a blank page instead of either the automatic reload or the
      // recovery screen (confirmed via a repro test: rendering the boundary
      // around a component that throws a chunk-load error, with reload()
      // stubbed to not actually navigate, surfaces the SECOND throw escaping
      // the boundary entirely). Once any error has been caught, NEVER
      // re-attempt the broken children — show a neutral loading placeholder
      // (harmless: about to be replaced either by the real navigation, or by
      // the recovery UI once componentDidCatch's setState({recovery:true})
      // lands) until the state machine finishes deciding.
      return <div className="capiro-vnext-route-loading">Loading…</div>;
    }
    return this.props.children;
  }
}

function readAttempted(): string[] {
  try {
    const raw = window.sessionStorage.getItem('capiro:chunk-reload-attempted');
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
