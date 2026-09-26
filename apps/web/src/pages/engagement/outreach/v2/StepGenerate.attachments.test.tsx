import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';
import type { Client } from '../../../clients/clientTypes.js';
import { StepGenerate } from './StepGenerate.js';
import { INITIAL_V2_STATE } from './types.js';

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn(async (_url: string, options?: { params?: { clientId?: string } }) => ({
    data: options?.params?.clientId === 'client-b'
      ? [
          { id: 'file-b1', fileName: 'Beta Overview.pdf', contentType: 'application/pdf', createdAt: '2026-09-24T12:00:00.000Z' },
          { id: 'file-b2', fileName: 'Beta Pricing.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        ]
      : [{ id: 'file-a1', fileName: 'Alpha Profile.pdf', contentType: 'application/pdf' }],
  })),
}));

vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => ({ get: getMock }) }));

const clients = [
  { id: 'client-a', name: 'Alpha Systems' },
  { id: 'client-b', name: 'Beta Works' },
] as Client[];

describe('StepGenerate — client file attachments', () => {
  test('switches clients, filters saved files, and attaches multiple selected files campaign-wide', async () => {
    const onToggleAttachment = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const { unmount } = render(
      <QueryClientProvider client={queryClient}>
        <StepGenerate
          entities={[{ kind: 'individual', target: { key: 'target-1' } as never, name: 'Test person', members: [] }]}
          slots={[]}
          generated={{}}
          tone={INITIAL_V2_STATE.tone}
          onTone={() => {}}
          selectedKey={null}
          onSelectKey={() => {}}
          onRegenerateAll={() => {}}
          onRegenerateOne={() => {}}
          onImprove={() => {}}
          onRevert={() => {}}
          onEdit={() => {}}
          onApplyToList={() => {}}
          regenerating={false}
          generatingKey={null}
          clientId="client-a"
          clients={clients}
          docs={[{ id: 'file-a1', fileName: 'Alpha Profile.pdf', contentType: 'application/pdf' }]}
          attachmentIds={[]}
          onToggleAttachment={onToggleAttachment}
          onUploadAttachment={() => {}}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Attach from client files/i }));
    expect(await screen.findByText('Alpha Profile.pdf')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Alpha Profile.pdf' }));
    expect(screen.getByText('Attached')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Beta Works/i }));
    expect(await screen.findByText('Beta Overview.pdf')).toBeTruthy();
    expect(screen.getByText('Beta Pricing.xlsx')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Search client files…'), { target: { value: 'Pricing' } });
    expect(screen.getByText('Beta Pricing.xlsx')).toBeTruthy();
    expect(screen.queryByText('Beta Overview.pdf')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Search client files…'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /^Beta Overview\.pdf/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Beta Pricing.xlsx' }));
    fireEvent.click(screen.getByRole('button', { name: 'Attach files' }));
    await waitFor(() => expect(onToggleAttachment).toHaveBeenCalledTimes(3));
    expect(onToggleAttachment).toHaveBeenNthCalledWith(1, 'file-a1');
    expect(onToggleAttachment).toHaveBeenNthCalledWith(2, 'file-b1');
    expect(onToggleAttachment).toHaveBeenNthCalledWith(3, 'file-b2');
    unmount();
    queryClient.clear();
  });
});
