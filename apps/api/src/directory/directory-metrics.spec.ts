import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { RolesGuard } from '../auth/roles.guard.js';
import { DirectoryController } from './directory.controller.js';
import type { DirectoryContact } from './directory.types.js';
import { DirectoryService } from './directory.service.js';

jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
// Note writes are outside this read-only snapshot fixture and require a DB client.
jest.mock('./directory-note-command.js', () => ({}));

const start = new Date('2026-10-31T12:00:00.000Z');
function fixture(size = 501) {
  const service = new DirectoryService(
    { get: () => 'us-east-1' } as never,
    {} as never,
    {} as never,
  );
  (service as any).explicitPrefix = null;
  jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
  jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
  const members = Array.from({ length: size }, (_, id) => ({
    member: { member_id: id + 1, profile: { first_name: 'Fixture', last_name: String(id) } },
    member_offices: [{ status: 'In Office', state_id: 'VA', office_type_id: 'H', district_no: 1 }],
  }));
  const pointer = jest
    .spyOn(service as any, 'fetchJsonSafe')
    .mockImplementation(async (key: any) =>
      key.endsWith('LATEST.json')
        ? { snapshot_prefix: 'current', previous_snapshot_prefix: 'previous' }
        : null,
    );
  const fetch = jest
    .spyOn(service as any, 'fetchGzipJson')
    .mockImplementation(async (key: any) =>
      key.endsWith('member-list-current.json.gz') ? members : [],
    );
  jest.spyOn(service as any, 'loadBioOverlay').mockResolvedValue(new Map());
  jest.spyOn(service as any, 'loadPressOverlay').mockResolvedValue(new Map());
  // Never perform a provider call or initialize a DB in these unit fixtures.
  return { service, pointer, fetch };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(start);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('Directory full-population metrics and snapshot provenance', () => {
  test('counts the real complete contact population, beyond one page, without synthetic or staff inflation', async () => {
    const { service } = fixture();
    const metrics = await service.getMetrics();
    const page = await service.getContacts({ page: 1, pageSize: 1 });
    expect(page.contacts).toHaveLength(1);
    expect(page.total).toBe(501);
    expect(metrics).toMatchObject({
      count: 501,
      complete: true,
      capped: false,
      scope: 'global_catalog',
      snapshot: { state: 'current', publisherObservedAt: null, loadedAt: start.toISOString() },
    });
    expect(metrics.count).toBe(page.total);
    expect(JSON.stringify(metrics)).not.toContain('Fixture');
  });

  test('a complete empty publisher snapshot is zero, not a production QA contact', async () => {
    expect(await fixture(0).service.getMetrics()).toMatchObject({ count: 0, complete: true });
  });

  test('cached reads preserve original load/check times while count observation advances', async () => {
    const { service, fetch } = fixture(2);
    const first = await service.getMetrics();
    jest.setSystemTime(new Date(start.getTime() + 60_000));
    const second = await service.getMetrics();
    expect(second.snapshot).toEqual(first.snapshot);
    expect(second.observedAt).not.toEqual(first.observedAt);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test('failed latest load reports previous snapshot, including on cached reads', async () => {
    const { service, fetch } = fixture(0);
    fetch.mockImplementation(async (key: any) => {
      if (key.startsWith('current/')) throw new Error('synthetic failure');
      return [];
    });
    const result = await service.getMetrics();
    expect(result.snapshot.state).toBe('previous_fallback');
    expect(result.snapshot.sourceId).toMatch(/\/previous$/);
    expect((await service.getMetrics()).snapshot).toEqual(result.snapshot);
  });

  test('expired cache after source failure is stale with original source/load time', async () => {
    const { service, fetch } = fixture(3);
    const original = await service.getMetrics();
    jest.setSystemTime(new Date(start.getTime() + 31 * 60_000));
    fetch.mockRejectedValue(new Error('synthetic failure'));
    const stale = await service.getMetrics();
    expect(stale.count).toBe(original.count);
    expect(stale.snapshot).toMatchObject({
      sourceId: original.snapshot.sourceId,
      loadedAt: original.snapshot.loadedAt,
      state: 'stale_cache',
    });
    expect(stale.snapshot.checkedAt).not.toBe(original.snapshot.checkedAt);
  });

  test('no cache plus failed sources is unavailable, never zero', async () => {
    const { service, fetch } = fixture();
    fetch.mockRejectedValue(new Error('synthetic failure'));
    await expect(service.getMetrics()).rejects.toMatchObject({ status: 503 });
  });

  test('malformed snapshot populations are unavailable, not complete zero', async () => {
    const { service, fetch } = fixture(0);
    fetch.mockResolvedValue({ invalid: true });
    await expect(service.getMetrics()).rejects.toMatchObject({ status: 503 });
  });

  test('missing pointer uses the existing fallback with unknown freshness', async () => {
    const { service, pointer } = fixture(0);
    pointer.mockResolvedValue(null);
    expect((await service.getMetrics()).snapshot).toMatchObject({
      state: 'unknown',
      publisherObservedAt: null,
    });
  });

  test('an emergency pin is unconfirmed, not asserted latest', async () => {
    const { service } = fixture(0);
    (service as any).explicitPrefix = 'pinned';
    expect((await service.getMetrics()).snapshot).toMatchObject({
      state: 'unknown',
      publisherObservedAt: null,
    });
  });
});

test('the new global route retains the canonical standard-user guard and fails closed without identity', () => {
  const guard = new RolesGuard(new Reflector());
  const context = (role?: string) =>
    ({
      getHandler: () => DirectoryController.prototype.metrics,
      getClass: () => DirectoryController,
      switchToHttp: () => ({ getRequest: () => (role ? { tenantContext: { role } } : {}) }),
    }) as unknown as ExecutionContext;
  expect(() => guard.canActivate(context())).toThrow();
  expect(() => guard.canActivate(context('invalid-role'))).toThrow();
  expect(guard.canActivate(context('standard_user'))).toBe(true);
});

// Explicit test-only profile; production snapshot mapping never injects it.
const TEST_DIRECTORY_CONTACT: DirectoryContact = {
  id: 'test-member-capiro-profile',
  memberId: -1001,
  bioguideId: 'TEST001',
  fullName: 'Rep. Avery Testwell',
  memberName: 'Avery Testwell',
  honorific: 'Rep.',
  photoUrl: '',
  title: 'Member of Congress - Test Profile',
  office: 'Avery Testwell office (TS-1)',
  chamber: 'House',
  state: 'TS',
  district: 'TS-1',
  party: 'I',
  partyName: 'Independent',
  gender: 'Unknown',
  region: 'South',
  isFreshman: false,
  servingSince: '2021-01-03',
  focusAreas: ['Defense Innovation', 'Federal Procurement', 'Small Business'],
  committees: ['House Committee on Armed Services', 'House Committee on Small Business'],
  committeeLeadership: ['Chair — House Committee on Small Business'],
  topIssues: [
    { issue: 'Defense Innovation', stafferCount: 2 },
    { issue: 'Federal Procurement', stafferCount: 1 },
  ],
  leadershipPositions: ['Testing Caucus Co-Chair'],
  caucuses: ['Congressional Test Data Caucus', 'Defense Innovation Caucus'],
  educationInstitutions: ['Example State University', 'National Policy Institute'],
  senateClass: null,
  outgoingStatus: null,
  officeLocation: '123 Test House Office Building, Washington, DC 20515',
  phone: '202-555-0147',
  fax: '202-555-0199',
  email: 'avery.testwell@example.invalid',
  contactFormUrl: 'https://example.invalid/contact/avery-testwell',
  newsPressUrl: 'https://example.invalid/avery-testwell/press-releases',
  rssFeedUrl: '',
  rssSource: '',
  officialLinks: [
    {
      label: 'Website, official',
      url: 'https://example.invalid/avery-testwell',
      type: 'Website',
    },
    {
      label: 'Contact form',
      url: 'https://example.invalid/contact/avery-testwell',
      type: 'Email Form',
    },
    {
      label: 'Email, test',
      url: 'mailto:avery.testwell@example.invalid',
      type: 'Email',
    },
  ],
  addresses: [
    {
      id: 'test-main-office',
      title: 'Main Office',
      address1: '123 Test House Office Building',
      address2: '',
      city: 'Washington',
      state: 'DC',
      zip: '20515',
      phone: '202-555-0147',
      fax: '202-555-0199',
      isMain: true,
    },
    {
      id: 'test-district-office',
      title: 'District Office',
      address1: '456 Constituent Avenue',
      address2: 'Suite 200',
      city: 'Testville',
      state: 'TS',
      zip: '00001',
      phone: '202-555-0188',
      fax: '',
      isMain: false,
    },
  ],
  staff: [
    {
      id: 'test-staff-chief',
      fullName: 'Jordan Sample',
      title: 'Chief of Staff',
      roles: ['Chief of Staff', 'Leadership'],
      issueAreas: ['Defense Innovation', 'Appropriations'],
      email: 'jordan.sample@example.invalid',
      phone: '202-555-0151',
      officeLocation: '123 Test House Office Building',
      isCurrent: true,
    },
    {
      id: 'test-staff-leg',
      fullName: 'Morgan Example',
      title: 'Legislative Assistant',
      roles: ['Legislative Assistant'],
      issueAreas: ['Federal Procurement', 'Small Business', 'Technology'],
      email: 'morgan.example@example.invalid',
      phone: '202-555-0152',
      officeLocation: '123 Test House Office Building',
      isCurrent: true,
    },
  ],
  bio: {
    dob: '1979-05-15',
    hometown: 'Testville, TS',
    birthplace: 'Example City, TS',
    occupation: 'Attorney; former technology policy advisor',
    race: 'Not specified',
    religion: 'Not specified',
    pronunciation: 'AY-vuh-ree TEST-well',
    narrative:
      'Avery Testwell — Independent Representative, TS-1. Synthetic QA profile used to validate the directory member detail view.',
    education: 'Example State University (BA); Test School of Law (JD)',
    military: '',
    relatives: '',
  },
  lastTouchpoint: '2026-05-04',
  owner: 'Capiro Test Data',
  relationshipTier: 'Watch',
  notes: 'Synthetic directory profile for QA only.',
  recentInteractions: [
    {
      date: '2026-04-29',
      channel: 'Email',
      summary: 'Synthetic outreach record for interface testing.',
    },
  ],
};

test('QA contacts appear only when explicitly supplied by a test fixture', async () => {
  const { service } = fixture(0);
  jest
    .spyOn((service as any).contactMapper, 'buildContacts')
    .mockReturnValueOnce([TEST_DIRECTORY_CONTACT]);
  expect(await service.getMetrics()).toMatchObject({ count: 1 });
  expect((await service.getContacts()).contacts.map((c) => c.id)).toEqual([
    TEST_DIRECTORY_CONTACT.id,
  ]);
});
