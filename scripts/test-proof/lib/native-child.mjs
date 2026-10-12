/**
 * Native child-process completeness classification.
 *
 * A wrapper process exiting 0 does NOT prove the native run was green
 * (independent review round 3, item 17). `spawnSync` reports a killed child as
 * `status: null` + `signal`, and a spawn failure as `status: null` + `error`;
 * the old guard `if (res.status && res.status !== 0)` read both as success
 * whenever a partial report existed.
 *
 * `classifyChild` requires a DEFINITE integer status of 0 with no signal and no
 * spawn error, and returns a distinct non-zero failure code for every other
 * outcome so the caller fails closed and can retain raw diagnostics.
 */
export function classifyChild(res) {
  if (!res) return { nativeExit: null, signal: null, spawnError: 'no-result', failure: 'spawn-error', failCode: 3, definiteZero: false };
  if (res.error) {
    return { nativeExit: typeof res.status === 'number' ? res.status : null, signal: res.signal ?? null, spawnError: String(res.error.message || res.error), failure: 'spawn-error', failCode: 3, definiteZero: false };
  }
  if (res.signal) {
    return { nativeExit: typeof res.status === 'number' ? res.status : null, signal: res.signal, spawnError: null, failure: `signal:${res.signal}`, failCode: 5, definiteZero: false };
  }
  if (typeof res.status !== 'number') {
    return { nativeExit: null, signal: null, spawnError: null, failure: 'no-exit-status', failCode: 6, definiteZero: false };
  }
  if (res.status !== 0) {
    return { nativeExit: res.status, signal: null, spawnError: null, failure: `exit:${res.status}`, failCode: res.status, definiteZero: false };
  }
  return { nativeExit: 0, signal: null, spawnError: null, failure: null, failCode: 0, definiteZero: true };
}
