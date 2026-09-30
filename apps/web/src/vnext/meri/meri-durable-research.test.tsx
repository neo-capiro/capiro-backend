import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  mergeMeriDurableResearchSnapshot,
  readMeriDurableResearchSnapshot,
  type MeriDurableResearchSnapshot,
} from '../../components/chat/meri-durable-research.js';

vi.mock('../../env.js', () => ({ config: { apiBaseUrl: 'https://api.test' } }));
import { useMeriDurableResearch } from './useMeriDurableResearch.js';

const headers = async () => ({ Authorization: 'Bearer current-request-token' });
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function snapshot(
  overrides: {
    sequence?: number;
    goalRevision?: number;
    planVersion?: number;
    leaseEpoch?: number;
    status?: NonNullable<MeriDurableResearchSnapshot['run']>['status'];
    runId?: string;
    cursorResetRequired?: true;
  } = {},
): MeriDurableResearchSnapshot {
  const sequence = overrides.sequence ?? 4;
  const goalRevision = overrides.goalRevision ?? 0;
  const leaseEpoch = overrides.leaseEpoch ?? 1;
  return {
    version: 1,
    researchId: 'research-1',
    run: {
      id: overrides.runId ?? 'run-1',
      leaseEpoch,
      eventSequence: sequence,
      phase: 'research',
      status: overrides.status ?? 'running',
      stage: 'Reading House bill text',
      startedAt: '2026-09-28T12:00:00.000Z',
      heartbeatAt: '2026-09-28T12:00:10.000Z',
    },
    coordinator: {
      version: 1,
      planVersion: overrides.planVersion ?? 1,
      goalRevision,
      goal: { objective: 'Assess the bill', constraints: [], deliverables: [] },
      deadlineAt: null,
      leaseEpoch,
      aggregateBudgetRef: 'researchToolBudget',
      cancellation: { state: 'none' },
      steps: [
        {
          id: `step-${goalRevision}`,
          objective: 'Read the authoritative bill',
          dependsOn: [],
          goalRevision,
          effect: 'safe_read',
          attempt: 1,
          deadlineAt: null,
          outcome: 'reserved',
          sourceRefs: [],
          operationRefs: [],
          leaseEpoch,
          completedAt: null,
          failureCode: null,
        },
      ],
    },
    events: [
      {
        version: 1,
        sequence,
        type: 'step_reserved',
        goalRevision,
        planVersion: overrides.planVersion ?? 1,
        stepId: `step-${goalRevision}`,
        createdAt: '2026-09-28T12:00:10.000Z',
      },
    ],
    nextSequence: sequence,
    ...(overrides.cursorResetRequired ? { cursorResetRequired: true as const } : {}),
  };
}

