import { selectCurrentMemberOffice } from './directory-indexes.js';
import { uniqueSorted } from './directory-collection.js';
import type {
  Chamber,
  Party,
  Region,
  DirectoryAddress,
  DirectoryLink,
  DirectoryStaffMember,
  DirectoryContact,
  MemberPressOverlay,
} from './directory.types.js';

interface StaffDetail {
  id: string;
  fullName: string;
  title: string;
  email: string;
  phone: string;
  officeLocation: string;
}

export interface MemberBioOverlay {
  narrative?: string;
  education?: string;
  military?: string;
  relatives?: string;
  first_elected?: string | number;
  years_in_congress?: string | number;
  total_terms?: string | number;
  party_leadership?: string[];
  wikipedia?: string;
}

export class DirectoryContactMapper {
  buildContacts(
    membersRaw: unknown[],
    staffRaw: unknown[],
    bioOverlay: Map<string, MemberBioOverlay> = new Map(),
    pressOverlay: Map<string, MemberPressOverlay> = new Map(),
  ): DirectoryContact[] {
    const members = Array.isArray(membersRaw) ? membersRaw : [];
    const staffById = this.buildStaffDetailsById(staffRaw);
    const staffIdsByMember = this.buildStaffIdsByMember(staffRaw);
    const contacts: DirectoryContact[] = [];

    for (const row of members as any[]) {
      const member = row?.member;
      const memberId = Number(member?.member_id);
      if (!Number.isFinite(memberId)) continue;

      const profile = member?.profile;
      const memberName = [
        profile?.preferred_first_name ?? profile?.first_name,
        profile?.preferred_last_name ?? profile?.last_name,
      ]
        .filter(Boolean)
        .join(' ')
        .trim();
      if (!memberName) continue;

      const currentOffice = this.currentMemberOffice(row?.member_offices);
      if (!currentOffice) continue;

      const state = String(currentOffice.state_id ?? '').toUpperCase();
      const chamber = this.mapChamber(String(currentOffice.office_type_id ?? '').toUpperCase());
      const district = this.formatDistrict(chamber, state, currentOffice.district_no);
      const partyName = String(currentOffice.party ?? profile?.bio_details?.party_name ?? '');
      const party = this.mapParty(partyName);
      const honorific = this.honorific(chamber);
      const fullName = `${honorific} ${memberName}`;
      const title = this.primaryTitle(chamber, row?.leaderships);

      const addresses = this.buildAddresses(row?.office_member_addresses);
      const mainAddress = addresses.find((address) => address.isMain) ?? addresses[0];
      const officialLinks = this.buildLinks(row?.social_media);
      const email =
        officialLinks.find(
          (link) => link.type.toLowerCase().includes('email') && link.url.includes('@'),
        )?.url ?? '';
      const contactFormUrl =
        officialLinks.find(
          (link) =>
            link.type.toLowerCase().includes('email') &&
            !link.url.includes('@') &&
            link.url.startsWith('http'),
        )?.url ?? '';
      const committees = this.buildCommittees(row?.committees);
      const committeeLeadership = this.buildCommitteeLeadershipLabels(row?.committees);
      const leadershipPositions = this.buildLeadership(row?.leaderships);
      const staff = this.buildMemberStaff(row, staffById, staffIdsByMember.get(memberId) ?? []);
      const focusAreas = uniqueSorted(staff.flatMap((staffer) => staffer.issueAreas)).slice(0, 12);
      const topIssues = this.buildTopIssues(staff);
      const servingSince = this.servingSince(row?.member_offices);
      const photoUrl = this.primaryPhoto(row?.photos);
      const senateClass = this.parseSenateClass(currentOffice.senate_class);
      const outgoingStatus = currentOffice.outgoing_status
        ? String(currentOffice.outgoing_status)
        : null;
      const press = pressOverlay.get(String(member?.bioguide_id ?? ''));

      contacts.push({
        id: `member-${memberId}`,
        memberId,
        bioguideId: String(member?.bioguide_id ?? ''),
        fullName,
        memberName,
        honorific,
        photoUrl,
        title,
        office: this.formatOfficeLabel(chamber, memberName, state, currentOffice.district_no),
        chamber,
        state: state || 'DC',
        district,
        party,
        partyName: partyName || this.partyLabel(party),
        gender: this.mapGender(profile?.gender),
        region: this.mapRegion(state),
        isFreshman: this.isFreshman(servingSince),
        servingSince,
        focusAreas,
        committees,
        committeeLeadership,
        topIssues,
        leadershipPositions,
        caucuses: this.buildNamedList(row?.caucuses),
        educationInstitutions: this.buildEducation(row),
        senateClass,
        outgoingStatus,
        officeLocation: mainAddress ? this.formatAddress(mainAddress) : '',
        phone: mainAddress?.phone ?? '',
        fax: mainAddress?.fax ?? '',
        email,
        contactFormUrl,
        newsPressUrl: press?.newsPressUrl ?? '',
        rssFeedUrl: press?.rssFeedUrl ?? '',
        rssSource: press?.rssSource ?? '',
        officialLinks,
        addresses,
        staff,
        bio: {
          dob: String(profile?.bio_details?.dob ?? ''),
          hometown: String(profile?.bio_details?.hometown ?? ''),
          birthplace: String(profile?.bio_details?.pob ?? ''),
          occupation: String(profile?.bio_details?.occupation ?? ''),
          race: String(profile?.bio_details?.race_name ?? ''),
          religion: String(profile?.bio_details?.religion_name ?? ''),
          pronunciation: String(profile?.bio_details?.pronunciation ?? ''),
          narrative: String(bioOverlay.get(String(member?.bioguide_id ?? ''))?.narrative ?? ''),
          education: String(bioOverlay.get(String(member?.bioguide_id ?? ''))?.education ?? ''),
          military: String(bioOverlay.get(String(member?.bioguide_id ?? ''))?.military ?? ''),
          relatives: String(bioOverlay.get(String(member?.bioguide_id ?? ''))?.relatives ?? ''),
        },
        lastTouchpoint: this.latestDate([
          currentOffice.updated_at,
          mainAddress?.id
            ? row?.office_member_addresses?.find?.((a: any) => String(a?.id) === mainAddress.id)
                ?.updated_at
            : undefined,
          ...(Array.isArray(row?.social_media)
            ? row.social_media.map((link: any) => link?.updated_at)
            : []),
          ...(Array.isArray(row?.committees)
            ? row.committees.map((committee: any) => committee?.updated_at)
            : []),
          ...(Array.isArray(row?.leaderships)
            ? row.leaderships.map((leadership: any) => leadership?.updated_at)
            : []),
        ]),
        owner: 'Unassigned',
        relationshipTier:
          leadershipPositions.length > 0 ? 'Core' : committees.length > 0 ? 'Active' : 'Watch',
        notes: '',
        recentInteractions: [],
      });
    }

    return contacts.sort((a, b) => a.memberName.localeCompare(b.memberName));
  }

