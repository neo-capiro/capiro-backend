import { describe, expect, it } from '@jest/globals';
import { PENDING_ARTIFACT_REF } from './artifact-ref.js';
import {
  MAX_RECONCILE_ATTEMPTS,
  detectRecovery,
  needsHuman,
  repairFor,
  type RecoveryInput,
} from './run-recovery.js';

/*
 * P0-2 reconciliation rules. These are the detections the audit's reconciliation
 * job is required to make, tested against plain row shapes so each one is pinned
 * independently of any DB.
 *
 * The two that matter most for safety:
 *  - ARTIFACT_NOT_ADVANCED is auto-repairable (the artifact is provably there),
 *  - RESERVATION_WITHOUT_ARTIFACT is NEVER auto-repaired (the artifact may or may
 *    not exist upstream and the create-only artifact client cannot ask).
 * A regression that flipped the second into an auto repair would either duplicate
 * an external document or silently discard a real one.
 */

const T0 = Date.parse('2026-07-25T12:00:00.000Z');
const minsAgo = (n: number) => new Date(T0 - n * 60_000);

function input(overrides: Partial<RecoveryInput> = {}): RecoveryInput {
  return {
    run: {
      id: 'r1',
      state: 'executing',
      heartbeatAt: minsAgo(1),
      startedAt: minsAgo(5),
      createdAt: minsAgo(5),
      reconcileAttempts: 0,
    },
    execution: { kind: 'workspace', nodeId: 'n1', pinnedVersionId: null },
    hasApproval: false,
    artifacts: [],
    headVersionId: 'v-head',
    nodeLive: true,
    nodeHasTarget: true,
    nowMs: T0,
    ...overrides,
  };
}

const codes = (i: RecoveryInput) => detectRecovery(i).map((f) => f.code);

describe('detectRecovery — healthy runs', () => {
  it('finds nothing wrong with a freshly-heartbeating executing run', () => {
    expect(detectRecovery(input())).toEqual([]);
  });

  it('finds nothing wrong with a completed run that has its artifact', () => {
    expect(
      detectRecovery(
        input({
          run: { ...input().run, state: 'completed' },
          artifacts: [{ artifactType: 'workspace_draft', artifactRef: 'ws-1', detachedAt: null }],
        }),
      ),
    ).toEqual([]);
  });

  it('ignores a check run (no execution intent) entirely', () => {
    expect(
      detectRecovery(
        input({ execution: null, run: { ...input().run, state: 'ready_for_review' } }),
      ),
    ).toEqual([]);
  });
});

describe('detectRecovery — (1) inactive beyond the threshold', () => {
  it('strands an executing run whose heartbeat is stale, and offers failed_recoverable', () => {
    const findings = detectRecovery(input({ run: { ...input().run, heartbeatAt: minsAgo(30) } }));
    const f = findings.find((x) => x.code === 'STRANDED_NO_HEARTBEAT')!;
    expect(f.severity).toBe('auto');
    expect(f.transition).toEqual({
      to: 'failed_recoverable',
      reason: expect.stringContaining('no agent progress'),
    });
    expect(f.detail).toMatch(/recoverable/i);
  });

  it('falls back to startedAt then createdAt so pre-P0-2 runs (no heartbeat) are still detected', () => {
    // heartbeatAt NULL is the entire population of already-stuck runs at rollout.
    expect(
      codes(input({ run: { ...input().run, heartbeatAt: null, startedAt: minsAgo(40) } })),
    ).toContain('STRANDED_NO_HEARTBEAT');
    expect(
      codes(
        input({
          run: { ...input().run, heartbeatAt: null, startedAt: null, createdAt: minsAgo(40) },
        }),
      ),
    ).toContain('STRANDED_NO_HEARTBEAT');
  });

  it('does NOT strand a run parked on a human, however old', () => {
    expect(
      codes(
        input({
          run: { ...input().run, state: 'waiting_for_input', heartbeatAt: minsAgo(60 * 24 * 14) },
        }),
      ),
    ).not.toContain('STRANDED_NO_HEARTBEAT');
  });

  it('does NOT strand a stale run whose artifact provably exists — that is an advance, not a failure', () => {
    const findings = codes(
      input({
        run: { ...input().run, heartbeatAt: minsAgo(60) },
        artifacts: [{ artifactType: 'workspace_draft', artifactRef: 'ws-1', detachedAt: null }],
      }),
    );
    expect(findings).not.toContain('STRANDED_NO_HEARTBEAT');
    expect(findings).toContain('ARTIFACT_NOT_ADVANCED');
  });
});

