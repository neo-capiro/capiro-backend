/**
 * Q08 (evidence #129-133, directory-console-errors.json, 04-directory-blank.jpg):
 * a confirmed session failure opening a staff directory profile
 * (/directory/staff/staff-396593) after a dynamic import of
 * StaffProfileVNext-<hash>.js failed — the app area went blank; reloading the
 * same route recovered it.
 *
 * Root cause found here, independent of whether the specific asset hash was a
 * stale post-deploy chunk (a plausible but unverified hypothesis) or some
 * other transient fetch failure: `LazyRouteErrorBoundary.render()` had no
 * branch for "an error was just caught but we haven't settled into the
 * `recovery` state yet". On a first-time chunk failure the state machine
 * orders a `reload` (`chunkFailureAction` → 'reload') and calls
 * `window.location.reload()` — but that call does NOT synchronously unload
 * the page; the JS thread and React keep running until the browser actually
 * navigates. With no `error` branch, render() fell through to
 * `this.props.children`, which is the SAME still-broken lazy component
 * (`React.lazy()` memoizes a rejected dynamic-import promise permanently), so
 * it threw again immediately — and that second throw is what produced the
 * blank page, not a broken reload path or a permanently-broken route.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LazyRouteErrorBoundary } from './LazyRouteErrorBoundary.js';

function ThrowChunkLoadError(): never {
  throw new Error('Failed to fetch dynamically imported module: /assets/StaffProfileVNext-Cr8Di0oN.js');
}

function ThrowRenderError(): never {
  throw new TypeError('Cannot read properties of undefined (reading "foo")');
}

describe('LazyRouteErrorBoundary — chunk-load failure never re-renders the broken children', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('first chunk failure on a build: reloads exactly once, and never re-throws through the broken children while waiting for navigation', () => {
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadSpy },
      writable: true,
    });
    // console.error is expected here — React logs the caught throw. The
    // assertion that matters is that nothing escapes the boundary itself
    // (render() below would throw synchronously and fail the test).
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(
      <LazyRouteErrorBoundary routePath="/directory/staff/staff-396593">
        <ThrowChunkLoadError />
      </LazyRouteErrorBoundary>,
    );

    // Q08: the fix. Previously this rendered nothing usable (the second,
    // uncaught throw produced a blank app area) — now it's a neutral loading
    // placeholder while window.location.reload() takes effect, never the
    // crashed children again.
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('repeat chunk failure on the same build: shows the recovery surface with Retry/Go to Dashboard, not a second reload', () => {
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadSpy },
      writable: true,
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Simulate: this build already had its one automatic reload.
    window.sessionStorage.setItem('capiro:chunk-reload-attempted', JSON.stringify(['']));

    render(
      <LazyRouteErrorBoundary routePath="/directory/staff/staff-396593">
        <ThrowChunkLoadError />
      </LazyRouteErrorBoundary>,
    );

    expect(screen.getByText('This page could not finish loading')).toBeInTheDocument();
    expect(screen.getByText(/directory\/staff\/staff-396593/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to Dashboard' })).toBeInTheDocument();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('an ordinary render error (not a chunk-load failure) goes straight to the recovery surface, no reload attempted', () => {
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadSpy },
      writable: true,
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(
      <LazyRouteErrorBoundary routePath="/directory/staff/staff-396593">
        <ThrowRenderError />
      </LazyRouteErrorBoundary>,
    );

    expect(screen.getByText('This page could not finish loading')).toBeInTheDocument();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('healthy children render untouched, no interference from the error state machine', () => {
    render(
      <LazyRouteErrorBoundary routePath="/directory/staff/staff-396593">
        <div>staff profile content</div>
      </LazyRouteErrorBoundary>,
    );

    expect(screen.getByText('staff profile content')).toBeInTheDocument();
  });
});
