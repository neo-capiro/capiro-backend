// QA gap coverage (independent verification pass): DraftVersionCompare had ZERO
// test coverage anywhere in the repo before this file — not even a mock
// reference. It is the ONLY UI for Phase 2 §3.f3's candidate-regeneration
// flow (keep mine / use regenerated / merge manually), so its wiring is worth
// testing directly rather than trusting that StepGenerate's own tests cover it
// (they don't; they test the state machine, not this component's button-to-
// callback wiring).
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { DraftVersionCompare } from './DraftVersionCompare.js';
import type { DraftCandidate } from './versioned-drafts.js';

function makeCandidate(overrides: Partial<DraftCandidate> = {}): DraftCandidate {
  return {
    genKey: 'individual:dana@mail.house.gov',
    artifactId: 'art-1',
    candidateVersionId: 'v-2',
    candidateVersion: 2,
    baseVersion: 1,
    subject: 'Regenerated subject',
    body: '<p>Regenerated body.</p>',
    ...overrides,
  };
}

describe('DraftVersionCompare', () => {
  test('renders current and candidate side-by-side by default, HTML stripped to plain text', () => {
    render(
      <DraftVersionCompare
        candidate={makeCandidate()}
        slotName="Dana Reed"
        current={{ subject: 'Current subject', body: '<p>Current body.</p>' }}
        onKeepMine={vi.fn()}
        onAccept={vi.fn()}
        onMergeManually={vi.fn()}
      />,
    );
    expect(screen.getByText('A regenerated draft is available for Dana Reed')).toBeTruthy();
    expect(screen.getByText('Current subject')).toBeTruthy();
    expect(screen.getByText('Current body.')).toBeTruthy();
    expect(screen.getByText('Regenerated subject')).toBeTruthy();
    expect(screen.getByText('Regenerated body.')).toBeTruthy();
    // No raw HTML tags leaked into the rendered text.
    expect(screen.queryByText(/<p>/)).toBeNull();
  });

  test('"Keep mine" calls onKeepMine and nothing else', () => {
    const onKeepMine = vi.fn();
    const onAccept = vi.fn();
    render(
      <DraftVersionCompare
        candidate={makeCandidate()}
        slotName="Dana Reed"
        current={{ subject: 'Current', body: 'Current body' }}
        onKeepMine={onKeepMine}
        onAccept={onAccept}
        onMergeManually={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Keep mine'));
    expect(onKeepMine).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
  });

  test('"Use regenerated" calls onAccept, never mutating the current draft locally', () => {
    const onAccept = vi.fn().mockResolvedValue(undefined);
    render(
      <DraftVersionCompare
        candidate={makeCandidate()}
        slotName="Dana Reed"
        current={{ subject: 'Current', body: 'Current body' }}
        onKeepMine={vi.fn()}
        onAccept={onAccept}
        onMergeManually={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Use regenerated'));
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  test('"Merge manually" pre-fills the merge form from the CURRENT draft, not the candidate', () => {
    render(
      <DraftVersionCompare
        candidate={makeCandidate({ subject: 'Regenerated subject', body: '<p>Regenerated body.</p>' })}
        slotName="Dana Reed"
        current={{ subject: 'My edited subject', body: '<p>My edited body.</p>' }}
        onKeepMine={vi.fn()}
        onAccept={vi.fn()}
        onMergeManually={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Merge manually'));
    const subjectInput = screen.getByPlaceholderText('Subject') as HTMLInputElement;
    expect(subjectInput.value).toBe('My edited subject');
    expect(screen.getByDisplayValue('My edited body.')).toBeTruthy();
    // The candidate's own text must NOT appear pre-filled in the merge form.
    expect(screen.queryByDisplayValue('Regenerated subject')).toBeNull();
  });

  test('"Save merged draft" calls onMergeManually with the EDITED (not original) subject/body', () => {
    const onMergeManually = vi.fn();
    render(
      <DraftVersionCompare
        candidate={makeCandidate()}
        slotName="Dana Reed"
        current={{ subject: 'My edited subject', body: 'My edited body' }}
        onKeepMine={vi.fn()}
        onAccept={vi.fn()}
        onMergeManually={onMergeManually}
      />,
    );
    fireEvent.click(screen.getByText('Merge manually'));
    fireEvent.change(screen.getByPlaceholderText('Subject'), { target: { value: 'Hand-merged subject' } });
    const bodyBox = screen.getByDisplayValue('My edited body');
    fireEvent.change(bodyBox, { target: { value: 'Hand-merged body' } });
    fireEvent.click(screen.getByText('Save merged draft'));
    expect(onMergeManually).toHaveBeenCalledWith('Hand-merged subject', 'Hand-merged body');
  });

  test('"Cancel" from merge mode returns to the comparison view without calling any callback', () => {
    const onMergeManually = vi.fn();
    render(
      <DraftVersionCompare
        candidate={makeCandidate()}
        slotName="Dana Reed"
        current={{ subject: 'Current', body: 'Current body' }}
        onKeepMine={vi.fn()}
        onAccept={vi.fn()}
        onMergeManually={onMergeManually}
      />,
    );
    fireEvent.click(screen.getByText('Merge manually'));
    expect(screen.getByPlaceholderText('Subject')).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByPlaceholderText('Subject')).toBeNull();
    expect(screen.getByText('Current (yours)')).toBeTruthy();
    expect(onMergeManually).not.toHaveBeenCalled();
  });

  test('all action buttons are disabled while busy', () => {
    render(
      <DraftVersionCompare
        candidate={makeCandidate()}
        slotName="Dana Reed"
        current={{ subject: 'Current', body: 'Current body' }}
        onKeepMine={vi.fn()}
        onAccept={vi.fn()}
        onMergeManually={vi.fn()}
        busy
      />,
    );
    expect((screen.getByText('Keep mine') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Use regenerated') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Merge manually') as HTMLButtonElement).disabled).toBe(true);
  });

  test('handles an empty current draft honestly, not as a crash', () => {
    render(
      <DraftVersionCompare
        candidate={makeCandidate()}
        slotName="Dana Reed"
        current={{ subject: '', body: '' }}
        onKeepMine={vi.fn()}
        onAccept={vi.fn()}
        onMergeManually={vi.fn()}
      />,
    );
    expect(screen.getByText('(no subject)')).toBeTruthy();
    expect(screen.getByText('(empty)')).toBeTruthy();
  });
});
