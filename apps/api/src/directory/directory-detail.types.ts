/**
 * Deep-linkable member/staff/committee detail + unified-people contracts (Task 12).
 * Every observed LegiStorm person field is exposed through these typed sections —
 * NOT a raw source blob. Null vs. unavailable is kept distinct (see `availability`).
 */
import type { DirectoryCommittee } from './directory.service.js';
import type { DirectoryCommitteeMembership, DirectoryPersonType } from './directory-indexes.js';
import type { DirectoryPhotoRecord, DirectoryPhotoSource } from './directory-photo.js';

export interface DirectoryContactMethod {
  type: string | null;
  value: string;
  updatedAt: string | null;
}

export interface DirectoryMemberOffice {
  officeId: number | null;
  name: string | null;
  officeTypeId: string | null;
  state: string | null;
  district: string | null;
  party: string | null;
  senateClass: string | null;
  outgoingStatus: string | null;
  status: string | null;
  startDate: string | null;
  endDate: string | null;
  updatedAt: string | null;
}

export interface DirectoryLeadershipEntry {
  position: string | null;
  startDate: string | null;
  endDate: string | null;
  updatedAt: string | null;
}

export interface DirectoryStaffRoleEntry {
  memberId: number | null;
  roleName: string | null;
  updatedAt: string | null;
}

export interface DirectoryStaffIssueEntry {
  memberId: number | null;
  issueName: string | null;
  updatedAt: string | null;
}

export interface DirectoryStaffPositionMember {
  memberId: number | null;
  fullName: string | null;
  party: string | null;
  state: string | null;
  district: string | null;
  officeTypeId: string | null;
}

export interface DirectoryStaffPosition {
  officeId: number | null;
  officeName: string | null;
  memberId: number | null;
  title: string | null;
  positionType: string | null;
  isCurrent: boolean;
  isOnLeave: boolean;
  startDate: string | null;
  endDate: string | null;
  updatedAt: string | null;
  /** The member this position serves (null for committee/non-member offices). */
  member: DirectoryStaffPositionMember | null;
}

/** A physical office address block attached to a staffer (office_member_addresses). */
export interface DirectoryStaffOfficeAddress {
  addressId: number | null;
  officeId: number | null;
  officeName: string | null;
  label: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  zipExt: string | null;
  phone: string | null;
  fax: string | null;
  isMain: boolean;
  publicNotes: string | null;
  updatedAt: string | null;
}

/** A policy issue area a staffer covers (sourced from the member's staffer_issues). */
export interface DirectoryStaffIssueRef {
  issueName: string | null;
  memberId: number | null;
  memberName: string | null;
  updatedAt: string | null;
}

/** A functional role a staffer holds (sourced from the member's staffer_roles). */
export interface DirectoryStaffRoleRef {
  roleName: string | null;
  memberId: number | null;
  memberName: string | null;
  updatedAt: string | null;
}

export interface DirectoryStaffMemberAssociation {
  id: string;
  memberId: number;
  fullName: string;
  party: string | null;
  state: string | null;
  district: string | null;
}

export interface DirectoryMemberDetail {
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
    dateOfDeath: string | null;
    placeOfBirth: string | null;
    hometown: string | null;
    nativeOf: string | null;
    majMin: string | null;
    partyName: string | null;
    occupation: string | null;
    pronunciation: string | null;
    raceName: string | null;
    religionName: string | null;
  };
  photos: DirectoryPhotoRecord[];
  selectedPhotoUrl: string | null;
  photoSource: DirectoryPhotoSource;
  offices: DirectoryMemberOffice[];
  officeAddresses: DirectoryStaffOfficeAddress[];
  committees: DirectoryCommitteeMembership[];
  leaderships: DirectoryLeadershipEntry[];
  socialContacts: DirectoryContactMethod[];
  staffRoles: DirectoryStaffRoleEntry[];
  staffIssues: DirectoryStaffIssueEntry[];
  enrichments: {
    bioOverlay: boolean;
    pressOverlay: boolean;
  };
}

export interface DirectoryStaffDetail {
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
  bioDetails: {
    dob: string | null;
    dateOfDeath: string | null;
    hometown: string | null;
    placeOfBirth: string | null;
    nativeOf: string | null;
    majMin: string | null;
    partyName: string | null;
    occupation: string | null;
    pronunciation: string | null;
    raceName: string | null;
    religionName: string | null;
  };
  photoUrl: string | null;
  photoSource: DirectoryPhotoSource;
  emails: DirectoryContactMethod[];
  socialContacts: DirectoryContactMethod[];
  officeAddresses: DirectoryStaffOfficeAddress[];
  positions: DirectoryStaffPosition[];
  memberAssociations: DirectoryStaffMemberAssociation[];
  committeeAssociations: DirectoryCommitteeMembership[];
  /** Issue areas this staffer covers, aggregated from every member they serve. */
  issues: DirectoryStaffIssueRef[];
  /** Functional roles this staffer holds, aggregated from every member they serve. */
  roles: DirectoryStaffRoleRef[];
  availability: {
    photo: 'available' | 'not_provided';
    socialContacts: 'available' | 'not_provided';
  };
}

export interface DirectoryCommitteeRef {
  id: string;
  officeId: number;
  name: string;
  kind: DirectoryCommittee['kind'];
}

export interface DirectoryCommitteeDetail extends DirectoryCommittee {
  parentCommittee: DirectoryCommitteeRef | null;
  subcommittees: DirectoryCommitteeRef[];
  contacts: DirectoryCommitteeMembership[];
  memberCount: number;
  currentStaffCount: number;
}

export interface DirectoryPersonResult {
  personType: DirectoryPersonType;
  id: string;
  fullName: string;
  title: string;
  photoUrl: string | null;
  party: string | null;
  state: string | null;
  district: string | null;
  isCurrent: boolean;
  /** When a committee query matched via this person, the evidence for the match. */
  matchedVia?: { committeeId: string; committeeName: string; role: string | null } | null;
}

export interface DirectoryPeoplePayload {
  people: DirectoryPersonResult[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * WS-F, LegiStorm gaps/enrichment plan — one privately funded trip as seen
 * from a specific contact's profile. `role` is relative to THAT contact:
 * 'approver' when viewing the member who approved someone else's trip,
 * 'traveler' when viewing whoever actually traveled (member or staffer).
 * `otherPartyName` is always the OTHER party for that role, so either
 * profile reads as a complete, standalone summary.
 */
export interface DirectoryContactTripSummary {
  id: number;
  role: 'approver' | 'traveler';
  otherPartyName: string | null;
  companionName: string | null;
  startDate: string | null;
  endDate: string | null;
  durationDays: number | null;
  purpose: string | null;
  totalCost: number | null;
  destinations: Array<{ id: number; name: string | null; stateId: string | null }>;
  sponsors: Array<{ id: number; name: string | null }>;
  filedDate: string | null;
}

export interface DirectoryContactTripsPayload {
  contactId: string;
  trips: DirectoryContactTripSummary[];
}
