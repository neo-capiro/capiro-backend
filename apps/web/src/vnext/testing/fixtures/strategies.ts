/**
 * Strategies module — visual harness fixtures.
 *
 * Shapes mirror the real DTOs (`pages/strategy/types.ts`) and the
 * `strategies-api.ts` query hooks exactly, so `StrategyLibraryVNext` renders
 * as it would against a live tenant. One strategy carries a pending watcher
 * count so the "Needs review" stat's attention-ring modifier
 * (STRATEGIES-UI-PARITY.md #2) is actually exercised, not just present.
 */
import type { FirmPhase, StrategyListItem } from '../../../pages/strategy/types.js';
import type { ClientLite, TenantMember } from '../../pages/strategies/strategies-api.js';

export const STRATEGIES_VISUAL_CLIENTS: ClientLite[] = [
  { id: 'client-1', name: 'Meridian Health Systems' },
  { id: 'client-2', name: 'Alpine Defense Partners' },
];

export const STRATEGIES_VISUAL_MEMBERS: TenantMember[] = [
  { id: 'member-1', clerkUserId: 'user_1', email: 'schen@capiro.ai', name: 'Sarah Chen' },
  { id: 'member-2', clerkUserId: 'user_2', email: 'mwebb@capiro.ai', name: 'Marcus Webb' },
];

export const STRATEGIES_VISUAL_FIRM_PHASES: FirmPhase[] = [
  { id: 'phase-1', label: 'Firm growth phase', startFy: 2027, startQ: 1, endFy: 2029, endQ: 4, position: 0 },
];

export const STRATEGIES_VISUAL_LIST: StrategyListItem[] = [
  {
    id: 'strategy-1',
    clientId: 'client-1',
    title: 'FY27 Appropriations Ask — Rural Health Expansion',
    type: 'appropriations',
    ownerUserId: 'user_1',
    createdByUserId: 'user_1',
    lastEditedByUserId: 'user_1',
    lastEditedAt: '2026-08-15T18:30:00.000Z',
    createdAt: '2026-05-01T12:00:00.000Z',
    nodeCount: 14,
  },
  {
    id: 'strategy-2',
    clientId: 'client-2',
    title: 'NDAA Procurement Pathway',
    type: 'procurement',
    ownerUserId: 'user_2',
    createdByUserId: 'user_2',
    lastEditedByUserId: 'user_2',
    lastEditedAt: '2026-08-10T09:15:00.000Z',
    createdAt: '2026-04-12T12:00:00.000Z',
    nodeCount: 9,
  },
  {
    id: 'strategy-3',
    clientId: 'client-1',
    title: 'Regulatory Comment Coalition — CMS Rule',
    type: 'regulatory',
    ownerUserId: 'user_1',
    createdByUserId: 'user_1',
    lastEditedByUserId: null,
    lastEditedAt: null,
    createdAt: '2026-02-20T12:00:00.000Z',
    nodeCount: 6,
  },
];

/** One pending watcher proposal on strategy-1 — needsReview resolves to 1, > 0. */
export const STRATEGIES_VISUAL_PENDING_WATCH_COUNTS: Record<string, number> = {
  'strategy-1': 1,
};

/** Same data, nothing pending — the "Needs review" card's plain (non-attention) state. */
export const STRATEGIES_VISUAL_NO_PENDING_WATCH_COUNTS: Record<string, number> = {};