  private buildStaffDetailsById(staffRaw: unknown[]): Map<number, StaffDetail> {
    const staffById = new Map<number, StaffDetail>();
    const staffList = Array.isArray(staffRaw) ? staffRaw : [];

    for (const row of staffList as any[]) {
      const staff = row?.staff;
      const staffId = Number(staff?.id);
      if (!Number.isFinite(staffId)) continue;

      const fullName = [
        staff?.preferred_first_name ?? staff?.first_name,
        staff?.preferred_last_name ?? staff?.last_name,
      ]
        .filter(Boolean)
        .join(' ')
        .trim();
      if (!fullName) continue;

      const positions = Array.isArray(row?.positions) ? row.positions : [];
      const currentPosition =
        positions.find((position: any) => position?.is_current && position?.position_title) ??
        positions.find((position: any) => position?.position_title) ??
        positions[0];
      const emails = Array.isArray(row?.staff_emails) ? row.staff_emails : [];
      const emailRecord = emails.find(
        (email: any) =>
          typeof email?.contact_string === 'string' && email.contact_string.includes('@'),
      );
      const addresses = Array.isArray(row?.office_member_addresses)
        ? row.office_member_addresses
        : [];
      const address = addresses.find((entry: any) => entry?.is_main) ?? addresses[0];

      staffById.set(staffId, {
        id: `staff-${staffId}`,
        fullName,
        title: String(currentPosition?.position_title ?? currentPosition?.position_type ?? 'Staff'),
        email: String(emailRecord?.contact_string ?? ''),
        phone: String(address?.phone ?? ''),
        officeLocation: [address?.address1, address?.city, address?.state_id]
          .filter(Boolean)
          .join(', '),
      });
    }

    return staffById;
  }

