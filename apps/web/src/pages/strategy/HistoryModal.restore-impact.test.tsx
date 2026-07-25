/*
 * P0-1 web contract: restoring a version must DISCLOSE its impact first.
 *
 * The audited defect had two halves. The server half destroyed operational
 * history; the UI half was that the only thing standing between a user and that
 * destruction was a one-line confirm reading "The current plan will be replaced."
 * Fixing the server without fixing the disclosure would leave users unable to see
 * what they were authorising, so these tests pin the UI half:
 *
 *   - Restore opens the IMPACT PREVIEW, and does not mutate anything on click;
 *   - the preview names what leaves the plan, what comes back, and the artifacts
 *     and in-flight runs affected;
 *   - it states the non-destructive guarantee (0 artifacts deleted);
 *   - the audit's three controls exist: Restore as new version / View changes / Cancel;
 *   - "View changes" reveals the per-step detail;
 *   - Cancel restores nothing;
 *   - confirming calls the restore mutation with the chosen version;
 *   - a failed preview fetch DISABLES the restore button (never a blind restore);
 *   - steps a past restore archived stay discoverable under "Detached steps".
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from 'antd';
import type { DetachedSurface, RestoreImpact, VersionsPage } from './types.js';

const idle = { isLoading: false, isError: false, isSuccess: true, error: null };

const restoreMutate = vi.fn();
let impactState: { data: RestoreImpact | undefined; isLoading: boolean; isError: boolean };
let detachedData: DetachedSurface;

const versionsPage: VersionsPage = {
  items: [
    {
      id: 'v-head',
      authorKind: 'person',
      authorUserId: 'u1',
      note: 'Updated strategy details',
      restoredFromVersionId: null,
      createdAt: '2026-07-24T12:00:00.000Z',
    },
    {
      id: 'v-older',
      authorKind: 'person',
      authorUserId: 'u1',
      note: 'Added Secure HASC support',
      restoredFromVersionId: null,
      createdAt: '2026-07-20T12:00:00.000Z',
    },
  ],
  nextCursor: null,
};

// members.js (imported by HistoryModal for author names) pulls in useApi ->
// api-client -> env.ts, which throws without a runtime Clerk config. Stub the
// module so this test exercises the component, not app bootstrap.
vi.mock('../../lib/use-api.js', () => ({ useApi: () => ({}) }));

vi.mock('./api.js', () => ({
  useVersions: () => ({
    ...idle,
    data: [versionsPage],
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }),
  useRestoreVersion: () => ({ mutate: restoreMutate, isPending: false }),
  useDetachedSurface: () => ({ ...idle, data: detachedData }),
  useRestoreImpact: () => ({ ...idle, ...impactState }),
}));

import { HistoryModal } from './HistoryModal.js';

function impact(overrides: Partial<RestoreImpact> = {}): RestoreImpact {
  return {
    versionId: 'v-older',
    versionNote: 'Added Secure HASC support',
    versionCreatedAt: '2026-07-20T12:00:00.000Z',
    versionAuthorKind: 'person',
    versionAuthorUserId: 'u1',
    noOp: false,
    nodes: {
      added: [
        {
          id: 'n-add',
          title: 'File the reprogramming request',
          kind: 'action',
          subject: 'submission',
        },
      ],
      revived: [],
      changed: [
        {
          id: 'n-chg',
          title: 'Brief the SAC-D staff',
          kind: 'action',
          subject: 'member',
          changedFields: ['startsOn', 'ownerUserId'],
        },
      ],
      removed: [
        { id: 'n-rm', title: 'Draft the coalition letter', kind: 'action', subject: 'deliverable' },
      ],
      unchangedCount: 7,
    },
    artifacts: {
      workspaceDraftsAffected: 1,
      outreachRecordsAffected: 2,
      detaching: [
        { nodeId: 'n-rm', artifactType: 'workspace_draft', artifactRef: 'ws-1' },
        { nodeId: 'n-rm', artifactType: 'outreach_record', artifactRef: 'or-1' },
        { nodeId: 'n-rm', artifactType: 'outreach_record', artifactRef: 'or-2' },
      ],
      reattaching: [],
      deleted: 0,
    },
    runs: {
      active: [{ id: 'r-1', state: 'waiting_for_input', nodeId: 'n-rm' }],
      activeCount: 1,
      historicalCount: 3,
    },
    provenance: {
      nodesArchivedWithProvenance: 1,
      snapshotCarriesProvenance: true,
      nodesReCreatedWithoutProvenance: 1,
    },
    ...overrides,
  };
}

function renderModal() {
  return render(
    <App>
      <HistoryModal strategyId="strat-1" members={[]} onClose={vi.fn()} onRestored={vi.fn()} />
    </App>,
  );
}

/** Click the Restore button on the (only) non-current version row. */
function openPreview() {
  fireEvent.click(screen.getByRole('button', { name: /^Restore$/ }));
}

beforeEach(() => {
  restoreMutate.mockReset();
  impactState = { data: impact(), isLoading: false, isError: false };
  detachedData = { nodes: [], artifacts: [] };
});

