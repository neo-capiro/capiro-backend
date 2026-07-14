/**
 * Directory detail + dictionary API client (Phase 5). Thin functions over the shared
 * axios instance (Clerk auth + base URL are injected by useApi()), mirroring the
 * program-element/api.ts convention. Types mirror the API's directory-detail contracts.
 */
import type { AxiosInstance } from 'axios';
import type { CommitteeChamber, CommitteeKind } from './directoryData.js';

export type DirectoryPersonType = 'member' | 'staff';

export interface DirectoryPhotoRecord {
  id: number | null;
  url: string;
  status: string | null;
  isPrimary: boolean;
  isDirectory: boolean;
  updatedAt: string | null;
}

export interface DirectoryPersonRef {
  personType: DirectoryPersonType;
  id: string;
  sourceId: number;
  fullName: string;
  title: string;
  photoUrl: string | null;
  photoSource: 'legistorm' | 'capiro_overlay' | null;
  party: string | null;
  state: string | null;
  district: string | null;
  isCurrent: boolean;
}

export interface DirectoryCommitteeMembership {
  committeeId: string;
  person: DirectoryPersonRef;
  membershipType: DirectoryPersonType;
  position: string | null;
  party: string | null;
  rank: number | null;
  status: string | null;
  startedAt: string | null;
  endedAt: string | null;
  sourceUpdatedAt: string | null;
}

export interface DirectoryContactMethod {
  type: string | null;
  value: string;
  updatedAt: string | null;
}

export interface MemberDetail {
  kind: 'member';
  id: string;
  source: { snapshotId: string; memberId: number; lastUpdatedAt: string | null };
  identity: {
    memberId: number;
    bioguideId: string;
    icpsrId: number | null;
    lisMemberId: string | null;
    firstName: string;
    lastName: string;
    preferredFirstName: string | null;
    preferredLastName: string | null;
    suffix: string | null;
    gender: string | null;
  };
  bioDetails: {
    dob: string | null;
    placeOfBirth: string | null;
    hometown: string | null;
    partyName: string | null;
    occupation: string | null;
    pronunciation: string | null;
    raceName: string | null;
    religionName: string | null;
  };
  photos: DirectoryPhotoRecord[];
  selectedPhotoUrl: string | null;
  photoSource: 'legistorm' | 'capiro_overlay' | null;
  offices: Array<{
    officeId: number | null;
    name: string | null;
    officeTypeId: string | null;
    state: string | null;
    district: string | null;
    party: string | null;
    status: string | null;
    startDate: string | null;
    endDate: string | null;
    updatedAt: string | null;
  }>;
  committees: DirectoryCommitteeMembership[];
  leaderships: Array<{ position: string | null; startDate: string | null; endDate: string | null; updatedAt: string | null }>;
  socialContacts: DirectoryContactMethod[];
  staffRoles: Array<{ memberId: number | null; roleName: string | null; updatedAt: string | null }>;
  staffIssues: Array<{ memberId: number | null; issueName: string | null; updatedAt: string | null }>;
  enrichments: { bioOverlay: boolean; pressOverlay: boolean };
}

export interface StaffDetail {
  kind: 'staff';
  id: string;
  source: { snapshotId: string; staffId: number; lastUpdatedAt: string | null };
  identity: {
    staffId: number;
    firstName: string;
    lastName: string;
    preferredFirstName: string | null;
    preferredLastName: string | null;
    suffix: string | null;
    gender: string | null;
  };
  bioDetails: { dob: string | null; partyName: string | null; occupation: string | null };
  photoUrl: string | null;
  photoSource: 'legistorm' | 'capiro_overlay' | null;
  emails: DirectoryContactMethod[];
  socialContacts: DirectoryContactMethod[];
  positions: Array<{
    officeId: number | null;
    officeName: string | null;
    memberId: number | null;
    title: string | null;
    positionType: string | null;
    isCurrent: boolean;
    startDate: string | null;
    endDate: string | null;
    updatedAt: string | null;
  }>;
  memberAssociations: Array<{ id: string; memberId: number; fullName: string }>;
  committeeAssociations: DirectoryCommitteeMembership[];
  availability: { photo: 'available' | 'not_provided'; socialContacts: 'available' | 'not_provided' };
}

export interface CommitteeRef {
  id: string;
  officeId: number;
  name: string;
  kind: CommitteeKind;
}

export interface CommitteeDetail {
  id: string;
  officeId: number;
  name: string;
  chamber: CommitteeChamber;
  kind: CommitteeKind;
  committeeCode: string | null;
  parentOfficeId: number | null;
  staffCount: number;
  phone: string;
  officeLocation: string;
  parentCommittee: CommitteeRef | null;
  subcommittees: CommitteeRef[];
  contacts: DirectoryCommitteeMembership[];
  memberCount: number;
  currentStaffCount: number;
}

export interface CommitteeContactsResponse {
  committee: CommitteeDetail | null;
  contacts: DirectoryCommitteeMembership[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PeopleResponse {
  people: DirectoryPersonRef[];
  total: number;
  page: number;
  pageSize: number;
}

export async function getMemberDetail(api: AxiosInstance, memberId: string): Promise<MemberDetail> {
  const { data } = await api.get<MemberDetail>(`/api/directory/members/${encodeURIComponent(memberId)}`);
  return data;
}

export async function getStaffDetail(api: AxiosInstance, staffId: string): Promise<StaffDetail> {
  const { data } = await api.get<StaffDetail>(`/api/directory/staffers/${encodeURIComponent(staffId)}`);
  return data;
}

export async function getCommitteeDetail(api: AxiosInstance, committeeId: string): Promise<CommitteeDetail> {
  const { data } = await api.get<CommitteeDetail>(
    `/api/directory/committees/${encodeURIComponent(committeeId)}`,
  );
  return data;
}

export async function getCommitteeContacts(
  api: AxiosInstance,
  committeeId: string,
  params: { personType?: string; current?: string; q?: string; role?: string; page?: number; pageSize?: number } = {},
): Promise<CommitteeContactsResponse> {
  const { data } = await api.get<CommitteeContactsResponse>(
    `/api/directory/committees/${encodeURIComponent(committeeId)}/contacts`,
    { params },
  );
  return data;
}

export async function searchPeople(
  api: AxiosInstance,
  params: { q?: string; committeeId?: string; personType?: string; current?: string; page?: number; pageSize?: number } = {},
): Promise<PeopleResponse> {
  const { data } = await api.get<PeopleResponse>('/api/directory/people', { params });
  return data;
}