  // member_id -> staffIds with a CURRENT position in that member's office, from
  // staff-list `positions[].member`. Committee positions have member=null, so
  // they're naturally excluded. Powers the staffer-coverage merge.
  private buildStaffIdsByMember(staffRaw: unknown[]): Map<number, number[]> {
    const byMember = new Map<number, Set<number>>();
    const staffList = Array.isArray(staffRaw) ? staffRaw : [];
    for (const row of staffList as any[]) {
      const staffId = Number(row?.staff?.id);
      if (!Number.isFinite(staffId)) continue;
      const positions = Array.isArray(row?.positions) ? row.positions : [];
      for (const position of positions) {
        if (!position?.is_current) continue;
        const memberId = Number(position?.member?.member_id);
        if (!Number.isFinite(memberId)) continue;
        const set = byMember.get(memberId) ?? new Set<number>();
        set.add(staffId);
        byMember.set(memberId, set);
      }
    }
    const out = new Map<number, number[]>();
    for (const [memberId, set] of byMember) out.set(memberId, [...set]);
    return out;
  }

  private buildMemberStaff(
    row: any,
    staffById: Map<number, StaffDetail>,
    extraStaffIds: number[] = [],
  ): DirectoryStaffMember[] {
    const byStaffId = new Map<number, DirectoryStaffMember>();
    const roles = Array.isArray(row?.staffer_roles) ? row.staffer_roles : [];
    const issues = Array.isArray(row?.staffer_issues) ? row.staffer_issues : [];
    // extraStaffIds is already "staff with a CURRENT position at THIS member's
    // office" (buildStaffIdsByMember) — reused here as the ground truth for
    // every staffer's isCurrent, not just the coverage-merge ones below, since
    // staffer_roles/staffer_issues carry no position/current data of their own.
    const currentAtThisOffice = new Set(extraStaffIds);

    const ensureStaffer = (staffer: any): DirectoryStaffMember | null => {
      const staffId = Number(staffer?.id);
      if (!Number.isFinite(staffId)) return null;
      const detail = staffById.get(staffId);
      const fullName =
        detail?.fullName ??
        [
          staffer?.preferred_first_name ?? staffer?.first_name,
          staffer?.preferred_last_name ?? staffer?.last_name,
        ]
          .filter(Boolean)
          .join(' ')
          .trim();
      if (!fullName) return null;
      const existing = byStaffId.get(staffId);
      if (existing) return existing;
      const created: DirectoryStaffMember = {
        id: `staff-${staffId}`,
        fullName,
        title: detail?.title ?? 'Staff',
        roles: [],
        issueAreas: [],
        email: detail?.email ?? '',
        phone: detail?.phone ?? '',
        officeLocation: detail?.officeLocation ?? '',
        isCurrent: currentAtThisOffice.has(staffId),
      };
      byStaffId.set(staffId, created);
      return created;
    };

    for (const role of roles) {
      const staffer = ensureStaffer(role?.staffer);
      if (!staffer || !role?.role_name) continue;
      staffer.roles.push(String(role.role_name));
      if (staffer.title === 'Staff') staffer.title = String(role.role_name);
    }

    for (const issue of issues) {
      const staffer = ensureStaffer(issue?.staffer);
      if (!staffer || !issue?.issue_name) continue;
      staffer.issueAreas.push(String(issue.issue_name));
    }

    // Coverage merge: staffers linked to this member via staff-list
    // `positions[].member` but absent from staffer_roles/issues. They get their
    // title/contact from staffById; roles/issueAreas stay empty (not tagged).
    for (const staffId of extraStaffIds) {
      if (byStaffId.has(staffId)) continue;
      const detail = staffById.get(staffId);
      if (!detail?.fullName) continue;
      byStaffId.set(staffId, {
        id: `staff-${staffId}`,
        fullName: detail.fullName,
        title: detail.title || 'Staff',
        roles: [],
        issueAreas: [],
        email: detail.email ?? '',
        phone: detail.phone ?? '',
        officeLocation: detail.officeLocation ?? '',
        // extraStaffIds is itself the current-at-this-office set, so anyone
        // added from it is current by construction.
        isCurrent: true,
      });
    }

    return [...byStaffId.values()]
      .map((staffer) => ({
        ...staffer,
        roles: uniqueSorted(staffer.roles),
        issueAreas: uniqueSorted(staffer.issueAreas),
      }))
      .sort((left, right) => left.fullName.localeCompare(right.fullName));
  }

  private currentMemberOffice(rawOffices: unknown): any | null {
    // Single source of truth (see selectCurrentMemberOffice): in-office > newest
    // non-expired > last term. Never the first (oldest) array element.
    return selectCurrentMemberOffice(rawOffices);
  }

