import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ProgramTeamPanel, confidencePillColor } from './ProgramTeamPanel.js';

function setupBrowserMocks() {
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
}

const people = [
  { id: '1', fullName: 'COL Jane Doe', title: 'PEO Aviation', organization: 'PEO Aviation', role: 'PEO', confidence: 0.97, lastSeenAt: '2026-01-15T00:00:00.000Z', sourceCount: 4 },
  { id: '2', fullName: 'John Smith', title: 'Program Manager', organization: 'Army Futures Command', role: 'PM', confidence: 0.9, lastSeenAt: '2026-01-14T00:00:00.000Z', sourceCount: 2 },
  { id: '3', fullName: 'Alex Brown', title: 'DPM', organization: 'Navy', role: 'DPM', confidence: 0.79, lastSeenAt: '2026-01-13T00:00:00.000Z', sourceCount: 1 },
  { id: '4', fullName: 'Maria Lee', title: 'Contracting Officer', organization: 'AFLCMC', role: 'KO', confidence: 0.96, lastSeenAt: '2026-01-12T00:00:00.000Z', sourceCount: 3 },
  { id: '5', fullName: 'Sam Patel', title: 'Tech Director', organization: 'DARPA', role: 'TD', confidence: 0.81, lastSeenAt: '2026-01-11T00:00:00.000Z', sourceCount: 5 },
];

// Step 2.2 (plan §8): people hang off OFFICES and ROLES. A person with a real
// PersonRole chain renders a contactUse badge + the verbatim why-shown line + a
// freshness line, plus a stale badge when staleAt is set.
const personWithRoles = {
  id: 'r1',
  fullName: 'COL Dana Reyes',
  title: 'Procurement Lead',
  organization: 'PEO Missiles & Space',
  role: 'KO',
  confidence: 0.93,
  lastSeenAt: '2026-01-10T00:00:00.000Z',
  sourceCount: 2,
  roles: [
    {
      id: 'role-1',
      roleTitle: 'Contracting Officer',
      roleType: 'contracting_officer',
      officeName: 'PEO Missiles & Space',
      programName: 'LRPF',
      contactUse: 'official_procurement_poc',
      contactUseLabel: 'Official procurement POC',
      reviewStatus: 'accepted',
      // Noon UTC so the calendar day is stable across the runner's timezone.
      observedAt: '2026-01-10T12:00:00.000Z',
      staleAt: '2026-06-01T00:00:00.000Z',
      whyShown:
        'Contracting Officer in PEO Missiles & Space, which manages LRPF (mapped to this PE)',
    },
    {
      id: 'role-2',
      roleTitle: 'Deputy PM',
      roleType: 'deputy',
      officeName: 'PEO Missiles & Space',
      programName: null,
      contactUse: 'program_ownership_context',
      contactUseLabel: 'Program ownership context',
      reviewStatus: 'accepted',
      observedAt: '2026-01-08T00:00:00.000Z',
      staleAt: null,
      whyShown: 'Deputy PM in PEO Missiles & Space',
    },
  ],
};

const personEmptyRoles = {
  id: 'e1',
  fullName: 'Pat Lin',
  title: 'Program Analyst',
  organization: 'DARPA',
  role: 'Analyst',
  confidence: 0.84,
  lastSeenAt: '2026-01-09T00:00:00.000Z',
  sourceCount: 1,
  roles: [],
};

describe('ProgramTeamPanel', () => {
  test('renders the primary role contactUse badge, why-shown, and stale badge', () => {
    setupBrowserMocks();
    render(<ProgramTeamPanel personnel={[personWithRoles]} />);

    expect(screen.getByText('Official procurement POC')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Contracting Officer in PEO Missiles & Space, which manages LRPF (mapped to this PE)',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Stale — verify before use')).toBeInTheDocument();
    // The freshness line renders the observed date. The "Last observed", the date,
    // and the host suffix are separate text nodes, so match on the element's
    // normalized textContent rather than a single text node.
    expect(
      screen.getByText((_content, el) =>
        Boolean(
          el?.className === 'pe-team-role-seen' &&
            (el.textContent ?? '').includes('Last observed Jan 10, 2026'),
        ),
      ),
    ).toBeInTheDocument();
    // The additional (non-primary) role is listed compactly.
    expect(screen.getByText('Deputy PM · Program ownership context')).toBeInTheDocument();
  });

  test('empty roles → legacy display + pending note, no crash, no "owns PE"', () => {
    setupBrowserMocks();
    const { container } = render(<ProgramTeamPanel personnel={[personEmptyRoles]} />);

    // Legacy display still renders.
    expect(screen.getByText('Pat Lin')).toBeInTheDocument();
    expect(screen.getByText('Program Analyst · DARPA')).toBeInTheDocument();
    // Subtle muted pending note instead of a role chain.
    expect(screen.getByText('Role mapping pending review')).toBeInTheDocument();
    // The forbidden phrase never appears anywhere in the rendered output.
    expect(container.textContent ?? '').not.toContain('owns PE');
  });

  test('never renders the phrase "owns PE" even with a full role chain', () => {
    setupBrowserMocks();
    const { container } = render(<ProgramTeamPanel personnel={[personWithRoles]} />);
    expect(container.textContent ?? '').not.toContain('owns PE');
  });

  test('renders with 5 persons and link actions', () => {
    setupBrowserMocks();
    const onLink = vi.fn();
    render(
      <ProgramTeamPanel
        personnel={people}
        estimatedTotal={12}
        onViewAllSources={() => undefined}
        onLinkCrmContact={onLink}
      />,
    );

    expect(screen.getByText('Program team')).toBeInTheDocument();
        // Phase 5: no fabricated "~12 known" roster estimate — identified count only.
        expect(screen.getByTestId('pe-team-identified-count')).toHaveTextContent('5 identified people');
        expect(screen.queryByText(/of ~/)).toBeNull();
        expect(screen.getByText('View all sources →')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Link' })).toHaveLength(5);

    fireEvent.click(screen.getAllByRole('button', { name: 'Link' })[0]!);
    expect(onLink).toHaveBeenCalledWith('1');
  });

  test('shows empty state', () => {
    setupBrowserMocks();
    render(<ProgramTeamPanel personnel={[]} />);
    expect(screen.getByText('No team data found for this PE — log meeting contacts to build coverage')).toBeInTheDocument();
  });

  test('shows loading skeleton', () => {
    setupBrowserMocks();
    render(<ProgramTeamPanel personnel={[]} loading />);
    expect(screen.getByText('Program team')).toBeInTheDocument();
  });

  test('confidence pill colors follow threshold spec', () => {
    expect(confidencePillColor(0.95)).toBe('green');
    expect(confidencePillColor(0.9)).toBe('gold');
    expect(confidencePillColor(0.8)).toBe('gold');
    expect(confidencePillColor(0.79)).toBe('default');
  });
});