describe('HistoryModal restore → impact preview (P0-1)', () => {
  test('clicking Restore opens the impact preview and mutates NOTHING', () => {
    renderModal();
    openPreview();

    // The preview's own subtitle (the title text also appears on the confirm button).
    expect(screen.getByText(/Restoring the version from/)).toBeTruthy();
    // The destructive one-liner this replaced must be gone.
    expect(screen.queryByText(/The current plan will be replaced/)).toBeNull();
    expect(restoreMutate).not.toHaveBeenCalled();
  });

  test('the preview quantifies archived / re-created / changed steps', () => {
    renderModal();
    openPreview();

    for (const label of ['Steps archived', 'Steps restored', 'Steps revived', 'Steps changed']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText('Steps unchanged')).toBeTruthy();
  });

  test('states the non-destructive guarantee: zero artifacts deleted', () => {
    renderModal();
    openPreview();
    expect(screen.getByText('Artifacts deleted')).toBeTruthy();
  });

  test('warns about the Workspace drafts and Outreach records that go historical', () => {
    renderModal();
    openPreview();
    expect(
      screen.getByText(/1 Workspace draft and 2 Outreach records become historical/),
    ).toBeTruthy();
    expect(screen.getByText(/not deleted/)).toBeTruthy();
  });

  test('warns about an in-flight run that references a step being archived', () => {
    renderModal();
    openPreview();
    expect(screen.getByText(/1 in-flight execution/)).toBeTruthy();
  });

  test('offers exactly the audit-required controls', () => {
    renderModal();
    openPreview();
    expect(screen.getByRole('button', { name: /Restore as new version/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /View changes/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Cancel$/ })).toBeTruthy();
  });

  test('"View changes" reveals the per-step detail', () => {
    renderModal();
    openPreview();
    expect(screen.queryByText('Draft the coalition letter')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /View changes/ }));

    expect(screen.getByText(/Draft the coalition letter/)).toBeTruthy();
    expect(screen.getByText(/File the reprogramming request/)).toBeTruthy();
    // Changed fields are named in human terms, not raw column names.
    expect(screen.getByText(/reverts start date, owner/)).toBeTruthy();
  });

  test('Cancel closes the preview without restoring', () => {
    renderModal();
    openPreview();
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));

    expect(screen.queryByRole('button', { name: /Restore as new version/ })).toBeNull();
    expect(restoreMutate).not.toHaveBeenCalled();
  });

  test('confirming restores the version the user picked', () => {
    renderModal();
    openPreview();
    fireEvent.click(screen.getByRole('button', { name: /Restore as new version/ }));

    expect(restoreMutate).toHaveBeenCalledTimes(1);
    expect(restoreMutate.mock.calls[0]![0]).toBe('v-older');
  });

  test('a no-op restore is called out as changing nothing', () => {
    impactState = {
      data: impact({
        noOp: true,
        nodes: { added: [], revived: [], changed: [], removed: [], unchangedCount: 9 },
      }),
      isLoading: false,
      isError: false,
    };
    renderModal();
    openPreview();
    expect(screen.getByText(/would change nothing/)).toBeTruthy();
  });

  test('a failed preview fetch DISABLES restore — never a blind restore', () => {
    impactState = { data: undefined, isLoading: false, isError: true };
    renderModal();
    openPreview();

    const btn = screen.getByRole('button', { name: /Restore as new version/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(btn);
    expect(restoreMutate).not.toHaveBeenCalled();
  });
});

describe('HistoryModal detached surface (P0-1)', () => {
  test('is absent when no step has been archived', () => {
    renderModal();
    expect(screen.queryByText(/Detached steps/)).toBeNull();
  });

  test('lists archived steps and the staged work still attached to them', () => {
    detachedData = {
      nodes: [
        {
          id: 'n-rm',
          strategyId: 'strat-1',
          kind: 'action',
          subject: 'deliverable',
          title: 'Draft the coalition letter',
          note: null,
          ownerUserId: 'u1',
          status: 'in_progress',
          startsOn: '2026-07-01',
          endsOn: null,
          openEnded: false,
          dependsOnIds: [],
          provenance: null,
          targetRef: null,
          meriAuthored: false,
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-25T00:00:00.000Z',
          archivedAt: '2026-07-25T00:00:00.000Z',
          archivedByUserId: 'u1',
          archivedReason: 'Archived by restore of the Jul 20, 2026 version',
        },
      ],
      artifacts: [
        {
          id: 'a-1',
          strategyId: 'strat-1',
          nodeId: 'n-rm',
          artifactType: 'workspace_draft',
          artifactRef: 'ws-1',
          createdAt: '2026-07-02T00:00:00.000Z',
          detachedAt: '2026-07-25T00:00:00.000Z',
          detachedReason: 'Archived by restore of the Jul 20, 2026 version',
        },
      ],
    };
    renderModal();

    const toggle = screen.getByText('Detached steps (1)');
    expect(toggle).toBeTruthy();
    // Collapsed by default — this is history, not the working plan.
    expect(screen.queryByText('Draft the coalition letter')).toBeNull();

    fireEvent.click(toggle);

    expect(screen.getByText('Draft the coalition letter')).toBeTruthy();
    expect(screen.getByText('Workspace draft')).toBeTruthy();
  });
});
