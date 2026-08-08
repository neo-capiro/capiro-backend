import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FundingOpportunityOutcomeService,
  LOST_REASON_CODES,
  PASSED_REASON_CODES,
  PURSUIT_OUTCOME_KINDS,
  WON_REASON_CODES,
  reasonCodesFor,
  validateRecordOutcomeInput,
  type RecordOutcomeInput,
} from './funding-opportunity-outcome.service.js';

/**
 * Outcome capture and governed learning candidate (P36).
 *
 * Five properties carry the phase:
 *   1. A won/lost/passed transition with no outcome fields fails.
 *   2. Reopening is an INSERT, never an update — the prior version survives.
 *   3. The memory candidate is client-scoped and never auto-promoted; its
 *      failure never costs the operational record.
 *   4. Rejecting the candidate does not touch the outcome.
 *   5. The gate (flag, role, wall) fails closed, matching every other phase.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const CLIENT = '33333333-3333-3333-3333-333333333333';
const SAM_ID = '44444444-4444-4444-4444-444444444444';
const AS_OF = new Date('2026-09-04T12:00:00.000Z');

const STANDARD = { tenantId: TENANT, userId: USER, role: 'standard_user' as const };
const PORTAL = { tenantId: TENANT, userId: USER, role: 'client_portal_user' as const };

// The default outcome date, deliberately in the PAST relative to the real
// wall clock — validateRecordOutcomeInput's future check reads Date.now(),
// not a caller-supplied asOf, so a fixture date must actually have happened.
const OUTCOME_DATE = new Date('2026-08-01T00:00:00.000Z');

function input(over: Partial<RecordOutcomeInput> = {}): RecordOutcomeInput {
  return {
    clientId: CLIENT,
    source: 'sam_gov',
    sourceRecordId: SAM_ID,
    kind: 'lost',
    outcomeDate: OUTCOME_DATE,
    reasonCodes: ['price'],
    note: 'Lost on price to a lower incumbent bid.',
    vehicleOutcome: null,
    sourceAwardLink: null,
    ...over,
  };
}

function makeService(
  over: {
    flagEnabled?: boolean;
    flagThrows?: boolean;
    visibleClientIds?: string[];
    insertedRows?: unknown[];
    historyRows?: unknown[];
    proposeSaveMemory?: (...args: unknown[]) => Promise<unknown>;
  } = {},
) {
  const calls = { insert: 0, history: 0, propose: 0 };
  const flagEnabled = over.flagEnabled ?? true;
  const visible = over.visibleClientIds ?? [CLIENT];

  const defaultRow = {
    id: 'evt-1',
    kind: 'pursuit_lost',
    notes: 'Lost on price to a lower incumbent bid.',
    evidence_jsonb: { reasonCodes: ['price'], vehicleOutcome: null, sourceAwardLink: null },
    recorded_by: USER,
    observed_at: AS_OF,
    created_at: AS_OF,
  };

  const prisma = {
    withSystem: async (fn: (tx: unknown) => unknown) => {
      if (over.flagThrows) throw new Error('42883 operator does not exist: text = uuid');
      return fn({ $queryRaw: async () => (flagEnabled ? [{ ok: 1 }] : []) });
    },
    withTenant: async (_t: string, fn: (tx: unknown) => unknown) =>
      fn({
        client: { findMany: async () => visible.map((id) => ({ id, memoryWall: false })) },
        clientMemoryAccess: { findMany: async () => [] },
      }),
    withTenantUser: async (_t: string, _u: string, fn: (tx: unknown) => unknown) =>
      fn({
        $queryRaw: async () => {
          calls.insert += 1;
          calls.history += 1;
          return over.insertedRows ?? over.historyRows ?? [defaultRow];
        },
      }),
  };

  const memoryCandidates = {
    proposeSaveMemory: async (...args: unknown[]) => {
      calls.propose += 1;
      if (over.proposeSaveMemory) return over.proposeSaveMemory(...args);
      return { candidateId: 'cand-1', status: 'pending', memoryId: null, ruleId: 'x', reason: 'x' };
    },
  };

  return {
    service: new FundingOpportunityOutcomeService(prisma as never, memoryCandidates as never),
    calls,
    memoryCandidates,
  };
}

// ── 1. Required fields ──────────────────────────────────────────────────────

describe('P36 — a won/lost/passed transition with no outcome fields fails', () => {
  it('every required field is checked, one at a time', () => {
    expect(validateRecordOutcomeInput(input())).toBeNull();

    expect(validateRecordOutcomeInput(input({ kind: 'submitted' as never }))).toMatch(
      /not a recordable outcome/,
    );
    expect(
      validateRecordOutcomeInput(input({ outcomeDate: new Date('not-a-date') })),
    ).toMatch(/outcome date is required/);
    expect(
      validateRecordOutcomeInput(
        input({ outcomeDate: new Date(Date.now() + 7 * 86_400_000) }),
      ),
    ).toMatch(/cannot be in the future/);
    expect(validateRecordOutcomeInput(input({ reasonCodes: [] }))).toMatch(
      /At least one reason code/,
    );
    expect(
      validateRecordOutcomeInput(
        input({ reasonCodes: ['price', 'technical_score', 'protest_related', 'agency_cancelled', 'other', 'no_bid_competitive'] }),
      ),
    ).toMatch(/No more than 5/);
    expect(validateRecordOutcomeInput(input({ reasonCodes: ['not_a_real_code'] }))).toMatch(
      /is not a reason code/,
    );
    expect(validateRecordOutcomeInput(input({ reasonCodes: ['price', 'price'] }))).toMatch(
      /listed twice/,
    );
    expect(validateRecordOutcomeInput(input({ note: '   ' }))).toMatch(/note explaining/);
    expect(validateRecordOutcomeInput(input({ note: 'x'.repeat(4_001) }))).toMatch(
      /may not exceed/,
    );
  });

  it('the reason-code vocabulary is closed and different per kind', () => {
    expect(reasonCodesFor('won')).toEqual(WON_REASON_CODES);
    expect(reasonCodesFor('lost')).toEqual(LOST_REASON_CODES);
    expect(reasonCodesFor('passed')).toEqual(PASSED_REASON_CODES);
    // A lost-only code is refused on a won outcome, and vice versa.
    expect(validateRecordOutcomeInput(input({ kind: 'won', reasonCodes: ['price'] }))).toMatch(
      /is not a reason code for a "won"/,
    );
    expect(
      validateRecordOutcomeInput(input({ kind: 'won', reasonCodes: ['best_value'] })),
    ).toBeNull();
    // Every vocabulary carries 'other', and 'other' relies on the note field
    // rather than a second free-text-reason field.
    for (const kind of PURSUIT_OUTCOME_KINDS) expect(reasonCodesFor(kind)).toContain('other');
  });

  it('the service itself refuses before touching the database', async () => {
    const { service, calls } = makeService();
    const result = await service.recordOutcome(STANDARD, input({ reasonCodes: [] }));
    expect(result.state).toBe('invalid_request');
    expect(calls.insert).toBe(0);
    expect(calls.propose).toBe(0);
  });
});

// ── 2. Reopening is an insert, never an update ──────────────────────────────

describe('P36 — reopening preserves the prior version; nothing is ever updated', () => {
  it('the service holds no update verb at all', () => {
    const code = readFileSync(join(__dirname, 'funding-opportunity-outcome.service.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const verb of ['UPDATE outcome_event', '.update(', '.upsert(', 'ON CONFLICT']) {
      expect(code).not.toContain(verb);
    }
    expect(code).toContain('INSERT INTO outcome_event');
  });

  it('history returns every recorded outcome, latest marked current', async () => {
    const older = {
      id: 'evt-1',
      kind: 'pursuit_lost',
      notes: 'Initial loss.',
      evidence_jsonb: { reasonCodes: ['price'] },
      recorded_by: USER,
      observed_at: new Date('2026-08-01T00:00:00.000Z'),
      created_at: new Date('2026-08-01T00:00:00.000Z'),
    };
    const newer = {
      id: 'evt-2',
      kind: 'pursuit_lost',
      notes: 'Corrected after debrief: actually a technical score issue.',
      evidence_jsonb: { reasonCodes: ['technical_score'] },
      recorded_by: USER,
      observed_at: new Date('2026-09-01T00:00:00.000Z'),
      created_at: new Date('2026-09-01T00:00:00.000Z'),
    };
    const { service } = makeService({ historyRows: [newer, older] });
    const result = await service.getOutcomeHistory(STANDARD, CLIENT, 'sam_gov', SAM_ID);

    expect(result.state).toBe('available');
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes[0]!.id).toBe('evt-2');
    expect(result.outcomes[0]!.current).toBe(true);
    expect(result.outcomes[1]!.id).toBe('evt-1');
    expect(result.outcomes[1]!.current).toBe(false);
    // The FIRST row is untouched — same note, same reason codes it always had.
    expect(result.outcomes[1]!.note).toBe('Initial loss.');
  });

  it('no history is a stated fact, not an empty array with no explanation', async () => {
    const { service } = makeService({ historyRows: [] });
    const result = await service.getOutcomeHistory(STANDARD, CLIENT, 'sam_gov', SAM_ID);
    expect(result.outcomes).toEqual([]);
    expect(result.explanation).toContain('No outcome has been recorded');
  });
});

// ── 3. The memory candidate ──────────────────────────────────────────────────

describe('P36 — the memory candidate is client-scoped, never auto-promoted, fail-open', () => {
  it('proposeSaveMemory is called with scope client and this client’s id', async () => {
    let captured: unknown;
    const { service } = makeService({
      proposeSaveMemory: async (...args: unknown[]) => {
        captured = args[2];
        return { candidateId: 'c1', status: 'pending', memoryId: null, ruleId: 'x', reason: 'x' };
      },
    });
    const result = await service.recordOutcome(STANDARD, input());
    expect(result.state).toBe('recorded');
    if (result.state === 'recorded') expect(result.memoryCandidateProposed).toBe(true);
    expect((captured as { scope: string }).scope).toBe('client');
    expect((captured as { clientId: string }).clientId).toBe(CLIENT);
  });

  it('a memory-candidate failure never loses the outcome record', async () => {
    const { service, calls } = makeService({
      proposeSaveMemory: async () => {
        throw new Error('memory store unavailable');
      },
    });
    const result = await service.recordOutcome(STANDARD, input());
    expect(result.state).toBe('recorded');
    if (result.state === 'recorded') {
      expect(result.memoryCandidateProposed).toBe(false);
      // The outcome itself is fully present despite the candidate failure.
      expect(result.outcome.note).toBe(input().note);
    }
    expect(calls.insert).toBe(1);
  });

  it('the summary leads with the human-written note, not a bare code list', async () => {
    let capturedValue = '';
    const { service } = makeService({
      proposeSaveMemory: async (...args: unknown[]) => {
        capturedValue = (args[2] as { value: string }).value;
        return { candidateId: 'c1', status: 'pending', memoryId: null, ruleId: 'x', reason: 'x' };
      },
    });
    await service.recordOutcome(
      STANDARD,
      input({ note: 'The client’s bonding capacity fell through late.' }),
    );
    expect(capturedValue).toContain('The client’s bonding capacity fell through late.');
  });
});

// ── 4. Rejection independence ───────────────────────────────────────────────

describe('P36 — rejecting the candidate cannot touch the outcome', () => {
  it('the outcome write and the candidate proposal are separate calls with no shared rollback', () => {
    // Structural: the outcome INSERT commits and returns before the candidate
    // is even attempted, so there is no code path in which the review flow's
    // reject action could reach back into outcome_event.
    const code = readFileSync(join(__dirname, 'funding-opportunity-outcome.service.ts'), 'utf8');
    const insertAt = code.indexOf('INSERT INTO outcome_event');
    const proposeAt = code.indexOf('proposeLearningCandidate(actor, input, outcome)');
    expect(insertAt).toBeGreaterThan(-1);
    expect(proposeAt).toBeGreaterThan(insertAt);
  });
});

// ── 5. The gate ──────────────────────────────────────────────────────────────

describe('P36 — the gate is flag, then role, then wall, and all three fail closed', () => {
  it('the flag off refuses before any write or read', async () => {
    const { service, calls } = makeService({ flagEnabled: false });
    const recorded = await service.recordOutcome(STANDARD, input());
    expect(recorded.state).toBe('disabled');
    const history = await service.getOutcomeHistory(STANDARD, CLIENT, 'sam_gov', SAM_ID);
    expect(history.state).toBe('disabled');
    expect(calls.insert).toBe(0);
    expect(calls.propose).toBe(0);
  });

  it('a throwing flag read fails closed', async () => {
    const { service } = makeService({ flagThrows: true });
    expect((await service.recordOutcome(STANDARD, input())).state).toBe('disabled');
  });

  it('a portal user is denied before any client read', async () => {
    const { service, calls } = makeService();
    const result = await service.recordOutcome(PORTAL, input());
    expect(result.state).toBe('denied');
    expect(calls.insert).toBe(0);
  });

  it('a walled client is denied with the same sentence a non-existent one gets', async () => {
    const { service } = makeService({ visibleClientIds: [] });
    const result = await service.recordOutcome(STANDARD, input());
    expect(result.state).toBe('denied');
    expect(result.state === 'denied' && result.explanation).toBe('Not available for this client.');
  });

  it('reuses the PIPELINE flag, not a new one — the plan’s own instruction', () => {
    const code = readFileSync(join(__dirname, 'funding-opportunity-outcome.service.ts'), 'utf8');
    expect(code).toContain('FUNDING_OPPORTUNITIES_PIPELINE_V2_FEATURE');
    expect(code).not.toMatch(/funding_opportunities_outcome/);
  });
});

// ── Vocabulary ───────────────────────────────────────────────────────────────

describe('P36 — vocabulary', () => {
  it('exactly the three outcome kinds the plan names', () => {
    expect([...PURSUIT_OUTCOME_KINDS]).toEqual(['won', 'lost', 'passed']);
  });

  it('the kind namespacing cannot collide with outcome_event’s existing advocacy vocabulary', () => {
    // Every value this file writes is pursuit_-prefixed.
    const code = readFileSync(join(__dirname, 'funding-opportunity-outcome.service.ts'), 'utf8');
    for (const kind of ['pursuit_won', 'pursuit_lost', 'pursuit_passed']) {
      expect(code).toContain(kind);
    }
  });
});