function HookWrapper({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('durable research snapshot ordering', () => {
  test('deduplicates repeated events and keeps ordered cursor progress', () => {
    const first = snapshot({ sequence: 4 });
    const duplicate = snapshot({ sequence: 4 });
    const next = snapshot({ sequence: 5 });
    const mergedDuplicate = mergeMeriDurableResearchSnapshot(first, duplicate);
    const mergedNext = mergeMeriDurableResearchSnapshot(mergedDuplicate, next);
    expect(mergedDuplicate.events.map((event) => event.sequence)).toEqual([4]);
    expect(mergedNext.events.map((event) => event.sequence)).toEqual([4, 5]);
    expect(mergedNext.nextSequence).toBe(5);
  });

  test('ignores reordered snapshots from an older event sequence or lease', () => {
    const current = snapshot({ sequence: 8, leaseEpoch: 3 });
    expect(
      mergeMeriDurableResearchSnapshot(current, snapshot({ sequence: 7, leaseEpoch: 3 })),
    ).toBe(current);
    expect(
      mergeMeriDurableResearchSnapshot(current, snapshot({ sequence: 20, leaseEpoch: 2 })),
    ).toBe(current);
  });

  test('late old-revision and post-terminal events cannot revive or regress the task', () => {
    const revised = snapshot({ sequence: 12, goalRevision: 2, planVersion: 3 });
    const oldRevision = snapshot({ sequence: 13, goalRevision: 1, planVersion: 2 });
    expect(mergeMeriDurableResearchSnapshot(revised, oldRevision)).toBe(revised);

    const completed = snapshot({
      sequence: 14,
      goalRevision: 2,
      planVersion: 3,
      status: 'complete',
    });
    const lateRunning = snapshot({
      sequence: 15,
      goalRevision: 2,
      planVersion: 3,
      status: 'running',
    });
    expect(mergeMeriDurableResearchSnapshot(completed, lateRunning)).toBe(completed);
  });

  test('accepts the actual terminal-without-run projection and rejects malformed public fields', () => {
    const terminal = { ...snapshot({ status: 'complete' }), run: null };
    expect(readMeriDurableResearchSnapshot(terminal)?.run).toBeNull();
    expect(
      readMeriDurableResearchSnapshot({
        ...terminal,
        coordinator: {
          ...terminal.coordinator,
          cancellation: { state: 'requested' },
        },
      }),
    ).toBeNull();
    expect(
      readMeriDurableResearchSnapshot({
        ...terminal,
        events: [{ ...terminal.events[0], type: 'provider_private_event' }],
      }),
    ).toBeNull();
  });

  test('applies an authoritative bounded cursor reset without replacing an existing sequence', () => {
    const previous = snapshot({ sequence: 205, goalRevision: 2, planVersion: 3 });
    previous.nextSequence = 999;
    previous.events = Array.from({ length: 205 }, (_, index) => ({
      ...previous.events[0]!,
      sequence: index + 1,
    }));
    const reset = snapshot({
      sequence: 205,
      goalRevision: 2,
      planVersion: 3,
      cursorResetRequired: true,
    });
    reset.events = previous.events.map((event) =>
      event.sequence === 205 ? { ...event, type: 'step_completed', goalRevision: 1 } : event,
    );
    const merged = mergeMeriDurableResearchSnapshot(previous, reset);
    expect(merged.nextSequence).toBe(205);
    expect(merged.events).toHaveLength(200);
    expect(merged.events[0]?.sequence).toBe(6);

    const reorderedDuplicate = snapshot({ sequence: 205, goalRevision: 2, planVersion: 3 });
    reorderedDuplicate.events = [
      { ...previous.events.at(-1)!, type: 'step_completed', goalRevision: 1 },
    ];
    const withoutReset = mergeMeriDurableResearchSnapshot(previous, reorderedDuplicate);
    expect(withoutReset.events.at(-1)?.type).toBe('step_reserved');
  });
});

describe('durable research observer interactions', () => {
  test('ignores a late manual refresh after account authority changes for the same research id', async () => {
    let finishOldRefresh!: (value: Response) => void;
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        reads += 1;
        if (reads === 2)
          return new Promise<Response>((resolve) => {
            finishOldRefresh = resolve;
          });
        return json(snapshot({ sequence: reads === 1 ? 4 : 5 }));
      }),
    );
    const nextHeaders = async () => ({ Authorization: 'Bearer another-account' });
    const hook = renderHook(({ auth }) => useMeriDurableResearch('research-1', auth, 60_000), {
      initialProps: { auth: headers },
    });
    await waitFor(() => expect(hook.result.current.snapshot?.nextSequence).toBe(4));
    let pending!: Promise<MeriDurableResearchSnapshot | null>;
    act(() => {
      pending = hook.result.current.refresh();
    });
    await waitFor(() => expect(reads).toBe(2));
    hook.rerender({ auth: nextHeaders });
    await waitFor(() => expect(hook.result.current.snapshot?.nextSequence).toBe(5));
    await act(async () => {
      finishOldRefresh(json(snapshot({ sequence: 99 })));
      expect(await pending).toBeNull();
    });
    expect(hook.result.current.snapshot?.nextSequence).toBe(5);
    hook.unmount();
  });

  test('mounting and reopening only observes the same research id and never auto-starts work', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET' });
        return json(snapshot());
      }),
    );

    const first = renderHook(() => useMeriDurableResearch('research-1', headers, 60_000), {
      wrapper: HookWrapper,
    });
    await waitFor(() => expect(first.result.current.snapshot?.researchId).toBe('research-1'));
    first.unmount();

    const reopened = renderHook(() => useMeriDurableResearch('research-1', headers, 60_000), {
      wrapper: HookWrapper,
    });
    await waitFor(() => expect(reopened.result.current.snapshot?.run?.id).toBe('run-1'));
    reopened.unmount();

    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    expect(calls.map((call) => new URL(call.url).searchParams.get('afterSequence'))).toEqual([
      '0',
      '0',
    ]);
    expect(calls.every((call) => call.url.includes('/research/research-1/coordinator'))).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/stream'))).toBe(false);
  });

  test('browser disconnect retries from the last ordered cursor without creating a duplicate run', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    let attempt = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET' });
        attempt += 1;
        if (attempt === 2) throw new TypeError('browser offline');
        return json(snapshot({ sequence: attempt >= 3 ? 5 : 4 }));
      }),
    );

    const view = renderHook(() => useMeriDurableResearch('research-1', headers, 5), {
      wrapper: HookWrapper,
    });
    await waitFor(() => expect(view.result.current.snapshot?.nextSequence).toBe(5), {
      timeout: 1_000,
    });
    view.unmount();

    expect(
      calls.slice(0, 3).map((call) => new URL(call.url).searchParams.get('afterSequence')),
    ).toEqual(['0', '4', '4']);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    expect(calls.every((call) => call.url.includes('research-1'))).toBe(true);
  });

  test('a lost steering response retries the identical idempotency request only after explicit Send', async () => {
    const posted: Array<Record<string, unknown>> = [];
    let postAttempt = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'GET') return json(snapshot());
        postAttempt += 1;
        posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (postAttempt === 1) throw new TypeError('response lost');
        return json({
          version: 1,
          accepted: true,
          idempotentReplay: true,
          receipt: {
            version: 1,
            requestId: posted[0]?.requestId,
            sequence: 5,
            previousGoalRevision: 0,
            goalRevision: 1,
            message: 'House version only',
            acceptedAt: '2026-09-28T12:05:00.000Z',
            state: 'pending_safe_boundary',
            appliedAt: null,
          },
        });
      }),
    );

    const view = renderHook(() => useMeriDurableResearch('research-1', headers, 60_000), {
      wrapper: HookWrapper,
    });
    await waitFor(() => expect(view.result.current.snapshot).not.toBeNull());
    await act(async () => {
      expect(await view.result.current.sendSteering('House version only')).toBe(false);
    });
    expect(posted).toHaveLength(1);
    expect(view.result.current.steeringTransportUncertain).toBe(true);

    await act(async () => {
      expect(await view.result.current.sendSteering('House version only')).toBe(true);
    });
    expect(posted).toHaveLength(2);
    expect(posted[1]).toEqual(posted[0]);
    expect(view.result.current.acceptedDirection?.goalRevision).toBe(1);
    view.unmount();
  });

  test('stale expected revision refreshes authority and never silently resubmits', async () => {
    let revision = 0;
    let posts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posts += 1;
          revision = 2;
          return json({ version: 1, currentGoalRevision: 2 }, 409);
        }
        return json(
          snapshot({
            sequence: revision ? 8 : 4,
            goalRevision: revision,
            planVersion: revision + 1,
          }),
        );
      }),
    );

    const view = renderHook(() => useMeriDurableResearch('research-1', headers, 60_000), {
      wrapper: HookWrapper,
    });
    await waitFor(() => expect(view.result.current.snapshot?.coordinator.goalRevision).toBe(0));
    await act(async () => {
      expect(await view.result.current.sendSteering('Change the deliverable')).toBe(false);
    });
    expect(posts).toBe(1);
    expect(view.result.current.snapshot?.coordinator.goalRevision).toBe(2);
    expect(view.result.current.steeringConflictRevision).toBe(2);
    view.unmount();
  });

  test('current authorization failure clears the private coordinator display', async () => {
    let allowed = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => (allowed ? json(snapshot()) : json({ message: 'Forbidden' }, 403))),
    );
    const view = renderHook(() => useMeriDurableResearch('research-1', headers, 5), {
      wrapper: HookWrapper,
    });
    await waitFor(() => expect(view.result.current.snapshot).not.toBeNull());
    allowed = false;
    await waitFor(() => expect(view.result.current.snapshot).toBeNull(), { timeout: 1_000 });
    expect(view.result.current.error).toContain('current account scope');
    view.unmount();
  });
});
