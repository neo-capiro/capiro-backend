import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
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
          <Link to="/planner/forms/another-synthetic-capability">Next synthetic form</Link>
          <Routes>
            <Route path="/planner/forms/:token" element={<PlannerPublicFormPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}
describe('Public Planner intake', () => {
  it('shows configured confirmation, clears another response, and submits one request during repeated synchronous submits', async () => {
    fixture.get.mockResolvedValue({
      data: {
        name: 'Custom confirmation',
        description: '',
        confirmationMessage: 'Thanks. We will review this.',
        allowAnotherSubmission: true,
        fields: [{ id: 'request', label: 'Request', type: 'text', required: true, options: [] }],
      },
    });
    let resolve: (value: unknown) => void = () => {};
    fixture.post.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    showForm();
    await screen.findByRole('heading', { name: 'Custom confirmation' });
    fireEvent.input(screen.getByLabelText('Request *'), { target: { value: 'Synthetic request' } });
    const form = screen.getByRole('button', { name: 'Submit request' }).closest('form')!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await waitFor(() => expect(fixture.post).toHaveBeenCalledTimes(1));
    await act(async () => resolve({ data: { received: true } }));
    await screen.findByText('Thanks. We will review this.');
    fireEvent.click(screen.getByRole('button', { name: 'Submit another response' }));
    expect(screen.getByLabelText('Request *')).toHaveValue('');
    expect(screen.queryByRole('heading', { name: 'Request received' })).not.toBeInTheDocument();
  });
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
  it('clears draft answers when navigating to another capability', async () => {
    fixture.get.mockImplementation(async (path) => ({
      data: {
        name: path.includes('another-') ? 'Second form' : 'First form',
        description: 'Synthetic',
        fields: [
          {
            id: 'name',
            label: 'Request',
            type: 'text',
            taskField: 'name',
            required: false,
            options: [],
          },
        ],
      },
    }));
    fixture.post.mockResolvedValue({ data: { received: true } });
    showForm();
    await screen.findByRole('heading', { name: 'First form' });
    fireEvent.input(screen.getByRole('textbox', { name: 'Request' }), {
      target: { value: 'Draft for the first form only' },
    });
    fireEvent.click(screen.getByRole('link', { name: 'Next synthetic form' }));
    await screen.findByRole('heading', { name: 'Second form' });
    expect(screen.getByRole('textbox', { name: 'Request' })).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    await screen.findByRole('heading', { name: 'Request received' });
    expect(fixture.post).toHaveBeenCalledWith(
      'https://qa.invalid/strategy-api/planner/public/forms/another-synthetic-capability',
      {},
      { timeout: 30000 },
    );
  });
});
