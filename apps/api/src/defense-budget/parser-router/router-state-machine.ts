/**
 * Operational parser-router state machine.
 *
 * The original contract map omitted local escalation after VERIFYING. This
 * map is the executable state machine used by ParserRouterV1Service and keeps
 * local and paid escalation explicit without relabeling local work as paid.
 */
import type { ParserDocumentStateV1 } from './parser-runtime-contract-v1.js';

export const ROUTER_STATE_TRANSITIONS: Record<
  ParserDocumentStateV1,
  readonly ParserDocumentStateV1[]
> = {
  PLANNED: ['RUNNING_LOCAL', 'FAILED'],
  RUNNING_LOCAL: ['LOCAL_COMPLETE', 'FAILED'],
  LOCAL_COMPLETE: ['VERIFYING', 'FAILED'],
  VERIFYING: [
    'ESCALATION_PLANNED',
    'TERMINAL_PASSED',
    'TERMINAL_REVIEW',
    'TERMINAL_REJECTED',
    'FAILED',
  ],
  ESCALATION_PLANNED: [
    'RUNNING_LOCAL',
    'RUNNING_PAID',
    'TERMINAL_REVIEW',
    'TERMINAL_REJECTED',
    'FAILED',
  ],
  RUNNING_PAID: ['PAID_COMPLETE', 'FAILED'],
  PAID_COMPLETE: ['VERIFYING', 'FAILED'],
  TERMINAL_PASSED: [],
  TERMINAL_REVIEW: [],
  TERMINAL_REJECTED: [],
  FAILED: [],
};

export function assertRouterStateTransition(
  from: ParserDocumentStateV1,
  to: ParserDocumentStateV1,
): void {
  if (!ROUTER_STATE_TRANSITIONS[from].includes(to)) {
    throw new Error(`invalid parser router state transition: ${from} -> ${to}`);
  }
}
