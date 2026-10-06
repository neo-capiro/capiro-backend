import type { ResearchPlanV1 } from './meri-research-plan';
import type { ResearchRunState } from './meri-research-run-state';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  activateDurableResearchCoordinator,
  admitDurableResearchCoordinator,
  applyDurableResearchReplan,
  completeDurableResearchStep,
  failDurableResearchStep,
  publicDurableResearchCoordinator,
  queueDurableResearchSteering,
  requestDurableResearchCancellation,
  observeDurableResearchCancellation,
  reserveDurableResearchStep,
} from './meri-research-coordinator';

const run = (leaseEpoch = 1, id = `run-${leaseEpoch}`): ResearchRunState => ({
  id,
  leaseEpoch,
  eventSequence: 0,
  phase: 'research',
  status: 'running',
  stage: 'Gathering evidence',
  startedAt: '2099-09-28T00:00:00.000Z',
  heartbeatAt: '2099-09-28T00:00:00.000Z',
});

function plan(revision = 0): ResearchPlanV1 {
  return {
    version: 1,
    title: `House bill analysis ${revision}`,
    scope: {
      sessionId: 'research-1',
      tenantId: 'tenant-1',
      actorId: 'actor-1',
      clientId: 'client-1',
      conversationId: 'conversation-1',
    },
    budget: { toolCalls: 3, tokens: 6_000 },
    steps: [
      {
        id: 'read-house-text',
        objective: `Read House text ${revision}`,
        dependsOn: [],
        requiredEvidenceDomains: ['legislative'],
        allowedCapabilities: ['get_bill_status'],
        effect: 'read',
        completionCondition: 'Current House text is saved from the canonical owner.',
        budget: { toolCalls: 1, tokens: 2_000 },
      },
      {
        id: 'compare-client-position',
        objective: `Compare client position ${revision}`,
        dependsOn: ['read-house-text'],
        requiredEvidenceDomains: ['client_context'],
        allowedCapabilities: ['search_memory'],
        effect: 'read',
        completionCondition: 'The comparison has current authorized evidence.',
        budget: { toolCalls: 1, tokens: 2_000 },
      },
      {
        id: 'prepare-follow-up',
        objective: `Prepare follow-up ${revision}`,
        dependsOn: ['compare-client-position'],
        requiredEvidenceDomains: ['internal_records'],
        allowedCapabilities: ['create_task'],
        effect: 'approval_required',
        completionCondition: 'A proposal receipt exists; no effect is claimed before observation.',
        budget: { toolCalls: 1, tokens: 2_000 },
      },
    ],
    clarifyingQuestions: [],
  };
}

function admitted() {
  const initialRun = run();
  return admitDurableResearchCoordinator({
    metadata: { run: initialRun, unrelatedProviderBudget: { future: true } },
    plan: plan(),
    objective: 'Assess the bill for the selected client',
    run: initialRun,
    now: new Date('2026-09-28T00:00:00.000Z'),
  });
}