describe('detectRecovery — (2)/(3) surviving staging reservation', () => {
  const reserved = input({
    artifacts: [
      { artifactType: 'workspace_draft', artifactRef: PENDING_ARTIFACT_REF, detachedAt: null },
    ],
  });

  it('detects it', () => {
    expect(codes(reserved)).toContain('RESERVATION_WITHOUT_ARTIFACT');
  });

  it('is NEVER auto-repairable — the artifact may or may not exist upstream', () => {
    const f = detectRecovery(reserved).find((x) => x.code === 'RESERVATION_WITHOUT_ARTIFACT')!;
    expect(f.severity).toBe('human');
    expect(f.transition).toBeNull();
  });

  it('offers both operator resolutions (adopt / release)', () => {
    const f = detectRecovery(reserved).find((x) => x.code === 'RESERVATION_WITHOUT_ARTIFACT')!;
    expect(f.resolutions).toHaveLength(2);
    expect(f.resolutions!.join(' ')).toMatch(/adopt/i);
    expect(f.resolutions!.join(' ')).toMatch(/release/i);
  });

  it('escalates to a human rather than being repaired', () => {
    const findings = detectRecovery(reserved);
    expect(repairFor(findings, 0)).toBeNull();
    expect(needsHuman(findings, 0)).toBe(true);
  });

  it('a sentinel does not count as a real artifact for the advance rule', () => {
    expect(codes(reserved)).not.toContain('ARTIFACT_NOT_ADVANCED');
  });
});

describe('detectRecovery — (4) artifact created but the run never advanced', () => {
  it('offers `staged` for an executing run whose artifact is linked', () => {
    const f = detectRecovery(
      input({
        artifacts: [{ artifactType: 'workspace_draft', artifactRef: 'ws-1', detachedAt: null }],
      }),
    ).find((x) => x.code === 'ARTIFACT_NOT_ADVANCED')!;
    expect(f.severity).toBe('auto');
    expect(f.transition!.to).toBe('staged');
    // The user must be told nothing was sent.
    expect(f.detail).toMatch(/Nothing was sent/i);
  });

  it('applies to a run already parked or recoverable-failed (the real stranded shapes)', () => {
    for (const state of ['waiting_for_input', 'failed_recoverable']) {
      expect(
        codes(
          input({
            run: { ...input().run, state },
            artifacts: [{ artifactType: 'workspace_draft', artifactRef: 'ws-1', detachedAt: null }],
          }),
        ),
      ).toContain('ARTIFACT_NOT_ADVANCED');
    }
  });

  it('matches the artifact type to the run KIND, not just any artifact on the node', () => {
    // An outreach run must not be advanced by the node's Workspace draft.
    expect(
      codes(
        input({
          execution: { kind: 'outreach', nodeId: 'n1', pinnedVersionId: null },
          artifacts: [{ artifactType: 'workspace_draft', artifactRef: 'ws-1', detachedAt: null }],
        }),
      ),
    ).not.toContain('ARTIFACT_NOT_ADVANCED');
  });

  it('names the right artifact kind in the message', () => {
    const f = detectRecovery(
      input({
        execution: { kind: 'outreach', nodeId: 'n1', pinnedVersionId: null },
        artifacts: [{ artifactType: 'outreach_record', artifactRef: 'or-1', detachedAt: null }],
      }),
    ).find((x) => x.code === 'ARTIFACT_NOT_ADVANCED')!;
    expect(f.detail).toMatch(/Outreach record/);
  });
});

describe('detectRecovery — (5) finished with no artifact', () => {
  it('escalates a completed run with nothing to show for it', () => {
    const findings = detectRecovery(input({ run: { ...input().run, state: 'completed' } }));
    const f = findings.find((x) => x.code === 'COMPLETED_WITHOUT_ARTIFACT')!;
    expect(f.severity).toBe('human');
    expect(f.transition).toBeNull();
    expect(needsHuman(findings, 0)).toBe(true);
  });

  it('applies to a staged run too', () => {
    expect(codes(input({ run: { ...input().run, state: 'staged' } }))).toContain(
      'COMPLETED_WITHOUT_ARTIFACT',
    );
  });
});

