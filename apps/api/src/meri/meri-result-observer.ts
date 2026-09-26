/**
 * Deliver optional telemetry without delaying or changing a successful read.
 * The caller awaits the legacy read before invoking this helper; both a
 * synchronous throw and a later Promise rejection stay inside observation.
 */
export function notifyMeriResultObserver(deliver: () => unknown): void {
  try {
    void Promise.resolve(deliver()).catch(() => undefined);
  } catch {
    // Observation must not change the legacy result.
  }
}
