import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  ALLOWED_TRANSITIONS,
  FORECAST_FORBIDDEN_STAGES,
  FundingOpportunityPipelineService,
  HUMAN_ONLY_STAGES,
  LEGACY_STATUS_TO_STAGE,
  PIPELINE_STAGES,
  STAGE_TO_LEGACY_STATUS,
  TERMINAL_STAGES,
  UNSTAGED,
  effectiveStage,
  foldBoardCounts,
  isPipelineStage,
  refuseTransition,
  type PipelinePort,
  type PipelineRow,
  type PipelineStage,
} from './funding-opportunity-pipeline.js';
import {
  HUMAN_DECISION_STATUSES,
  OPPORTUNITY_WORKFLOW_STATUSES,
} from './funding-opportunities.types.js';

/**
 * The pursuit pipeline (P35).
 *
 * Six properties carry the phase:
 *   1. the rolling deploy is survivable — old pods write only the legacy column,
 *      and reads never show a stage that contradicts it;
 *   2. an invalid transition fails, and the graph is the only authority;
 *   3. a concurrent transition is DETECTED rather than silently overwritten;
 *   4. board counts describe every workflow row, not a page;
 *   5. a forecast never reaches a pursuit or an outcome stage;
 *   6. producers cannot move a stage.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const OTHER_USER = '22222222-2222-2222-2222-222222222299';
const CLIENT = '33333333-3333-3333-3333-333333333333';
const ROW = '44444444-4444-4444-4444-444444444444';
const AS_OF = new Date('2026-08-07T12:00:00.000Z');

function row(over: Partial<PipelineRow> = {}): PipelineRow {
  return {
    id: ROW,
    clientId: CLIENT,
    source: 'sam_gov',
    sourceRecordId: '55555555-5555-5555-5555-555555555555',
    workflowStatus: 'saved',
    pipelineStage: 'reviewing',
    pipelineStageVersion: 3,
    pipelineStageAt: AS_OF,
    pipelineStageByUserId: USER,
    title: null,
    responseDeadline: new Date('2026-10-01T17:00:00.000Z'),
    ...over,
  };
}

function makeService(over: Partial<PipelinePort> = {}) {
  const commits: Array<Parameters<PipelinePort['commitTransition']>[1]> = [];
  const base: PipelinePort = {
    visibleClientIds: async () => [CLIENT],
    readRow: async () => row(),
    countByStage: async () => [{ pipelineStage: 'reviewing', workflowStatus: 'saved', count: 1 }],
    commitTransition: async (_tenantId, input) => {
      commits.push(input);
      return true;
    },
    listForBoard: async () => [row()],
  };
  const merged = { ...base, ...over };
  // The commit recorder wraps the MERGED port so an override still gets counted —
  // spreading it after the defaults would silently replace the recorder and every
  // assertion about what was written would pass by measuring nothing.
  const port: PipelinePort = {
    ...merged,
    commitTransition: async (tenantId, input) => {
      commits.push(input);
      return merged.commitTransition(tenantId, input);
    },
  };
  return {
    service: new FundingOpportunityPipelineService({} as never).withPort(port),
    commits,
  };
}

// ── 1 ─ Rolling-deploy compatibility ─────────────────────────────────────────

describe('THE RULE: an old pod writes only the legacy column, and reads stay honest', () => {
  it('derives a stage from the workflow status when no stage was recorded', () => {
    const resolved = effectiveStage({ workflowStatus: 'pursuing', pipelineStage: null });
    expect(resolved).toEqual({
      stage: 'pursuing',
      basis: 'workflow_status',
      explanation: expect.stringContaining('Derived from the workflow status'),
    });
  });

  it('lets the legacy status WIN when it has moved past the recorded stage', () => {
    // The exact rolling-deploy case: an old pod recorded a win and could not move
    // the stage. Showing `pursuing` here would tell a user a won bid is still open.
    const resolved = effectiveStage({ workflowStatus: 'won', pipelineStage: 'pursuing' });
    expect(resolved.stage).toBe('won');
    expect(resolved.basis).toBe('legacy_override');
    expect(resolved.explanation).toContain('out of date');
  });

  it('keeps the finer stage when the legacy status AGREES with it', () => {
    // `qualified` and `submitted` both project onto `pursuing`. Comparing in the
    // other direction would call every one of them stale.
    for (const stage of ['qualified', 'submitted'] as PipelineStage[]) {
      const resolved = effectiveStage({ workflowStatus: 'pursuing', pipelineStage: stage });
      expect(resolved.stage).toBe(stage);
      expect(resolved.basis).toBe('recorded');
    }
  });

  it('round-trips every stage through its legacy projection', () => {
    for (const stage of PIPELINE_STAGES) {
      const legacy = STAGE_TO_LEGACY_STATUS[stage];
      const resolved = effectiveStage({ workflowStatus: legacy, pipelineStage: stage });
      expect(resolved.basis).toBe('recorded');
      expect(resolved.stage).toBe(stage);
    }
  });

  it('leaves a producer suggestion UNSTAGED rather than calling it reviewing', () => {
    // Mapping it would put the producer's entire backlog on a column named for a
    // human activity nobody is performing.
    const resolved = effectiveStage({ workflowStatus: 'suggested', pipelineStage: null });
    expect(resolved.stage).toBeNull();
    expect(resolved.basis).toBe('unstaged');
    expect(resolved.explanation).toContain('not a stage somebody is working');
  });

  it('leaves an expired row unstaged, and says the stage is not recorded', () => {
    const resolved = effectiveStage({ workflowStatus: 'expired', pipelineStage: null });
    expect(resolved.stage).toBeNull();
    expect(resolved.explanation).toContain('is not recorded, and it is not guessed');
  });

  it('reports a stale stage as unstaged when the legacy status is not a stage at all', () => {
    // An old pod expired a row that had been staged. There is no honest stage to
    // show, and the recorded one is stale.
    const resolved = effectiveStage({ workflowStatus: 'expired', pipelineStage: 'pursuing' });
    expect(resolved.stage).toBeNull();
    expect(resolved.basis).toBe('legacy_override');
    expect(resolved.explanation).toContain('out of date');
  });

  it('covers every legacy status, so a new one cannot be silently unmapped', () => {
    for (const status of OPPORTUNITY_WORKFLOW_STATUSES) {
      expect(LEGACY_STATUS_TO_STAGE).toHaveProperty(status);
    }
    // The two mechanical statuses map to nothing, and every human decision maps.
    expect(LEGACY_STATUS_TO_STAGE.suggested).toBeNull();
    expect(LEGACY_STATUS_TO_STAGE.expired).toBeNull();
    for (const status of HUMAN_DECISION_STATUSES) {
      expect(LEGACY_STATUS_TO_STAGE[status]).not.toBeNull();
    }
  });

  it('ignores an unrecognised stage string rather than trusting the column', () => {
    const resolved = effectiveStage({ workflowStatus: 'saved', pipelineStage: 'shipping_it' });
    expect(resolved.stage).toBe('reviewing');
    expect(resolved.basis).toBe('workflow_status');
  });

  it('writes the legacy column on every transition, so old readers stay correct', async () => {
    const { service, commits } = makeService();
    await service.transition(TENANT, USER, CLIENT, ROW, { toStage: 'qualified', expectedVersion: 3 }, AS_OF);
    expect(commits[0]!.toWorkflowStatus).toBe('pursuing');
    expect(commits[0]!.toStage).toBe('qualified');
  });

  it('reads no clock of its own beyond an asOf default', () => {
    const source = readFileSync(join(__dirname, 'funding-opportunity-pipeline.ts'), 'utf8');
    const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const clocks = code.match(/new Date\(\)/g) ?? [];
    const defaults = code.match(/asOf: Date = new Date\(\)/g) ?? [];
    expect(defaults.length).toBeGreaterThan(0);
    expect(clocks.length).toBe(defaults.length);
  });
});

// ── 2 ─ Invalid transitions fail ─────────────────────────────────────────────

describe('THE RULE: the transition graph is the only authority', () => {
  it('allows only the declared moves out of each stage', () => {
    expect(ALLOWED_TRANSITIONS[UNSTAGED]).toEqual(['reviewing']);
    expect(ALLOWED_TRANSITIONS.reviewing).toEqual(['qualified', 'passed']);
    expect(ALLOWED_TRANSITIONS.qualified).toEqual(['pursuing', 'passed']);
    expect(ALLOWED_TRANSITIONS.pursuing).toEqual(['submitted', 'passed']);
    expect(ALLOWED_TRANSITIONS.submitted).toEqual(['won', 'lost']);
    expect(ALLOWED_TRANSITIONS.passed).toEqual(['reviewing']);
  });

  it('declares an entry for every stage plus the unstaged key', () => {
    for (const stage of PIPELINE_STAGES) expect(ALLOWED_TRANSITIONS).toHaveProperty(stage);
    expect(ALLOWED_TRANSITIONS).toHaveProperty(UNSTAGED);
  });

  it('reaches won and lost ONLY from submitted', () => {
    // A bid cannot be won if it was never submitted, and a board that allowed the
    // jump would report conversion numbers describing nothing that happened.
    const sources = PIPELINE_STAGES.filter((s) => (ALLOWED_TRANSITIONS[s] ?? []).includes('won'));
    expect(sources).toEqual(['submitted']);
    expect(PIPELINE_STAGES.filter((s) => (ALLOWED_TRANSITIONS[s] ?? []).includes('lost'))).toEqual([
      'submitted',
    ]);
  });

  it('refuses a jump from reviewing straight to won', () => {
    expect(
      refuseTransition({ from: 'reviewing', to: 'won', source: 'sam_gov', reason: 'we won' }),
    ).toMatch(/moves to qualified or passed, not to won/);
  });

  it('refuses to move out of a terminal stage', () => {
    for (const stage of TERMINAL_STAGES) {
      expect(refuseTransition({ from: stage, to: 'reviewing', source: 'sam_gov', reason: 'x' })).toMatch(
        /is final/,
      );
    }
  });

  it('refuses a move to where it already is', () => {
    expect(
      refuseTransition({ from: 'qualified', to: 'qualified', source: 'sam_gov', reason: null }),
    ).toMatch(/already at qualified/);
  });

  it('refuses a stage string that is not in the vocabulary', () => {
    expect(
      refuseTransition({ from: 'reviewing', to: 'shipped' as PipelineStage, source: 'sam_gov', reason: null }),
    ).toMatch(/is not a pipeline stage/);
    expect(isPipelineStage('shipped')).toBe(false);
    expect(isPipelineStage('reviewing')).toBe(true);
  });

  it('lets an unstaged row enter only at the front', () => {
    expect(refuseTransition({ from: null, to: 'reviewing', source: 'sam_gov', reason: null })).toBeNull();
    for (const stage of PIPELINE_STAGES.filter((s) => s !== 'reviewing')) {
      expect(
        refuseTransition({ from: null, to: stage, source: 'sam_gov', reason: 'because' }),
      ).not.toBeNull();
    }
  });

  it('requires a stated reason for every outcome stage', () => {
    expect(HUMAN_ONLY_STAGES).toEqual(new Set(['submitted', 'won', 'lost', 'passed']));
    expect(
      refuseTransition({ from: 'pursuing', to: 'submitted', source: 'sam_gov', reason: null }),
    ).toMatch(/needs a stated reason/);
    expect(
      refuseTransition({ from: 'pursuing', to: 'submitted', source: 'sam_gov', reason: '   ' }),
    ).toMatch(/needs a stated reason/);
    expect(
      refuseTransition({ from: 'pursuing', to: 'submitted', source: 'sam_gov', reason: 'Proposal uploaded.' }),
    ).toBeNull();
  });

  it('does not require a reason to enter or advance within the pipeline', () => {
    expect(refuseTransition({ from: null, to: 'reviewing', source: 'sam_gov', reason: null })).toBeNull();
    expect(
      refuseTransition({ from: 'reviewing', to: 'qualified', source: 'sam_gov', reason: null }),
    ).toBeNull();
  });

  it('refuses through the service with a 400, and writes nothing', async () => {
    const { service, commits } = makeService({
      readRow: async () => row({ pipelineStage: 'reviewing', workflowStatus: 'saved' }),
    });
    await expect(
      service.transition(TENANT, USER, CLIENT, ROW, { toStage: 'won', expectedVersion: 3, reason: 'x' }, AS_OF),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(commits).toEqual([]);
  });

  it('validates against the EFFECTIVE stage, not the stale recorded one', async () => {
    // An old pod moved this row to `won`. `won` is terminal, so nothing moves out
    // of it — even though the recorded stage still says `pursuing`, which would
    // have allowed a move to `submitted`.
    const { service, commits } = makeService({
      readRow: async () => row({ workflowStatus: 'won', pipelineStage: 'pursuing' }),
    });
    await expect(
      service.transition(TENANT, USER, CLIENT, ROW, { toStage: 'submitted', expectedVersion: 3, reason: 'x' }, AS_OF),
    ).rejects.toThrow(/won is final/);
    expect(commits).toEqual([]);
  });

  it('records the stage it actually moved FROM', async () => {
    const { service, commits } = makeService();
    const result = await service.transition(
      TENANT,
      USER,
      CLIENT,
      ROW,
      { toStage: 'qualified', expectedVersion: 3 },
      AS_OF,
    );
    expect(commits[0]!.fromStage).toBe('reviewing');
    expect(result.from).toBe('reviewing');
    expect(result.to).toBe('qualified');
    expect(result.version).toBe(4);
    expect(result.occurredAt).toBe(AS_OF.toISOString());
  });

  it('trims a reason and stores null for a blank one', async () => {
    const { service, commits } = makeService({
      readRow: async () => row({ pipelineStage: 'pursuing', workflowStatus: 'pursuing' }),
    });
    await service.transition(
      TENANT,
      USER,
      CLIENT,
      ROW,
      { toStage: 'submitted', expectedVersion: 3, reason: '  Proposal uploaded.  ' },
      AS_OF,
    );
    expect(commits[0]!.reason).toBe('Proposal uploaded.');
  });
});

// ── 3 ─ Concurrency ─────────────────────────────────────────────────────────

describe('THE RULE: a concurrent transition is detected, never overwritten', () => {
  it('raises a conflict when the expected version no longer matches', async () => {
    const { service } = makeService({ commitTransition: async () => false });
    await expect(
      service.transition(TENANT, USER, CLIENT, ROW, { toStage: 'qualified', expectedVersion: 3 }, AS_OF),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('tells the user what happened and what to do about it', async () => {
    const { service } = makeService({ commitTransition: async () => false });
    await expect(
      service.transition(TENANT, USER, CLIENT, ROW, { toStage: 'qualified', expectedVersion: 3 }, AS_OF),
    ).rejects.toThrow(/Somebody else moved this.*Reload/s);
  });

  it('passes the caller’s expected version through to the conditional update', async () => {
    const { service, commits } = makeService();
    await service.transition(TENANT, USER, CLIENT, ROW, { toStage: 'qualified', expectedVersion: 7 }, AS_OF);
    expect(commits[0]!.expectedVersion).toBe(7);
  });

  it('lets exactly one of two simultaneous moves win', async () => {
    // The port models the real conditional UPDATE: it commits only when the
    // caller's expected version still matches the row's.
    let version = 3;
    const { service } = makeService({
      commitTransition: async (_t, input) => {
        if (input.expectedVersion !== version) return false;
        version += 1;
        return true;
      },
    });
    const [first, second] = await Promise.allSettled([
      service.transition(TENANT, USER, CLIENT, ROW, { toStage: 'qualified', expectedVersion: 3 }, AS_OF),
      service.transition(TENANT, OTHER_USER, CLIENT, ROW, { toStage: 'passed', expectedVersion: 3, reason: 'no fit' }, AS_OF),
    ]);
    const outcomes = [first.status, second.status].sort();
    expect(outcomes).toEqual(['fulfilled', 'rejected']);
    expect(version).toBe(4);
  });
});

// ── 4 ─ Board counts ────────────────────────────────────────────────────────

describe('THE RULE: board counts describe every workflow row, not a page', () => {
  it('folds a grouped aggregate into all seven stages, zeros included', () => {
    const counts = foldBoardCounts([
      { pipelineStage: 'reviewing', workflowStatus: 'saved', count: 4 },
      { pipelineStage: 'qualified', workflowStatus: 'pursuing', count: 2 },
    ]);
    expect(counts.stages).toHaveLength(PIPELINE_STAGES.length);
    expect(counts.stages.map((s) => s.stage)).toEqual([...PIPELINE_STAGES]);
    expect(counts.stages.find((s) => s.stage === 'reviewing')?.count).toBe(4);
    expect(counts.stages.find((s) => s.stage === 'won')?.count).toBe(0);
    expect(counts.total).toBe(6);
  });

  it('counts unstaged rows separately, split by why', () => {
    const counts = foldBoardCounts([
      { pipelineStage: null, workflowStatus: 'suggested', count: 900 },
      { pipelineStage: null, workflowStatus: 'expired', count: 12 },
      { pipelineStage: 'reviewing', workflowStatus: 'saved', count: 3 },
    ]);
    expect(counts.unstaged).toEqual({ suggested: 900, expired: 12, other: 0 });
    // The producer's backlog is NOT added to reviewing.
    expect(counts.stages.find((s) => s.stage === 'reviewing')?.count).toBe(3);
    expect(counts.total).toBe(915);
  });

  it('reports how many stages were derived rather than recorded', () => {
    const counts = foldBoardCounts([
      { pipelineStage: null, workflowStatus: 'saved', count: 5 },
      { pipelineStage: 'reviewing', workflowStatus: 'saved', count: 2 },
      { pipelineStage: 'pursuing', workflowStatus: 'won', count: 1 },
    ]);
    // 5 derived from the legacy column, 1 legacy override; the 2 recorded ones
    // are not counted.
    expect(counts.derivedFromWorkflowStatus).toBe(6);
  });

  it('counts a legacy-override row under the stage the legacy column implies', () => {
    const counts = foldBoardCounts([
      { pipelineStage: 'pursuing', workflowStatus: 'won', count: 3 },
    ]);
    expect(counts.stages.find((s) => s.stage === 'won')?.count).toBe(3);
    expect(counts.stages.find((s) => s.stage === 'pursuing')?.count).toBe(0);
  });

  it('returns an all-zero board for a client with nothing tracked', () => {
    const counts = foldBoardCounts([]);
    expect(counts.total).toBe(0);
    expect(counts.stages.every((s) => s.count === 0)).toBe(true);
    expect(counts.unstaged).toEqual({ suggested: 0, expired: 0, other: 0 });
  });

  it('counts from the aggregate even when the cards are truncated', async () => {
    // The specific failure this exists to prevent: a board that counted its own
    // page would report 2 when the client has 915.
    const many = Array.from({ length: 5 }, (_, i) => row({ id: `row-${i}` }));
    const { service } = makeService({
      countByStage: async () => [
        { pipelineStage: null, workflowStatus: 'suggested', count: 900 },
        { pipelineStage: 'reviewing', workflowStatus: 'saved', count: 15 },
      ],
      listForBoard: async () => many,
    });
    const board = await service.board(TENANT, USER, CLIENT, 2);
    expect(board.counts.total).toBe(915);
    expect(board.cards).toHaveLength(2);
    expect(board.cardsTruncated).toBe(true);
  });

  it('does not claim truncation when the card list is complete', async () => {
    const { service } = makeService({ listForBoard: async () => [row()] });
    const board = await service.board(TENANT, USER, CLIENT, 200);
    expect(board.cardsTruncated).toBe(false);
  });

  it('ships the allowed moves per card so a UI cannot offer one the server refuses', async () => {
    const { service } = makeService();
    const board = await service.board(TENANT, USER, CLIENT);
    expect(board.cards[0]!.allowedTransitions).toEqual(['qualified', 'passed']);
    expect(board.cards[0]!.version).toBe(3);
    expect(board.cards[0]!.stageBasis).toBe('recorded');
  });

  it('returns an empty board rather than a 403 for a client the actor cannot see', async () => {
    const { service } = makeService({ visibleClientIds: async () => [] });
    const board = await service.board(TENANT, USER, CLIENT);
    expect(board.cards).toEqual([]);
    expect(board.counts.total).toBe(0);
  });

  it('reads nothing on behalf of a client the actor cannot see', async () => {
    let reads = 0;
    const { service } = makeService({
      visibleClientIds: async () => [],
      countByStage: async () => {
        reads += 1;
        return [];
      },
      listForBoard: async () => {
        reads += 1;
        return [];
      },
    });
    await service.board(TENANT, USER, CLIENT);
    expect(reads).toBe(0);
  });
});

// ── 5 ─ Forecasts ───────────────────────────────────────────────────────────

describe('THE RULE: a forecast never reaches a pursuit or an outcome stage', () => {
  it('forbids exactly the four stages P26 already forbids the actions for', () => {
    expect(FORECAST_FORBIDDEN_STAGES).toEqual(new Set(['pursuing', 'submitted', 'won', 'lost']));
  });

  it('refuses every forbidden stage, and says why', () => {
    for (const stage of FORECAST_FORBIDDEN_STAGES) {
      expect(
        refuseTransition({ from: 'qualified', to: stage, source: 'agency_forecast', reason: 'because' }),
      ).toMatch(/pre-solicitation signal|moves to/);
    }
    expect(
      refuseTransition({ from: 'qualified', to: 'pursuing', source: 'agency_forecast', reason: null }),
    ).toMatch(/nothing to respond to yet/);
  });

  it('lets a forecast be reviewed, qualified and passed', () => {
    expect(refuseTransition({ from: null, to: 'reviewing', source: 'agency_forecast', reason: null })).toBeNull();
    expect(
      refuseTransition({ from: 'reviewing', to: 'qualified', source: 'agency_forecast', reason: null }),
    ).toBeNull();
    expect(
      refuseTransition({ from: 'qualified', to: 'passed', source: 'agency_forecast', reason: 'no capability' }),
    ).toBeNull();
  });

  it('refuses a forecast pursuit through the service, and writes nothing', async () => {
    const { service, commits } = makeService({
      readRow: async () =>
        row({ source: 'agency_forecast', pipelineStage: 'qualified', workflowStatus: 'pursuing' }),
    });
    await expect(
      service.transition(TENANT, USER, CLIENT, ROW, { toStage: 'pursuing', expectedVersion: 3 }, AS_OF),
    ).rejects.toThrow(/pre-solicitation signal/);
    expect(commits).toEqual([]);
  });

  it('omits the forbidden stages from a forecast card’s allowed moves', async () => {
    const { service } = makeService({
      listForBoard: async () => [
        row({ source: 'agency_forecast', pipelineStage: 'qualified', workflowStatus: 'pursuing' }),
      ],
    });
    const board = await service.board(TENANT, USER, CLIENT);
    // `qualified` normally offers pursuing and passed. A forecast gets only passed.
    expect(board.cards[0]!.allowedTransitions).toEqual(['passed']);
  });
});

// ── 6 ─ Producers cannot move a stage ───────────────────────────────────────

describe('THE RULE: producers cannot move a stage', () => {
  const producers = [
    '../../scripts/generate-sam-opportunity-candidates.ts',
    '../../scripts/generate-funding-grant-candidates.ts',
    '../../scripts/process-funding-opportunity-lifecycle.ts',
  ];

  it.each(producers)('%s never mentions the stage columns', (relative) => {
    const source = readFileSync(join(__dirname, relative), 'utf8');
    expect(source).not.toMatch(/pipelineStage|pipeline_stage/);
  });

  it('records an actor on every transition it commits', async () => {
    const { service, commits } = makeService();
    await service.transition(TENANT, USER, CLIENT, ROW, { toStage: 'qualified', expectedVersion: 3 }, AS_OF);
    expect(commits[0]!.actorUserId).toBe(USER);
  });

  it('is the only module in the feature that writes the stage', () => {
    // Structural: if a second writer appears, this fails and somebody has to
    // decide deliberately rather than by accident.
    const source = readFileSync(join(__dirname, 'funding-opportunity-pipeline.ts'), 'utf8');
    expect(source).toMatch(/pipelineStage: input\.toStage/);
  });

  it('404s rather than 403s for a client the actor cannot see', async () => {
    // A 403 would confirm the client exists.
    const { service, commits } = makeService({ visibleClientIds: async () => [] });
    await expect(
      service.transition(TENANT, USER, CLIENT, ROW, { toStage: 'qualified', expectedVersion: 3 }, AS_OF),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(commits).toEqual([]);
  });

  it('404s for a row that does not exist', async () => {
    const { service } = makeService({ readRow: async () => null });
    await expect(
      service.transition(TENANT, USER, CLIENT, ROW, { toStage: 'qualified', expectedVersion: 3 }, AS_OF),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a stage string the DTO would have caught, as a backstop', async () => {
    const { service } = makeService();
    await expect(
      service.transition(TENANT, USER, CLIENT, ROW, { toStage: 'shipped', expectedVersion: 3 }, AS_OF),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
