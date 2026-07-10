import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  App,
  Avatar,
  Button,
  Card,
  Col,
  Drawer,
  Dropdown,
  Empty,
  Input,
  Modal,
  Pagination,
  Popover,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  Typography,
  type MenuProps,
} from 'antd';
import {
  BankOutlined,
  CopyOutlined,
  CheckOutlined,
  DownOutlined,
  HomeOutlined,
  LinkOutlined,
  MailOutlined,
  PhoneOutlined,
  SearchOutlined,
  SendOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../lib/use-api.js';
import { decodeHtmlEntities } from '../../lib/html-entities.js';
import { getAcquisitionPersonnel, getAcquisitionPersonnelDetail } from '../program-element/api.js';
import type { AcquisitionPersonnelDetail } from '../program-element/types.js';
import { DowDirectoryResults, DowPersonDrawer } from './DowDirectoryResults.js';
import {
  type DirectoryApiResponse,
  type DirectoryCommittee,
  type DirectoryCommitteesResponse,
  type DirectoryCommitteeStaffer,
  type DirectoryCommitteeStaffResponse,
  type DirectoryContactNote,
  type DirectoryEntry,
  type DirectoryStaffer,
  type DirectoryStaffersResponse,
  type Party,
} from './directoryData.js';

type FreshmanFilter = 'All' | 'Freshman' | 'Non-Freshman';
type ChamberFilter = DirectoryEntry['chamber'];
type GenderFilter = DirectoryEntry['gender'] | 'All';
type SortOption = 'recent' | 'name-asc' | 'name-desc' | 'state-asc' | 'chamber' | 'party';

const PAGE_SIZE = 12;
const SEARCH_DEBOUNCE_MS = 300;
const emptyFilters = [] as string[];

const SORT_OPTIONS: Array<{ value: SortOption; label: string; shortLabel: string }> = [
  { value: 'recent', label: 'Recently Updated', shortLabel: 'Recently Updated' },
  { value: 'name-asc', label: 'A–Z (Last Name)', shortLabel: 'A–Z' },
  { value: 'name-desc', label: 'Z–A (Last Name)', shortLabel: 'Z–A' },
  { value: 'chamber', label: 'Chamber', shortLabel: 'Chamber' },
  { value: 'party', label: 'Party', shortLabel: 'Party' },
  { value: 'state-asc', label: 'State', shortLabel: 'State' },
];

function partyColor(party: Party): string {
  if (party === 'D') return 'blue';
  if (party === 'R') return 'red';
  return 'default';
}

function partyLabel(party: Party): string {
  if (party === 'D') return 'Democrat';
  if (party === 'R') return 'Republican';
  return 'Independent';
}

function partyShortCode(party: Party): string | null {
  if (party === 'D' || party === 'R' || party === 'I') return party;
  return null;
}

function stateDistrict(entry: DirectoryEntry): string {
  const state = entry.state || '';
  const district = entry.district || '';
  if (!state) return district;
  if (district && !district.includes(state)) return `${state}-${district}`;
  return district || state;
}

function genderLabel(gender: DirectoryEntry['gender']): string {
  if (gender === 'F') return 'Female';
  if (gender === 'M') return 'Male';
  return 'Unknown';
}

function initials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function yearFromDate(date: string): string {
  if (!date) return 'Unknown';
  return date.slice(0, 4);
}

function romanNumeral(value: number | null): string {
  return value === 1 ? 'I' : value === 2 ? 'II' : value === 3 ? 'III' : '';
}

function formatNoteDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(date));
}

function noteAuthor(note: DirectoryContactNote): string {
  const fullName = [note.createdBy?.firstName, note.createdBy?.lastName].filter(Boolean).join(' ');
  return fullName || note.createdBy?.email || 'Former user';
}

function buildApiParams(filters: {
  query: string;
  freshman: FreshmanFilter;
  chamber: ChamberFilter[];
  party: Party[];
  gender: GenderFilter;
  leadership: string[];
  committee: string[];
  state: string[];
  district: string[];
  sort: SortOption;
  page: number;
  pageSize: number;
}) {
  const params: Record<string, string | number> = {
    page: filters.page,
    pageSize: filters.pageSize,
    sort: filters.sort,
  };

  if (filters.query.trim()) params.q = filters.query.trim();
  if (filters.freshman !== 'All') params.freshman = filters.freshman;
  if (filters.chamber.length > 0) params.chamber = filters.chamber.join(',');
  if (filters.party.length > 0) params.party = filters.party.join(',');
  if (filters.gender !== 'All') params.gender = filters.gender;
  if (filters.leadership.length > 0) params.leadership = filters.leadership.join(',');
  if (filters.committee.length > 0) params.committee = filters.committee.join(',');
  if (filters.state.length > 0) params.state = filters.state.join(',');
  if (filters.district.length > 0) params.district = filters.district.join(',');

  return params;
}

