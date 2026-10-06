type JsonRecord = Record<string, unknown>;

export type FloridaDirectoryStaff = {
  name: string;
  role: string;
  email: string | null;
  phone: string | null;
  sourcePage: number | null;
};

export type FloridaDirectoryContact = {
  location: string | null;
  mailingAddress: string | null;
  phone: string | null;
  voip: string | null;
};

export type FloridaCommitteeDirectoryProfile = {
  contacts: FloridaDirectoryContact[];
  jurisdiction: string | null;
  leadership: Array<{ name: string; role: string }>;
  staff: FloridaDirectoryStaff[];
  sources: Array<{
    document: string;
    sha256: string;
    asOfDate: string;
    pages: number[];
  }>;
};

export type FloridaLegislatorDirectoryProfile = {
  source: {
    document: string | null;
    sha256: string;
    asOfDate: string | null;
    pages: number[];
  };
  email: string | null;
  portraitUrl: string | null;
  leadershipTitle: string | null;
  spouse: string | null;
  offices: Array<{
    kind: string | null;
    label: string | null;
    addressLines: string[];
    phone: string | null;
    voip: string | null;
    fax: string | null;
  }>;
  staff: Array<{ name: string; role: string; sourcePage: number | null }>;
  committeeAssignments: Array<{ name: string; role: string | null }>;
};

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function isoDate(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate
    ? candidate
    : null;
}

function directoryPdfObservations(sourceEvidence: unknown): JsonRecord[] {
  const root = record(record(sourceEvidence)?.directoryPdf);
  if (!root) return [];
  const observations = Array.isArray(root.observations)
    ? root.observations.map(record).filter((value): value is JsonRecord => !!value)
    : [];
  // Direct shape remains readable for an interrupted rolling deployment, but
  // all new ingestion writes append-only source-versioned observations.
  return (observations.length ? observations : [root]).sort((a, b) => {
    const aDate = isoDate(record(a.source)?.asOfDate) ?? '';
    const bDate = isoDate(record(b.source)?.asOfDate) ?? '';
    return bDate.localeCompare(aDate);
  });
}

/** Resolve an assignment already attached to a stable legislator ID by the
 * reviewed directory importer. Both subjects and the same published edition
 * must agree; this never matches people by display name or guesses an alias. */
export function floridaDirectoryCommitteeAssignment(
  committee: { officialSourceKey: string | null; name: string; sourceEvidence: unknown },
  legislator: {
    state: string;
    chamber: string | null;
    district: string | null;
    sourceEvidence: unknown;
  },
): { role: string | null; asOfDate: string } | null {
  if (legislator.state !== 'FL' || !committee.officialSourceKey?.startsWith('FL:2026:'))
    return null;
  const chamber = committee.officialSourceKey.includes(':house:')
    ? 'lower'
    : committee.officialSourceKey.includes(':senate:')
      ? 'upper'
      : null;
  if (!chamber || legislator.chamber !== chamber) return null;
  const body = directoryPdfObservations(committee.sourceEvidence)[0];
  const person = directoryPdfObservations(legislator.sourceEvidence)[0];
  if (!body || !person) return null;
  const bodySubject = record(body.subject);
  const personSubject = record(person.subject);
  const bodySource = record(body.source);
  const personSource = record(person.source);
  const hash = text(bodySource?.sha256);
  const asOfDate = isoDate(bodySource?.asOfDate);
  if (
    bodySubject?.kind !== 'committee' ||
    bodySubject.officialSourceKey !== committee.officialSourceKey ||
    bodySubject.name !== committee.name ||
    personSubject?.kind !== 'legislator' ||
    personSubject.state !== 'FL' ||
    personSubject.chamber !== chamber ||
    personSubject.district !== legislator.district ||
    !legislator.district ||
    !hash ||
    !/^[a-f0-9]{64}$/i.test(hash) ||
    personSource?.sha256 !== hash ||
    !asOfDate ||
    isoDate(personSource?.asOfDate) !== asOfDate
  )
    return null;
  const matches = (Array.isArray(person.committeeAssignments) ? person.committeeAssignments : [])
    .map(record)
    .filter((row) => row?.name === committee.name);
  if (matches.length !== 1) return null;
  return { role: text(matches[0]?.role), asOfDate };
}

function normalized(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter((entry): entry is string => !!entry) : [];
}

export function preferNonBlank(
  primary: string | null | undefined,
  fallback: string | null,
): string | null {
  return text(primary) ?? fallback;
}

/**
 * Project the reviewed PDF facts from one official committee plus its verified
 * aliases. Only this narrow, display-safe shape leaves sourceEvidence.
 */
