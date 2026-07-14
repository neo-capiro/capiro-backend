import { describe, expect, test } from '@jest/globals';
import memberPage from './__fixtures__/member-page.json';
import officePage from './__fixtures__/office-page.json';
import staffPage from './__fixtures__/staff-page.json';
import {
  validateDirectorySnapshot,
  type DirectoryApprovalGate,
} from './directory-snapshot-validation.js';

function members(count: number, options: { photos?: number; committees?: number } = {}) {
  const photoCount = options.photos ?? count;
  const committeeCount = options.committees ?? count;
  return Array.from({ length: count }, (_, index) => ({
    ...structuredClone(memberPage[0]!),
    member: {
      ...structuredClone(memberPage[0]!.member),
      member_id: 1000 + index,
      bioguide_id: `X${String(index).padStart(6, '0')}`,
    },
    photos: index < photoCount ? structuredClone(memberPage[0]!.photos) : [],
    committees: index < committeeCount ? structuredClone(memberPage[0]!.committees) : [],
  }));
}

function staff(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    ...structuredClone(staffPage[0]!),
    staff: { ...structuredClone(staffPage[0]!.staff), id: 2000 + index },
  }));
}

function offices(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    ...structuredClone(officePage[0]!),
    office: { ...structuredClone(officePage[0]!.office), office_id: 3000 + index },
  }));
}

function input(previousCounts = { members: 10, staff: 20, offices: 20 }) {
  return {
    previous: {
      members: members(previousCounts.members),
      staff: staff(previousCounts.staff),
      offices: offices(previousCounts.offices),
    },
    next: {
      members: members(previousCounts.members),
      staff: staff(previousCounts.staff),
      offices: offices(previousCounts.offices),
    },
    retiredIds: { staff: [] as number[], office: [] as number[] },
  };
}

function approval(gates: DirectoryApprovalGate[]) {
  return {
    approvedBy: 'fixture-operator',
    approvedAt: '2026-07-13T03:30:00.000Z',
    reason: 'Reviewed source retirement reconciliation',
    gates,
  };
}

