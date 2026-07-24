import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { BillsTouchingPePanel } from './BillsTouchingPePanel.js';
import type { ProgramElementBill } from './types.js';

// The panel routes through useBillTarget, which reads the tenant's `bill_360` flag.
// Mocked so this spec doesn't need the app's API client / runtime config; `enabled`
// is flipped per-test to prove BOTH destinations.
let billFlag = { enabled: true, ready: true };
vi.mock('../../lib/intel-feature-flags.js', () => ({
  BILL_360_FEATURE: 'bill_360',
  useIntelFeature: () => billFlag,
  useIntelFeatureEnabled: () => billFlag.enabled,
}));

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
  billFlag = { enabled: true, ready: true };
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

  // Bill 360 (R2 §2.5): the PE bill timeline is one of the entry points routed to
  // the canonical dossier. It used to navigate to the legacy
  // `/intelligence/bills/:bill` Explorer redirect.
  test('click navigates to the Bill 360 page, not the legacy Explorer redirect', () => {
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
    expect(navigateMock).toHaveBeenCalledWith('/bills/HR-123');
    for (const call of navigateMock.mock.calls) {
      expect(String(call[0])).not.toContain('/intelligence/bills/');
      expect(String(call[0])).not.toContain('/explorer');
    }
  });

  // R4 §4.2: Program Element 360 stays the line-level source of truth, so a bill
  // lane must show WHY it is linked (match basis + confidence) and which budget
  // package it rides in — never a bare link.
  test('shows the package label plus an explicit match basis and confidence', () => {
    render(
      <MemoryRouter>
        <BillsTouchingPePanel
          bills={[
            bill({
              id: '119-hr-9100',
              latestActionText: 'Reported by committee.',
              latestActionDate: '2026-02-01',
              link: {
                type: 'explicit_pe_code',
                confidence: 1,
                evidence: 'Found in enrolled bill text: "…0603270A…"',
                status: 'accepted',
              },
              budgetPackage: {
                name: 'FY27 Defense Budget',
                fiscalYear: 2027,
                track: 'appropriation',
                stage: 'house',
              },
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText(/FY27 Defense Budget · appropriation · house/)).toBeInTheDocument();
    expect(screen.getByText(/Explicit PE match · 100%/)).toBeInTheDocument();
    // The full evidence string is the hover title, keeping the swimlane calm.
    expect(
      document.querySelector('[title=\'Found in enrolled bill text: "…0603270A…"\']'),
    ).toBeTruthy();
  });

  test('labels a fuzzy link as inferred and flags a candidate review status', () => {
    render(
      <MemoryRouter>
        <BillsTouchingPePanel
          bills={[
            bill({
              id: '119-s-9100',
              latestActionText: 'Reported.',
              latestActionDate: '2026-02-01',
              link: {
                type: 'title_match',
                confidence: 0.55,
                evidence: 'Matched on project title.',
                status: 'candidate',
              },
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText(/Inferred match · candidate · 55%/)).toBeInTheDocument();
    expect(screen.queryByText(/Explicit PE match/)).not.toBeInTheDocument();
  });

  test('shows NO basis chip when the server sent no link row (absent, not "explicit")', () => {
    render(
      <MemoryRouter>
        <BillsTouchingPePanel
          bills={[bill({ id: '119-hr-1', latestActionDate: '2026-02-01' })]}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByText(/Explicit PE match/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Inferred match/)).not.toBeInTheDocument();
  });

  // A tenant WITHOUT bill_360 must keep the destination it has today. /bills/:id
  // fails closed, so routing an un-enabled tenant there would replace a working
  // Explorer view with a "Bill 360 is not enabled" page.
  test('falls back to Explorer for a tenant without bill_360', () => {
    billFlag = { enabled: false, ready: true };
    render(
      <MemoryRouter>
        <BillsTouchingPePanel
          bills={[bill({ id: 'HR-123', latestActionDate: '2026-02-01' })]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /H\.R\. 123/i }));
    expect(navigateMock).toHaveBeenCalledWith('/explorer?bill=HR-123');
    expect(navigateMock).not.toHaveBeenCalledWith('/bills/HR-123');
  });

  test('falls back to Explorer while the flag is still resolving (no dark flash)', () => {
    billFlag = { enabled: false, ready: false };
    render(
      <MemoryRouter>
        <BillsTouchingPePanel
          bills={[bill({ id: 'HR-123', latestActionDate: '2026-02-01' })]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /H\.R\. 123/i }));
    expect(navigateMock).toHaveBeenCalledWith('/explorer?bill=HR-123');
  });

  test('an undated linked bill also opens Bill 360', () => {
    render(
      <MemoryRouter>
        <BillsTouchingPePanel
          bills={[
            bill({
              id: '119-s-4200',
              billType: 's',
              billNumber: '4200',
              title: 'A dateless measure',
              latestActionText: null,
              latestActionDate: null,
            }),
          ]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /S\.? ?4200/i }));
    expect(navigateMock).toHaveBeenCalledWith('/bills/119-s-4200');
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
