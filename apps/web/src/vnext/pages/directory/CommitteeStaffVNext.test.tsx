import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  DirectoryCommittee,
  DirectoryCommitteeStaffer,
} from '../../../pages/directory/directoryData.js';

const get = vi.fn();
const navigate = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

const { CommitteeStaffVNext } = await import('./CommitteeStaffVNext.js');

const COMMITTEE: DirectoryCommittee = {
  id: 'committee-1',
  officeId: 1,
  name: 'House Armed Services',
  chamber: 'House',
  kind: 'committee',
  committeeCode: 'HASC',
  parentOfficeId: null,
  staffCount: 2,
  chair: { id: 'm-1', name: 'Chair Person' },
  rankingMember: { id: 'm-2', name: 'Ranking Member' },
  viceChairs: [],
  phone: '',
  officeLocation: '',
};

function staffer(overrides: Partial<DirectoryCommitteeStaffer> = {}): DirectoryCommitteeStaffer {
  return {
    id: 'staff-1',
    fullName: 'Sam Diaz',
    title: 'Professional Staff',
    email: 'sam@house.gov',
    phone: '',
    officeLocation: '',
    isCurrent: true,
    committee: { id: 'committee-1', name: 'House Armed Services', chamber: 'House', kind: 'committee' },
    ...overrides,
  };
}

function renderAt(path = '/directory/committee-staff?view=roster') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/directory/committee-staff" element={<CommitteeStaffVNext />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockHappy(staff: DirectoryCommitteeStaffer[]) {
  get.mockImplementation((...args: unknown[]) => {
    const url = args[0] as string;
    if (url === '/api/directory/committees')
      return Promise.resolve({ data: { committees: [COMMITTEE], total: 1, page: 1, pageSize: 200 } });
    if (typeof url === 'string' && url.includes('/staff'))
      return Promise.resolve({ data: { committee: COMMITTEE, staff, total: staff.length, page: 1, pageSize: 500 } });
    if (url === undefined) return Promise.resolve({ data: {} });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

describe('Committee Staff vNext', () => {
  beforeEach(() => {
    get.mockReset();
    navigate.mockReset();
  });

  test('roster renders rows over the canonical committee-staff dataset', async () => {
    mockHappy([staffer()]);
    renderAt();
    await waitFor(() => expect(screen.getByText('Sam Diaz')).toBeTruthy());
    expect(screen.getAllByText(/House Armed Services/).length).toBeGreaterThan(0);
  });

  test('Open → resolves the canonical shared staff profile route', async () => {
    mockHappy([staffer()]);
    renderAt();
    await waitFor(() => expect(screen.getByText('Sam Diaz')).toBeTruthy());
    // Select the row, then open the profile from the rail.
    fireEvent.click(screen.getByText('Sam Diaz'));
    await waitFor(() => expect(screen.getByText('Open full profile')).toBeTruthy());
    fireEvent.click(screen.getByText('Open full profile'));
    // One canonical identity: /directory/staff/:id — never a committee-specific copy.
    expect(navigate).toHaveBeenCalledWith('/directory/staff/staff-1');
  });

  test('hierarchy view annotates non-source-backed affordances instead of faking them', async () => {
    mockHappy([staffer()]);
    renderAt('/directory/committee-staff');
    // Dashed working-relationship and muted vacancy legend entries are disabled.
    await waitFor(() => expect(screen.getAllByText(/not source-backed/i).length).toBe(2));
    // Leadership is source-backed and renders.
    await waitFor(() => expect(screen.getByText('Chair Person')).toBeTruthy());
  });
});
