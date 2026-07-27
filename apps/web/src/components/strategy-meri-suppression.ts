/*
 * Where the GLOBAL Meri control (MeriOverlay / ChatDrawer) is hidden.
 *
 * Phase 1 §3 Step 6: the Strategy Planner list and editor get their own
 * in-editor Meri panel, so the floating global control is suppressed on exactly
 * those two surfaces — and nowhere else. It deliberately does NOT use a broad
 * `startsWith('/strategies')`, which would also blank the control on the
 * Context library, the Steward, the agent review queue and the Execution review,
 * all of which are still reachable by deep link and have no in-page assistant.
 *
 * The router registers `/strategies/:id` as a FREE segment (StrategyRoutes), so
 * the editor test cannot assume a UUID; anything that is not one of the static
 * child prefixes is a strategy id.
 */

/** First segments under /strategies that belong to a static child route. */
const RESERVED_SEGMENTS = new Set(['context', 'agents']);

const LIST_PATH = '/strategies';

/** True on the strategy list and the strategy editor only. */
export function isStrategyMeriSuppressed(pathname: string): boolean {
  // React Router matches case-insensitively by default, and trailing slashes are
  // equivalent — normalise both so the predicate agrees with what actually renders.
  const path = (pathname || '').toLowerCase().replace(/\/+$/, '');

  if (path === LIST_PATH) return true;
  if (!path.startsWith(`${LIST_PATH}/`)) return false;

  const rest = path.slice(LIST_PATH.length + 1);
  if (rest === '') return true;

  const segments = rest.split('/');
  // Deeper than one segment ⇒ a static child surface (context/:id,
  // agents/review, …), never the editor.
  if (segments.length !== 1) return false;

  return !RESERVED_SEGMENTS.has(segments[0]!);
}