  private buildAddresses(rawAddresses: unknown): DirectoryAddress[] {
    const addresses = Array.isArray(rawAddresses) ? rawAddresses : [];
    return addresses.map((address: any) => ({
      id: String(address?.id ?? ''),
      title: String(address?.title ?? ''),
      address1: String(address?.address1 ?? ''),
      address2: String(address?.address2 ?? ''),
      city: String(address?.city ?? ''),
      state: String(address?.state_id ?? ''),
      zip: [address?.zip, address?.zip_ext].filter(Boolean).join('-'),
      phone: String(address?.phone ?? ''),
      fax: String(address?.fax ?? ''),
      isMain: Boolean(address?.is_main),
    }));
  }

  private buildLinks(rawLinks: unknown): DirectoryLink[] {
    const links = Array.isArray(rawLinks) ? rawLinks : [];
    return links
      .map((link: any) => ({
        label: this.linkLabel(String(link?.contact_type ?? 'Link')),
        type: String(link?.contact_type ?? ''),
        url: String(link?.contact_string ?? ''),
      }))
      .filter((link) => link.url);
  }

  private linkLabel(type: string): string {
    const lower = type.toLowerCase();
    if (lower.includes('website'))
      return type.includes('campaign') ? 'Website, campaign' : 'Website, official';
    if (lower.includes('twitter') || lower.includes('x ('))
      return type.includes('campaign') ? 'X, campaign' : 'X, official';
    if (lower.includes('facebook'))
      return type.includes('campaign') ? 'Facebook, campaign' : 'Facebook, official';
    if (lower.includes('instagram'))
      return type.includes('campaign') ? 'Instagram, campaign' : 'Instagram, official';
    if (lower.includes('youtube'))
      return type.includes('campaign') ? 'YouTube, campaign' : 'YouTube, official';
    if (lower.includes('email')) return type.includes('form') ? 'Contact form' : type;
    return type || 'Link';
  }

  private buildCommittees(rawCommittees: unknown): string[] {
    const committees = Array.isArray(rawCommittees) ? rawCommittees : [];
    return uniqueSorted(
      committees
        .map((committee: any) => committee?.committee_office?.name)
        .filter(Boolean)
        .map(String),
    );
  }

  // Leadership roles this member holds on committees, e.g. "Chair — House Armed
  // Services Committee". Only the ranking roles (not plain membership).
  private buildCommitteeLeadershipLabels(rawCommittees: unknown): string[] {
    const committees = Array.isArray(rawCommittees) ? rawCommittees : [];
    const ranked = new Set([
      'Chair',
      'Ranking Member',
      'Vice Chair',
      'Vice Ranking Member',
      'Co-Chair',
      'Chair Emeritus',
    ]);
    return uniqueSorted(
      committees
        .filter((committee: any) => ranked.has(String(committee?.position ?? '').trim()))
        .map((committee: any) => {
          const name = committee?.committee_office?.name;
          const position = String(committee?.position ?? '').trim();
          return name ? `${position} — ${name}` : '';
        })
        .filter(Boolean),
    );
  }

