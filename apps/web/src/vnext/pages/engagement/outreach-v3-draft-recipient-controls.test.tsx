import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DraftRecipientControls } from './outreach-v3-draft-recipient-controls.js';
import type { OutreachV3DraftArtifact } from './engagement-api.js';

function draft(overrides: Partial<OutreachV3DraftArtifact> = {}): OutreachV3DraftArtifact {
  return {
    id: 'draft-1',
    outreachRecordId: 'session-1',
    generationKey: 'slot-a',
    recipientKey: 'slot-a',
    audienceKind: 'individual',
    currentVersion: 1,
    current: {
      id: 'version-1',
      artifactId: 'draft-1',
      outreachRecordId: 'session-1',
      version: 1,
      sourceVersionId: null,
      generationKey: 'slot-a',
      recipientKey: 'slot-a',
      audienceKind: 'individual',
      subject: 'Meeting request',
      body: 'Dear Jordan, ...',
      contentHash: 'hash-1',
      generationStatus: 'complete',
      auditStatus: 'passed',
      approvalStatus: 'pending',
      auditDecision: null,
      auditChecks: [],
      reviewRequestId: null,
      provider: 'anthropic',
      model: 'model-a',
      promptSpecVersion: 'v2',
      sendable: true,
      createdAt: '2026-08-22T00:00:00.000Z',
    },
    history: [],
    ...overrides,
  };
}

describe('DraftRecipientControls', () => {
  it('asks Meri for a new version with an instruction that preserves the approved facts', () => {
    const onRefine = vi.fn();
    render(
      <DraftRecipientControls
        draft={draft()}
        busy={false}
        refineBusy={false}
        onEdit={vi.fn()}
        onRefine={onRefine}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /edit with meri/i }));
    fireEvent.change(screen.getByPlaceholderText(/make the opening more personal/i), {
      target: { value: 'Shorten the second paragraph.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create new version/i }));

    expect(onRefine).toHaveBeenCalledTimes(1);
    const instruction = onRefine.mock.calls[0]![0] as string;
    expect(instruction).toContain('Shorten the second paragraph.');
    expect(instruction).toContain('Preserve the exact approved subject line');
    expect(instruction).not.toContain('undefined');
  });

  it('does not submit a Meri instruction that is blank', () => {
    const onRefine = vi.fn();
    render(
      <DraftRecipientControls
        draft={draft()}
        busy={false}
        refineBusy={false}
        onEdit={vi.fn()}
        onRefine={onRefine}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /edit with meri/i }));
    expect(screen.getByRole('button', { name: /create new version/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /create new version/i }));
    expect(onRefine).not.toHaveBeenCalled();
  });

  it('applies a tone change as a new version without discarding recipient-specific facts', () => {
    const onRefine = vi.fn();
    render(
      <DraftRecipientControls
        draft={draft()}
        busy={false}
        refineBusy={false}
        onEdit={vi.fn()}
        onRefine={onRefine}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /change tone/i }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Warm' } });
    fireEvent.click(screen.getByRole('button', { name: /apply to new version/i }));

    expect(onRefine).toHaveBeenCalledTimes(1);
    const instruction = onRefine.mock.calls[0]![0] as string;
    expect(instruction).toContain('warm tone');
    expect(instruction).toContain('recipient-specific note');
  });

  it('regenerates the draft from the approved packet on request', () => {
    const onRefine = vi.fn();
    render(
      <DraftRecipientControls
        draft={draft()}
        busy={false}
        refineBusy={false}
        onEdit={vi.fn()}
        onRefine={onRefine}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /regenerate/i }));

    expect(onRefine).toHaveBeenCalledTimes(1);
    expect(onRefine.mock.calls[0]![0]).toContain('Regenerate');
    expect(onRefine.mock.calls[0]![0]).toContain('approved campaign packet');
  });

  it('disables every control while the draft has no current version or is busy', () => {
    const onRefine = vi.fn();
    const onEdit = vi.fn();
    render(
      <DraftRecipientControls
        draft={draft({ current: null })}
        busy={false}
        refineBusy={false}
        onEdit={onEdit}
        onRefine={onRefine}
      />,
    );

    for (const name of [/edit text/i, /edit with meri/i, /change tone/i, /regenerate/i]) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
  });
});
