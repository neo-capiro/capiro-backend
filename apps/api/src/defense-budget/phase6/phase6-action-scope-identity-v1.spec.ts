import {
  deriveActionScopeIdentityV1,
  phase6ActionScopeIdentityHashV1,
  phase6ActionScopeIdentityKeyV1,
  phase6ActionScopeIdentityV1Schema,
  type ActionScopeSourceV1,
} from './phase6-action-scope-identity-v1.js';
import type { BudgetLineIdentityV1 } from '../contracts/extraction-artifact-v1.js';

const PE_A: BudgetLineIdentityV1 = { lineKind: 'RDTE_PE', peCode: '0601101A' };
const PE_B: BudgetLineIdentityV1 = { lineKind: 'RDTE_PE', peCode: '0602303A' };

function baseSource(overrides: Partial<ActionScopeSourceV1> = {}): ActionScopeSourceV1 {
  return {
    vehicleClass: 'conference_report',
    fiscalYear: 2027,
    stage: 'appropriations_conference',
    ...overrides,
  };
}

describe('deriveActionScopeIdentityV1', () => {
  it('derives PACKAGE when packageScope is set', () => {
    const result = deriveActionScopeIdentityV1(baseSource({ packageScope: 'pkg-modernization-1' }));
    expect(result).toEqual({
      ok: true,
      identity: {
        kind: 'PACKAGE',
        packageScope: 'pkg-modernization-1',
        vehicleClass: 'conference_report',
        fiscalYear: 2027,
        stage: 'appropriations_conference',
      },
    });
  });

  it('derives ACCOUNT when accountScope is set', () => {
    const result = deriveActionScopeIdentityV1(baseSource({ accountScope: 'ARMY-RDTE' }));
    expect(result).toEqual({
      ok: true,
      identity: {
        kind: 'ACCOUNT',
        accountScope: 'ARMY-RDTE',
        fiscalYear: 2027,
        stage: 'appropriations_conference',
      },
    });
  });

  it('derives TRANSFER_PAIR only when both endpoints are present', () => {
    const result = deriveActionScopeIdentityV1(
      baseSource({ sourceIdentity: PE_A, destinationIdentity: PE_B }),
    );
    expect(result).toEqual({
      ok: true,
      identity: {
        kind: 'TRANSFER_PAIR',
        from: PE_A,
        to: PE_B,
        fiscalYear: 2027,
        stage: 'appropriations_conference',
      },
    });
  });

  it('refuses a transfer with only the source endpoint named', () => {
    const result = deriveActionScopeIdentityV1(baseSource({ sourceIdentity: PE_A }));
    expect(result).toEqual({
      ok: false,
      reason: 'incomplete_transfer_endpoint',
      detail: expect.stringContaining('not be inferred'),
    });
  });

  it('refuses a transfer with only the destination endpoint named', () => {
    const result = deriveActionScopeIdentityV1(baseSource({ destinationIdentity: PE_B }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('incomplete_transfer_endpoint');
  });

  it('refuses an action with no scope at all, rather than guessing one', () => {
    const result = deriveActionScopeIdentityV1(baseSource());
    expect(result).toEqual({
      ok: false,
      reason: 'no_scope_present',
      detail: expect.any(String),
    });
  });

  it('prefers packageScope over accountScope when both are somehow present', () => {
    // Mirrors defense-budget-stage-action-v1.ts's own precedence, matching the
    // schema's mutual-exclusion of primary scopes — this case should not occur
    // in practice, but the derivation must still be deterministic if it does.
    const result = deriveActionScopeIdentityV1(
      baseSource({ packageScope: 'pkg-1', accountScope: 'ARMY-RDTE' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.identity.kind).toBe('PACKAGE');
  });
});

describe('phase6ActionScopeIdentityKeyV1 / hash', () => {
  it('is direction-sensitive for TRANSFER_PAIR: A to B is not B to A', () => {
    const aToB = phase6ActionScopeIdentityKeyV1({
      kind: 'TRANSFER_PAIR',
      from: PE_A,
      to: PE_B,
      fiscalYear: 2027,
      stage: 'appropriations_conference',
    });
    const bToA = phase6ActionScopeIdentityKeyV1({
      kind: 'TRANSFER_PAIR',
      from: PE_B,
      to: PE_A,
      fiscalYear: 2027,
      stage: 'appropriations_conference',
    });
    expect(aToB).not.toBe(bToA);
    expect(
      phase6ActionScopeIdentityHashV1({
        kind: 'TRANSFER_PAIR',
        from: PE_A,
        to: PE_B,
        fiscalYear: 2027,
        stage: 'appropriations_conference',
      }),
    ).not.toBe(
      phase6ActionScopeIdentityHashV1({
        kind: 'TRANSFER_PAIR',
        from: PE_B,
        to: PE_A,
        fiscalYear: 2027,
        stage: 'appropriations_conference',
      }),
    );
  });

  it('is deterministic: the same identity hashes the same way twice', () => {
    const identity = {
      kind: 'ACCOUNT' as const,
      accountScope: 'ARMY-RDTE',
      fiscalYear: 2027,
      stage: 'appropriations_conference' as const,
    };
    expect(phase6ActionScopeIdentityHashV1(identity)).toBe(
      phase6ActionScopeIdentityHashV1({ ...identity }),
    );
  });

  it('separates PACKAGE from ACCOUNT even with an overlapping scope string', () => {
    const pkg = phase6ActionScopeIdentityHashV1({
      kind: 'PACKAGE',
      packageScope: 'X',
      vehicleClass: 'conference_report',
      fiscalYear: 2027,
      stage: 'appropriations_conference',
    });
    const acct = phase6ActionScopeIdentityHashV1({
      kind: 'ACCOUNT',
      accountScope: 'X',
      fiscalYear: 2027,
      stage: 'appropriations_conference',
    });
    expect(pkg).not.toBe(acct);
  });

  it('separates two different package vehicle classes sharing the same scope string', () => {
    const a = phase6ActionScopeIdentityHashV1({
      kind: 'PACKAGE',
      packageScope: 'X',
      vehicleClass: 'conference_report',
      fiscalYear: 2027,
      stage: 'appropriations_conference',
    });
    const b = phase6ActionScopeIdentityHashV1({
      kind: 'PACKAGE',
      packageScope: 'X',
      vehicleClass: 'public_law',
      fiscalYear: 2027,
      stage: 'public_law',
    });
    expect(a).not.toBe(b);
  });

  it('every discriminated variant parses through its own schema', () => {
    expect(() =>
      phase6ActionScopeIdentityV1Schema.parse({
        kind: 'PACKAGE',
        packageScope: 'X',
        vehicleClass: 'conference_report',
        fiscalYear: 2027,
        stage: 'appropriations_conference',
      }),
    ).not.toThrow();
    expect(() =>
      phase6ActionScopeIdentityV1Schema.parse({
        kind: 'ACCOUNT',
        accountScope: 'X',
        fiscalYear: 2027,
        stage: 'appropriations_conference',
      }),
    ).not.toThrow();
    expect(() =>
      phase6ActionScopeIdentityV1Schema.parse({
        kind: 'TRANSFER_PAIR',
        from: PE_A,
        to: PE_B,
        fiscalYear: 2027,
        stage: 'appropriations_conference',
      }),
    ).not.toThrow();
  });

  it('refuses an unknown discriminant', () => {
    expect(() =>
      phase6ActionScopeIdentityV1Schema.parse({ kind: 'SOMETHING_ELSE', fiscalYear: 2027 }),
    ).toThrow();
  });
});
