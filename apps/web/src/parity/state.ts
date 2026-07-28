/*
 * Phase 7 parity harness — which state the page is in, resolved once from the
 * query string so the transport stub and the mounted tree agree.
 *
 *   ?state=<name>   the capture state (see PARITY_STATES)
 *   ?hang=<substr>  make matching requests never settle (pending treatments)
 *   ?x,?y,?w,?h     the content-region box (defaults to the prototype's)
 */
import type { StrategyChatMessage, StrategyDetail, WatchReviewState } from '../pages/strategy/types.js';
import * as fx from './fixtures.js';

export type ParityStateName =
  | 'list'
  | 'editor-closed'
  | 'editor-panel'
  | 'editor-panel-long'
  | 'editor-step'
  | 'watch'
  | 'watch-why'
  | 'watch-rechecking'
  | 'low-context'
  | 'truncation'
  | 'today-before'
  | 'today-after';

export const PARITY_STATES: ParityStateName[] = [
  'list',
  'editor-closed',
  'editor-panel',
  'editor-panel-long',
  'editor-step',
  'watch',
  'watch-why',
  'watch-rechecking',
  'low-context',
  'truncation',
  'today-before',
  'today-after',
];

export interface ParityState {
  name: ParityStateName;
  detail: StrategyDetail;
  watch: WatchReviewState;
  threads: Record<string, StrategyChatMessage[]>;
  /** features.strategyPlannerMeri / agenticMeri / strategyWatcher */
  meri: boolean;
  agentic: boolean;
  watcher: boolean;
  /** Panel/selection the harness should drive after mount. */
  openPanel: boolean;
  selectNodeId: string | null;
  box: { x: number; y: number; w: number; h: number };
}

/**
 * The prototype's Strategy content region at 1440x900: a 232px sider and a 54px
 * topbar, leaving 1208x846. The harness renders the strategy surface into
 * exactly that box so the compared region aligns without reproducing the app
 * shell, whose parity is not part of this rollout.
 */
const DEFAULT_BOX = { x: 232, y: 54, w: 1208, h: 846 };

let cached: ParityState | null = null;

export function parityState(): ParityState {
  if (cached) return cached;
  const q = new URLSearchParams(location.search);
  const name = (q.get('state') ?? 'editor-closed') as ParityStateName;
  const num = (k: string, d: number) => {
    const v = q.get(k);
    return v == null ? d : Number(v);
  };
  const box = {
    x: num('x', DEFAULT_BOX.x),
    y: num('y', DEFAULT_BOX.y),
    w: num('w', DEFAULT_BOX.w),
    h: num('h', DEFAULT_BOX.h),
  };

  const base: ParityState = {
    name,
    detail: fx.detail(),
    watch: fx.watchState(),
    threads: { strategy: fx.STRATEGY_THREAD, n3: fx.STEP_THREAD },
    meri: true,
    agentic: true,
    watcher: true,
    openPanel: false,
    selectNodeId: null,
    box,
  };

  switch (name) {
    case 'list':
      break;
    case 'editor-closed':
      break;
    case 'editor-panel':
      base.openPanel = true;
      break;
    case 'editor-panel-long':
      base.openPanel = true;
      base.threads = { ...base.threads, strategy: fx.LONG_THREAD };
      break;
    case 'editor-step':
      base.openPanel = true;
      base.selectNodeId = 'n3';
      break;
    case 'watch':
    case 'watch-why':
    case 'watch-rechecking':
      base.openPanel = true;
      break;
    case 'low-context':
      base.openPanel = true;
      base.detail = fx.detail({ nodes: fx.NODES_LOW_CONTEXT });
      base.threads = { ...base.threads, strategy: fx.LOW_CONTEXT_THREAD };
      break;
    case 'truncation':
      base.detail = fx.detail({ title: fx.LONG_TITLE, goal: fx.LONG_GOAL });
      break;
    case 'today-before':
      // The whole plan is in the future: the today-line clamps to the left edge.
      base.detail = fx.detail({ nodes: fx.NODES_FUTURE });
      break;
    case 'today-after':
      base.detail = fx.detail({ nodes: fx.NODES_PAST });
      break;
    default:
      break;
  }

  cached = base;
  return base;
}
