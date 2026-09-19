/**
 * The Builder's "Custom note" tab must be usable on its own surface —
 * add → editor appears focused here → typing updates the SAME
 * SelectedContextItem the wizard persists → the note rides the
 * Phase 1 §3.b1 wire shape (customNoteText, no title/body).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { StepContextBuilder } from './StepContextBuilder.js';
import {
  toContextItemPayload,
  type ContextKind,
  type ContextPoolItem,
  type SelectedContextItem,
} from './types.js';

const api = { get: vi.fn(async () => ({ data: {} })) };
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => api,
}));

/** Captures every emitted state change while re-rendering like the wizard. */
let emitted: SelectedContextItem[] = [];
function StatefulBuilder() {
  const [selected, setSelected] = useState<SelectedContextItem[]>([]);
  const onChangeWithCapture = (next: SelectedContextItem[]) => {
    emitted = next;
    setSelected(next);
  };
  // One empty list per ContextKind — the component indexes pool by kind.
  const emptyPool: Record<ContextKind, ContextPoolItem[]> = {
    bill: [], stateBill: [], intel: [], email: [], meeting: [],
    note: [], document: [], debrief: [], prep: [],
    programElement: [], capability: [],
  };
  return (
    <QueryClientProvider client={new QueryClient()}>
      <StepContextBuilder
        recipients={[]}
        targets={[]}
        selected={selected}
        onChange={onChangeWithCapture}
        pool={emptyPool}
        discoveryBills={[]}
        hasClient={false}
        loading={false}
      />
    </QueryClientProvider>
  );
}

describe('StepContextBuilder — Custom note tab', () => {
  test('Add shared note exposes a focused editor on this tab; typing persists to wizard state', async () => {
    render(<StatefulBuilder />);

    fireEvent.click(screen.getByRole('tab', { name: /custom note/i }));
    fireEvent.click(screen.getByRole('button', { name: /add shared note/i }));

    const editor = await screen.findByPlaceholderText(/write your note here/i);
    await waitFor(() => expect(document.activeElement).toBe(editor));

    fireEvent.change(editor, { target: { value: 'Lead with the hearing date.' } });

    // Assert on the ACTUAL state the component emitted, not a reconstruction.
    await waitFor(() => {
      expect(emitted).toHaveLength(1);
      const item = emitted[0]!;
      expect(item.kind).toBe('note');
      expect(item.scope).toBe('all');
      expect(item.note).toBe('Lead with the hearing date.');
      const payload = toContextItemPayload(item);
      expect(payload).toMatchObject({
        kind: 'note',
        scope: 'all',
        customNoteText: 'Lead with the hearing date.',
      });
      expect(payload).not.toHaveProperty('title');
      expect(payload).not.toHaveProperty('body');
    });
    // Controlled re-render proves the emitted state fed back through.
    expect((screen.getByPlaceholderText(/write your note here/i) as HTMLTextAreaElement).value)
      .toBe('Lead with the hearing date.');
  });

  test('Remove on this tab deletes the note from the shared state', async () => {
    render(<StatefulBuilder />);

    fireEvent.click(screen.getByRole('tab', { name: /custom note/i }));
    fireEvent.click(screen.getByRole('button', { name: /add shared note/i }));
    await screen.findByPlaceholderText(/write your note here/i);

    fireEvent.click(screen.getByRole('button', { name: 'Remove Shared note' }));
    await waitFor(() => {
      expect(emitted).toHaveLength(0);
      expect(screen.queryByPlaceholderText(/write your note here/i)).toBeNull();
    });
  });
});