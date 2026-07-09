import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { BillsTouchingPePanel } from './BillsTouchingPePanel.js';
import type { ProgramElementBill } from './types.js';

const navigateMock = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

beforeEach(() => {
  navigateMock.mockReset();
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
});

function bill(partial: Partial<ProgramElementBill>): ProgramElementBill {
  return {
    id: '119-hr-123',
    congress: 119,
    billType: 'HR',
    billNumber: '123',
    title: 'Focused program bill',
    policyArea: null,
    latestActionText: null,
    latestActionDate: null,
    url: null,
    sponsor: 'Rep. Doe',
    committee: 'Armed Services',
    peCodeCount: 2,
    ...partial,
  };
}

describe('BillsTouchingPePanel', () => {
  test('renders a compact swimlane and chronological action history', () => {
    render(
      <MemoryRouter>
        <BillsTouchingPePanel
          bills={[
            bill({
              id: '118-hr-2670',
              congress: 118,
              billType: 'HR',
              billNumber: '2670',
              title: 'National Defense Authorization Act for Fiscal Year 2024',
              latestActionText: 'Became Public Law No: 118-31.',
              latestActionDate: '2023-12-22',
              peCodeCount: 746,
              actions: [
                {
                  id: 'a1',
                  date: '2023-06-22',
                  text: 'Reported by the Committee on Armed Services.',
                  type: null,
                  chamber: 'House',
                },
                {
                  id: 'a2',
                  date: '2023-12-14',
                  text: 'Passed House.',
                  type: null,
                  chamber: 'House',
                },
                {
                  id: 'a3',
                  date: '2023-12-22',
                  text: 'Became Public Law No: 118-31.',
                  type: null,
                  chamber: null,
                },
              ],
            }),
            bill({
              id: '119-s-2296',
              billType: 'S',
              billNumber: '2296',
              title: 'Senate defense measure',
              latestActionText: 'Passed Senate.',
              latestActionDate: '2026-01-14',
              actions: [
                {
                  id: 'b1',
                  date: '2025-12-16',
                  text: 'Reported by the Committee on Armed Services.',
                  type: null,
                  chamber: 'Senate',
                },
                {
                  id: 'b2',
                  date: '2026-01-14',
                  text: 'Passed Senate.',
                  type: null,
                  chamber: 'Senate',
                },
              ],
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText(/Legislative bill timeline/i)).toBeInTheDocument();
    expect(screen.getAllByText(/H\.R\. 2670/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/S\. 2296/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/2023/i)).toBeInTheDocument();
    expect(screen.getByText(/2026/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Became law/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Reported/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Action history/i)).toBeInTheDocument();
    expect(screen.getByText(/Became Public Law No: 118-31/i)).toBeInTheDocument();
    expect(screen.getByText(/746 PEs/i)).toBeInTheDocument();
  });

  test('does not infer chamber-specific labels when action text is generic', () => {
    render(
      <MemoryRouter>
        <BillsTouchingPePanel
          bills={[
            bill({
              id: '119-s-2296',
              billType: 'S',
              billNumber: '2296',
              title: 'Senate defense measure',
              latestActionText: 'Passed.',
              latestActionDate: '2026-01-14',
              actions: [
                {
                  id: 'b1',
                  date: '2026-01-14',
                  text: 'Passed.',
                  type: null,
                  chamber: 'Senate',
                },
              ],
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getAllByText(/^Passed$/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Passed Senate/i)).not.toBeInTheDocument();
  });

  test('falls back to latest action when detailed actions are absent', () => {
    render(
      <MemoryRouter>
        <BillsTouchingPePanel
          bills={[
            bill({
              latestActionText: 'Reported by the Committee on Armed Services.',
              latestActionDate: '2026-02-01',
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getAllByText(/H\.R\. 123/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Reported/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Reported by the Committee on Armed Services/i)).toBeInTheDocument();
  });

  test('empty state renders', () => {
    render(
      <MemoryRouter>
        <BillsTouchingPePanel bills={[]} />
      </MemoryRouter>,
    );

    expect(screen.getByText(/No linked bills yet/i)).toBeInTheDocument();
  });

  test('click navigates to bill detail route', () => {
    render(
      <MemoryRouter>
        <BillsTouchingPePanel
          bills={[
            bill({
              id: 'HR-123',
              latestActionText: 'Reported by committee.',
              latestActionDate: '2026-02-01',
            }),
          ]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /H\.R\. 123/i }));
    expect(navigateMock).toHaveBeenCalledWith('/intelligence/bills/HR-123');
  });

  test('linked bills without dated actions still render as rows', () => {
    render(
      <MemoryRouter>
        <BillsTouchingPePanel
          bills={[
            bill({
              id: '119-hr-100',
              billNumber: '100',
              title: 'A targeted program bill',
              latestActionText: null,
              latestActionDate: null,
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText(/A targeted program bill/i)).toBeInTheDocument();
    expect(screen.getByText(/No dated legislative actions/i)).toBeInTheDocument();
  });
});
