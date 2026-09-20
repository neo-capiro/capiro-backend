import { describe, expect, test } from '@jest/globals';
import {
  shouldRouteMeriV2FullChat,
  type MeriV2FullChatRoutingInput,
} from './meriv2-routing.helpers.js';

/**
 * Exhaustive routing truth table for `shouldRouteMeriV2FullChat` — the single
 * decision point that sends a full-chat turn from the raw MeriService loop to
 * the MeriV2 orchestrator (meri.service.ts streamMessage →
 * streamMessageViaMeriV2). It runs only after the MeriV3 canary gate in
 * meriv3-runtime.proxy.ts has declined the turn.
 *
 * Contract pinned here (EXISTING behavior — this spec changes nothing):
 *
 *   route to MeriV2  ⇔  bearer present ∧ orchestrator configured
 *                        ∧ meriv2.fullChat enabled ∧ NOT impersonated
 *
 * Every other combination stays on the contained in-process (legacy V1) path.
 *  - Bearer requirement: Wave 2 gate-flip 3e2a9b42f (2026-07-14). The
 *    orchestrator's delegated tool execution + action-proposal creation
 *    re-authenticate with the caller's bearer, so a missing bearer routes legacy.
 *  - Impersonation containment: 264b351af (2026-07-28). Impersonated turns
 *    cannot enter MeriV2 until one unified effective actor/tenant/impersonation
 *    context is carried end-to-end. This is deliberate, not an oversight.
 *
 * meriv2-routing.helpers.spec.ts carries the five canonical contract cases
 * (they are rows 1, 9, 5, 3 and 2 of CORE_TABLE below). This file enumerates the
 * whole input space — all 16 boolean cells plus every representation of
 * "absent" / "impersonated" the controller can hand the helper — so a refactor
 * cannot change the route of a cell the canonical cases do not name.
 *
 * If a cell here goes red, ROUTING CHANGED. Explain the change as a defect (or
 * an explicitly authorized contract change); do not edit the expectation to
 * match the helper.
 */

const BEARER = 'clerk-session-jwt';
const IMPERSONATED_TENANT_ID = '11111111-1111-4111-8111-111111111111';

type Route = 'meriv2-orchestrator' | 'contained-legacy';

function routeOf(input: MeriV2FullChatRoutingInput): Route {
  return shouldRouteMeriV2FullChat(input) ? 'meriv2-orchestrator' : 'contained-legacy';
}

interface Cell {
  bearer: boolean;
  configured: boolean;
  enabled: boolean;
  impersonated: boolean;
  expected: Route;
}

function row(
  bearer: boolean,
  configured: boolean,
  enabled: boolean,
  impersonated: boolean,
  expected: Route,
): Cell {
  return { bearer, configured, enabled, impersonated, expected };
}

function inputFor(cell: Cell): MeriV2FullChatRoutingInput {
  return {
    bearerToken: cell.bearer ? BEARER : undefined,
    configured: cell.configured,
    enabled: cell.enabled,
    impersonateTenantId: cell.impersonated ? IMPERSONATED_TENANT_ID : undefined,
  };
}

// Written out literally — NOT derived from the helper's formula — so the
// expectation is independent of the implementation. Exactly ONE row routes to
// MeriV2: the normal authenticated browser turn.
const CORE_TABLE: Cell[] = [
  //  bearer configured enabled impersonated
  row(true, true, true, false, 'meriv2-orchestrator'),
  row(true, true, true, true, 'contained-legacy'),
  row(true, true, false, false, 'contained-legacy'),
  row(true, true, false, true, 'contained-legacy'),
  row(true, false, true, false, 'contained-legacy'),
  row(true, false, true, true, 'contained-legacy'),
  row(true, false, false, false, 'contained-legacy'),
  row(true, false, false, true, 'contained-legacy'),
  row(false, true, true, false, 'contained-legacy'),
  row(false, true, true, true, 'contained-legacy'),
  row(false, true, false, false, 'contained-legacy'),
  row(false, true, false, true, 'contained-legacy'),
  row(false, false, true, false, 'contained-legacy'),
  row(false, false, true, true, 'contained-legacy'),
  row(false, false, false, false, 'contained-legacy'),
  row(false, false, false, true, 'contained-legacy'),
];

/** The one fully "ready" input: bearer + configured + enabled, not impersonated. */
const READY: MeriV2FullChatRoutingInput = {
  bearerToken: BEARER,
  configured: true,
  enabled: true,
};