describe('validateDirectorySnapshot', () => {
  test('passes a healthy snapshot and emits aggregate metrics without source rows', () => {
    const report = validateDirectorySnapshot(input());

    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.metrics).toMatchObject({
      previous: { members: 10, staff: 20, offices: 20, committeeMemberships: 10 },
      next: { members: 10, staff: 20, offices: 20, committeeMemberships: 10 },
      memberPhotoCoverage: { previous: 1, next: 1 },
    });
    expect(JSON.stringify(report)).not.toContain('Alex');
    expect(report.gates.every((gate: { passed: boolean }) => gate.passed)).toBe(true);
  });

  test('rejects duplicate IDs, incomplete identities, and members without a current office', () => {
    const candidate = input();
    candidate.next.members[1]!.member.member_id = candidate.next.members[0]!.member.member_id;
    candidate.next.staff[0]!.staff.first_name = '';
    candidate.next.offices[0]!.office.name = '';
    candidate.next.members[2]!.member_offices = [];

    const report = validateDirectorySnapshot(candidate);

    expect(report.valid).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('duplicate member ID'),
        expect.stringContaining('malformed staff record'),
        expect.stringContaining('malformed office record'),
        expect.stringContaining('current office'),
      ]),
    );
  });

  test('enforces member 90–110% and unapproved staff/office five-percent count gates', () => {
    const candidate = input();
    candidate.next.members = members(8);
    candidate.next.staff = staff(18);
    candidate.next.offices = offices(18);

    const report = validateDirectorySnapshot(candidate);

    expect(report.valid).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('member count ratio'),
        expect.stringContaining('staff count fell'),
        expect.stringContaining('office count fell'),
      ]),
    );
    expect(report.gates.find((gate) => gate.name === 'identity-and-current-office')).toMatchObject({
      passed: true,
    });
  });

  test('requires tombstones for every removed staff and office identity even when counts are replaced', () => {
    const candidate = input();
    const replacementStaff = staff(2).map((record, index) => ({
      ...record,
      staff: { ...record.staff, id: 9000 + index },
    }));
    const replacementOffices = offices(2).map((record, index) => ({
      ...record,
      office: { ...record.office, office_id: 9100 + index },
    }));
    candidate.next.staff = [...staff(18), ...replacementStaff];
    candidate.next.offices = [...offices(18), ...replacementOffices];

    const missing = validateDirectorySnapshot(candidate);
    expect(missing.valid).toBe(false);
    expect(missing.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('staff identities removed without tombstones'),
        expect.stringContaining('office identities removed without tombstones'),
      ]),
    );

    candidate.retiredIds = { staff: [2018, 2019], office: [3018, 3019] };
    expect(validateDirectorySnapshot(candidate).valid).toBe(true);
  });

  test('requires a valid linked office and lets explicit inactive state override date heuristics', () => {
    const candidate = input();
    Object.assign(candidate.next.members[0]!, { member_offices: [{ is_current: true }] });
    Object.assign(candidate.next.members[1]!, {
      member_offices: [
        {
          office: { office_id: 950001, name: 'Former Office' },
          is_current: false,
          status: 'Former',
          end_date: '2100-01-01',
        },
      ],
    });

    const report = validateDirectorySnapshot(candidate);
    expect(report.valid).toBe(false);
    expect(report.errors.filter((error) => error.includes('current office'))).toHaveLength(2);
  });

  test('requires matching retired IDs and explicit approval for staff/office drops above five percent', () => {
    const candidate = input();
    candidate.next.staff = staff(18);
    candidate.next.offices = offices(18);
    candidate.retiredIds = { staff: [2018, 2019], office: [3018, 3019] };

    expect(validateDirectorySnapshot(candidate).valid).toBe(false);

    const approved = validateDirectorySnapshot({
      ...candidate,
      approval: approval(['staffCountDrop', 'officeCountDrop']),
    });
    expect(approved.valid).toBe(true);
    expect(approved.approval).toEqual(approval(['staffCountDrop', 'officeCountDrop']));
  });

  test('rejects committee-membership and photo-coverage regression beyond thresholds', () => {
    const candidate = input({ members: 20, staff: 20, offices: 20 });
    candidate.next.members = members(20, { photos: 18, committees: 17 });

    const report = validateDirectorySnapshot(candidate);

    expect(report.valid).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('committee membership count fell'),
        expect.stringContaining('member photo coverage fell'),
      ]),
    );

    const approved = validateDirectorySnapshot({
      ...candidate,
      approval: approval(['committeeMembershipDrop', 'photoCoverageDrop']),
    });
    expect(approved.valid).toBe(true);
  });

  test('rejects malformed approval provenance instead of honoring its gates', () => {
    const candidate = input();
    candidate.next.staff = staff(18);
    candidate.retiredIds.staff = [2018, 2019];

    const report = validateDirectorySnapshot({
      ...candidate,
      approval: { ...approval(['staffCountDrop']), approvedBy: '', reason: '' },
    });

    expect(report.valid).toBe(false);
    expect(report.errors).toContain('invalid directory validation approval provenance');
  });

  test.each([
    { approvedAt: 'bad' },
    {
      approvedBy: 42,
      approvedAt: '2026-07-13T03:30:00.000Z',
      reason: false,
      gates: 'staffCountDrop',
    },
  ])('fails closed for structurally malformed approval JSON', (approvalValue) => {
    const candidate = input();
    candidate.next.staff = staff(18);
    candidate.retiredIds.staff = [2018, 2019];

    expect(() =>
      validateDirectorySnapshot({ ...candidate, approval: approvalValue }),
    ).not.toThrow();
    const report = validateDirectorySnapshot({ ...candidate, approval: approvalValue });
    expect(report.valid).toBe(false);
    expect(report.approval).toBeNull();
    expect(report.errors).toContain('invalid directory validation approval provenance');
  });

  test('fails closed for a sparse approval gates array instead of honoring a hole', () => {
    const candidate = input();
    candidate.next.staff = staff(18);
    candidate.retiredIds.staff = [2018, 2019];

    // A sparse array: length 1 with an empty slot at index 0. Array.every() and the
    // Set constructor both skip holes, so the old code accepted this and serialized [null].
    const sparseGates = new Array(1) as DirectoryApprovalGate[];

    expect(() =>
      validateDirectorySnapshot({
        ...candidate,
        approval: { ...approval([]), gates: sparseGates },
      }),
    ).not.toThrow();
    const report = validateDirectorySnapshot({
      ...candidate,
      approval: { ...approval([]), gates: sparseGates },
    });
    expect(report.valid).toBe(false);
    expect(report.approval).toBeNull();
    expect(report.errors).toContain('invalid directory validation approval provenance');
  });

  test('rejects an approval gates array with a hole among otherwise-valid entries', () => {
    const candidate = input();
    candidate.next.staff = staff(18);
    candidate.retiredIds.staff = [2018, 2019];

    const gatesWithHole: DirectoryApprovalGate[] = ['staffCountDrop'];
    gatesWithHole[2] = 'officeCountDrop'; // leaves index 1 as a hole

    const report = validateDirectorySnapshot({
      ...candidate,
      approval: { ...approval([]), gates: gatesWithHole },
    });
    expect(report.valid).toBe(false);
    expect(report.approval).toBeNull();
    expect(report.errors).toContain('invalid directory validation approval provenance');
  });

  test('fails closed without throwing when an approval getter throws', () => {
    const candidate = input();
    candidate.next.staff = staff(18);
    candidate.retiredIds.staff = [2018, 2019];

    const hostileApproval = {
      approvedBy: 'fixture-operator',
      approvedAt: '2026-07-13T03:30:00.000Z',
      reason: 'Reviewed source retirement reconciliation',
      get gates(): DirectoryApprovalGate[] {
        throw new Error('hostile getter');
      },
    };

    expect(() =>
      validateDirectorySnapshot({ ...candidate, approval: hostileApproval }),
    ).not.toThrow();
    const report = validateDirectorySnapshot({ ...candidate, approval: hostileApproval });
    expect(report.valid).toBe(false);
    expect(report.approval).toBeNull();
    expect(report.errors).toContain('invalid directory validation approval provenance');
  });

  test('reports completeness metrics (Task 16) and no drift warning by default', () => {
    const report = validateDirectorySnapshot(input());
    expect(report.metrics.next).toMatchObject({
      uniqueBioguideIds: 10,
      membersWithCurrentOffice: 10,
      staffWithPhoto: 0, // honest zero — the entitlement returns no staff photo today
    });
    expect(report.warnings).toEqual([]);
  });

  test('warns (non-blocking) when the source starts returning a staff photo', () => {
    const candidate = input();
    (candidate.next.staff[0] as { photos?: unknown[] }).photos = [{ url: 'https://x.invalid/s.jpg' }];

    const report = validateDirectorySnapshot(candidate);
    expect(report.valid).toBe(true); // advisory only — does not block promotion
    expect(report.warnings.join(' ')).toMatch(/staff photo/i);
    expect(report.metrics.next.staffWithPhoto).toBe(1);
  });

  test('accepts exact boundary values without approval', () => {
    const candidate = input({ members: 20, staff: 20, offices: 20 });
    candidate.next.members = members(18, { photos: 18, committees: 18 });
    candidate.next.staff = staff(19);
    candidate.next.offices = offices(19);
    candidate.retiredIds = { staff: [2019], office: [3019] };

    const report = validateDirectorySnapshot(candidate);

    expect(report.valid).toBe(true);
  });
});
