import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider } from 'antd';
import { GRANTS_GOV_UNRESTRICTED_APPLICANTS } from '@capiro/shared';
import { describe, expect, it, vi } from 'vitest';
import { ClientFormModal } from './ClientFormModal.js';
import type { Client, ClientFormSubmit } from './clientTypes.js';

vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({ get: async () => ({ data: [] }) }),
}));

describe('legacy client funding profile editor', () => {
  it('uses the shared organization picker and round-trips funding priorities with unrelated intake data', async () => {
    const client = {
      name: 'Lakeside Research',
      website: 'lakeside.example',
      description: 'Water quality monitoring.',
      applicantTypes: [GRANTS_GOV_UNRESTRICTED_APPLICANTS],
      intakeData: {
        fundingPriorities: ['Water quality monitoring'],
        profileNotes: ['Preserve me'],
      },
    } as unknown as Client;
    const onSubmit = vi.fn<(value: ClientFormSubmit) => void>();
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ConfigProvider theme={{ token: { motion: false } }}>
          <ClientFormModal
            open
            mode="edit"
            client={client}
            submitting={false}
            onCancel={() => {}}
            onSubmit={onSubmit}
          />
        </ConfigProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('button', { name: 'Back' });
    await waitFor(() => expect(screen.getByText('Saved selections need review')).toBeVisible());
    fireEvent.click(screen.getByText('Select organization types'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Private college or university' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    const save = await screen.findByRole('button', { name: 'Save changes' });
    await waitFor(() => expect(screen.getByText('Water quality monitoring')).toBeVisible());
    fireEvent.click(save);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]![0].payload).toMatchObject({
      applicantTypes: ['Private institutions of higher education'],
      intakeData: {
        fundingPriorities: ['Water quality monitoring'],
        profileNotes: ['Preserve me'],
      },
    });
  });
});
