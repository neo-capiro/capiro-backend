import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const get = vi.fn();
  const patch = vi.fn();
  return { get, patch, api: { get, patch } };
});

vi.mock('../../lib/use-api.js', () => ({
  useApi: () => mocks.api,
}));

import { VNextMeriReasoningControl } from './VNextMeriReasoningControl.js';

describe('VNextMeriReasoningControl', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.patch.mockReset();
    mocks.get.mockResolvedValue({ data: { reasoningMode: 'standard' } });
    mocks.patch.mockResolvedValue({ data: { reasoningMode: 'deep' } });
  });

  test('loads the saved mode and exposes every supported reasoning option', async () => {
    render(<VNextMeriReasoningControl conversationId="conversation-1" />);

    await waitFor(() =>
      expect(mocks.get).toHaveBeenCalledWith('/api/clio/v3/conversations/conversation-1/reasoning-mode'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning mode: Standard' }));

    expect(screen.getByRole('menu', { name: 'Reasoning mode' })).toBeTruthy();
    expect(screen.getByRole('menuitemradio', { name: /Fast/ })).toBeTruthy();
    expect(screen.getByRole('menuitemradio', { name: /Standard/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: /Deep/ })).toBeTruthy();
    expect(screen.getByRole('menuitemradio', { name: /Max/ })).toBeTruthy();
  });

  test('persists a selected mode for the active conversation', async () => {
    render(<VNextMeriReasoningControl conversationId="conversation-1" />);

    await screen.findByRole('button', { name: 'Reasoning mode: Standard' });
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning mode: Standard' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Deep/ }));

    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith(
        '/api/clio/v3/conversations/conversation-1/reasoning-mode',
        { reasoningMode: 'deep' },
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Reasoning mode: Deep' })).toBeTruthy(),
    );
  });

  test('restores the prior choice and reports an error when persistence fails', async () => {
    mocks.patch.mockRejectedValueOnce(new Error('offline'));
    render(<VNextMeriReasoningControl conversationId="conversation-1" />);

    await screen.findByRole('button', { name: 'Reasoning mode: Standard' });
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning mode: Standard' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('The reasoning mode could not be saved.'),
    );
    expect(screen.getByRole('button', { name: 'Reasoning mode: Standard' })).toBeTruthy();
  });
});
