/**
 * F10 (2026-09-10 remediation plan §8) — server blocker projection.
 *
 * The projection itself is a pure function over the persisted run row; the
 * listRuns/runs.get wiring attaches it as an additive field (visible in the
 * service diff). This spec pins the projection contract directly.
 */
import { describe, expect, it } from '@jest/globals';
import { projectExecutionBlocker } from './execution-blocker.js';
import type { Prisma } from '../../generated/prisma-client/index.js';

const OWNER_MISSING_RUN = {
  state: 'waiting_for_input',
  idempotencyKey: 'exec:node-1:workspace',
  strategyId: 'strat-1',
  waitingReason: 'node no longer eligible: node has no owner (ownerUserId is required)',
  error: null,
  findings: {
    execution: { nodeId: 'node-1', strategyId: 'strat-1' },
    g0: {
      eligibility: {
        eligible: false,
        reasons: ['node has no owner (ownerUserId is required)'],
      },
    },
  } as unknown as Prisma.JsonValue,
};

describe('F10 server blocker projection (projectExecutionBlocker)', () => {
  it('maps the backend missing-owner park to owner_missing with the step repair target', () => {
    const blocker = projectExecutionBlocker(OWNER_MISSING_RUN);
    expect(blocker).toMatchObject({
      code: 'owner_missing',
      primary: 'Assign an owner to this step before preparing work.',
      nodeId: 'node-1',
      strategyId: 'strat-1',
      repair: 'open_step',
    });
  });

  it('names only the known missing context types', () => {
    const blocker = projectExecutionBlocker({
      ...OWNER_MISSING_RUN,
      waitingReason: 'required client context is missing: client_constraints',
      findings: {
        execution: { nodeId: 'node-2', strategyId: 'strat-1' },
        g0: {
          eligibility: { eligible: false, reasons: [] },
          missingRequired: ['client_constraints'],
        },
      } as unknown as Prisma.JsonValue,
    });
    expect(blocker?.code).toBe('required_source_missing');
    expect(blocker?.requirements).toEqual([
      { kind: 'client_constraints', label: 'Client constraints' },
    ]);
    expect(blocker?.repair).toBe('add_context');
  });

  it('an unknown-cause verification failure never invents a missing requirement', () => {
    const blocker = projectExecutionBlocker({
      state: 'failed_recoverable',
      strategyId: 'strat-1',
      waitingReason: null,
      error:
        'generated artifact verification did not pass — no Workspace or Outreach artifact was created',
      findings: {
        execution: { nodeId: 'node-3', strategyId: 'strat-1' },
        g0: { eligibility: { eligible: true, reasons: [] }, missingRequired: [] },
      } as unknown as Prisma.JsonValue,
    });
    expect(blocker?.code).toBe('verification_failed_unknown');
    expect(blocker?.requirements).toEqual([]);
  });

  it('a send-approval park carries no generic blocker (its own dedicated surface)', () => {
    const blocker = projectExecutionBlocker({
      ...OWNER_MISSING_RUN,
      waitingReason: 'awaiting send approval',
    });
    expect(blocker).toBeNull();
  });

  it('a ready run carries no blocker', () => {
    expect(
      projectExecutionBlocker({
        ...OWNER_MISSING_RUN,
        state: 'ready_for_review',
        waitingReason: null,
        findings: {
          execution: { nodeId: 'node-1', strategyId: 'strat-1' },
          g0: { eligibility: { eligible: true, reasons: [] } },
        } as unknown as Prisma.JsonValue,
      }),
    ).toBeNull();
  });
});
