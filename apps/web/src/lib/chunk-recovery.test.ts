/**
 * PR D / LW-QA-010 — chunk-recovery state machine unit tests.
 * Covers §6 A (one reload), B (no loop), C (new build permits again),
 * D (non-chunk errors never reload), plus detection narrowness.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chunkFailureAction,
  clearReloadMarker,
  currentBuildId,
  hasAttemptedReload,
  isChunkLoadError,
  markReloadAttempted,
} from './chunk-recovery.js';

const BUILD_X = 'sha-x';
const BUILD_Y = 'sha-y';

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('chunkFailureAction state machine (§4)', () => {
  it('A: first chunk failure on a build → reload exactly once', () => {
    const action = chunkFailureAction(
      new Error('Failed to fetch dynamically imported module: /assets/settings-abc123.js'),
      BUILD_X,
      [],
    );
    expect(action).toBe('reload');
  });

  it('B: same build failing after the marker → recover, never a second reload', () => {
    const attempted = [BUILD_X];
    const action = chunkFailureAction(
      new Error('Failed to fetch dynamically imported module'),
      BUILD_X,
      attempted,
    );
    expect(action).toBe('recover');
  });

  it('C: a new build ID re-arms the single retry', () => {
    const attempted = [BUILD_X];
    expect(chunkFailureAction(new Error('Failed to fetch dynamically imported module'), BUILD_Y, attempted)).toBe('reload');
  });
});

describe('isChunkLoadError narrowness (§3.9)', () => {
  it('matches the real failure shapes', () => {
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module: /a.js'))).toBe(true);
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(Object.assign(new Error('boom'), { name: 'ChunkLoadError' }))).toBe(true);
    expect(isChunkLoadError(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('ordinary render/API errors are NOT chunk errors (no reload, no recovery hijack)', () => {
    expect(isChunkLoadError(new TypeError('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(new Error('Request failed with status code 500'))).toBe(false);
    expect(isChunkLoadError(new RangeError('Maximum call stack size exceeded'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe('attempted-marker persistence (§4)', () => {
  it('marks a build and reports it attempted; per-build isolation', () => {
    expect(hasAttemptedReload(BUILD_X)).toBe(false);
    markReloadAttempted(BUILD_X);
    expect(hasAttemptedReload(BUILD_X)).toBe(true);
    expect(hasAttemptedReload(BUILD_Y)).toBe(false); // new deployment → retry permitted
  });

  it('clearing the marker re-arms manual Retry', () => {
    markReloadAttempted(BUILD_X);
    clearReloadMarker(BUILD_X);
    expect(hasAttemptedReload(BUILD_X)).toBe(false);
  });

  it('never marks an unknown build (empty id is a no-op)', () => {
    markReloadAttempted('');
    expect(window.sessionStorage.getItem('capiro:chunk-reload-attempted')).toBeNull();
  });

  it('keeps the marker list bounded across deployments', () => {
    for (let i = 0; i < 9; i += 1) markReloadAttempted(`sha-${i}`);
    const raw = JSON.parse(window.sessionStorage.getItem('capiro:chunk-reload-attempted') ?? '[]') as string[];
    expect(raw.length).toBeLessThanOrEqual(5);
  });
});

describe('currentBuildId (§4)', () => {
  it('reads the real immutable release SHA from runtime config', () => {
    expect(currentBuildId()).toBe('');
    window.__CAPIRO_CONFIG__ = { clerkPublishableKey: 'k', apiBaseUrl: 'http://x', releaseSha: '  sha-abc  ' };
    expect(currentBuildId()).toBe('sha-abc');
    delete window.__CAPIRO_CONFIG__;
  });
});

describe('chunkFailureAction with non-chunk errors (§6.D)', () => {
  it('a render error routes to recover — the state machine never orders a reload for it', () => {
    expect(chunkFailureAction(new TypeError('undefined is not a function'), BUILD_X, [BUILD_X])).toBe('recover');
    expect(chunkFailureAction(new TypeError('undefined is not a function'), BUILD_X, [])).toBe('recover');
  });
});
