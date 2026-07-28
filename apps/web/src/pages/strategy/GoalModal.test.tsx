/*
 * Phase 5 §7 — the Goal flow's typed-422 unable-to-draft path: no navigation
 * (no strategy exists yet), the specific required inputs render inline in
 * THIS SAME flow, the existing attachment control stays available, entered
 * data survives, and a successful draft only ever calls onCreated with the
 * server's final id — never speculatively.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { App } from 'antd';

const draftMutateAsync = vi.fn();
const createMutateAsync = vi.fn();

vi.mock('./api.js', () => ({
  useCreateStrategy: () => ({ mutateAsync: createMutateAsync, isPending: false }),
  useDraftStrategy: () => ({ mutateAsync: draftMutateAsync, isPending: false }),
  useUploadAttachment: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@clerk/clerk-react', () => ({ useUser: () => ({ user: { id: 'user-1' } }) }));
vi.mock('./members.js', () => ({
  useTenantMembers: () => ({ data: [], isLoading: false }),
  memberName: () => 'Neo Martinez',
  initialsOf: () => 'NM',
}));

import { GoalModal } from './GoalModal.js';

const clients = [{ id: 'client-1', name: 'Brightdefense' }];

function renderModal(onCreated = vi.fn()) {
  const onClose = vi.fn();
  render(
    <App>
      <GoalModal clients={clients} meriEnabled onClose={onClose} onCreated={onCreated} />
    </App>,
  );
  return { onClose, onCreated };
}

function selectClient() {
  const clientSelect = screen.getAllByRole('combobox')[0]!;
  fireEvent.change(clientSelect, { target: { value: 'client-1' } });
}

function setGoal(text: string) {
  fireEvent.change(screen.getByPlaceholderText(/Secure a \$14M/), { target: { value: text } });
}

function clickDraft() {
  fireEvent.click(screen.getByRole('button', { name: /Draft with Meri/i }));
}

beforeEach(() => {
  draftMutateAsync.mockReset();
  createMutateAsync.mockReset();
});

describe('GoalModal — Phase 5 unable-to-draft flow', () => {
  test('a typed 422 stays in the Goal flow, lists the specific required inputs, and never navigates (§9.1)', async () => {
    draftMutateAsync.mockRejectedValueOnce({
      response: {
        status: 422,
        data: {
          code: 'STRATEGY_DRAFT_INPUT_REQUIRED',
          message: 'Meri needs a little more information before it can build this timeline.',
          requiredInputs: [
            {
              code: 'more-detail',
              label: 'more detail in your goal, or a document for Meri to work from',
              canAttach: true,
            },
          ],
        },
      },
    });
    const { onCreated } = renderModal();
    selectClient();
    setGoal('Win the plus-up');
    clickDraft();

    await waitFor(() => expect(screen.getByTestId('sp-goal-draft-error')).toBeTruthy());
    expect(
      screen.getByText('Meri needs a little more information before it can build this timeline.'),
    ).toBeTruthy();
    expect(screen.getByText(/more detail in your goal/i)).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
  });

  test('the existing attachment control remains available in the same flow after a 422 — no new page (§9.2)', async () => {
    draftMutateAsync.mockRejectedValueOnce({
      response: { status: 422, data: { code: 'STRATEGY_DRAFT_INVALID', message: 'x', requiredInputs: [] } },
    });
    renderModal();
    selectClient();
    setGoal('Win the plus-up');
    clickDraft();

    await waitFor(() => expect(screen.getByTestId('sp-goal-draft-error')).toBeTruthy());
    expect(screen.getByText(/Attach memos, bill text, or prior plans/i)).toBeTruthy();
    // Still the Goal modal itself — the client/goal fields are still present.
    expect(screen.getByPlaceholderText(/Secure a \$14M/)).toBeTruthy();
  });

  test('the entered goal and selected client survive a failed draft (§9.3)', async () => {
    draftMutateAsync.mockRejectedValueOnce({
      response: { status: 422, data: { code: 'STRATEGY_DRAFT_INVALID', message: 'x', requiredInputs: [] } },
    });
    renderModal();
    selectClient();
    setGoal('Win the plus-up');
    clickDraft();

    await waitFor(() => expect(screen.getByTestId('sp-goal-draft-error')).toBeTruthy());
    expect((screen.getByPlaceholderText(/Secure a \$14M/) as HTMLTextAreaElement).value).toBe(
      'Win the plus-up',
    );
    const clientSelect = (screen.getAllByRole('combobox') as HTMLSelectElement[])[0]!;
    expect(clientSelect.value).toBe('client-1');
  });

  test('retrying after a 422 is allowed — a second attempt clears the prior error and can succeed', async () => {
    draftMutateAsync
      .mockRejectedValueOnce({
        response: { status: 422, data: { code: 'STRATEGY_DRAFT_INVALID', message: 'x', requiredInputs: [] } },
      })
      .mockResolvedValueOnce({ id: 'strat-99' });
    const { onCreated } = renderModal();
    selectClient();
    setGoal('Win the plus-up');
    clickDraft();
    await waitFor(() => expect(screen.getByTestId('sp-goal-draft-error')).toBeTruthy());

    clickDraft();
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('strat-99'));
    expect(screen.queryByTestId('sp-goal-draft-error')).toBeNull();
  });

  test('a successful draft calls onCreated with the server id — the timeline route loads only after that (§9.10)', async () => {
    draftMutateAsync.mockResolvedValueOnce({ id: 'strat-42' });
    const { onCreated } = renderModal();
    selectClient();
    setGoal('Win the plus-up');
    clickDraft();

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('strat-42'));
  });

  test('an untyped/unexpected draft failure (not a typed 422) shows a generic message and never navigates', async () => {
    draftMutateAsync.mockRejectedValueOnce(new Error('network blip'));
    const { onCreated } = renderModal();
    selectClient();
    setGoal('Win the plus-up');
    clickDraft();

    await screen.findByText(/Meri could not draft a plan just now/i);
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.queryByTestId('sp-goal-draft-error')).toBeNull();
  });
});
