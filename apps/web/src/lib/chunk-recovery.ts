/**
 * PR D / LW-QA-010 — chunk-load recovery state machine.
 *
 * Hard navigation to a lazy route after a deployment can fail with
 * "Failed to fetch dynamically imported module" (the old index is still
 * served, the old chunk is gone). Recovery:
 *
 *   failure on build X → no marker for X → mark X attempted → reload once
 *   failure again on X → visible recovery UI (Retry / Home) — NO second reload
 *   new deployment Y   → marker is per-build, so retry permits again
 *
 * Ordinary React render errors must NOT route through here (they use the
 * normal error boundary) — `isChunkLoadError` is deliberately narrow.
 *
 * Build identity comes from the real immutable release SHA
 * (`window.__CAPIRO_CONFIG__.releaseSha`, injected by the container
 * entrypoint). No timestamps are invented; a dev/undefined SHA is stable for
 * the session, which is exactly the right granularity for "same build".
 */

const STORAGE_KEY = 'capiro:chunk-reload-attempted';

/** The build identity for retry fencing. Empty string = unknown build. */
export function currentBuildId(): string {
  try {
    return window.__CAPIRO_CONFIG__?.releaseSha?.trim() || '';
  } catch {
    return '';
  }
}

/**
 * Narrow chunk-load detection. Matches:
 *  - native dynamic-import failures ("Failed to fetch dynamically imported module")
 *  - webpack-style ChunkLoadError names/messages, for any future bundler switch
 *  - TypeError "Failed to fetch" / "error loading dynamically imported module"
 * Everything else (render errors, API errors, undefined derefs) is NOT a
 * chunk error and must use the normal error boundary.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  const m = message.toLowerCase();
  if (name === 'ChunkLoadError') return true;
  if (m.includes('dynamically imported module')) return true;
  if (m.includes('error loading dynamically imported')) return true;
  if (m.includes('chunkloaderror')) return true;
  // Bare fetch failures during import resolution (module 404s from a stale
  // index). "Failed to fetch" alone is broad, but it is only consulted inside
  // a lazy() loader where ordinary API calls never surface.
  if (m === 'failed to fetch' || m.includes('load failed')) return true;
  return false;
}

function readAttempted(): string[] {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeAttempted(ids: string[]): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // sessionStorage unavailable (privacy mode) — fail open to "not attempted"
    // which permits one reload; the reload itself is harmless.
  }
}

/** True when this build has already had its one automatic reload. */
export function hasAttemptedReload(buildId: string): boolean {
  return readAttempted().includes(buildId);
}

/**
 * Mark a build as reload-attempted. Idempotent per build; keeps the list
 * bounded (last 5) so sessionStorage cannot grow unboundedly across many
 * deployments in one tab session.
 */
export function markReloadAttempted(buildId: string): void {
  if (!buildId) return;
  const next = [...readAttempted().filter((id) => id !== buildId), buildId].slice(-5);
  writeAttempted(next);
}

/** Clear the marker (used by the recovery surface's manual Retry). */
export function clearReloadMarker(buildId: string): void {
  writeAttempted(readAttempted().filter((id) => id !== buildId));
}

/**
 * Decide the action for a chunk failure. Pure decision function (unit-tested):
 *   'reload'  — first failure for this build: mark + reload exactly once
 *   'recover' — same build already attempted: render the recovery surface
 */
export function chunkFailureAction(
  error: unknown,
  buildId: string,
  attempted: readonly string[],
): 'reload' | 'recover' {
  if (!isChunkLoadError(error)) return 'recover';
  return attempted.includes(buildId) ? 'recover' : 'reload';
}

/** Perform the automatic single reload (isolated for tests). */
export function reloadOnce(buildId: string): void {
  markReloadAttempted(buildId);
  window.location.reload();
}
