import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkPerformed } from './WorkPerformed.js';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock }),
}));
vi.mock('./chat-store.js', () => ({
  useChatStore: () => ({ activeConversationId: 'conversation-1' }),
}));

beforeEach(() => {
  getMock.mockReset();
  getMock.mockResolvedValue({
    data: {
      packetId: 'packet-1',
      compiledAt: '2026-07-28T14:00:00.000Z',
      surface: 'ga-chat',
      items: [
        {
          id: 'firm-1',
          label: 'Firm Compass',
          type: 'firm-compass',
          scope: 'firm',
          authority: 'human-authored',
          rationale: 'Firm identity steers the response.',
          selection: 'automatic',
        },
      ],
      exclusions: [],
      unauthorizedCount: 0,
      degraded: false,
    },
  });
});

describe('WorkPerformed', () => {
  it('shows a bounded source/check log and exact context packet', async () => {
    render(
      <WorkPerformed
        intent="query_intelligence"
        tier="deep"
        isStreaming={false}
        planSteps={['Resolve the bill', 'Check the latest action']}
        steps={[
          {
            tool: 'search_congress_bills',
            label: 'Searched congressional bills',
            detail: '2 matching records',
            count: 2,
            confidence: 'high',
            status: 'done',
          },
        ]}
      />,
    );

    await waitFor(() => expect(getMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Work performed/i }));
    expect(screen.getByText('Resolve the bill')).toBeTruthy();
    expect(screen.getByText('Searched congressional bills')).toBeTruthy();
    fireEvent.click(screen.getByText(/Context used/i));
    expect(screen.getByText('Firm Compass')).toBeTruthy();
    expect(screen.getByText(/This log shows tools, sources, context, and checks/)).toBeTruthy();
    expect(screen.queryByText(/Thought process/i)).toBeNull();
    expect(screen.queryByText(/^Reasoning$/i)).toBeNull();
  });

  it('keeps errors visible after streaming completes', async () => {
    render(
      <WorkPerformed
        isStreaming={false}
        steps={[
          {
            tool: 'get_bill_status',
            label: 'Checked bill status',
            detail: 'Source unavailable',
            status: 'error',
          },
        ]}
      />,
    );
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /1 issue/i }));
    expect(screen.getByText('Source unavailable')).toBeTruthy();
  });

  it('renders a degraded context state without exposing hidden item identity', async () => {
    getMock.mockRejectedValueOnce(new Error('offline'));
    render(<WorkPerformed isStreaming={false} steps={[]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Sources and context/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Sources and context/i }));
    fireEvent.click(screen.getByText(/Context used/i));
    expect(screen.getByRole('alert')).toHaveTextContent('Context provenance could not be loaded');
  });
});
