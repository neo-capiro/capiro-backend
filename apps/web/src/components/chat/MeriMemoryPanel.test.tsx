import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { MeriMemoryPanel, type MeriLearnedMemory } from './MeriMemoryPanel.js';

/**
 * `canMutate` is the server's Phase 0 authorization decision. It is explicit here
 * because the panel now fails CLOSED: an absent flag means "not editable" rather
 * than offering an edit the API would refuse.
 */
const memory = (over: Partial<MeriLearnedMemory> = {}): MeriLearnedMemory => ({
  id: 'm1',
  key: 'tone',
  value: 'Use concise weekly briefs',
  scope: 'user_private',
  state: 'active',
  source: 'explicit_save',
  learnedAt: '2026-07-01T12:00:00.000Z',
  canMutate: true,
  ...over,
});

function renderPanel(
  memories: MeriLearnedMemory[],
  extra: {
    forgotten?: MeriLearnedMemory[];
    expanded?: boolean;
    onSave?: (id: string, value: string) => void;
    onForget?: (id: string) => void;
    onUndo?: (id: string) => void;
    onSuggestCorrection?: (id: string, value: string) => void;
  } = {},
) {
  return render(
    <MeriMemoryPanel
      memories={memories}
      forgotten={extra.forgotten ?? []}
      expanded={extra.expanded ?? true}
      onExpandedChange={vi.fn()}
      onSave={extra.onSave ?? vi.fn()}
      onForget={extra.onForget ?? vi.fn()}
      onUndo={extra.onUndo ?? vi.fn()}
      {...(extra.onSuggestCorrection ? { onSuggestCorrection: extra.onSuggestCorrection } : {})}
    />,
  );
}

describe('MeriMemoryPanel', () => {
  test('edits inline and commits with Enter', () => {
    const onSave = vi.fn();
    renderPanel([memory()], { onSave });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const input = screen.getByRole('textbox', { name: 'Edit memory' });
    fireEvent.change(input, { target: { value: 'Use concise client briefs' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSave).toHaveBeenCalledWith('m1', 'Use concise client briefs');
  });

  test('renders a reversible forget notification', () => {
    const onUndo = vi.fn();
    renderPanel([], { forgotten: [memory()], expanded: false, onUndo });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledWith('m1');
  });
});

describe('MeriMemoryPanel authorization affordances', () => {
  test('offers edit and forget only when the server permits mutation', () => {
    renderPanel([memory({ canMutate: true })]);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Forget' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Suggest correction' })).toBeNull();
  });

  test('replaces mutation with Suggest correction when authorization is denied', () => {
    // A standard user cannot edit firm memory. Offering Edit anyway invites a
    // request the API will refuse — exactly what Step 9 forbids.
    renderPanel([memory({ scope: 'firm', canMutate: false })], {
      onSuggestCorrection: vi.fn(),
    });
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Forget' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Suggest correction' })).toBeTruthy();
  });

  test('fails closed when the server omits canMutate', () => {
    const legacy = { ...memory(), canMutate: undefined } as MeriLearnedMemory;
    renderPanel([legacy], { onSuggestCorrection: vi.fn() });
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Suggest correction' })).toBeTruthy();
  });

  test('sends a correction for review without applying it locally', () => {
    const onSuggestCorrection = vi.fn();
    renderPanel([memory({ scope: 'firm', canMutate: false })], { onSuggestCorrection });
    fireEvent.click(screen.getByRole('button', { name: 'Suggest correction' }));
    const input = screen.getByRole('textbox', { name: 'Suggest a corrected value' });
    fireEvent.change(input, { target: { value: 'Corrected fact.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send for review' }));
    expect(onSuggestCorrection).toHaveBeenCalledWith('m1', 'Corrected fact.');
    // The original value is still displayed: nothing is applied client-side.
    expect(screen.getByTitle('Use concise weekly briefs')).toBeTruthy();
  });

  test('never calls a pending candidate something Meri learned', () => {
    renderPanel([memory({ state: 'pending_review', source: 'candidate_review' })]);
    expect(screen.getByText('Pending review')).toBeTruthy();
    expect(screen.getByText('Meri suggested remembering')).toBeTruthy();
    expect(screen.queryByText(/Meri learned/)).toBeNull();
  });

  test('shows scope, client name, and an expired lifetime honestly', () => {
    renderPanel([
      memory({
        scope: 'client',
        clientName: 'Raytheon',
        canMutate: false,
        expiresAt: '2020-01-01T00:00:00.000Z',
      }),
    ]);
    expect(screen.getByText('Client · Raytheon')).toBeTruthy();
    expect(screen.getByText(/^Expired /)).toBeTruthy();
  });

  test('omits confidence for an explicit human save rather than inventing precision', () => {
    const explicit = renderPanel([memory({ source: 'explicit_save', confidence: 1 })]);
    expect(screen.queryByText(/confidence/)).toBeNull();
    explicit.unmount();

    renderPanel([memory({ source: 'auto_learned_legacy', confidence: 0.42 })]);
    expect(screen.getByText('42% confidence')).toBeTruthy();
  });
});
