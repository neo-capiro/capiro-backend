import { uniqueSorted } from './directory-collection.js';
import type {
  Chamber,
  Party,
  DirectoryContact,
  DirectorySort,
  DirectoryQuery,
  DirectoryPayload,
  DirectoryAvailableFilters,
  DirectoryStaffer,
  StaffersQuery,
  DirectoryStaffersPayload,
  DirectoryCommittee,
  CommitteesQuery,
  DirectoryCommitteesPayload,
  DirectoryCommitteeStaffer,
  CommitteeStaffQuery,
  DirectoryCommitteeStaffPayload,
} from './directory.types.js';

type DirectoryBrowseSource = Pick<
  DirectoryPayload,
  'sourceId' | 'contacts' | 'totals' | 'availableStates' | 'availableFilters'
>;

export class DirectoryBrowse {
  toStaffersPayload(
    staffers: DirectoryStaffer[],
    query: StaffersQuery,
    page: number,
    pageSize: number,
  ): DirectoryStaffersPayload {
    const q = String(query.q ?? '')
      .trim()
      .toLowerCase();
    const chamber = this.normalizeFilter(query.chamber);
    const states = this.normalizeMultiFilter(query.state);
    const issues = this.normalizeMultiFilter(query.issue);

    const filtered = staffers.filter((staffer) => {
      const blob = [
        staffer.fullName,
        staffer.title,
        staffer.email,
        staffer.phone,
        staffer.roles.join(' '),
        staffer.issueAreas.join(' '),
        staffer.member.memberName,
        staffer.member.fullName,
        staffer.member.state,
      ]
        .join(' ')
        .toLowerCase();
      const matchesQuery = q.length === 0 || blob.includes(q);
      const matchesChamber = chamber === null || staffer.member.chamber === chamber;
      const matchesState = states.length === 0 || states.includes(staffer.member.state);
      const matchesIssue =
        issues.length === 0 || staffer.issueAreas.some((area) => issues.includes(area));
      return matchesQuery && matchesChamber && matchesState && matchesIssue;
    });

    const total = filtered.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, pageCount);
    const start = (safePage - 1) * pageSize;
    return { staffers: filtered.slice(start, start + pageSize), total, page: safePage, pageSize };
  }

  toCommitteesPayload(
    committees: DirectoryCommittee[],
    query: CommitteesQuery,
    page: number,
    pageSize: number,
  ): DirectoryCommitteesPayload {
    const q = String(query.q ?? '')
      .trim()
      .toLowerCase();
    const chamber = this.normalizeFilter(query.chamber);
    const kind = this.normalizeFilter(query.kind);

    const filtered = committees.filter((committee) => {
      const matchesQuery =
        q.length === 0 ||
        committee.name.toLowerCase().includes(q) ||
        (committee.committeeCode ?? '').toLowerCase().includes(q);
      const matchesChamber = chamber === null || committee.chamber === chamber;
      const matchesKind = kind === null || committee.kind === kind;
      return matchesQuery && matchesChamber && matchesKind;
    });

    const total = filtered.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, pageCount);
    const start = (safePage - 1) * pageSize;
    return { committees: filtered.slice(start, start + pageSize), total, page: safePage, pageSize };
  }

  toCommitteeStaffPayload(
    committeeId: string,
    committees: DirectoryCommittee[],
    committeeStaff: Map<string, DirectoryCommitteeStaffer[]>,
    query: CommitteeStaffQuery,
    page: number,
    pageSize: number,
  ): DirectoryCommitteeStaffPayload {
    const committee = committees.find((entry) => entry.id === committeeId) ?? null;
    if (!committee) {
      return { committee: null, staff: [], total: 0, page: 1, pageSize };
    }

    const q = String(query.q ?? '')
      .trim()
      .toLowerCase();
    const roster = committeeStaff.get(committeeId) ?? [];
    const filtered = roster.filter((staffer) => {
      if (q.length === 0) return true;
      return staffer.fullName.toLowerCase().includes(q) || staffer.title.toLowerCase().includes(q);
    });

    const total = filtered.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, pageCount);
    const start = (safePage - 1) * pageSize;
    return {
      committee,
      staff: filtered.slice(start, start + pageSize),
      total,
      page: safePage,
      pageSize,
    };
  }

  toPagedPayload(
    base: DirectoryBrowseSource,
    query: DirectoryQuery,
    page: number,
    pageSize: number,
  ): DirectoryPayload {
    const chamber = this.normalizeFilter(query.chamber);
    const freshman = this.normalizeFilter(query.freshman);
    const gender = this.normalizeFilter(query.gender);
    const region = this.normalizeFilter(query.region);
    const parties = this.normalizeMultiFilter(query.party);
    const leadership = this.normalizeMultiFilter(query.leadership);
    const committees = this.normalizeMultiFilter(query.committee);
    const caucuses = this.normalizeMultiFilter(query.caucus);
    const states = this.normalizeMultiFilter(query.state);
    const districts = this.normalizeMultiFilter(query.district);
    const education = this.normalizeMultiFilter(query.education);
    const issues = this.normalizeMultiFilter(query.issue);
    const roles = this.normalizeMultiFilter(query.role);
    const normalizedQuery = String(query.q ?? '')
      .trim()
      .toLowerCase();
    // Tokenize so multi-word queries match in any order ("cruz ted" == "ted cruz")
    // and tolerate extra whitespace. A single token behaves exactly as before.
    const queryTokens = normalizedQuery.split(/\s+/).filter((t) => t.length > 0);
    const sort = this.normalizeSort(query.sort);

    // A blob matches if it contains the full query as a contiguous substring
    // (back-compat) OR — for multi-word queries — contains every token. Single-
    // token queries reduce to the old `includes` behavior.
    const blobMatches = (blob: string): boolean => {
      if (queryTokens.length === 0) return true;
      if (blob.includes(normalizedQuery)) return true;
      return queryTokens.length > 1 && queryTokens.every((token) => blob.includes(token));
    };

    // Why a contact matched the query: by the member's own fields, and/or via
    // specific staffers. `matchedStaff` lets the UI explain a result whose member
    // name doesn't contain the query (e.g. searching a staffer's first name).
    const matchInfo = new Map<
      string,
      { memberMatched: boolean; matchedStaff: Array<{ fullName: string; title: string }> }
    >();

    const filtered = base.contacts.filter((contact) => {
      const matchesFreshman =
        freshman === null ||
        (freshman === 'Freshman' && contact.isFreshman) ||
        (freshman === 'Non-Freshman' && !contact.isFreshman);
      const matchesChamber = chamber === null || contact.chamber === chamber;
      const matchesRegion = region === null || contact.region === region;
      const matchesGender = gender === null || contact.gender === gender;
      const matchesParty = parties.length === 0 || parties.includes(contact.party);
      const matchesState = states.length === 0 || states.includes(contact.state);
      const matchesDistrict = districts.length === 0 || districts.includes(contact.district);
      const matchesLeadership =
        leadership.length === 0 ||
        contact.leadershipPositions.some((position) => leadership.includes(position));
      const matchesCommittee =
        committees.length === 0 ||
        contact.committees.some((committee) => committees.includes(committee));
      const matchesCaucus =
        caucuses.length === 0 || contact.caucuses.some((caucus) => caucuses.includes(caucus));
      const matchesEducation =
        education.length === 0 ||
        contact.educationInstitutions.some((institution) => education.includes(institution));
      // Role and issue live on the roster, never on the member, so the office
      // qualifies on the strength of a single matching staffer. The same
      // staffer set is what the client then shows nested under the office —
      // matching here and narrowing there must use the same predicate. Both
      // short-circuit when unset, so an unfiltered read never walks a roster.
      const matchesIssue =
        issues.length === 0 ||
        contact.staff.some((staff) => staff.issueAreas.some((area) => issues.includes(area)));
      const matchesRole =
        roles.length === 0 ||
        contact.staff.some((staff) => staff.roles.some((role) => roles.includes(role)));

      // Cheap structured filters first; only build search blobs if those pass.
      if (
        !(
          matchesFreshman &&
          matchesChamber &&
          matchesRegion &&
          matchesGender &&
          matchesParty &&
          matchesState &&
          matchesDistrict &&
          matchesLeadership &&
          matchesCommittee &&
          matchesCaucus &&
          matchesEducation &&
          matchesIssue &&
          matchesRole
        )
      ) {
        return false;
      }

      // No free-text query → structured filters alone decide; no match metadata.
      if (queryTokens.length === 0) return true;

      const memberBlob = [
        contact.fullName,
        contact.memberName,
        contact.title,
        contact.office,
        contact.state,
        contact.district,
        contact.partyName,
        contact.phone,
        contact.email,
        contact.contactFormUrl,
        contact.focusAreas.join(' '),
        contact.committees.join(' '),
        contact.leadershipPositions.join(' '),
      ]
        .join(' ')
        .toLowerCase();

      const staffBlobs = contact.staff.map((staff) => ({
        staff,
        blob: (
          `${staff.fullName} ${staff.title} ${staff.email} ${staff.phone} ` +
          `${staff.roles.join(' ')} ${staff.issueAreas.join(' ')}`
        ).toLowerCase(),
      }));

      // Reproduces the legacy combined-blob `includes` match for member fields and
      // within a single staffer's fields, and adds order-independent tokens plus
      // staffer roles/issue-areas to the searchable text. (The one legacy match it
      // does not reproduce is a contiguous substring that spanned two adjacent
      // staffers — not a realistic free-text query.)
      const combinedBlob = `${memberBlob} ${staffBlobs.map((s) => s.blob).join(' ')}`;
      if (!blobMatches(combinedBlob)) return false;

      const memberMatched = blobMatches(memberBlob);
      const matchedStaff = staffBlobs
        .filter((s) => blobMatches(s.blob))
        .slice(0, 5)
        .map((s) => ({ fullName: s.staff.fullName, title: s.staff.title }));
      matchInfo.set(contact.id, { memberMatched, matchedStaff });
      return true;
    });

    let sorted = this.sortContacts(filtered, sort);
    // When searching, hoist offices whose own name/fields matched above offices
    // that matched only via a staffer — the member you typed should come first.
    // Array.prototype.sort is stable in V8, so the requested sort is preserved
    // within each group.
    if (queryTokens.length > 0) {
      sorted = sorted
        .slice()
        .sort(
          (a, b) =>
            Number(matchInfo.get(b.id)?.memberMatched ?? false) -
            Number(matchInfo.get(a.id)?.memberMatched ?? false),
        );
    }
    const total = sorted.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, pageCount);
    const start = (safePage - 1) * pageSize;
    // Attach the staffer match reason to the page slice only (shallow copy — the
    // cached contact objects are shared and must not be mutated).
    const contacts = sorted.slice(start, start + pageSize).map((contact) => {
      const info = matchInfo.get(contact.id);
      if (info && !info.memberMatched && info.matchedStaff.length > 0) {
        return { ...contact, matchedStaff: info.matchedStaff };
      }
      return contact;
    });

    return {
      sourceId: base.sourceId,
      contacts,
      total,
      page: safePage,
      pageSize,
      totals: base.totals,
      availableStates: base.availableStates,
      availableFilters: base.availableFilters,
    };
  }

  private sortContacts(entries: DirectoryContact[], sort: DirectorySort): DirectoryContact[] {
    const next = [...entries];

    if (sort === 'name-asc') {
      return next.sort((left, right) => this.compareLastName(left, right));
    }

    if (sort === 'name-desc') {
      return next.sort((left, right) => this.compareLastName(right, left));
    }

    if (sort === 'state-asc') {
      return next.sort((left, right) => {
        const stateCompare = left.state.localeCompare(right.state);
        return stateCompare !== 0 ? stateCompare : this.compareLastName(left, right);
      });
    }

    if (sort === 'chamber') {
      return next.sort((left, right) => {
        const chamberCompare = left.chamber.localeCompare(right.chamber);
        return chamberCompare !== 0 ? chamberCompare : this.compareLastName(left, right);
      });
    }

    if (sort === 'party') {
      return next.sort((left, right) => {
        const partyCompare = left.partyName.localeCompare(right.partyName);
        return partyCompare !== 0 ? partyCompare : this.compareLastName(left, right);
      });
    }

    return next.sort((left, right) => right.lastTouchpoint.localeCompare(left.lastTouchpoint));
  }

  private compareLastName(left: DirectoryContact, right: DirectoryContact): number {
    return this.lastNameSortKey(left.memberName).localeCompare(
      this.lastNameSortKey(right.memberName),
    );
  }

  private lastNameSortKey(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    const last = parts.at(-1) ?? name;
    const first = parts.slice(0, -1).join(' ');
    return `${last} ${first}`.toLowerCase();
  }

  buildAvailableFilters(contacts: DirectoryContact[]): DirectoryAvailableFilters {
    return {
      chambers: uniqueSorted(contacts.map((contact) => contact.chamber)) as Chamber[],
      parties: (
        [
          { value: 'D', label: 'Democrat' },
          { value: 'R', label: 'Republican' },
          { value: 'I', label: 'Independent' },
        ] satisfies Array<{ value: Party; label: string }>
      ).filter((party) => contacts.some((contact) => contact.party === party.value)),
      genders: [
        { value: 'F' as const, label: 'Female' },
        { value: 'M' as const, label: 'Male' },
      ].filter((gender) => contacts.some((contact) => contact.gender === gender.value)),
      leadership: uniqueSorted(contacts.flatMap((contact) => contact.leadershipPositions)),
      committees: uniqueSorted(contacts.flatMap((contact) => contact.committees)),
      // CRS issue taxonomy, derived from staffer issue tags across all members.
      issues: uniqueSorted(
        contacts.flatMap((contact) => contact.staff.flatMap((staffer) => staffer.issueAreas)),
      ),
      // Same derivation for roles, so the Role filter offers exactly the values
      // the `role` query parameter can actually match.
      roles: uniqueSorted(
        contacts.flatMap((contact) => contact.staff.flatMap((staffer) => staffer.roles)),
      ),
      // Caucus & Education have no backing data in the current snapshot (the
      // LegiStorm pull omits those endpoints). Emit empty arrays so the response
      // shape stays stable for consumers; the UI no longer renders these filters.
      caucuses: [],
      states: uniqueSorted(contacts.map((contact) => contact.state)),
      districts: uniqueSorted(
        contacts.map((contact) => contact.district),
        compareDistricts,
      ),
      educationInstitutions: [],
    };
  }

  private normalizeSort(raw: unknown): DirectorySort {
    const value = String(raw ?? 'recent');
    if (
      value === 'name-asc' ||
      value === 'name-desc' ||
      value === 'state-asc' ||
      value === 'chamber' ||
      value === 'party'
    )
      return value;
    return 'recent';
  }

  private normalizeFilter(raw: unknown): string | null {
    const value = String(raw ?? '').trim();
    if (!value || value.toLowerCase() === 'all') return null;
    return value;
  }

  private normalizeMultiFilter(raw: unknown): string[] {
    const values = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
    return uniqueSorted(
      values
        .map((value) => String(value).trim())
        .filter((value) => value.length > 0 && value.toLowerCase() !== 'all'),
    );
  }

  toPositiveInt(raw: unknown, fallback: number, max?: number): number {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    const intValue = Math.floor(parsed);
    if (max && intValue > max) return max;
    return intValue;
  }
}

function compareDistricts(left: string, right: string): number {
  const [leftState = '', leftDistrictRaw = '0'] = left.split('-');
  const [rightState = '', rightDistrictRaw = '0'] = right.split('-');
  const stateCompare = leftState.localeCompare(rightState);
  if (stateCompare !== 0) return stateCompare;
  return Number(leftDistrictRaw) - Number(rightDistrictRaw);
}
