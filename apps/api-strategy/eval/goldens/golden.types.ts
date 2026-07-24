/**
 * Golden-plan schema (Stage B — Step B1). One JSON file per fixture under
 * `eval/goldens/<strategyType>/<slug>.json`. Pure type declarations — no
 * runtime validation library (Stage A/B take on zero new external packages).
 *
 * `plan.nodes` is the fixture's OWN concrete, hand-approved plan — it must
 * pass `verifyPlan` (from `@capiro/strategy-verifier`) with zero errors when
 * checked against `clientContextFixture.fiscal`/`congress`/`ppbeCurrentPhases`.
 * That self-test is what Step B2's L1 harness runs; `expectedPlanShape` is the
 * separate, coarser shape a *generated* draft is graded against (a live/stubbed
 * draft need not reproduce this plan verbatim, only satisfy its shape).
 */

import type { VerifierNode, VerifierRefRow, VerifierFiscal } from '@capiro/strategy-verifier';

export type GoldenStrategyType =
  | 'appropriations'
  | 'authorization'
  | 'regulatory'
  | 'coalition'
  | 'procurement'
  | 'earmark';

/** Stands in for the Client Context Pack a real draft call would receive:
 *  enough fiscal/reference grounding for `verifyPlan`'s self-test (B2) and a
 *  short profile blurb for the L2 judge's groundedness scoring (B3). */
export interface GoldenClientContextFixture {
  clientName: string;
  /** Short blurb grounding the goal — stands in for the pack's client-profile
   *  section; the L2 judge checks generated nodes' `sources` against this. */
  profileSummary: string;
  fiscal: VerifierFiscal;
  /** Congress reference rows relevant to this fixture. [] data-gap-skips the
   *  submission-before-markup / recess checks (matches verifyPlan's own
   *  data-gap guards) — most non-appropriations goldens leave this empty. */
  congress?: VerifierRefRow[];
  ppbeCurrentPhases?: VerifierRefRow[];
}

/** A single ordering expectation beyond the generic shape/verifier checks —
 *  asserts `nodes[beforeNodeId].startsOn <= nodes[afterNodeId].startsOn` (by
 *  node id, resolved against whichever plan is being graded). */
export interface GoldenOrderingAssertion {
  description: string;
  beforeNodeId: string;
  afterNodeId: string;
}

export interface GoldenExpectedPlanShape {
  /** [min, max] inclusive node count a generated plan should land in. The
   *  fixture's own `plan.nodes.length` always sits inside this range. */
  nodeCountRange: [number, number];
  /** Every one of these `kind` values must appear at least once. */
  requiredKinds: string[];
  /** Every one of these `subject` values must appear at least once. */
  requiredSubjects: string[];
  orderingAssertions: GoldenOrderingAssertion[];
}

export interface Golden {
  /** The user goal a draft-from-goal call would receive. */
  goal: string;
  clientContextFixture: GoldenClientContextFixture;
  /** The fixture's own expert-approved, self-testing plan. */
  plan: { nodes: VerifierNode[] };
  expectedPlanShape: GoldenExpectedPlanShape;
  /** Free-text authoring note: why this fixture exists, what it exercises. */
  notes: string;
}