describe('shouldRouteMeriV2FullChat — exhaustive 16-cell truth table', () => {
  test.each(CORE_TABLE)(
    'bearer=$bearer configured=$configured enabled=$enabled impersonated=$impersonated → $expected',
    (cell) => {
      expect(routeOf(inputFor(cell))).toBe(cell.expected);
    },
  );

  test('the table enumerates every boolean combination exactly once', () => {
    const keys = CORE_TABLE.map((cell) =>
      [cell.bearer, cell.configured, cell.enabled, cell.impersonated].join(','),
    );
    expect(CORE_TABLE).toHaveLength(16);
    expect(new Set(keys).size).toBe(16);
  });

  test('exactly one cell routes to MeriV2: bearer ∧ configured ∧ enabled ∧ ¬impersonated', () => {
    const expectedV2Cells = CORE_TABLE.filter((cell) => cell.expected === 'meriv2-orchestrator');
    expect(expectedV2Cells).toEqual([
      {
        bearer: true,
        configured: true,
        enabled: true,
        impersonated: false,
        expected: 'meriv2-orchestrator',
      },
    ]);
    // ...and the helper agrees with the table on which cell that is.
    const routedByHelper = CORE_TABLE.filter((cell) => shouldRouteMeriV2FullChat(inputFor(cell)));
    expect(routedByHelper).toEqual(expectedV2Cells);
  });
});

describe('absent-bearer representations stay contained even when everything else is ready', () => {
  // meri.controller.ts streamMessage normalizes a missing/blank Authorization
  // header to `undefined`; null and '' are pinned too so a future caller cannot
  // slip a falsy-but-not-undefined value past the gate.
  test.each([
    { label: 'undefined (header missing)', bearerToken: undefined },
    { label: 'null', bearerToken: null },
    { label: 'empty string', bearerToken: '' },
  ])('bearerToken = $label → contained-legacy', ({ bearerToken }) => {
    expect(routeOf({ ...READY, bearerToken })).toBe('contained-legacy');
  });
});

describe('impersonation representations (containment contract, 264b351af)', () => {
  // The controller forwards x-capiro-impersonate-tenant trimmed, or `undefined`
  // when the header is missing/blank. The helper trims again, so every blank
  // representation counts as "not impersonated".
  test.each([
    { label: 'undefined (header missing)', impersonateTenantId: undefined },
    { label: 'null', impersonateTenantId: null },
    { label: 'empty string', impersonateTenantId: '' },
    { label: 'whitespace only', impersonateTenantId: '   ' },
  ])(
    'impersonateTenantId = $label counts as NOT impersonated → ready turn routes to MeriV2',
    ({ impersonateTenantId }) => {
      expect(routeOf({ ...READY, impersonateTenantId })).toBe('meriv2-orchestrator');
    },
  );

  test.each([
    { label: 'tenant uuid', impersonateTenantId: IMPERSONATED_TENANT_ID },
    { label: 'padded tenant uuid', impersonateTenantId: `  ${IMPERSONATED_TENANT_ID}  ` },
    { label: 'non-uuid string', impersonateTenantId: 'acme-lobby' },
    { label: 'single character', impersonateTenantId: 'x' },
  ])(
    'impersonateTenantId = $label is contained even for a fully ready turn',
    ({ impersonateTenantId }) => {
      expect(routeOf({ ...READY, impersonateTenantId })).toBe('contained-legacy');
    },
  );

  test('containment does not depend on the other three keys (all 8 combinations)', () => {
    let checked = 0;
    for (const bearerToken of [BEARER, undefined]) {
      for (const configured of [true, false]) {
        for (const enabled of [true, false]) {
          expect(
            routeOf({
              bearerToken,
              configured,
              enabled,
              impersonateTenantId: IMPERSONATED_TENANT_ID,
            }),
          ).toBe('contained-legacy');
          checked += 1;
        }
      }
    }
    expect(checked).toBe(8);
  });
});

describe('documented edges of the helper itself', () => {
  test('the helper trims impersonateTenantId but NOT bearerToken: a whitespace-only bearer counts as present (meri.controller.ts normalizes it to undefined before the helper ever sees it)', () => {
    expect(routeOf({ ...READY, bearerToken: '   ' })).toBe('meriv2-orchestrator');
  });

  test('the helper returns a strict boolean, never a truthy/falsy passthrough', () => {
    expect(shouldRouteMeriV2FullChat(READY)).toBe(true);
    expect(shouldRouteMeriV2FullChat({ ...READY, bearerToken: undefined })).toBe(false);
    expect(shouldRouteMeriV2FullChat({ ...READY, bearerToken: null })).toBe(false);
  });
});