  // Per-member issue intensity: distinct staffers tagged with each issue, ranked
  // by headcount. This is the honest signal (issue *presence* is near-universal).
  private buildTopIssues(
    staff: DirectoryStaffMember[],
  ): Array<{ issue: string; stafferCount: number }> {
    const counts = new Map<string, number>();
    for (const staffer of staff) {
      for (const issue of new Set(staffer.issueAreas)) {
        counts.set(issue, (counts.get(issue) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([issue, stafferCount]) => ({ issue, stafferCount }))
      .sort((left, right) => {
        if (right.stafferCount !== left.stafferCount) return right.stafferCount - left.stafferCount;
        return left.issue.localeCompare(right.issue);
      })
      .slice(0, 12);
  }

  private parseSenateClass(raw: unknown): number | null {
    const value = Number(raw);
    return value === 1 || value === 2 || value === 3 ? value : null;
  }

  private buildLeadership(rawLeaderships: unknown): string[] {
    const leaderships = Array.isArray(rawLeaderships) ? rawLeaderships : [];
    return uniqueSorted(
      leaderships
        .filter(
          (leadership: any) => !leadership?.end_date || String(leadership.end_date) >= '2026-01-01',
        )
        .map((leadership: any) => leadership?.position)
        .filter(Boolean)
        .map(String),
    );
  }

  private buildNamedList(rawList: unknown): string[] {
    const list = Array.isArray(rawList) ? rawList : [];
    return uniqueSorted(
      list
        .map((entry: any) => entry?.name ?? entry?.caucus_name ?? entry?.title)
        .filter(Boolean)
        .map(String),
    );
  }

  private buildEducation(row: any): string[] {
    const list = Array.isArray(row?.education)
      ? row.education
      : Array.isArray(row?.educations)
        ? row.educations
        : [];
    return uniqueSorted(
      list
        .map((entry: any) => entry?.school ?? entry?.institution ?? entry?.name)
        .filter(Boolean)
        .map(String),
    );
  }

  private servingSince(rawOffices: unknown): string {
    const offices = Array.isArray(rawOffices) ? rawOffices : [];
    const starts = offices
      .map((office: any) => String(office?.start_date ?? ''))
      .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
      .sort();
    return starts[0] ?? '';
  }

  private isFreshman(servingSince: string): boolean {
    return Boolean(servingSince) && servingSince >= '2025-01-03';
  }

  private primaryPhoto(rawPhotos: unknown): string {
    const photos = Array.isArray(rawPhotos) ? rawPhotos : [];
    return String(
      photos.find((photo: any) => photo?.status === 'public' && photo?.is_directory)?.url ??
        photos.find((photo: any) => photo?.status === 'public' && photo?.is_primary)?.url ??
        photos.find((photo: any) => photo?.status === 'public')?.url ??
        '',
    );
  }

  private primaryTitle(chamber: Chamber, rawLeaderships: unknown): string {
    const leadership = this.buildLeadership(rawLeaderships)[0];
    if (leadership) return leadership;
    if (chamber === 'Senate') return 'United States Senator';
    if (chamber === 'Governor') return 'Governor';
    return 'Member of Congress';
  }

  private mapChamber(officeType: string): Chamber {
    if (officeType === 'SM') return 'Senate';
    if (officeType === 'GV') return 'Governor';
    return 'House';
  }

  private mapParty(rawParty: unknown): Party {
    const value = String(rawParty ?? '').toLowerCase();
    if (value.startsWith('r')) return 'R';
    if (value.startsWith('i')) return 'I';
    return 'D';
  }

  private partyLabel(party: Party): string {
    if (party === 'R') return 'Republican';
    if (party === 'I') return 'Independent';
    return 'Democrat';
  }

  private mapGender(rawGender: unknown): DirectoryContact['gender'] {
    const value = String(rawGender ?? '').toUpperCase();
    if (value === 'F' || value === 'M') return value;
    return 'Unknown';
  }

  private mapRegion(stateCode: string): Region {
    const state = stateCode.toUpperCase();
    const northeast = new Set(['ME', 'NH', 'VT', 'MA', 'RI', 'CT', 'NY', 'NJ', 'PA']);
    const south = new Set([
      'DE',
      'MD',
      'DC',
      'VA',
      'WV',
      'NC',
      'SC',
      'GA',
      'FL',
      'KY',
      'TN',
      'MS',
      'AL',
      'OK',
      'TX',
      'AR',
      'LA',
    ]);
    const midwest = new Set([
      'OH',
      'MI',
      'IN',
      'IL',
      'WI',
      'MN',
      'IA',
      'MO',
      'ND',
      'SD',
      'NE',
      'KS',
    ]);
    if (northeast.has(state)) return 'Northeast';
    if (south.has(state)) return 'South';
    if (midwest.has(state)) return 'Midwest';
    return 'West';
  }

  private honorific(chamber: Chamber): string {
    if (chamber === 'Senate') return 'Sen.';
    if (chamber === 'Governor') return 'Gov.';
    return 'Rep.';
  }

  private formatOfficeLabel(
    chamber: Chamber,
    memberName: string,
    state: string,
    district: unknown,
  ): string {
    if (chamber === 'Senate') return `Senate office, ${state}`;
    if (chamber === 'Governor') return `Governor office, ${state}`;
    const districtNo = Number(district);
    if (Number.isFinite(districtNo) && districtNo > 0) {
      return `${memberName} office (${state}-${districtNo})`;
    }
    return `${memberName} office (${state})`;
  }

  private formatDistrict(chamber: Chamber, state: string, district: unknown): string {
    if (chamber !== 'House') return state;
    const districtNo = Number(district);
    return Number.isFinite(districtNo) && districtNo > 0 ? `${state}-${districtNo}` : state;
  }

  private formatAddress(address: DirectoryAddress): string {
    return [address.address1, address.address2, address.city, address.state, address.zip]
      .filter(Boolean)
      .join(', ');
  }

  private latestDate(values: unknown[]): string {
    const dates = values
      .map((value) => this.toIsoDate(value))
      .filter((value) => value !== '1970-01-01');
    return dates.sort().at(-1) ?? '1970-01-01';
  }

  private toIsoDate(raw: unknown): string {
    if (!raw) return '1970-01-01';
    const parsed = new Date(String(raw).replace(' ', 'T'));
    if (Number.isNaN(parsed.getTime())) return '1970-01-01';
    return parsed.toISOString().slice(0, 10);
  }
}
