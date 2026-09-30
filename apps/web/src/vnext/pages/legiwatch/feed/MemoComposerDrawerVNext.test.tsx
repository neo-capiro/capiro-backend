import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const controller = vi.fn();
vi.mock('../../../../pages/clients/tracker/MemoComposerController.js', () => ({
  MEMO_REPLACEMENT_NOTICE: 'Replacing this filed memo loses the current version.',
  useMemoComposerController: (...args: unknown[]) => controller(...args),
}));
vi.mock('../../../components/feedback/toast.js', () => ({
  useCapiroToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
import { MemoComposerDrawer } from './MemoComposerDrawerVNext.js';

const props = {
  open: true,
  onClose: vi.fn(),
  clientId: 'owner-a',
  clientName: 'A',
  item: { id: 'alert-a' } as never,
};
function state(overrides: Record<string, unknown> = {}) {
  return {
    memo: null,
    markdown: 'Saved content',
    setMarkdown: vi.fn(),
    attachmentId: 'doc-a',
    dirty: false,
    setDirty: vi.fn(),
    linkFailed: null,
    existingLoaded: true,
    held: false,
    blockedNoReviewer: false,
    confirmAndRegenerate: vi.fn(),
    onSave: vi.fn(),
    retryLink: vi.fn(),
    busy: false,
    generate: { isPending: false },
    save: { isPending: false },
    recordLink: { isPending: false },
    openInWorkspace: { mutate: vi.fn(), isPending: false },
    navigate: vi.fn(),
    ...overrides,
  };
}
afterEach(() => {
  vi.clearAllMocks();
  document.body.style.overflow = '';
});
describe('native memo composer presentation', () => {
  it('keeps saved-content editing, link retry, and filing actions bound to the controller', () => {
    const model = state({ linkFailed: { attachmentId: 'doc-a', title: 'Memo' } });
    controller.mockReturnValue(model);
    render(<MemoComposerDrawer {...props} />);
    expect(screen.getByText('Loaded from Documents')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Memo text' }), {
      target: { value: 'Edited' },
    });
    expect(model.setMarkdown).toHaveBeenCalledWith('Edited');
    fireEvent.click(screen.getByRole('button', { name: 'Link to alert' }));
    expect(model.retryLink).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Save to Documents' }));
    expect(model.onSave).toHaveBeenCalledOnce();
  });
  it('does not offer filing or a nonexistent review link for a held memo without a reviewer', () => {
    controller.mockReturnValue(state({ held: true, blockedNoReviewer: true }));
    render(<MemoComposerDrawer {...props} />);
    expect(screen.getByRole('button', { name: 'Save to Documents' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'View review request' })).not.toBeInTheDocument();
    expect(screen.getByText(/Filing blocked — no reviewer notified/)).toBeInTheDocument();
  });
  it('requires explicit confirmation before replacing a filed document', () => {
    const run = vi.fn();
    controller.mockImplementation((_props, _message, confirm) =>
      state({
        confirmAndRegenerate: () => confirm(run),
      }),
    );
    render(<MemoComposerDrawer {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(run).not.toHaveBeenCalled();
    expect(
      screen.getByText('Replacing this filed memo loses the current version.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Regenerate' }).at(-1)!);
    expect(run).toHaveBeenCalledOnce();
  });
});
