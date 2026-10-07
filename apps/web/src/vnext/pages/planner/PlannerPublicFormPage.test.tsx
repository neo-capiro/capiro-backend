import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlannerPublicFormPage } from './PlannerPublicFormPage.js';
const fixture = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('axios', () => ({ default: fixture }));
vi.mock('../../../env.js', () => ({ config: { apiBaseUrl: 'https://qa.invalid' } }));
afterEach(() => {
  cleanup();
  fixture.get.mockReset();
  fixture.post.mockReset();
});
function showForm() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/planner/forms/synthetic-capability']}>
          <Routes>
            <Route path="/planner/forms/:token" element={<PlannerPublicFormPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}
describe('Public Planner intake', () => {
  it('retains batched text, paragraph, choice, date and numeric answers after input events end', async () => {
    fixture.get.mockResolvedValue({
      data: {
        name: 'Synthetic public intake',
        description: 'Synthetic only',
        fields: [
          {
            id: 'name',
            label: 'Request',
            type: 'text',
            taskField: 'name',
            required: true,
            options: [],
          },
          {
            id: 'details',
            label: 'Details',
            type: 'paragraph',
            taskField: 'description',
            required: false,
            options: [],
          },
          {
            id: 'priority',
            label: 'Priority',
            type: 'select',
            taskField: 'priority',
            required: false,
            options: ['high', 'low'],
          },
          {
            id: 'due',
            label: 'Due',
            type: 'date',
            taskField: 'dueOn',
            required: false,
            options: [],
          },
          {
            id: 'estimate',
            label: 'Estimate',
            type: 'number',
            taskField: 'estimateMinutes',
            required: false,
            options: [],
          },
        ],
      },
    });
    fixture.post.mockResolvedValue({ data: { received: true } });
    showForm();
    await screen.findByRole('heading', { name: 'Synthetic public intake' });
    act(() => {
      fireEvent.input(screen.getByRole('textbox', { name: 'Request *' }), {
        target: { value: 'First draft' },
      });
      fireEvent.input(screen.getByRole('textbox', { name: 'Request *' }), {
        target: { value: 'Final request' },
      });
      fireEvent.change(screen.getByRole('textbox', { name: 'Details' }), {
        target: { value: 'Final details' },
      });
      fireEvent.change(screen.getByRole('combobox', { name: 'Priority' }), {
        target: { value: 'high' },
      });
      fireEvent.input(screen.getByLabelText('Due'), { target: { value: '2026-10-09' } });
      fireEvent.input(screen.getByRole('spinbutton', { name: 'Estimate' }), {
        target: { value: '30' },
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    await screen.findByRole('heading', { name: 'Request received' });
    expect(fixture.post).toHaveBeenCalledWith(
      'https://qa.invalid/strategy-api/planner/public/forms/synthetic-capability',
      {
        name: 'Final request',
        details: 'Final details',
        priority: 'high',
        due: '2026-10-09',
        estimate: 30,
      },
      { timeout: 30000 },
    );
    expect(fixture.get).toHaveBeenCalledWith(
      'https://qa.invalid/strategy-api/planner/public/forms/synthetic-capability',
      { timeout: 30000 },
    );
  });
  it('shows the closed form state after capability revocation', async () => {
    fixture.get.mockRejectedValue({ response: { status: 404 } });
    showForm();
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('unavailable or has been closed'),
    );
    expect(screen.queryByRole('button', { name: 'Submit request' })).not.toBeInTheDocument();
  });
});