describe('detectRecovery — (7) target missing', () => {
  it('escalates an outreach run whose step lost its target', () => {
    const f = detectRecovery(
      input({
        execution: { kind: 'outreach', nodeId: 'n1', pinnedVersionId: null },
        nodeHasTarget: false,
      }),
    ).find((x) => x.code === 'TARGET_MISSING')!;
    expect(f.severity).toBe('human');
    expect(f.detail).toMatch(/Nothing was sent/i);
  });

  it('does not apply to a workspace run (no recipient involved)', () => {
    expect(codes(input({ nodeHasTarget: false }))).not.toContain('TARGET_MISSING');
  });
});

describe('detectRecovery — (8) version drift after approval', () => {
  const drifted = input({
    run: { ...input().run, state: 'approved' },
    hasApproval: true,
    execution: { kind: 'outreach', nodeId: 'n1', pinnedVersionId: 'v-old' },
    headVersionId: 'v-head',
  });

  it('parks an approved run whose plan moved', () => {
    const f = detectRecovery(drifted).find((x) => x.code === 'VERSION_DRIFT')!;
    expect(f.severity).toBe('auto');
    expect(f.transition).toEqual({
      to: 'waiting_for_input',
      reason: expect.stringContaining('plan changed since approval'),
    });
  });

  it('does not fire without an approval to invalidate', () => {
    expect(codes({ ...drifted, hasApproval: false })).not.toContain('VERSION_DRIFT');
  });

  it('does not fire when the pinned version still matches the head', () => {
    expect(
      codes({
        ...drifted,
        execution: { kind: 'outreach', nodeId: 'n1', pinnedVersionId: 'v-head' },
      }),
    ).not.toContain('VERSION_DRIFT');
  });

  it('does not fire when the head cannot be resolved (never guess drift)', () => {
    expect(codes({ ...drifted, headVersionId: null })).not.toContain('VERSION_DRIFT');
  });
});

describe('detectRecovery — P0-1 interaction: the step left the live plan', () => {
  it('terminally fails a run whose node was archived by a restore', () => {
    const f = detectRecovery(input({ nodeLive: false })).find((x) => x.code === 'NODE_NOT_LIVE')!;
    expect(f.severity).toBe('auto');
    expect(f.transition!.to).toBe('failed_terminal');
    expect(f.detail).toMatch(/version restore/i);
  });

  it('leaves an already-terminal run alone', () => {
    expect(
      codes(input({ nodeLive: false, run: { ...input().run, state: 'completed' } })),
    ).not.toContain('NODE_NOT_LIVE');
  });

  it('takes precedence over advancing: a dead step is not staged', () => {
    // Ordering matters — repairFor applies the FIRST auto finding.
    const findings = detectRecovery(
      input({
        nodeLive: false,
        artifacts: [{ artifactType: 'workspace_draft', artifactRef: 'ws-1', detachedAt: null }],
      }),
    );
    expect(repairFor(findings, 0)!.code).toBe('NODE_NOT_LIVE');
  });
});

describe('repairFor / needsHuman — the loop-breaker', () => {
  const strandedInput = input({ run: { ...input().run, heartbeatAt: minsAgo(30) } });

  it('applies at most ONE repair per pass', () => {
    const findings = detectRecovery(strandedInput);
    const repair = repairFor(findings, 0);
    expect(repair).not.toBeNull();
    expect(repair!.severity).toBe('auto');
  });

  it('stops repairing once a run has burned its attempt budget, and escalates instead', () => {
    const findings = detectRecovery(strandedInput);
    expect(repairFor(findings, MAX_RECONCILE_ATTEMPTS - 1)).not.toBeNull();
    expect(repairFor(findings, MAX_RECONCILE_ATTEMPTS)).toBeNull();
    expect(needsHuman(findings, MAX_RECONCILE_ATTEMPTS)).toBe(true);
  });

  it('a clean run never needs a human', () => {
    expect(needsHuman([], 0)).toBe(false);
    expect(needsHuman([], MAX_RECONCILE_ATTEMPTS)).toBe(false);
  });
});