describe('durable per-step research coordinator', () => {
  it('rejects a failure for a reserved step after a new goal revision is accepted', () => {
    const first = admitted();
    const reserved = reserveDurableResearchStep({
      metadata: first.metadata,
      run: run(),
      reservationId: 'old-goal-reservation',
      providerCallId: 'old-goal-call',
      kind: 'dispatch',
      tool: 'get_bill_status',
      toolVersion: `sha256:${'b'.repeat(64)}`,
      toolInput: { billId: 'hr-1' },
    });
    const steered = queueDurableResearchSteering({
      metadata: reserved.metadata,
      expectedGoalRevision: 0,
      requestId: 'new-direction',
      message: 'Focus on the Senate revision instead',
    });
    expect(() =>
      failDurableResearchStep({
        metadata: steered.metadata,
        run: steered.run,
        reservationId: 'old-goal-reservation',
        code: 'late_failure',
      }),
    ).toThrow('research_step_reservation_not_found');
    expect(steered.coordinator.steps[0]?.outcome).toBe('reserved');
  });

  it('persists the admitted DAG and enforces dependency order on the served tool boundary', () => {
    const first = admitted();
    const active = activateDurableResearchCoordinator({
      metadata: first.metadata,
      run: { ...run(), eventSequence: first.coordinator.events.at(-1)!.sequence },
      deadlineAt: '2026-09-28T00:30:00.000Z',
    });

    expect(() =>
      reserveDurableResearchStep({
        metadata: active.metadata,
        run: active.run,
        reservationId: 'reservation-wrong',
        providerCallId: 'call-wrong',
        kind: 'dispatch',
        tool: 'search_memory',
        toolVersion: `sha256:${'a'.repeat(64)}`,
        toolInput: { query: 'client position' },
        now: new Date('2026-09-28T00:01:00.000Z'),
      }),
    ).toThrow('research_step_capability_not_ready:read-house-text');

    const reserved = reserveDurableResearchStep({
      metadata: active.metadata,
      run: active.run,
      reservationId: 'reservation-house',
      providerCallId: 'call-house',
      kind: 'dispatch',
      tool: 'get_bill_status',
      toolVersion: `sha256:${'b'.repeat(64)}`,
      toolInput: { billId: 'hr-1' },
      now: new Date('2026-09-28T00:01:01.000Z'),
    });
    expect(reserved.step).toMatchObject({
      id: 'read-house-text',
      attempt: 1,
      outcome: 'reserved',
      leaseEpoch: 1,
    });
    expect(reserved.metadata).toMatchObject({ unrelatedProviderBudget: { future: true } });

    const completed = completeDurableResearchStep({
      metadata: reserved.metadata,
      run: reserved.run,
      reservationId: 'reservation-house',
      receiptId: 'receipt-house',
      resultRef: 'private-result-house',
      now: new Date('2026-09-28T00:01:02.000Z'),
    });
    const second = reserveDurableResearchStep({
      metadata: completed.metadata,
      run: completed.run,
      reservationId: 'reservation-client',
      providerCallId: 'call-client',
      kind: 'dispatch',
      tool: 'search_memory',
      toolVersion: `sha256:${'c'.repeat(64)}`,
      toolInput: { query: 'client position' },
      now: new Date('2026-09-28T00:01:03.000Z'),
    });
    expect(second.step.id).toBe('compare-client-position');
    expect(second.coordinator.steps[0]).toMatchObject({
      outcome: 'completed',
      resultRef: 'private-result-house',
      sourceRefs: ['receipt:receipt-house'],
    });
    expect(publicDurableResearchCoordinator(second.coordinator)).not.toHaveProperty(
      'steps.0.fingerprint',
    );
    expect(JSON.stringify(publicDurableResearchCoordinator(second.coordinator))).not.toContain(
      'private-result-house',
    );
  });

  it('re-reads a completed step while a later step is ready, and keeps first reads in order', () => {
    const first = admitted();
    const active = activateDurableResearchCoordinator({
      metadata: first.metadata,
      run: { ...run(), eventSequence: first.coordinator.events.at(-1)!.sequence },
      deadlineAt: '2026-09-28T00:30:00.000Z',
    });
    const reserved = reserveDurableResearchStep({
      metadata: active.metadata,
      run: active.run,
      reservationId: 'reservation-house',
      providerCallId: 'call-house',
      kind: 'dispatch',
      tool: 'get_bill_status',
      toolVersion: `sha256:${'b'.repeat(64)}`,
      toolInput: { billId: 'hr-1' },
      now: new Date('2026-09-28T00:01:00.000Z'),
    });
    const completed = completeDurableResearchStep({
      metadata: reserved.metadata,
      run: reserved.run,
      reservationId: 'reservation-house',
      receiptId: 'receipt-house',
      resultRef: 'private-result-house',
      now: new Date('2026-09-28T00:01:01.000Z'),
    });

    // 'compare-client-position' is now ready, yet another read for the completed
    // first step (a further source, or one a bounded child read first) proceeds.
    const reread = reserveDurableResearchStep({
      metadata: completed.metadata,
      run: completed.run,
      reservationId: 'reservation-house-2',
      providerCallId: 'call-house-2',
      kind: 'dispatch',
      tool: 'get_bill_status',
      toolVersion: `sha256:${'b'.repeat(64)}`,
      toolInput: { billId: 'hr-2' },
      now: new Date('2026-09-28T00:01:02.000Z'),
    });
    expect(reread.step).toMatchObject({ id: 'read-house-text', attempt: 2, outcome: 'reserved' });

    // A failed re-read restores the earlier completion; nothing downstream is lost.
    const failed = failDurableResearchStep({
      metadata: reread.metadata,
      run: reread.run,
      reservationId: 'reservation-house-2',
      code: 'owner_result_not_complete',
    });
    expect(failed.coordinator.steps[0]).toMatchObject({
      outcome: 'completed',
      resultRef: 'private-result-house',
      sourceRefs: ['receipt:receipt-house'],
    });

    // A tool whose step is not yet reachable is still refused at the boundary.
    const second = reserveDurableResearchStep({
      metadata: failed.metadata,
      run: failed.run,
      reservationId: 'reservation-client',
      providerCallId: 'call-client',
      kind: 'dispatch',
      tool: 'search_memory',
      toolVersion: `sha256:${'c'.repeat(64)}`,
      toolInput: { query: 'client position' },
      now: new Date('2026-09-28T00:01:03.000Z'),
    });
    expect(second.step.id).toBe('compare-client-position');
    expect(() =>
      reserveDurableResearchStep({
        metadata: second.metadata,
        run: second.run,
        reservationId: 'reservation-task',
        providerCallId: 'call-task',
        kind: 'dispatch',
        tool: 'create_task',
        toolVersion: `sha256:${'d'.repeat(64)}`,
        toolInput: { title: 'follow up' },
        now: new Date('2026-09-28T00:01:04.000Z'),
      }),
    ).toThrow();
  });

  it('never completes a logical failure and permits a new bounded attempt', () => {
    const first = admitted();
    const active = activateDurableResearchCoordinator({
      metadata: first.metadata,
      run: { ...run(), eventSequence: 1 },
      deadlineAt: '2026-09-28T00:30:00.000Z',
    });
    const reserved = reserveDurableResearchStep({
      metadata: active.metadata,
      run: active.run,
      reservationId: 'reservation-failed',
      providerCallId: 'call-failed',
      kind: 'dispatch',
      tool: 'get_bill_status',
      toolVersion: `sha256:${'b'.repeat(64)}`,
      toolInput: { billId: 'hr-1' },
      now: new Date('2026-09-28T00:01:00.000Z'),
    });
    const failed = failDurableResearchStep({
      metadata: reserved.metadata,
      run: reserved.run,
      reservationId: 'reservation-failed',
      code: 'logical_failure',
    });
    expect(failed.coordinator.steps[0]).toMatchObject({
      outcome: 'retryable_failure',
      completedAt: null,
      resultRef: null,
    });
    const retried = reserveDurableResearchStep({
      metadata: failed.metadata,
      run: failed.run,
      reservationId: 'reservation-retry',
      providerCallId: 'call-retry',
      kind: 'dispatch',
      tool: 'get_bill_status',
      toolVersion: `sha256:${'b'.repeat(64)}`,
      toolInput: { billId: 'hr-1' },
      now: new Date('2026-09-28T00:02:00.000Z'),
    });
    expect(retried.step).toMatchObject({ attempt: 2, outcome: 'reserved' });
  });

  it('queues steering once, rejects late old-revision work, and archives truthful prior effects', () => {
    const first = admitted();
    const queued = queueDurableResearchSteering({
      metadata: first.metadata,
      expectedGoalRevision: 0,
      requestId: 'steer-house-only',
      message: 'Use the House version only.',
      now: new Date('2026-09-28T00:02:00.000Z'),
    });
    const duplicate = queueDurableResearchSteering({
      metadata: queued.metadata,
      expectedGoalRevision: 0,
      requestId: 'steer-house-only',
      message: 'Use the House version only.',
    });
    expect(duplicate.idempotentReplay).toBe(true);
    expect(duplicate.receipt).toEqual(queued.receipt);
    expect(() =>
      reserveDurableResearchStep({
        metadata: queued.metadata,
        run: queued.run,
        reservationId: 'late-old-revision',
        providerCallId: 'late-old-revision',
        kind: 'dispatch',
        tool: 'get_bill_status',
        toolVersion: `sha256:${'b'.repeat(64)}`,
        toolInput: { billId: 's-1' },
      }),
    ).toThrow('research_goal_revision_changed');

    const replanned = applyDurableResearchReplan({
      metadata: queued.metadata,
      plan: plan(1),
      run: { ...queued.run, id: 'run-2', leaseEpoch: 2, status: 'running' },
      now: new Date('2026-09-28T00:03:00.000Z'),
    });
    expect(replanned.coordinator).toMatchObject({
      goalRevision: 1,
      planVersion: 2,
      appliedInboxSequence: 1,
      goal: { constraints: ['Use the House version only.'] },
    });
    expect(replanned.coordinator.steps.every((step) => step.goalRevision === 1)).toBe(true);
    expect(replanned.coordinator.stepHistory.every((step) => step.outcome === 'superseded')).toBe(
      true,
    );
  });

  it('recovers an old reserved safe read under a new lease but fences stale commits', () => {
    const first = admitted();
    const active = activateDurableResearchCoordinator({
      metadata: first.metadata,
      run: { ...run(), eventSequence: 1 },
      deadlineAt: '2026-09-28T00:30:00.000Z',
    });
    const reserved = reserveDurableResearchStep({
      metadata: active.metadata,
      run: active.run,
      reservationId: 'lost-worker-read',
      providerCallId: 'lost-worker-call',
      kind: 'dispatch',
      tool: 'get_bill_status',
      toolVersion: `sha256:${'b'.repeat(64)}`,
      toolInput: { billId: 'hr-1' },
      now: new Date('2026-09-28T00:01:00.000Z'),
    });
    const successorRun = { ...reserved.run, id: 'run-2', leaseEpoch: 2 };
    const recovered = activateDurableResearchCoordinator({
      metadata: { ...reserved.metadata, run: successorRun },
      run: successorRun,
      deadlineAt: '2026-09-28T00:30:00.000Z',
    });
    expect(recovered.coordinator.steps[0]).toMatchObject({
      outcome: 'pending',
      failureCode: 'worker_lost_before_commit',
    });
    expect(() =>
      completeDurableResearchStep({
        metadata: recovered.metadata,
        run: reserved.run,
        reservationId: 'lost-worker-read',
        receiptId: 'late',
        resultRef: 'late-result',
      }),
    ).toThrow('research_lease_inactive');
  });

  it('reclaims after an actual worker process is killed and rejects its stale commit', async () => {
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      const first = admitted();
      const active = activateDurableResearchCoordinator({
        metadata: first.metadata,
        run: { ...run(), eventSequence: 1 },
        deadlineAt: '2026-09-28T00:30:00.000Z',
      });
      const reserved = reserveDurableResearchStep({
        metadata: active.metadata,
        run: active.run,
        reservationId: `worker-${worker.pid}`,
        providerCallId: 'worker-call',
        kind: 'dispatch',
        tool: 'get_bill_status',
        toolVersion: `sha256:${'b'.repeat(64)}`,
        toolInput: { billId: 'hr-1' },
        now: new Date('2026-09-28T00:01:00.000Z'),
      });

      const exited = once(worker, 'exit');
      worker.kill('SIGKILL');
      await exited;

      const successorRun = { ...reserved.run, id: 'run-after-kill', leaseEpoch: 2 };
      const reclaimed = activateDurableResearchCoordinator({
        metadata: { ...reserved.metadata, run: successorRun },
        run: successorRun,
        deadlineAt: '2026-09-28T00:30:00.000Z',
      });
      expect(reclaimed.coordinator.steps[0]).toMatchObject({
        outcome: 'pending',
        failureCode: 'worker_lost_before_commit',
      });
      expect(() =>
        completeDurableResearchStep({
          metadata: reclaimed.metadata,
          run: reserved.run,
          reservationId: `worker-${worker.pid}`,
          receiptId: 'stale-worker-receipt',
          resultRef: 'stale-worker-result',
        }),
      ).toThrow('research_lease_inactive');
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) {
        const exited = once(worker, 'exit');
        worker.kill('SIGKILL');
        await exited;
      }
    }
  });

  it('persists cancel_requested before observed cancellation and retains completed effects', () => {
    const first = admitted();
    const requested = requestDurableResearchCancellation({
      metadata: first.metadata,
      requestId: 'stop-1',
      reason: 'User pressed Stop',
      now: new Date('2026-09-28T00:04:00.000Z'),
    });
    expect(requested.run.status).toBe('cancel_requested');
    expect(requested.coordinator.cancellation).toMatchObject({ state: 'requested' });
    const observed = observeDurableResearchCancellation({
      metadata: requested.metadata,
      now: new Date('2026-09-28T00:04:01.000Z'),
    });
    expect(observed.run.status).toBe('cancelled');
    expect(observed.coordinator.cancellation).toMatchObject({ state: 'observed' });
    expect(observed.coordinator.steps.every((step) => step.outcome === 'cancelled')).toBe(true);
  });
});
