/** Backward-compatible router state helpers backed by the V1 contract map. */
import {
  PARSER_STATE_TRANSITIONS,
  assertValidTransition,
  type ParserDocumentStateV1,
} from './parser-runtime-contract-v1.js';

/** @deprecated Import PARSER_STATE_TRANSITIONS from parser-runtime-contract-v1. */
export const ROUTER_STATE_TRANSITIONS = PARSER_STATE_TRANSITIONS;

/** @deprecated Import assertValidTransition from parser-runtime-contract-v1. */
export function assertRouterStateTransition(
  from: ParserDocumentStateV1,
  to: ParserDocumentStateV1,
): void {
  assertValidTransition(from, to);
}
