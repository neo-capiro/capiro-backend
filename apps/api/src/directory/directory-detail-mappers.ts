import type { DirectoryMemberDetail, DirectoryStaffDetail } from './directory-detail.types.js';

export function mapMemberOffices(raw: unknown): DirectoryMemberDetail['offices'] {
  return (Array.isArray(raw) ? raw : []).filter((o) => o && typeof o === 'object').map((o: any) => ({
    officeId: Number.isFinite(Number(o.office?.office_id)) ? Number(o.office.office_id) : null,
    name: o.office?.name ?? null,
    officeTypeId: o.office_type_id ?? null,
    state: o.state_id ?? null,
    district: o.district_no == null ? null : String(o.district_no),
    party: o.party ?? null,
    senateClass: o.senate_class == null ? null : String(o.senate_class),
    outgoingStatus: o.outgoing_status ?? null,
    status: o.status ?? null,
    startDate: o.start_date ?? null,
    endDate: o.end_date ?? null,
    updatedAt: o.updated_at ?? null,
  }));
}

export function mapLeaderships(raw: unknown): DirectoryMemberDetail['leaderships'] {
  return (Array.isArray(raw) ? raw : []).filter((l) => l && typeof l === 'object').map((l: any) => ({
    position: l.position ?? null,
    startDate: l.start_date ?? null,
    endDate: l.end_date ?? null,
    updatedAt: l.updated_at ?? null,
  }));
}

export function mapContactMethods(raw: unknown): DirectoryMemberDetail['socialContacts'] {
  return (Array.isArray(raw) ? raw : [])
    .filter((c) => c && typeof c === 'object' && typeof (c as any).contact_string === 'string')
    .map((c: any) => ({
      type: c.contact_type ?? null,
      value: String(c.contact_string),
      updatedAt: c.updated_at ?? null,
    }));
}

export function mapStaffRoles(raw: unknown): DirectoryMemberDetail['staffRoles'] {
  return (Array.isArray(raw) ? raw : []).filter((r) => r && typeof r === 'object').map((r: any) => ({
    memberId: Number.isFinite(Number(r.staffer?.member_id ?? r.member_id)) ? Number(r.staffer?.member_id ?? r.member_id) : null,
    roleName: r.role_name ?? null,
    updatedAt: r.updated_at ?? null,
  }));
}

export function mapStaffIssues(raw: unknown): DirectoryMemberDetail['staffIssues'] {
  return (Array.isArray(raw) ? raw : []).filter((r) => r && typeof r === 'object').map((r: any) => ({
    memberId: Number.isFinite(Number(r.member_id)) ? Number(r.member_id) : null,
    issueName: r.issue_name ?? null,
    updatedAt: r.updated_at ?? null,
  }));
}

export function mapStaffPositions(raw: unknown): DirectoryStaffDetail['positions'] {
  return (Array.isArray(raw) ? raw : []).filter((p) => p && typeof p === 'object').map((p: any) => {
    const m = p.member && typeof p.member === 'object' ? p.member : null;
    const profile = m?.profile && typeof m.profile === 'object' ? m.profile : null;
    const memberFullName = profile
      ? [profile.preferred_first_name ?? profile.first_name, profile.preferred_last_name ?? profile.last_name]
          .filter(Boolean)
          .join(' ')
          .trim()
      : '';
    return {
      officeId: Number.isFinite(Number(p.office?.office_id)) ? Number(p.office.office_id) : null,
      officeName: p.office?.name ?? null,
      memberId: Number.isFinite(Number(m?.member_id)) ? Number(m.member_id) : null,
      title: p.position_title ?? null,
      positionType: p.position_type ?? null,
      isCurrent: p.is_current === true,
      isOnLeave: p.is_on_leave === true,
      startDate: p.start_date ?? null,
      endDate: p.end_date ?? null,
      updatedAt: p.updated_at ?? null,
      member: m
        ? {
            memberId: Number.isFinite(Number(m.member_id)) ? Number(m.member_id) : null,
            fullName: memberFullName || null,
            party: typeof m.party === 'string' ? m.party : null,
            state: typeof m.state_id === 'string' ? m.state_id : null,
            district: m.district_no === undefined || m.district_no === null ? null : String(m.district_no),
            officeTypeId:
              m.office_type_id === undefined || m.office_type_id === null
                ? null
                : String(m.office_type_id),
          }
        : null,
    };
  });
}

export function mapStaffOfficeAddresses(raw: unknown): DirectoryStaffDetail['officeAddresses'] {
  return (Array.isArray(raw) ? raw : [])
    .filter((a) => a && typeof a === 'object')
    .map((a: any) => ({
      addressId: Number.isFinite(Number(a.id)) ? Number(a.id) : null,
      officeId: Number.isFinite(Number(a.office?.office_id)) ? Number(a.office.office_id) : null,
      officeName: a.office?.name ?? null,
      label: a.title ?? null,
      address1: a.address1 ?? null,
      address2: a.address2 ?? null,
      city: a.city ?? null,
      state: a.state_id ?? null,
      zip: a.zip ?? null,
      zipExt: a.zip_ext ?? null,
      phone: a.phone ?? null,
      fax: a.fax ?? null,
      isMain: a.is_main === true,
      publicNotes: a.public_notes ?? null,
      updatedAt: a.updated_at ?? null,
    }));
}