export function floridaCommitteeDirectoryProfile(
  rows: Array<{ sourceEvidence: unknown }>,
): FloridaCommitteeDirectoryProfile | null {
  const contacts: FloridaDirectoryContact[] = [];
  const leadership: Array<{ name: string; role: string }> = [];
  const staff: FloridaDirectoryStaff[] = [];
  const sources: FloridaCommitteeDirectoryProfile['sources'] = [];
  let jurisdiction: string | null = null;

  for (const row of rows) {
    for (const pdf of directoryPdfObservations(row.sourceEvidence)) {
      jurisdiction ??= text(pdf.jurisdiction);

      const contactRows = Array.isArray(pdf.contacts)
        ? pdf.contacts
        : pdf.contact
          ? [pdf.contact]
          : [];
      for (const value of contactRows) {
        const contact = record(value);
        if (!contact) continue;
        const projected = {
          location: text(contact.location),
          mailingAddress: text(contact.mailingAddress),
          phone: text(contact.phone),
          voip: text(contact.voip),
        };
        if (Object.values(projected).some(Boolean)) contacts.push(projected);
      }

      for (const value of Array.isArray(pdf.leadership) ? pdf.leadership : []) {
        const item = record(value);
        const name = text(item?.name);
        const role = text(item?.role);
        if (name && role) leadership.push({ name, role });
      }
      for (const value of Array.isArray(pdf.staff) ? pdf.staff : []) {
        const item = record(value);
        const name = text(item?.name);
        const role = text(item?.role);
        if (!name || !role) continue;
        staff.push({
          name,
          role,
          email: text(item?.email),
          phone: text(item?.phone),
          sourcePage: integer(item?.sourcePage) ?? integer(pdf.sourcePage),
        });
      }
      const source = record(pdf.source);
      const document = text(source?.document);
      const sha256 = text(source?.sha256);
      const asOfDate = isoDate(source?.asOfDate);
      const pages = [
        ...stringArray(source?.pages).map(Number),
        ...(Array.isArray(source?.pages)
          ? source.pages.filter((page): page is number => integer(page) !== null)
          : []),
        ...(integer(pdf.sourcePage) ? [integer(pdf.sourcePage)!] : []),
      ]
        .filter((page) => Number.isInteger(page) && page > 0)
        .sort((a, b) => a - b);
      if (document && sha256 && /^[a-f0-9]{64}$/i.test(sha256) && asOfDate) {
        sources.push({
          document,
          sha256: sha256.toLowerCase(),
          asOfDate,
          pages: [...new Set(pages)],
        });
      }
    }
  }

  const dedupe = <T>(values: T[], key: (value: T) => string): T[] => {
    const firstByKey = new Map<string, T>();
    for (const value of values) {
      const identity = key(value);
      if (!firstByKey.has(identity)) firstByKey.set(identity, value);
    }
    return [...firstByKey.values()];
  };
  const profile: FloridaCommitteeDirectoryProfile = {
    contacts: dedupe(contacts, (value) => JSON.stringify(value)),
    jurisdiction,
    leadership: dedupe(
      leadership,
      (value) => `${normalized(value.name)}:${normalized(value.role)}`,
    ),
    staff: dedupe(staff, (value) => `${normalized(value.name)}:${normalized(value.role)}`),
    sources: dedupe(sources, (value) => `${value.sha256}:${value.pages.join(',')}`),
  };
  return profile.contacts.length ||
    profile.jurisdiction ||
    profile.leadership.length ||
    profile.staff.length ||
    profile.sources.length
    ? profile
    : null;
}

/** Narrow projection for the state-legislator detail endpoint. */
export function floridaLegislatorDirectoryProfile(
  sourceEvidence: unknown,
): FloridaLegislatorDirectoryProfile | null {
  const pdf = directoryPdfObservations(sourceEvidence)[0] ?? null;
  if (!pdf) return null;
  const source = record(pdf.source);
  const sha256 = text(source?.sha256);
  if (!sha256 || !/^[a-f0-9]{64}$/i.test(sha256)) return null;
  const email = text(pdf.email);
  const portrait = record(pdf.portrait);
  const portraitUrl = text(portrait?.publicUrl);
  const offices = (Array.isArray(pdf.offices) ? pdf.offices : [])
    .map(record)
    .filter((office): office is JsonRecord => !!office)
    .map((office) => ({
      kind: text(office.kind),
      label: text(office.label),
      addressLines: stringArray(office.addressLines),
      phone: text(office.phone),
      voip: text(office.voip),
      fax: text(office.fax),
    }));
  const staff = (Array.isArray(pdf.staff) ? pdf.staff : [])
    .map(record)
    .filter((staffer): staffer is JsonRecord => !!staffer)
    .map((staffer) => ({
      name: text(staffer.name),
      role: text(staffer.role),
      sourcePage: integer(staffer.sourcePage),
    }))
    .filter(
      (staffer): staffer is { name: string; role: string; sourcePage: number | null } =>
        !!staffer.name && !!staffer.role,
    );
  const committeeAssignments = (
    Array.isArray(pdf.committeeAssignments) ? pdf.committeeAssignments : []
  )
    .map(record)
    .filter((assignment): assignment is JsonRecord => !!assignment)
    .map((assignment) => ({ name: text(assignment.name), role: text(assignment.role) }))
    .filter((assignment): assignment is { name: string; role: string | null } => !!assignment.name);
  return {
    source: {
      document: text(source?.document),
      sha256: sha256.toLowerCase(),
      asOfDate: isoDate(source?.asOfDate),
      pages: Array.isArray(source?.pages)
        ? source.pages
            .map(integer)
            .filter((page): page is number => page !== null)
            .sort((a, b) => a - b)
        : [],
    },
    email: email && /^[^@\s]+@(flhouse\.gov|flsenate\.gov)$/i.test(email) ? email : null,
    portraitUrl:
      portraitUrl &&
      /^\/florida-directory\/portraits\/[a-z0-9][a-z0-9._-]*\.jpe?g$/i.test(portraitUrl)
        ? portraitUrl
        : null,
    leadershipTitle: text(pdf.leadershipTitle),
    spouse: text(pdf.spouse),
    offices,
    staff,
    committeeAssignments,
  };
}