export function DirectoryPage() {
  const { message } = App.useApp();
  const api = useApi();
  const [searchParams, setSearchParams] = useSearchParams();

  const [searchText, setSearchText] = useState('');
  const [mode, setMode] = useState<'members' | 'staffers' | 'committees' | 'dow'>('members');
  const [stafferPage, setStafferPage] = useState(1);
  const [committeePage, setCommitteePage] = useState(1);
  const [committeeChamber, setCommitteeChamber] = useState<
    'House' | 'Senate' | 'Joint' | undefined
  >(undefined);
  const [selectedCommitteeId, setSelectedCommitteeId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [freshman, setFreshman] = useState<FreshmanFilter>('All');
  const [chamber, setChamber] = useState<ChamberFilter[]>([]);
  const [party, setParty] = useState<Party[]>([]);
  const [gender, setGender] = useState<GenderFilter>('All');
  const [leadership, setLeadership] = useState<string[]>([]);
  const [committee, setCommittee] = useState<string[]>([]);
  const [state, setState] = useState<string[]>([]);
  const [district, setDistrict] = useState<string[]>([]);
  const [issue, setIssue] = useState<string[]>([]);
  const [sort, setSort] = useState<SortOption>('recent');
  const [page, setPage] = useState(1);
  const selectedEntryId = searchParams.get('profile');

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setQuery(searchText);
      setPage(1);
      setStafferPage(1);
      setCommitteePage(1);
      setDowPage(1);
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(handle);
  }, [searchText]);

  const directoryQuery = useQuery({
    queryKey: [
      'directory-contacts',
      query,
      freshman,
      chamber,
      party,
      gender,
      leadership,
      committee,
      state,
      district,
      sort,
      page,
    ],
    queryFn: async () =>
      (
        await api.get<DirectoryApiResponse>('/api/directory/contacts', {
          params: buildApiParams({
            query,
            freshman,
            chamber,
            party,
            gender,
            leadership,
            committee,
            state,
            district,
            sort,
            page,
            pageSize: PAGE_SIZE,
          }),
        })
      ).data,
    staleTime: 5 * 60_000,
    placeholderData: (previous) => previous,
    retry: 1,
  });

  const staffersQuery = useQuery({
    queryKey: ['directory-staffers', query, chamber, state, issue, stafferPage],
    queryFn: async () =>
      (
        await api.get<DirectoryStaffersResponse>('/api/directory/staffers', {
          params: {
            q: query || undefined,
            chamber: chamber.length === 1 ? chamber[0] : undefined,
            state: state.length ? state : undefined,
            issue: issue.length ? issue.join(',') : undefined,
            page: stafferPage,
            pageSize: PAGE_SIZE,
          },
        })
      ).data,
    enabled: mode === 'staffers',
    staleTime: 5 * 60_000,
    placeholderData: (previous) => previous,
    retry: 1,
  });
  const staffers = staffersQuery.data?.staffers ?? [];
  const stafferTotal = staffersQuery.data?.total ?? 0;
  const stafferPageCurrent = staffersQuery.data?.page ?? stafferPage;
  const staffersLoading = staffersQuery.isLoading && !staffersQuery.data;

  // ── Committees (federal House/Senate/Joint committees + subcommittees) ───────
  const committeesQuery = useQuery({
    queryKey: ['directory-committees', query, committeeChamber, committeePage],
    queryFn: async () =>
      (
        await api.get<DirectoryCommitteesResponse>('/api/directory/committees', {
          params: {
            q: query || undefined,
            chamber: committeeChamber,
            page: committeePage,
            pageSize: PAGE_SIZE,
          },
        })
      ).data,
    enabled: mode === 'committees',
    staleTime: 5 * 60_000,
    placeholderData: (previous) => previous,
    retry: 1,
  });
  const committees = committeesQuery.data?.committees ?? [];
  const committeeTotal = committeesQuery.data?.total ?? 0;
  const committeePageCurrent = committeesQuery.data?.page ?? committeePage;
  const committeesLoading = committeesQuery.isLoading && !committeesQuery.data;

  const committeeStaffQuery = useQuery({
    queryKey: ['directory-committee-staff', selectedCommitteeId],
    queryFn: async () =>
      (
        await api.get<DirectoryCommitteeStaffResponse>(
          `/api/directory/committees/${encodeURIComponent(selectedCommitteeId as string)}/staff`,
          { params: { pageSize: 500 } },
        )
      ).data,
    enabled: selectedCommitteeId !== null,
    staleTime: 5 * 60_000,
  });

  // ── DoW Directory (AcquisitionPersonnel) browse mode ────────────────────────
  const DOW_PAGE_SIZE = PAGE_SIZE;
  const [dowPage, setDowPage] = useState(1);
  const [selectedDowPersonId, setSelectedDowPersonId] = useState<string | null>(null);
  // DoW filters. PE-aligned people surface first by default (sort: 'pe_first').
  const [dowService, setDowService] = useState<string | undefined>(undefined);
  const [dowRole, setDowRole] = useState<string | undefined>(undefined);
  const [dowPeAligned, setDowPeAligned] = useState<'aligned' | 'unaligned' | undefined>(undefined);

  const dowQuery = useQuery({
    queryKey: ['dow-directory', query, dowPage, dowService, dowRole, dowPeAligned],
    queryFn: async () =>
      getAcquisitionPersonnel(api, {
        q: query || undefined,
        service: dowService,
        role: dowRole,
        pe_aligned: dowPeAligned,
        sort: 'pe_first',
        page: dowPage,
        limit: DOW_PAGE_SIZE,
      }),
    enabled: mode === 'dow',
    staleTime: 5 * 60_000,
    placeholderData: (previous) => previous,
    retry: 1,
  });
  const dowPersons = dowQuery.data?.data ?? [];
  const dowTotal = dowQuery.data?.total ?? 0;
  const dowPageCurrent = dowQuery.data?.page ?? dowPage;
  const dowLoading = dowQuery.isLoading && !dowQuery.data;

  const dowDetailQuery = useQuery({
    queryKey: ['dow-directory-detail', selectedDowPersonId],
    queryFn: async (): Promise<AcquisitionPersonnelDetail> =>
      getAcquisitionPersonnelDetail(api, selectedDowPersonId as string),
    enabled: selectedDowPersonId !== null,
  });

  const entries = directoryQuery.data?.contacts ?? [];
  const totalFiltered = directoryQuery.data?.total ?? 0;
  const currentPage = directoryQuery.data?.page ?? page;
  const totals =
    directoryQuery.data?.totals ??
    ({
      all: 0,
      house: 0,
      senate: 0,
      governors: 0,
      staff: 0,
    } as const);
  const availableFilters = directoryQuery.data?.availableFilters;
  const hasSearch = Boolean(searchText.trim() || query.trim());
  const hasFilters =
    chamber.length > 0 ||
    party.length > 0 ||
    state.length > 0 ||
    committee.length > 0 ||
    district.length > 0 ||
    leadership.length > 0 ||
    gender !== 'All' ||
    freshman !== 'All';
  const initialLoading = directoryQuery.isLoading && !directoryQuery.data;
  const directoryUnavailable =
    directoryQuery.isError || (!initialLoading && !directoryQuery.isFetching && totals.all === 0);
  const filtersDisabled = initialLoading || directoryUnavailable;
  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.id === selectedEntryId) ?? null,
    [entries, selectedEntryId],
  );

  function openEntryProfile(entryId: string) {
    const next = new URLSearchParams(searchParams);
    next.set('profile', entryId);
    setSearchParams(next);
  }

  function closeEntryProfile() {
    const next = new URLSearchParams(searchParams);
    next.delete('profile');
    setSearchParams(next);
  }

  function clearFilters() {
    setFreshman('All');
    setChamber([]);
    setParty([]);
    setGender('All');
    setLeadership([]);
    setCommittee([]);
    setState([]);
    setDistrict([]);
    setPage(1);
  }

  function clearSearch() {
    setSearchText('');
    setQuery('');
    setPage(1);
  }

  function clearEmptyState() {
    if (hasFilters) clearFilters();
    if (hasSearch) clearSearch();
  }

  async function copyContact(value: string, label: string) {
    if (!value) {
      message.warning(`No ${label.toLowerCase()} on this profile.`);
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      message.success(`Copied ${label.toLowerCase()}.`);
    } catch {
      message.error('Clipboard copy failed in this browser context.');
    }
  }

  return (
    <div className="directory-page redesign">
      <header className="directory-page-head">
        <div>
          <h1>Directory</h1>
          <p className="directory-page-dek">
            All federal members of Congress and governors, updated daily from official sources.
          </p>
        </div>
      </header>

      <DirectoryStatsRow
        totals={totals}
        dowTotal={dowTotal}
        loading={initialLoading || directoryUnavailable}
      />

      <div className="directory-filter-bar" aria-label="Directory filters">
        <FilterPill
          label="Chamber"
          values={chamber}
          options={(availableFilters?.chambers ?? emptyFilters).map((value) => ({
            value,
            label: value,
          }))}
          disabled={filtersDisabled}
          onSelect={(value) => {
            setChamber((current) => toggleValue(current, value as ChamberFilter));
            setPage(1);
          }}
          onClear={() => {
            setChamber([]);
            setPage(1);
          }}
        />
        <FilterPill
          label="Party"
          values={party}
          options={(availableFilters?.parties ?? []).map((option) => ({
            value: option.value,
            label: option.label,
          }))}
          disabled={filtersDisabled}
          onSelect={(value) => {
            setParty((current) => toggleValue(current, value as Party));
            setPage(1);
          }}
          onClear={() => {
            setParty([]);
            setPage(1);
          }}
        />
        <FilterPill
          label="State"
          values={state}
          options={(availableFilters?.states ?? emptyFilters).map((value) => ({
            value,
            label: value,
          }))}
          disabled={filtersDisabled}
          onSelect={(value) => {
            setState((current) => toggleValue(current, value));
            setPage(1);
          }}
          onClear={() => {
            setState([]);
            setPage(1);
          }}
        />
        <FilterPill
          label="Committee"
          values={committee}
          options={(availableFilters?.committees ?? emptyFilters).map((value) => ({
            value,
            label: value,
          }))}
          disabled={filtersDisabled}
          onSelect={(value) => {
            setCommittee((current) => toggleValue(current, value));
            setPage(1);
          }}
          onClear={() => {
            setCommittee([]);
            setPage(1);
          }}
        />
        <Popover
          trigger="click"
          placement="bottomLeft"
          content={
            <div className="directory-more-filter-panel">
              <FilterPill
                label="District"
                values={district}
                options={(availableFilters?.districts ?? emptyFilters).map((value) => ({
                  value,
                  label: value,
                }))}
                disabled={filtersDisabled}
                onSelect={(value) => {
                  setDistrict((current) => toggleValue(current, value));
                  setPage(1);
                }}
                onClear={() => {
                  setDistrict([]);
                  setPage(1);
                }}
              />
              <FilterPill
                label="Leadership"
                values={leadership}
                options={(availableFilters?.leadership ?? emptyFilters).map((value) => ({
                  value,
                  label: value,
                }))}
                disabled={filtersDisabled}
                onSelect={(value) => {
                  setLeadership((current) => toggleValue(current, value));
                  setPage(1);
                }}
                onClear={() => {
                  setLeadership([]);
                  setPage(1);
                }}
              />
              <FilterPill
                label="Gender"
                values={gender === 'All' ? [] : [gender]}
                options={(availableFilters?.genders ?? []).map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
                disabled={filtersDisabled}
                onSelect={(value) => {
                  setGender(value as GenderFilter);
                  setPage(1);
                }}
                onClear={() => {
                  setGender('All');
                  setPage(1);
                }}
              />
              <FilterPill
                label="Freshman Status"
                values={freshman === 'All' ? [] : [freshman]}
                options={[
                  { value: 'Freshman', label: 'Freshman' },
                  { value: 'Non-Freshman', label: 'Non-Freshman' },
                ]}
                disabled={filtersDisabled}
                onSelect={(value) => {
                  setFreshman(value as FreshmanFilter);
                  setPage(1);
                }}
                onClear={() => {
                  setFreshman('All');
                  setPage(1);
                }}
              />
            </div>
          }
        >
          <button className="directory-filter-pill" type="button" disabled={filtersDisabled}>
            + More Filters <DownOutlined />
          </button>
        </Popover>
        <span className="directory-filter-spacer" />
        {hasFilters ? (
          <button className="directory-clear-filter-button" type="button" onClick={clearFilters}>
            Clear All
          </button>
        ) : null}
        <SortDropdown
          sort={sort}
          disabled={filtersDisabled}
          onChange={(value) => {
            setSort(value);
            setPage(1);
          }}
        />
      </div>

      <div style={{ marginBottom: 10 }}>
        <Segmented
          value={mode}
          disabled={initialLoading}
          onChange={(value) => setMode(value as 'members' | 'staffers' | 'committees' | 'dow')}
          options={[
            {
              label: `Members${totals.all ? ` · ${totals.all.toLocaleString()}` : ''}`,
              value: 'members',
            },
            {
              label: `Staffers${totals.staff ? ` · ${totals.staff.toLocaleString()}` : ''}`,
              value: 'staffers',
            },
            {
              label: `Committees${committeeTotal ? ` · ${committeeTotal.toLocaleString()}` : ''}`,
              value: 'committees',
            },
            {
              label: `DoW Directory${dowTotal ? ` · ${dowTotal.toLocaleString()}` : ''}`,
              value: 'dow',
            },
          ]}
        />
      </div>

      <div className="directory-search-row">
        <Input
          allowClear
          size="large"
          prefix={<SearchOutlined />}
          value={searchText}
          disabled={filtersDisabled}
          onChange={(event) => {
            setSearchText(event.target.value);
          }}
          onPressEnter={() => {
            setQuery(searchText);
            setPage(1);
            setStafferPage(1);
            setCommitteePage(1);
            setDowPage(1);
          }}
          placeholder={
            mode === 'staffers'
              ? 'Search staffers by name, title, role, issue area, or member'
              : mode === 'committees'
                ? 'Search committees by name or code'
                : mode === 'dow'
                  ? 'Search DoW directory by name'
                  : 'Search by name, office, committee, staff, phone, or email'
          }
        />
        <Typography.Text className="directory-result-count" type="secondary">
          {mode === 'staffers'
            ? resultCountText(stafferTotal, stafferPageCurrent)
            : mode === 'committees'
              ? resultCountText(committeeTotal, committeePageCurrent)
              : mode === 'dow'
                ? resultCountText(dowTotal, dowPageCurrent)
                : resultCountText(totalFiltered, currentPage)}
        </Typography.Text>
      </div>

      {mode === 'staffers' ? (
        <div
          className="dow-filter-bar"
          style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}
        >
          <Select
            allowClear
            mode="multiple"
            placeholder="Filter by issue area"
            style={{ minWidth: 280 }}
            value={issue}
            onChange={(value) => {
              setIssue(value as string[]);
              setStafferPage(1);
            }}
            options={(availableFilters?.issues ?? []).map((value) => ({ value, label: value }))}
            maxTagCount="responsive"
          />
          {issue.length ? (
            <Button
              type="text"
              onClick={() => {
                setIssue([]);
                setStafferPage(1);
              }}
            >
              Clear issues
            </Button>
          ) : null}
        </div>
      ) : null}

      {mode === 'dow' ? (
        <div
          className="dow-filter-bar"
          style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}
        >
          <Select
            allowClear
            placeholder="PE alignment"
            style={{ minWidth: 160 }}
            value={dowPeAligned}
            onChange={(v) => {
              setDowPeAligned(v as 'aligned' | 'unaligned' | undefined);
              setDowPage(1);
            }}
            options={[
              { value: 'aligned', label: 'PE-aligned' },
              { value: 'unaligned', label: 'Unaligned' },
            ]}
          />
          <Select
            allowClear
            placeholder="Service"
            style={{ minWidth: 150 }}
            value={dowService}
            onChange={(v) => {
              setDowService(v as string | undefined);
              setDowPage(1);
            }}
            options={[
              { value: 'ARMY', label: 'Army' },
              { value: 'NAVY', label: 'Navy' },
              { value: 'AF', label: 'Air Force' },
              { value: 'SF', label: 'Space Force' },
              { value: 'USMC', label: 'Marine Corps' },
              { value: 'OSD', label: 'OSD / Joint' },
              { value: 'DARPA', label: 'DARPA' },
              { value: 'CONGRESS', label: 'Congress' },
            ]}
          />
          <Select
            allowClear
            placeholder="Role"
            style={{ minWidth: 150 }}
            value={dowRole}
            onChange={(v) => {
              setDowRole(v as string | undefined);
              setDowPage(1);
            }}
            options={[
              { value: 'PEO', label: 'PEO / CPE' },
              { value: 'DPEO', label: 'Deputy PEO' },
              { value: 'PM', label: 'Program/Product Mgr' },
              { value: 'DPM', label: 'Deputy PM' },
              { value: 'PCO', label: 'Procuring KO' },
              { value: 'KO', label: 'Contracting Officer' },
              { value: 'CE', label: 'Chief Engineer' },
              { value: 'TD', label: 'Technical Director' },
              { value: 'DIRECTOR', label: 'Director' },
              { value: 'STAFFER', label: 'Staff' },
            ]}
          />
          {dowPeAligned || dowService || dowRole ? (
            <Button
              type="text"
              onClick={() => {
                setDowPeAligned(undefined);
                setDowService(undefined);
                setDowRole(undefined);
                setDowPage(1);
              }}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : null}

      {mode === 'committees' ? (
        <div
          className="dow-filter-bar"
          style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}
        >
          <Select
            allowClear
            placeholder="Chamber"
            style={{ minWidth: 160 }}
            value={committeeChamber}
            onChange={(value) => {
              setCommitteeChamber(value as 'House' | 'Senate' | 'Joint' | undefined);
              setCommitteePage(1);
            }}
            options={[
              { value: 'House', label: 'House' },
              { value: 'Senate', label: 'Senate' },
              { value: 'Joint', label: 'Joint' },
            ]}
          />
          {committeeChamber ? (
            <Button
              type="text"
              onClick={() => {
                setCommitteeChamber(undefined);
                setCommitteePage(1);
              }}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : null}

      {mode === 'dow' ? (
        <DowDirectoryResults
          persons={dowPersons}
          loading={dowLoading}
          total={dowTotal}
          page={dowPageCurrent}
          pageSize={DOW_PAGE_SIZE}
          isError={dowQuery.isError}
          onPage={setDowPage}
          onSelectPerson={setSelectedDowPersonId}
          onRetry={() => dowQuery.refetch()}
        />
      ) : mode === 'staffers' ? (
        <StafferResults
          staffers={staffers}
          loading={staffersLoading}
          fetching={staffersQuery.isFetching}
          total={stafferTotal}
          page={stafferPageCurrent}
          isError={staffersQuery.isError}
          onPage={setStafferPage}
          onClear={clearSearch}
          onCopy={copyContact}
          onRetry={() => staffersQuery.refetch()}
        />
      ) : mode === 'committees' ? (
        <CommitteeResults
          committees={committees}
          loading={committeesLoading}
          fetching={committeesQuery.isFetching}
          total={committeeTotal}
          page={committeePageCurrent}
          isError={committeesQuery.isError}
          onPage={setCommitteePage}
          onClear={clearSearch}
          onOpen={setSelectedCommitteeId}
          onRetry={() => committeesQuery.refetch()}
        />
      ) : initialLoading ? (
        <DirectoryLoadingState />
      ) : directoryUnavailable ? (
        <DirectoryEmptyState
          heading="Directory Unavailable"
          subtext="We couldn't load the directory. Please try again."
          actionLabel="Retry"
          onAction={() => directoryQuery.refetch()}
        />
      ) : entries.length === 0 ? (
        <DirectoryEmptyState
          heading="No Results Found"
          subtext={emptyStateSubtext(hasFilters, hasSearch)}
          actionLabel={emptyStateActionLabel(hasFilters)}
          onAction={hasFilters ? clearEmptyState : clearSearch}
        />
      ) : (
        <>
          {directoryQuery.isFetching ? (
            <div className="directory-grid-loading" aria-hidden="true">
              <Spin size="small" />
            </div>
          ) : null}
          <div className="directory-card-grid">
            {entries.map((entry) => (
              <DirectoryMemberCard
                key={entry.id}
                entry={entry}
                onOpen={() => openEntryProfile(entry.id)}
                onCopy={copyContact}
              />
            ))}
          </div>
          {totalFiltered > PAGE_SIZE ? (
            <div className="directory-pagination">
              <Pagination
                current={currentPage}
                pageSize={PAGE_SIZE}
                total={totalFiltered}
                onChange={(nextPage) => setPage(nextPage)}
                showSizeChanger={false}
              />
            </div>
          ) : null}
        </>
      )}

      <Modal
        className="directory-profile-modal"
        width={1120}
        open={selectedEntry !== null}
        onCancel={closeEntryProfile}
        footer={null}
        title={null}
        destroyOnClose
      >
        {selectedEntry ? (
          <>
            <section className="directory-profile-hero">
              <Avatar
                src={selectedEntry.photoUrl || undefined}
                size={86}
                shape="square"
                className="directory-profile-photo"
              >
                {initials(selectedEntry.memberName)}
              </Avatar>
              <div className="directory-profile-main">
                <Space size={8} wrap className="directory-profile-pills">
                  <Tag className="directory-profile-member-tag">
                    {selectedEntry.chamber || 'Member'}
                  </Tag>
                  {partyShortCode(selectedEntry.party) ? (
                    <span
                      className={`party-pill ${partyShortCode(selectedEntry.party)!.toLowerCase()}`}
                      title={partyLabel(selectedEntry.party)}
                    >
                      {partyShortCode(selectedEntry.party)}
                    </span>
                  ) : null}
                  {stateDistrict(selectedEntry) ? (
                    <span className="state-pill num">{stateDistrict(selectedEntry)}</span>
                  ) : null}
                </Space>
                <Typography.Title level={2}>{selectedEntry.fullName}</Typography.Title>
                <Typography.Text>{selectedEntry.title}</Typography.Text>
                <Typography.Text type="secondary">
                  Serving in {selectedEntry.chamber} since{' '}
                  {yearFromDate(selectedEntry.servingSince)}
                </Typography.Text>
              </div>
              <Space className="directory-profile-actions" wrap>
                <Button
                  aria-label="Copy email"
                  onClick={() => copyContact(selectedEntry.email, 'Email')}
                >
                  <MailOutlined />
                </Button>
                <Button
                  aria-label="Copy phone"
                  onClick={() => copyContact(selectedEntry.phone, 'Phone')}
                >
                  <PhoneOutlined />
                </Button>
                {selectedEntry.contactFormUrl ? (
                  <Button href={selectedEntry.contactFormUrl} target="_blank" rel="noreferrer">
                    Contact Form
                  </Button>
                ) : null}
              </Space>
            </section>

            <Tabs
              className="directory-profile-tabs"
              defaultActiveKey="contact"
              items={[
                {
                  key: 'contact',
                  label: 'Contact',
                  children: (
                    <Row gutter={[24, 24]}>
                      <Col xs={24} lg={15}>
                        <Typography.Title level={4}>Contact</Typography.Title>
                        <div className="directory-contact-panel">
                          <div>
                            <Typography.Text strong>Main Office</Typography.Text>
                            <Typography.Paragraph>
                              {selectedEntry.officeLocation || 'No public office address listed'}
                            </Typography.Paragraph>
                            <div className="directory-profile-contact-lines">
                              <CopyableTextRow
                                label="Phone"
                                value={selectedEntry.phone}
                                emptyText="N/A"
                                onCopy={copyContact}
                              />
                              <Typography.Text>Fax: {selectedEntry.fax || 'N/A'}</Typography.Text>
                              <CopyableTextRow
                                label="Email"
                                value={selectedEntry.email}
                                emptyText="No public email listed"
                                onCopy={copyContact}
                              />
                            </div>
                          </div>
                          <div>
                            <Typography.Text strong>Official Links</Typography.Text>
                            <Space
                              direction="vertical"
                              size={4}
                              style={{ display: 'flex', marginTop: 8 }}
                            >
                              {selectedEntry.officialLinks.slice(0, 8).map((link) => (
                                <a
                                  key={`${link.type}-${link.url}`}
                                  href={link.url}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {link.label}
                                </a>
                              ))}
                            </Space>
                          </div>
                        </div>

                        <Typography.Title level={4} style={{ marginTop: 28 }}>
                          Office Locations
                        </Typography.Title>
                        <div className="directory-address-list">
                          {selectedEntry.addresses.map((address) => (
                            <div key={address.id} className="directory-address-row">
                              <Typography.Text strong>{address.title || 'Office'}</Typography.Text>
                              <Typography.Text>
                                {[
                                  address.address1,
                                  address.address2,
                                  address.city,
                                  address.state,
                                  address.zip,
                                ]
                                  .filter(Boolean)
                                  .join(', ')}
                              </Typography.Text>
                              <Typography.Text type="secondary">
                                {address.phone || 'No phone'}{' '}
                                {address.fax ? `| Fax ${address.fax}` : ''}
                              </Typography.Text>
                            </div>
                          ))}
                        </div>
                      </Col>
                      <Col xs={24} lg={9}>
                        <Card className="directory-side-card" title="Snapshot">
                          <Space direction="vertical" size={10} style={{ display: 'flex' }}>
                            <Typography.Text>
                              Party: {selectedEntry.partyName} ({selectedEntry.party})
                            </Typography.Text>
                            <Typography.Text>
                              Gender: {genderLabel(selectedEntry.gender)}
                            </Typography.Text>
                            <Typography.Text>Region: {selectedEntry.region}</Typography.Text>
                            {selectedEntry.senateClass ? (
                              <Typography.Text>
                                Senate class: {romanNumeral(selectedEntry.senateClass)}
                              </Typography.Text>
                            ) : null}
                            {selectedEntry.outgoingStatus ? (
                              <Typography.Text type="warning">
                                {selectedEntry.outgoingStatus}
                              </Typography.Text>
                            ) : null}
                            <Typography.Text>
                              Last source update: {selectedEntry.lastTouchpoint}
                            </Typography.Text>
                          </Space>
                        </Card>
                        {selectedEntry.topIssues.length > 0 ? (
                          <Card
                            className="directory-side-card"
                            title="Top issues by staff coverage"
                          >
                            <Space size={[8, 8]} wrap>
                              {selectedEntry.topIssues.map((entry) => (
                                <Tag key={entry.issue} color="blue">
                                  {entry.issue} · {entry.stafferCount}
                                </Tag>
                              ))}
                            </Space>
                            <Typography.Paragraph
                              type="secondary"
                              style={{ fontSize: 11, margin: '10px 0 0', lineHeight: 1.4 }}
                            >
                              Number of this office's staffers tagged to each issue — a proxy for
                              where the office invests, not a complete policy position.
                            </Typography.Paragraph>
                          </Card>
                        ) : null}
                        <DirectoryNotesPanel entry={selectedEntry} />
                        <DirectoryRepresentationPanel entry={selectedEntry} />
                        <DirectoryFecPanel entry={selectedEntry} />
                      </Col>
                    </Row>
                  ),
                },
                {
                  key: 'staff',
                  label: 'Staff',
                  children: (
                    <div>
                      <Typography.Title level={4}>
                        {selectedEntry.fullName}'s Staff
                      </Typography.Title>
                      <div className="directory-staff-list">
                        {selectedEntry.staff.length > 0 ? (
                          <>
                            <div className="directory-staff-header" aria-hidden="true">
                              <span>Staffer</span>
                              <span>Roles &amp; Issue Areas</span>
                              <span>Phone</span>
                              <span>Email</span>
                            </div>
                            {selectedEntry.staff.map((staffer) => (
                              <div key={staffer.id} className="directory-staff-row">
                                <div className="directory-staff-person">
                                  <Typography.Text strong>{staffer.fullName}</Typography.Text>
                                  <Typography.Text type="secondary">
                                    {staffer.title}
                                  </Typography.Text>
                                </div>
                                <Space className="directory-staff-tags" size={[6, 6]} wrap>
                                  {staffer.roles.slice(0, 2).map((role) => (
                                    <Tag key={`${staffer.id}-${role}`}>{role}</Tag>
                                  ))}
                                  {staffer.issueAreas.slice(0, 3).map((issue) => (
                                    <Tag key={`${staffer.id}-${issue}`} color="blue">
                                      {issue}
                                    </Tag>
                                  ))}
                                </Space>
                                <StaffContactValue
                                  icon={<PhoneOutlined />}
                                  label="Phone"
                                  value={staffer.phone || selectedEntry.phone}
                                  emptyText="None listed"
                                  onCopy={copyContact}
                                />
                                <StaffContactValue
                                  icon={<MailOutlined />}
                                  label="Email"
                                  value={staffer.email}
                                  emptyText="None listed"
                                  onCopy={copyContact}
                                />
                              </div>
                            ))}
                          </>
                        ) : (
                          <Empty description="No staff records in source snapshot" />
                        )}
                      </div>
                    </div>
                  ),
                },
                {
                  key: 'bio',
                  label: 'Bio',
                  children: (
                    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
                      {selectedEntry.bio.narrative ? (
                        <Card size="small" className="directory-bio-card">
                          <Typography.Text type="secondary">Biography</Typography.Text>
                          <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-line' }}>
                            {selectedEntry.bio.narrative}
                          </Typography.Paragraph>
                        </Card>
                      ) : null}
                      <Row gutter={[24, 16]}>
                        {[
                          ['Born', selectedEntry.bio.dob],
                          ['Birthplace', selectedEntry.bio.birthplace],
                          ['Hometown', selectedEntry.bio.hometown],
                          ['Occupation', selectedEntry.bio.occupation],
                          ['Education', selectedEntry.bio.education],
                          ['Military Service', selectedEntry.bio.military],
                          ['Political Family', selectedEntry.bio.relatives],
                          ['Race', selectedEntry.bio.race],
                          ['Religion', selectedEntry.bio.religion],
                          ['Pronunciation', selectedEntry.bio.pronunciation],
                        ]
                          .filter(([, value]) => value)
                          .map(([label, value]) => (
                            <Col xs={24} sm={12} lg={8} key={label}>
                              <Card size="small" className="directory-bio-card">
                                <Typography.Text type="secondary">{label}</Typography.Text>
                                <Typography.Paragraph>{value || 'N/A'}</Typography.Paragraph>
                              </Card>
                            </Col>
                          ))}
                      </Row>
                    </Space>
                  ),
                },
                {
                  key: 'committees',
                  label: 'Committees',
                  children: (
                    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
                      {selectedEntry.committeeLeadership.length > 0 ? (
                        <div>
                          <Typography.Text strong>Leadership roles</Typography.Text>
                          <Space size={[8, 8]} wrap style={{ display: 'flex', marginTop: 8 }}>
                            {selectedEntry.committeeLeadership.map((role) => (
                              <Tag key={role} color="gold" className="directory-large-tag">
                                {role}
                              </Tag>
                            ))}
                          </Space>
                        </div>
                      ) : null}
                      <div>
                        {selectedEntry.committeeLeadership.length > 0 ? (
                          <Typography.Text strong>All committees</Typography.Text>
                        ) : null}
                        <Space size={[8, 8]} wrap style={{ display: 'flex', marginTop: 8 }}>
                          {selectedEntry.committees.length > 0 ? (
                            selectedEntry.committees.map((committee) => (
                              <Tag key={committee} className="directory-large-tag">
                                {committee}
                              </Tag>
                            ))
                          ) : (
                            <Empty description="No committee data in source snapshot" />
                          )}
                        </Space>
                      </div>
                    </Space>
                  ),
                },
                {
                  key: 'leadership',
                  label: 'Leadership',
                  children: (
                    <Space direction="vertical" size={12} style={{ display: 'flex' }}>
                      {selectedEntry.leadershipPositions.length > 0 ? (
                        selectedEntry.leadershipPositions.map((position) => (
                          <Card key={position} size="small" className="directory-leadership-card">
                            <Typography.Text strong>{position}</Typography.Text>
                          </Card>
                        ))
                      ) : (
                        <Empty description="No current leadership roles in source snapshot" />
                      )}
                    </Space>
                  ),
                },
                {
                  key: 'links',
                  label: 'Links',
                  children: (
                    <div className="directory-link-grid">
                      {selectedEntry.officialLinks.map((link) => (
                        <a
                          key={`${link.type}-${link.url}`}
                          href={link.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <LinkOutlined /> {link.label}
                        </a>
                      ))}
                    </div>
                  ),
                },
                {
                  key: 'news',
                  label: 'News',
                  children: <DirectoryNewsPanel entry={selectedEntry} />,
                },
              ]}
            />
          </>
        ) : null}
      </Modal>

      <DowPersonDrawer
        open={selectedDowPersonId !== null}
        person={dowDetailQuery.data ?? null}
        loading={dowDetailQuery.isLoading}
        onClose={() => setSelectedDowPersonId(null)}
      />

      <CommitteeStaffDrawer
        open={selectedCommitteeId !== null}
        committee={committeeStaffQuery.data?.committee ?? null}
        staff={committeeStaffQuery.data?.staff ?? []}
        total={committeeStaffQuery.data?.total ?? 0}
        loading={committeeStaffQuery.isLoading}
        onClose={() => setSelectedCommitteeId(null)}
        onCopy={copyContact}
      />
    </div>
  );
}

function DirectoryStatsRow({
  totals,
  dowTotal,
  loading,
}: {
  totals: DirectoryApiResponse['totals'];
  dowTotal: number;
  loading: boolean;
}) {
  const stats: Array<{
    label: string;
    value: number;
    tone: 'accent' | 'info' | 'notable' | 'muted';
    icon: ReactNode;
  }> = [
    { label: 'All Members', value: totals.all, tone: 'accent', icon: <TeamOutlined /> },
    { label: 'House', value: totals.house, tone: 'info', icon: <HomeOutlined /> },
    { label: 'Senate', value: totals.senate, tone: 'notable', icon: <BankOutlined /> },
    { label: 'Staffers', value: totals.staff, tone: 'muted', icon: <TeamOutlined /> },
    { label: 'DoW Directory', value: dowTotal, tone: 'info', icon: <BankOutlined /> },
  ];

  return (
    <div className="dir-stats">
      {stats.map((s) => (
        <div
          key={s.label}
          className={loading ? 'dir-stat is-loading' : 'dir-stat'}
          data-tone={s.tone}
        >
          <div>
            <div className="l">{s.label}</div>
            <div className="v num">{loading ? '-' : s.value.toLocaleString()}</div>
          </div>
          <div className="ico" aria-hidden>
            {s.icon}
          </div>
        </div>
      ))}
    </div>
  );
}

function FilterPill({
  label,
  values,
  options,
  disabled,
  onSelect,
  onClear,
}: {
  label: string;
  values: string[];
  options: Array<{ value: string; label: string }>;
  disabled: boolean;
  onSelect: (value: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const active = values.length > 0;
  const text = active ? activeFilterLabel(label, values, options) : label;
  const content = (
    <SearchableFilterMenu
      label={label}
      values={values}
      options={options}
      search={search}
      onSearch={setSearch}
      onSelect={(value) => {
        onSelect(value);
        setOpen(false);
      }}
    />
  );
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) setSearch('');
  };

  if (active) {
    return (
      <span className="directory-filter-pill-wrap is-active">
        <button
          className="directory-filter-pill directory-filter-pill--active"
          type="button"
          disabled={disabled}
          onClick={onClear}
          title={`Clear ${label}`}
        >
          {text}
        </button>
        <Popover
          arrow={false}
          content={content}
          open={open}
          overlayClassName="directory-filter-popover"
          placement="bottomLeft"
          trigger="click"
          onOpenChange={handleOpenChange}
        >
          <button
            className="directory-filter-pill-caret"
            type="button"
            disabled={disabled}
            aria-label={`Open ${label} filter options`}
            onClick={(event) => event.stopPropagation()}
          >
            <DownOutlined />
          </button>
        </Popover>
      </span>
    );
  }

  return (
    <Popover
      arrow={false}
      content={content}
      open={open}
      overlayClassName="directory-filter-popover"
      placement="bottomLeft"
      trigger="click"
      onOpenChange={handleOpenChange}
    >
      <button className="directory-filter-pill" type="button" disabled={disabled}>
        {label} <DownOutlined />
      </button>
    </Popover>
  );
}

function SortDropdown({
  sort,
  disabled,
  onChange,
}: {
  sort: SortOption;
  disabled: boolean;
  onChange: (value: SortOption) => void;
}) {
  const selected = SORT_OPTIONS.find((option) => option.value === sort) ?? SORT_OPTIONS[0];
  const menu: MenuProps = {
    items: SORT_OPTIONS.map((option) => ({
      key: option.value,
      label: option.label,
    })),
    onClick: ({ key }) => onChange(key as SortOption),
  };

  return (
    <Dropdown menu={menu} trigger={['click']} disabled={disabled}>
      <button className="directory-sort-pill" type="button" disabled={disabled}>
        Sort: {selected?.shortLabel ?? 'Recently Updated'} <DownOutlined />
      </button>
    </Dropdown>
  );
}

function DirectoryLoadingState() {
  return (
    <div className="directory-loading-state">
      <Spin />
      <Typography.Text>Loading Directory...</Typography.Text>
    </div>
  );
}

function DirectoryEmptyState({
  heading,
  subtext,
  actionLabel,
  onAction,
}: {
  heading: string;
  subtext: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="directory-empty-state">
      <Typography.Title level={4}>{heading}</Typography.Title>
      <Typography.Text type="secondary">{subtext}</Typography.Text>
      <Button onClick={onAction}>{actionLabel}</Button>
    </div>
  );
}

function DirectoryMemberCard({
  entry,
  onOpen,
  onCopy,
}: {
  entry: DirectoryEntry;
  onOpen: () => void;
  onCopy: (value: string, label: string) => Promise<void>;
}) {
  const partyShort = partyShortCode(entry.party);
  const stateCode = stateDistrict(entry);
  const servingYear = yearFromDate(entry.servingSince);
  return (
    <article
      className="dir-card directory-person-card"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="dir-card-top">
        <div className={`dir-card-avatar${entry.photoUrl ? ' has-photo' : ''}`}>
          {entry.photoUrl ? (
            <img src={entry.photoUrl} alt={entry.memberName} />
          ) : (
            <span>{initials(entry.memberName)}</span>
          )}
        </div>
        <div className="dir-card-title">
          <div className="dir-card-name">{entry.fullName}</div>
          <div className="dir-card-role">{entry.title}</div>
        </div>
      </div>

      <div>
        <div className="dir-card-office">{properCaseOfficeLine(entry.office)}</div>
        <div className="dir-card-meta">
          <span>{entry.chamber}</span>
          {partyShort ? (
            <>
              <span className="dir-sep">·</span>
              <span
                className={`party-pill ${partyShort.toLowerCase()}`}
                title={partyLabel(entry.party)}
              >
                {partyShort}
              </span>
              <span>{partyLabel(entry.party)}</span>
            </>
          ) : null}
          {stateCode ? (
            <>
              <span className="dir-sep">·</span>
              <span className="state-pill num">{stateCode}</span>
            </>
          ) : null}
        </div>
        {servingYear ? (
          <div className="dir-card-since">
            Serving Since <b className="num">{servingYear}</b>
            {entry.outgoingStatus ? (
              <Tag color="orange" style={{ marginLeft: 8 }}>
                {entry.outgoingStatus}
              </Tag>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="dir-contact">
        <CopyContactLine
          icon={<PhoneOutlined />}
          value={entry.phone}
          emptyText="No Public Phone"
          label="Phone"
          onCopy={onCopy}
        />
        <CopyContactLine
          icon={<MailOutlined />}
          value={entry.email || entry.contactFormUrl}
          emptyText="No Public Email"
          label={entry.email ? 'Email' : 'Contact Form'}
          onCopy={onCopy}
        />
      </div>

      <div className="dir-committee directory-card-meta">
        {(entry.leadershipPositions[0] || entry.committees[0] || entry.focusAreas[0]) ??
          'No Policy Coverage Listed'}
      </div>
    </article>
  );
}

function StafferResults({
  staffers,
  loading,
  fetching,
  total,
  page,
  isError,
  onPage,
  onClear,
  onCopy,
  onRetry,
}: {
  staffers: DirectoryStaffer[];
  loading: boolean;
  fetching: boolean;
  total: number;
  page: number;
  isError: boolean;
  onPage: (next: number) => void;
  onClear: () => void;
  onCopy: (value: string, label: string) => Promise<void>;
  onRetry: () => void;
}) {
  if (loading) return <DirectoryLoadingState />;
  if (isError) {
    return (
      <DirectoryEmptyState
        heading="Staffers Unavailable"
        subtext="We couldn't load staffers. Please try again."
        actionLabel="Retry"
        onAction={onRetry}
      />
    );
  }
  if (staffers.length === 0) {
    return (
      <DirectoryEmptyState
        heading="No Staffers Found"
        subtext="Try a different name, title, role, or issue area."
        actionLabel="Clear Search"
        onAction={onClear}
      />
    );
  }
  return (
    <>
      {fetching ? (
        <div className="directory-grid-loading" aria-hidden="true">
          <Spin size="small" />
        </div>
      ) : null}
      <div className="directory-card-grid">
        {staffers.map((staffer) => (
          <StafferCard
            key={`${staffer.id}-${staffer.member.id}`}
            staffer={staffer}
            onCopy={onCopy}
          />
        ))}
      </div>
      {total > PAGE_SIZE ? (
        <div className="directory-pagination">
          <Pagination
            current={page}
            pageSize={PAGE_SIZE}
            total={total}
            onChange={onPage}
            showSizeChanger={false}
          />
        </div>
      ) : null}
    </>
  );
}

function StafferCard({
  staffer,
  onCopy,
}: {
  staffer: DirectoryStaffer;
  onCopy: (value: string, label: string) => Promise<void>;
}) {
  const member = staffer.member;
  const partyShort = partyShortCode(member.party);
  const stateCode = member.district || member.state;
  const tags = [...staffer.roles.slice(0, 2), ...staffer.issueAreas.slice(0, 2)].filter(Boolean);
  return (
    <article className="dir-card directory-person-card">
      <div className="dir-card-top">
        <div className="dir-card-avatar">
          <span>{initials(staffer.fullName)}</span>
        </div>
        <div className="dir-card-title">
          <div className="dir-card-name">{staffer.fullName}</div>
          <div className="dir-card-role">{staffer.title || 'Staff'}</div>
        </div>
      </div>

      <div>
        <div className="dir-card-office">Works for {member.fullName}</div>
        <div className="dir-card-meta">
          <span>{member.chamber}</span>
          {partyShort ? (
            <>
              <span className="dir-sep">·</span>
              <span
                className={`party-pill ${partyShort.toLowerCase()}`}
                title={partyLabel(member.party)}
              >
                {partyShort}
              </span>
            </>
          ) : null}
          {stateCode ? (
            <>
              <span className="dir-sep">·</span>
              <span className="state-pill num">{stateCode}</span>
            </>
          ) : null}
        </div>
        {tags.length ? <div className="dir-card-since">{tags.join(' · ')}</div> : null}
      </div>

      <div className="dir-contact">
        <CopyContactLine
          icon={<PhoneOutlined />}
          value={staffer.phone}
          emptyText="No Public Phone"
          label="Phone"
          onCopy={onCopy}
        />
        <CopyContactLine
          icon={<MailOutlined />}
          value={staffer.email}
          emptyText="No Public Email"
          label="Email"
          onCopy={onCopy}
        />
      </div>

      <div className="dir-committee directory-card-meta">
        {staffer.issueAreas[0] || staffer.roles[0] || 'No Issue Coverage Listed'}
      </div>
    </article>
  );
}

function CommitteeResults({
  committees,
  loading,
  fetching,
  total,
  page,
  isError,
  onPage,
  onClear,
  onOpen,
  onRetry,
}: {
  committees: DirectoryCommittee[];
  loading: boolean;
  fetching: boolean;
  total: number;
  page: number;
  isError: boolean;
  onPage: (next: number) => void;
  onClear: () => void;
  onOpen: (committeeId: string) => void;
  onRetry: () => void;
}) {
  if (loading) return <DirectoryLoadingState />;
  if (isError) {
    return (
      <DirectoryEmptyState
        heading="Committees Unavailable"
        subtext="We couldn't load committees. Please try again."
        actionLabel="Retry"
        onAction={onRetry}
      />
    );
  }
  if (committees.length === 0) {
    return (
      <DirectoryEmptyState
        heading="No Committees Found"
        subtext="Try a different committee name, code, or chamber."
        actionLabel="Clear Search"
        onAction={onClear}
      />
    );
  }
  return (
    <>
      {fetching ? (
        <div className="directory-grid-loading" aria-hidden="true">
          <Spin size="small" />
        </div>
      ) : null}
      <div className="directory-card-grid">
        {committees.map((committee) => (
          <CommitteeCard
            key={committee.id}
            committee={committee}
            onOpen={() => onOpen(committee.id)}
          />
        ))}
      </div>
      {total > PAGE_SIZE ? (
        <div className="directory-pagination">
          <Pagination
            current={page}
            pageSize={PAGE_SIZE}
            total={total}
            onChange={onPage}
            showSizeChanger={false}
          />
        </div>
      ) : null}
    </>
  );
}

function CommitteeCard({
  committee,
  onOpen,
}: {
  committee: DirectoryCommittee;
  onOpen: () => void;
}) {
  return (
    <article
      className="dir-card directory-person-card"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="dir-card-top">
        <div className="dir-card-avatar">
          <BankOutlined />
        </div>
        <div className="dir-card-title">
          <div className="dir-card-name">{committee.name}</div>
          <div className="dir-card-role">
            {committee.chamber} {committee.kind === 'subcommittee' ? 'Subcommittee' : 'Committee'}
          </div>
        </div>
      </div>

      <div>
        <div className="dir-card-meta">
          <Tag>{committee.chamber}</Tag>
          {committee.kind === 'subcommittee' ? <Tag color="purple">Subcommittee</Tag> : null}
          {committee.committeeCode ? (
            <span className="state-pill num">{committee.committeeCode}</span>
          ) : null}
        </div>
        {committee.chair || committee.rankingMember ? (
          <div className="dir-card-since">
            {committee.chair ? `Chair: ${committee.chair.name}` : ''}
            {committee.chair && committee.rankingMember ? ' · ' : ''}
            {committee.rankingMember ? `Ranking: ${committee.rankingMember.name}` : ''}
          </div>
        ) : null}
      </div>

      <div className="dir-committee directory-card-meta">
        {committee.staffCount > 0
          ? `${committee.staffCount.toLocaleString()} current staffer${committee.staffCount === 1 ? '' : 's'}`
          : 'No staff in source snapshot'}
      </div>
    </article>
  );
}

function CommitteeStaffDrawer({
  open,
  committee,
  staff,
  total,
  loading,
  onClose,
  onCopy,
}: {
  open: boolean;
  committee: DirectoryCommittee | null;
  staff: DirectoryCommitteeStaffer[];
  total: number;
  loading: boolean;
  onClose: () => void;
  onCopy: (value: string, label: string) => Promise<void>;
}) {
  const currentCount = staff.filter((member) => member.isCurrent).length;
  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={640}
      destroyOnClose
      title={committee ? committee.name : 'Committee staff'}
    >
      {loading ? (
        <DirectoryLoadingState />
      ) : !committee ? (
        <Empty description="Committee not found in source snapshot" />
      ) : (
        <>
          <Space size={8} wrap style={{ marginBottom: 16 }}>
            <Tag>{committee.chamber}</Tag>
            <Tag color={committee.kind === 'subcommittee' ? 'purple' : 'blue'}>
              {committee.kind === 'subcommittee' ? 'Subcommittee' : 'Committee'}
            </Tag>
            {committee.committeeCode ? <Tag className="num">{committee.committeeCode}</Tag> : null}
            <Typography.Text type="secondary">
              {currentCount.toLocaleString()} current · {total.toLocaleString()} on record
            </Typography.Text>
          </Space>

          {committee.chair || committee.rankingMember || committee.phone ? (
            <div className="directory-contact-panel" style={{ marginBottom: 16 }}>
              {committee.chair ? (
                <Typography.Text>
                  <strong>Chair:</strong> {committee.chair.name}
                </Typography.Text>
              ) : null}
              {committee.rankingMember ? (
                <Typography.Text>
                  <strong>Ranking Member:</strong> {committee.rankingMember.name}
                </Typography.Text>
              ) : null}
              {committee.viceChairs.length ? (
                <Typography.Text>
                  <strong>Vice Chair{committee.viceChairs.length > 1 ? 's' : ''}:</strong>{' '}
                  {committee.viceChairs.join(', ')}
                </Typography.Text>
              ) : null}
              {committee.phone ? (
                <CopyableTextRow
                  label="Phone"
                  value={committee.phone}
                  emptyText="N/A"
                  onCopy={onCopy}
                />
              ) : null}
              {committee.officeLocation ? (
                <Typography.Text type="secondary">{committee.officeLocation}</Typography.Text>
              ) : null}
            </div>
          ) : null}

          {staff.length === 0 ? (
            <Empty description="No committee staff in source snapshot" />
          ) : (
            <div className="directory-staff-list">
              <div className="directory-staff-header" aria-hidden="true">
                <span>Staffer</span>
                <span>Status</span>
                <span>Phone</span>
                <span>Email</span>
              </div>
              {staff.map((member) => (
                <div key={member.id} className="directory-staff-row">
                  <div className="directory-staff-person">
                    <Typography.Text strong>{member.fullName}</Typography.Text>
                    <Typography.Text type="secondary">{member.title}</Typography.Text>
                  </div>
                  <Space className="directory-staff-tags" size={[6, 6]} wrap>
                    {member.isCurrent ? <Tag color="green">Current</Tag> : <Tag>Former</Tag>}
                  </Space>
                  <StaffContactValue
                    icon={<PhoneOutlined />}
                    label="Phone"
                    value={member.phone}
                    emptyText="None listed"
                    onCopy={onCopy}
                  />
                  <StaffContactValue
                    icon={<MailOutlined />}
                    label="Email"
                    value={member.email}
                    emptyText="None listed"
                    onCopy={onCopy}
                  />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}

function SearchableFilterMenu({
  label,
  values,
  options,
  search,
  onSearch,
  onSelect,
}: {
  label: string;
  values: string[];
  options: Array<{ value: string; label: string }>;
  search: string;
  onSearch: (value: string) => void;
  onSelect: (value: string) => void;
}) {
  const searchable = options.length > 10;
  const normalizedSearch = search.trim().toLowerCase();
  const visibleOptions = normalizedSearch
    ? options.filter(
        (option) =>
          option.label.toLowerCase().includes(normalizedSearch) ||
          option.value.toLowerCase().includes(normalizedSearch),
      )
    : options;

  return (
    <div
      className="directory-filter-menu"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {searchable ? (
        <Input
          allowClear
          autoFocus
          className="directory-filter-menu-search"
          placeholder={`Search ${label.toLowerCase()}...`}
          prefix={<SearchOutlined />}
          size="small"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        />
      ) : null}
      <div className="directory-filter-option-list">
        {visibleOptions.length ? (
          visibleOptions.map((option) => {
            const selected = values.includes(option.value);
            return (
              <button
                className={
                  selected ? 'directory-filter-option is-selected' : 'directory-filter-option'
                }
                key={option.value}
                type="button"
                onClick={() => onSelect(option.value)}
              >
                <span>{option.label}</span>
                {selected ? <CheckOutlined /> : null}
              </button>
            );
          })
        ) : (
          <Typography.Text className="directory-filter-menu-empty" type="secondary">
            {options.length ? 'No matching options' : 'No Options'}
          </Typography.Text>
        )}
      </div>
    </div>
  );
}

function activeFilterLabel(
  label: string,
  values: string[],
  options: Array<{ value: string; label: string }>,
): string {
  if (values.length > 1) return `${label}: ${values.length} Selected`;
  const value = values[0] ?? '';
  const optionLabel = options.find((option) => option.value === value)?.label ?? value;
  return `${label}: ${optionLabel}`;
}

function resultCountText(total: number, page: number): string {
  if (total === 0) return '0 results';
  const start = (page - 1) * PAGE_SIZE + 1;
  const end = Math.min(page * PAGE_SIZE, total);
  return `Showing ${start}–${end} of ${total}`;
}

function emptyStateSubtext(hasFilters: boolean, hasSearch: boolean): string {
  if (hasFilters && hasSearch) return 'Try adjusting your filters or search terms';
  if (hasFilters) return 'Try adjusting your filters';
  return 'Try adjusting your search terms';
}

function emptyStateActionLabel(hasFilters: boolean): string {
  return hasFilters ? 'Clear All Filters' : 'Clear Search';
}

function toggleValue<T extends string>(values: T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value].sort((left, right) => left.localeCompare(right));
}

function properCaseOfficeLine(value: string): string {
  return value
    .replace(/\boffice\b/g, 'Office')
    .replace(/\bsenate\b/g, 'Senate')
    .replace(/\bgovernor\b/g, 'Governor');
}

function CopyContactLine({
  icon,
  value,
  emptyText,
  label,
  onCopy,
}: {
  icon: ReactNode;
  value: string;
  emptyText: string;
  label: string;
  onCopy: (value: string, label: string) => Promise<void>;
}) {
  const copyValue = value.trim();
  return (
    <button
      className="directory-copy-line"
      type="button"
      disabled={!copyValue}
      onClick={(event) => {
        event.stopPropagation();
        void onCopy(copyValue, label);
      }}
      title={copyValue ? `Copy ${label.toLowerCase()}` : emptyText}
    >
      <span className="directory-copy-line-main">
        {icon}
        <span>{copyValue || emptyText}</span>
      </span>
      {copyValue ? <CopyOutlined /> : null}
    </button>
  );
}

function CopyableTextRow({
  label,
  value,
  emptyText,
  onCopy,
  compact = false,
}: {
  label: string;
  value: string;
  emptyText: string;
  onCopy: (value: string, label: string) => Promise<void>;
  compact?: boolean;
}) {
  const copyValue = value.trim();
  return (
    <span
      className={
        compact
          ? 'directory-copyable-text-row directory-copyable-text-row--compact'
          : 'directory-copyable-text-row'
      }
    >
      <Typography.Text>
        {compact ? null : `${label}: `}
        {copyValue || emptyText}
      </Typography.Text>
      {copyValue ? (
        <Button
          size="small"
          type="text"
          icon={<CopyOutlined />}
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() => void onCopy(copyValue, label)}
        />
      ) : null}
    </span>
  );
}

function StaffContactValue({
  icon,
  label,
  value,
  emptyText,
  onCopy,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  emptyText: string;
  onCopy: (value: string, label: string) => Promise<void>;
}) {
  const copyValue = value.trim();
  return (
    <span className="directory-staff-contact-value" title={copyValue ? `Copy ${label}` : emptyText}>
      <span className="directory-staff-contact-main">
        {icon}
        <Typography.Text type={copyValue ? undefined : 'secondary'}>
          {copyValue || emptyText}
        </Typography.Text>
      </span>
      {copyValue ? (
        <Button
          size="small"
          type="text"
          icon={<CopyOutlined />}
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() => void onCopy(copyValue, label)}
        />
      ) : null}
    </span>
  );
}

function DirectoryNotesPanel({ entry }: { entry: DirectoryEntry }) {
  const { message } = App.useApp();
  const api = useApi();
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');

  const notes = useQuery<DirectoryContactNote[]>({
    queryKey: ['directory-contact-notes', entry.id],
    queryFn: async () =>
      (
        await api.get<DirectoryContactNote[]>(
          `/api/directory/contacts/${encodeURIComponent(entry.id)}/notes`,
        )
      ).data,
    staleTime: 15_000,
  });

  const createNote = useMutation({
    mutationFn: async () =>
      (
        await api.post<DirectoryContactNote>(
          `/api/directory/contacts/${encodeURIComponent(entry.id)}/notes`,
          {
            body,
            directoryContactName: entry.fullName,
          },
        )
      ).data,
    onSuccess: async () => {
      setBody('');
      await queryClient.invalidateQueries({ queryKey: ['directory-contact-notes', entry.id] });
      message.success('Note added.');
    },
    onError: (error) => {
      message.error((error as Error).message || 'Could not add note.');
    },
  });

  const trimmedBody = body.trim();

  return (
    <Card className="directory-side-card directory-notes-card" title="Notes">
      <Space direction="vertical" size={12} style={{ display: 'flex' }}>
        <Input.TextArea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Add a tenant-visible note"
          maxLength={4000}
          showCount
          autoSize={{ minRows: 3, maxRows: 7 }}
        />
        <Button
          type="primary"
          icon={<SendOutlined />}
          loading={createNote.isPending}
          disabled={!trimmedBody}
          onClick={() => createNote.mutate()}
        >
          Add note
        </Button>

        {notes.isLoading ? <Spin size="small" /> : null}

        {!notes.isLoading && (notes.data?.length ?? 0) === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No notes yet" />
        ) : null}

        <div className="directory-note-list">
          {(notes.data ?? []).map((note) => (
            <div key={note.id} className="directory-note-preview">
              <Typography.Paragraph>{note.body}</Typography.Paragraph>
              <Typography.Text type="secondary">
                {formatNoteDate(note.createdAt)} by {noteAuthor(note)}
              </Typography.Text>
            </div>
          ))}
        </div>
      </Space>
    </Card>
  );
}

interface MemberNewsItem {
  id: string;
  title: string;
  link: string;
  publishedAt: string | null;
  summary: string;
}

interface MemberNewsPayload {
  contactId: string;
  memberName: string;
  newsPressUrl: string | null;
  rssFeedUrl: string | null;
  rssSource: string | null;
  items: MemberNewsItem[];
  lastSyncedAt: string | null;
  feedError: 'no_feed' | null;
}

function formatNewsDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * News tab: the member's recent press releases, pre-ingested into member_press_item
 * every ~3 days by the sync-member-press job (no live fetch on profile view). Each
 * item shows title + date + the feed's summary and links out to the full release.
 */
function DirectoryNewsPanel({ entry }: { entry: DirectoryEntry }) {
  const api = useApi();

  const query = useQuery<MemberNewsPayload>({
    queryKey: ['directory-contact-news', entry.id],
    queryFn: async () =>
      (
        await api.get<MemberNewsPayload>(
          `/api/directory/contacts/${encodeURIComponent(entry.id)}/news`,
        )
      ).data,
    staleTime: 5 * 60_000,
  });

  const data = query.data;
  const items = data?.items ?? [];

  const links = (
    <Space size={8} wrap style={{ marginBottom: 12 }}>
      {data?.newsPressUrl ? (
        <Button
          size="small"
          icon={<LinkOutlined />}
          href={data.newsPressUrl}
          target="_blank"
          rel="noreferrer"
        >
          Press page
        </Button>
      ) : null}
      {data?.rssFeedUrl ? (
        <Button
          size="small"
          icon={<LinkOutlined />}
          href={data.rssFeedUrl}
          target="_blank"
          rel="noreferrer"
        >
          RSS feed
        </Button>
      ) : null}
    </Space>
  );

  if (query.isLoading) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <>
        {links}
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            data?.feedError === 'no_feed' && !data?.newsPressUrl
              ? 'No news feed or press page on file for this member.'
              : 'No recent press releases.'
          }
        >
          {data?.newsPressUrl ? (
            <Button type="primary" href={data.newsPressUrl} target="_blank" rel="noreferrer">
              Open press page
            </Button>
          ) : null}
        </Empty>
      </>
    );
  }

  return (
    <>
      {links}
      <div className="directory-news-list">
        {items.map((item) => (
          <div key={item.id} className="directory-news-item">
            <a
              className="directory-news-item-title"
              href={item.link || data?.newsPressUrl || undefined}
              target="_blank"
              rel="noreferrer"
            >
              {decodeHtmlEntities(item.title)}
            </a>
            {item.publishedAt ? (
              <div className="directory-news-item-date">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {formatNewsDate(item.publishedAt)}
                </Typography.Text>
              </div>
            ) : null}
            {item.summary ? (
              <Typography.Paragraph
                type="secondary"
                style={{ margin: '4px 0 0' }}
                ellipsis={{ rows: 3 }}
              >
                {decodeHtmlEntities(item.summary)}
              </Typography.Paragraph>
            ) : null}
          </div>
        ))}
      </div>
      {data?.lastSyncedAt ? (
        <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 12 }}>
          Updated {formatNewsDate(data.lastSyncedAt)}
        </Typography.Text>
      ) : null}
    </>
  );
}

interface MemberFecSummary {
  contactId: string;
  memberName: string | null;
  matchQuality: 'name_approximate';
  clients: Array<{
    clientId: string;
    clientName: string;
    mappedEmployer: string;
    totalAmount: number;
    contributionCount: number;
    latestContributionDate: string | null;
  }>;
  summary: { totalAmount: number; contributionCount: number; clientCount: number };
  disclaimer: string;
}

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

interface MemberRepresentationSummary {
  clients: Array<{
    clientId: string;
    clientName: string;
    facilities: Array<{ id: string; name: string }>;
  }>;
}

/**
 * District Impact Engine (Phase 1 M1.4) — "Represents client facilities":
 * every client (tenant-wide) with a facility in this member's district.
 * Deterministic (bioguideId + district join) — NOT name-matched like the FEC
 * panel below, so no approximate-match disclaimer is needed.
 */
function DirectoryRepresentationPanel({ entry }: { entry: DirectoryEntry }) {
  const api = useApi();
  const query = useQuery<MemberRepresentationSummary>({
    queryKey: ['directory-contact-representation', entry.id],
    queryFn: async () =>
      (
        await api.get<MemberRepresentationSummary>(
          `/api/directory/contacts/${encodeURIComponent(entry.id)}/representation-summary`,
        )
      ).data,
    staleTime: 5 * 60_000,
  });
  const clients = query.data?.clients ?? [];
  if (!query.isLoading && clients.length === 0) return null;
  return (
    <Card className="directory-side-card" title="Represents client facilities">
      <Space direction="vertical" size={10} style={{ display: 'flex' }}>
        {query.isLoading ? (
          <Spin size="small" />
        ) : (
          clients.map((c) => (
            <div key={c.clientId} className="directory-note-preview">
              <Typography.Text strong>{c.clientName}</Typography.Text>
              <div>
                <Space size={[6, 6]} wrap>
                  {c.facilities.map((f) => (
                    <Tag key={f.id}>{f.name}</Tag>
                  ))}
                </Space>
              </div>
            </div>
          ))
        )}
      </Space>
    </Card>
  );
}

/**
 * Member-scoped FEC relationship: contributions to this member from the tenant's
 * mapped clients' employers. APPROXIMATE (name-matched) — clearly labeled — and
 * wrapped in the API-provided compliance disclaimer. Read-only context only.
 */
function DirectoryFecPanel({ entry }: { entry: DirectoryEntry }) {
  const api = useApi();
  const query = useQuery<MemberFecSummary>({
    queryKey: ['directory-contact-fec', entry.id],
    queryFn: async () =>
      (
        await api.get<MemberFecSummary>(
          `/api/directory/contacts/${encodeURIComponent(entry.id)}/fec-summary`,
        )
      ).data,
    staleTime: 5 * 60_000,
  });

  const data = query.data;
  const hasData = (data?.clients.length ?? 0) > 0;

  return (
    <Card
      className="directory-side-card"
      title={
        <Space size={8}>
          <span>Client FEC relationship</span>
          <Tag color="default" style={{ fontSize: 10 }}>
            approximate · name-matched
          </Tag>
        </Space>
      }
    >
      <Space direction="vertical" size={10} style={{ display: 'flex' }}>
        {query.isLoading ? (
          <Spin size="small" />
        ) : hasData ? (
          <>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatUsd(data!.summary.totalAmount)} across {data!.summary.contributionCount}{' '}
              contribution
              {data!.summary.contributionCount !== 1 ? 's' : ''} from {data!.summary.clientCount}{' '}
              mapped client
              {data!.summary.clientCount !== 1 ? 's' : ''}.
            </Typography.Text>
            <div className="directory-note-list">
              {data!.clients.map((c) => (
                <div key={c.clientId} className="directory-note-preview">
                  <Space
                    style={{ justifyContent: 'space-between', display: 'flex', width: '100%' }}
                  >
                    <Typography.Text strong>{c.clientName}</Typography.Text>
                    <Tag color="green">{formatUsd(c.totalAmount)}</Tag>
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    via employer {c.mappedEmployer} · {c.contributionCount} contribution
                    {c.contributionCount !== 1 ? 's' : ''}
                  </Typography.Text>
                </div>
              ))}
            </div>
          </>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No contributions from your mapped clients matched this member."
          />
        )}

        <Typography.Paragraph type="secondary" style={{ fontSize: 10, margin: 0, lineHeight: 1.4 }}>
          {data?.disclaimer ??
            'Source: public FEC filings, for informational purposes only — not legal or campaign-finance advice. ' +
              'Matches are approximate (by candidate name) and reflect individual filers, legally distinct from ' +
              'corporate/PAC giving. Not a recommendation to make any contribution. Verify at FEC.gov.'}
        </Typography.Paragraph>
      </Space>
    </Card>
  );
}
