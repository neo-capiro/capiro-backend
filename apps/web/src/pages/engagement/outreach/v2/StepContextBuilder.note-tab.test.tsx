/**
 * The Builder's "Custom note" tab must be usable on its own surface —
 * add → editor appears focused here → typing updates the SAME
 * SelectedContextItem the wizard persists → the note rides the
 * Phase 1 §3.b1 wire shape (customNoteText, no title/body).
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { StepContextBuilder } from './StepContextBuilder.js';
import type { Client } from '../../../clients/clientTypes.js';
import {
  toContextItemPayload,
  type ContextKind,
  type ContextPoolItem,
  type SelectedContextItem,
} from './types.js';

const api = {
  get: vi.fn(async () => ({ data: {} })),
  post: vi.fn(async () => ({ data: { text: 'Extracted client profile context.' } })),
};
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

    fireEvent.click(screen.getByRole('button', { name: /custom note/i }));
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

    fireEvent.click(screen.getByRole('button', { name: /custom note/i }));
    fireEvent.click(screen.getByRole('button', { name: /add shared note/i }));
    await screen.findByPlaceholderText(/write your note here/i);

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove Shared note' })[0]!);
    await waitFor(() => {
      expect(emitted).toHaveLength(0);
      expect(screen.queryByPlaceholderText(/write your note here/i)).toBeNull();
    });
  });
});

describe('StepContextBuilder — client portfolio', () => {
  test('shows client profile details and allows multiple profile context items to be selected', async () => {
    emitted = [];
    const client = {
      id: 'client-1',
      name: 'Northstar Systems',
      sectorTag: 'Aerospace',
      profileType: 'Company',
      website: 'northstar.example',
      description: 'Builds mission systems for public agencies.',
    } as Client;
    const pool: Record<ContextKind, ContextPoolItem[]> = {
      bill: [], stateBill: [], intel: [
        { id: 'intel-1', kind: 'intel', title: 'Agency modernization update', clientId: client.id, clientName: client.name },
      ], email: [], meeting: [], note: [],
      document: [
        { id: 'doc-1', kind: 'document', title: 'Capability brief', clientId: client.id, clientName: client.name },
        { id: 'doc-2', kind: 'document', title: 'Program overview', clientId: client.id, clientName: client.name },
      ],
      debrief: [], prep: [
        { id: 'prep-1', kind: 'prep', title: 'Quarterly meeting prep', clientId: client.id, clientName: client.name },
      ], programElement: [], capability: [],
    };
    function PortfolioBuilder() {
      const [selected, setSelected] = useState<SelectedContextItem[]>([]);
      const onChangeWithCapture = (next: SelectedContextItem[]) => {
        emitted = next;
        setSelected(next);
      };
      return (
        <QueryClientProvider client={new QueryClient()}>
          <StepContextBuilder
            clients={[client]}
            selectedClientId={client.id}
            recipients={[]}
            targets={[]}
            selected={selected}
            onChange={onChangeWithCapture}
            pool={pool}
            hasClient
            loading={false}
          />
        </QueryClientProvider>
      );
    }

    render(<PortfolioBuilder />);
    expect(screen.getAllByText('Northstar Systems').length).toBeGreaterThan(1);
    expect(screen.getByText('Builds mission systems for public agencies.')).toBeTruthy();
    const documentsGroup = screen.getByRole('region', { name: 'Docs & Notes context' });
    expect(within(documentsGroup).getByText('Capability brief')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Meeting preps context' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Client intelligence context' })).getByText('Agency modernization update')).toBeTruthy();
    fireEvent.click(within(documentsGroup).getByRole('button', { name: 'Select all' }));
    await waitFor(() => expect(emitted.map((item) => item.id)).toEqual(['doc-1', 'doc-2']));
    fireEvent.click(within(screen.getByRole('region', { name: 'Meeting preps context' })).getByRole('button', { name: 'Select all' }));
    await waitFor(() => expect(emitted.map((item) => item.id)).toEqual(['doc-1', 'doc-2', 'prep-1']));
    expect(screen.getByRole('complementary', { name: 'Selected context' }).textContent).toContain('3');
  });
});
