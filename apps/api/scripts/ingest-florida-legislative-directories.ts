/**
 * Add reviewed Florida legislative-directory PDF facts to sourceEvidence.
 *
 * This importer is intentionally narrow:
 * - dry-run by default;
 * - exact source hashes and committed portrait assets are verified first;
 * - legislators are matched by FL + chamber + district, then name-checked;
 * - committees are matched by the reviewed inventory's officialSourceKey;
 * - only source_evidence.directoryPdf is changed;
 * - canonical person columns and committee memberships are transactionally
 *   proven unchanged with bidirectional EXCEPT ALL postconditions.
 */
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { URL } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';

dotenvConfig();

const HOUSE_SHA256 = 'd22307e5f0809fc19fb3e3964232542b288a95d868e021f8813ccbee893a37cc';
const SENATE_SHA256 = 'f39f6880aef73025919a73eefbc12da6f1ba23b7d547766473f8a3d1a58c152d';
const LOCAL_CONFIRMATION = '2026-local-only';
const NONLOCAL_CONFIRMATION = 'apply-2026-florida-legislative-directory-pdfs';

type JsonRecord = Record<string, unknown>;

type ManifestSource = {
  filename: string;
  sha256: string;
  asOfDate: string;
  pageCount: number;
};

type ManifestMember = {
  chamber: 'house' | 'senate';
  district: number;
  name?: string;
  directoryName?: string;
  vacant: boolean;
  leadershipTitles: string[];
  spouse?: string | null;
  committeeMemberships: Array<{ committeeName: string; role: string | null }>;
  contact: {
    email: string | null;
    capitolOfficeRaw?: string | null;
    capitolPhones?: string[];
    capitolVoip?: string[];
    districtOfficeRaw?: string | null;
    districtOfficesRaw?: string | null;
    districtPhones?: string[];
    districtVoip?: string[];
  };
  legislativeStaff?: Array<{ role: string; names: string[] }>;
  legislativeAides?: string[];
  portrait?: {
    publicUrl: string;
    filename: string;
    mediaType: string;
    sha256: string;
    width: number;
    height: number;
    source: { pageNumber: number; imageName: string };
  };
  provenance: { pageNumber: number; sourceId: string; sourceSha256: string; textSha256: string };
};

type ManifestCommittee = {
  chamber: 'house' | 'senate' | 'joint';
  name: string;
  officialCode: string;
  contactLine?: string | null;
  location?: string | null;
  mailingAddress?: string | null;
  phones: string[];
  senateVoip?: string[];
  description?: string | null;
  leadership: Array<{ name: string; role: string; party?: string }>;
  staff: Array<{ name: string; role: string }>;
  roster: Array<{ name: string; party?: string }>;
  sources: Array<{
    provenance: {
      pageNumber: number;
      sourceId: string;
      sourceSha256: string;
      textSha256: string;
    };
  }>;
};

export type FloridaDirectoryManifest = {
  schemaVersion: number;
  parserVersion: string;
  jurisdiction: string;
  legislativeSession: string;
  sources: {
    houseDirectory: ManifestSource;
    senateDirectory: ManifestSource;
    officialCommitteeInventory: { sha256: string };
  };
  counts: Record<string, number>;
  validation: Record<string, boolean>;
  house: {
    members: ManifestMember[];
    committees: ManifestCommittee[];
    officeDirectoryPages: unknown[];
  };
  senate: {
    members: ManifestMember[];
    committees: ManifestCommittee[];
    meetingRooms: unknown[];
    officeDirectoryPages: unknown[];
  };
  ambiguities: unknown[];
};

type InventoryRow = {
  chamber: 'house' | 'senate' | 'joint';
  officialCode: string;
  name: string;
};

type Inventory = { rows: InventoryRow[] };

export type ExistingLegislator = {
  id: string;
  name: string;
  state: string;
  chamber: string | null;
  district: string | null;
  email: string | null;
  active: boolean;
  sourceEvidence: unknown;
};

export type ExistingCommittee = {
  id: string;
  name: string;
  chamber: string | null;
  officialSourceKey: string | null;
  sourceEvidence: unknown;
};

type Observation = JsonRecord & {
  source: {
    document: string;
    sha256: string;
    asOfDate: string;
    pages: number[];
  };
};

export type DirectoryWrite = {
  kind: 'legislator' | 'committee';
  id: string;
  label: string;
  observation: Observation;
  priorSourceEvidence: unknown;
};

export type DirectoryPlan = {
  writes: DirectoryWrite[];
  unresolved: string[];
  warnings: string[];
};

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function normalized(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[“”‘’]/g, "'")
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

function surname(value: string): string {
  const withoutNickname = value.replace(/[“\"'][^”\"']+[”\"']/g, ' ');
  const commaName = withoutNickname.split(',')[0]?.trim();
  const parts = normalized(commaName || withoutNickname)
    .split(' ')
    .filter(Boolean)
    .filter((part) => !['jr', 'sr', 'ii', 'iii', 'iv'].includes(part));
  return parts.at(-1) ?? '';
}

export function namesCompatible(databaseName: string, directoryName: string): boolean {
  const left = normalized(databaseName);
  const right = normalized(
    directoryName.includes(',') ? directoryName.split(',').reverse().join(' ') : directoryName,
  );
  return left === right || (!!surname(left) && surname(left) === surname(right));
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function strictIsoDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
  );
}

export function officialKey(row: InventoryRow): string {
  if (row.chamber === 'house') return `FL:2026:fl:house:committee:${row.officialCode}`;
  if (row.chamber === 'senate') return `FL:2026:fl:senate:${row.officialCode}`;
  return `FL:directory:fl:joint:${row.officialCode}`;
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd9 || marker === 0xda) break;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2 || offset + length + 2 > bytes.length) return null;
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    ) {
      return {
        height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
        width: (bytes[offset + 7]! << 8) | bytes[offset + 8]!,
      };
    }
    offset += length + 2;
  }
  return null;
}

export function validateManifest(manifest: FloridaDirectoryManifest, inventory: Inventory): void {
  const failures: string[] = [];
  if (manifest.schemaVersion !== 1 || manifest.parserVersion !== '1.0.0')
    failures.push('unsupported schema/parser version');
  if (manifest.jurisdiction !== 'FL' || manifest.legislativeSession !== '2026')
    failures.push('wrong jurisdiction/session');
  const house = manifest.sources.houseDirectory;
  const senate = manifest.sources.senateDirectory;
  if (house.sha256 !== HOUSE_SHA256 || house.pageCount !== 182 || house.asOfDate !== '2026-06-04')
    failures.push('House source contract mismatch');
  if (
    senate.sha256 !== SENATE_SHA256 ||
    senate.pageCount !== 33 ||
    senate.asOfDate !== '2026-08-26'
  )
    failures.push('Senate source contract mismatch');
  if (!strictIsoDate(house.asOfDate) || !strictIsoDate(senate.asOfDate))
    failures.push('invalid source date');
  if (Object.entries(manifest.validation).some(([, value]) => value !== true))
    failures.push('extractor validation is incomplete');
  const expectedCounts: Record<string, number> = {
    houseMemberProfiles: 120,
    houseSeatedMemberProfiles: 118,
    housePendingElectionProfiles: 2,
    housePortraits: 118,
    houseCommitteeProfiles: 34,
    houseJointCommitteeProfiles: 5,
    senateMemberProfiles: 40,
    senateVacantProfiles: 1,
    senateCommitteeProfiles: 26,
    senateJointCommitteeProfiles: 5,
    senateMeetingRooms: 11,
    houseOfficeDirectoryPages: 31,
    senateOfficeDirectoryPages: 5,
  };
  for (const [key, expected] of Object.entries(expectedCounts)) {
    if (manifest.counts[key] !== expected) failures.push(`${key} expected ${expected}`);
  }
  const houseDistricts = manifest.house.members
    .map((member) => member.district)
    .sort((a, b) => a - b);
  const senateDistricts = manifest.senate.members
    .map((member) => member.district)
    .sort((a, b) => a - b);
  if (canonical(houseDistricts) !== canonical(Array.from({ length: 120 }, (_, index) => index + 1)))
    failures.push('House district coverage mismatch');
  if (canonical(senateDistricts) !== canonical(Array.from({ length: 40 }, (_, index) => index + 1)))
    failures.push('Senate district coverage mismatch');

  const inventoryByIdentity = new Map(
    inventory.rows.map((row) => [`${row.chamber}:${row.officialCode}`, row]),
  );
  for (const committee of [...manifest.house.committees, ...manifest.senate.committees]) {
    const inventoryRow = inventoryByIdentity.get(`${committee.chamber}:${committee.officialCode}`);
    if (!inventoryRow || normalized(inventoryRow.name) !== normalized(committee.name)) {
      failures.push(`committee inventory mismatch: ${committee.chamber}:${committee.officialCode}`);
    }
  }
  const portraits = manifest.house.members
    .filter((member) => !member.vacant)
    .map((member) => member.portrait);
  if (portraits.some((portrait) => !portrait))
    failures.push('seated House member missing portrait');
  const filenames = new Set<string>();
  for (const portrait of portraits) {
    if (!portrait) continue;
    if (
      portrait.mediaType !== 'image/jpeg' ||
      !/^[a-f0-9]{64}$/.test(portrait.sha256) ||
      !/^\/florida-directory\/portraits\/[a-z0-9][a-z0-9._-]*\.jpg$/.test(portrait.publicUrl) ||
      portrait.width < 150 ||
      portrait.height < 200 ||
      portrait.publicUrl.split('/').at(-1) !== portrait.filename
    ) {
      failures.push(`invalid portrait contract: ${portrait.filename}`);
    }
    if (filenames.has(portrait.filename)) failures.push(`duplicate portrait: ${portrait.filename}`);
    filenames.add(portrait.filename);
  }
  for (const member of [...manifest.house.members, ...manifest.senate.members]) {
    const email = member.contact.email;
    if (email && !/^[^@\s]+@(flhouse\.gov|flsenate\.gov)$/i.test(email))
      failures.push(`invalid official email: ${email}`);
  }
  if (failures.length)
    throw new Error(`Florida directory manifest invalid: ${failures.join('; ')}`);
}

async function validatePortraitAssets(manifest: FloridaDirectoryManifest): Promise<string> {
  const candidates = [
    join(__dirname, '../../web/public/florida-directory/portraits'),
    join(__dirname, '../data/florida-legislative-directory/portraits'),
  ];
  let directory: string | null = null;
  for (const candidate of candidates) {
    try {
      await access(candidate);
      directory = candidate;
      break;
    } catch {
      // Try the next release-layout candidate.
    }
  }
  if (!directory) throw new Error('Florida portrait assets are absent from this release image');
  const assetProof: Array<{ filename: string; sha256: string; width: number; height: number }> = [];
  for (const member of manifest.house.members.filter((entry) => !entry.vacant)) {
    const portrait = member.portrait!;
    const bytes = await readFile(join(directory, portrait.filename));
    const dimensions = jpegDimensions(bytes);
    if (
      sha256(bytes) !== portrait.sha256 ||
      dimensions?.width !== portrait.width ||
      dimensions.height !== portrait.height
    ) {
      throw new Error(`Portrait asset proof failed: ${portrait.filename}`);
    }
    assetProof.push({
      filename: portrait.filename,
      sha256: portrait.sha256,
      width: portrait.width,
      height: portrait.height,
    });
  }
  return sha256(canonical(assetProof));
}

function sourceFor(manifest: FloridaDirectoryManifest, sourceId: string, pages: number[]) {
  const source =
    sourceId === 'houseDirectory'
      ? manifest.sources.houseDirectory
      : manifest.sources.senateDirectory;
  return {
    document: source.filename,
    sha256: source.sha256,
    asOfDate: source.asOfDate,
    pages: [...new Set(pages)].sort((a, b) => a - b),
  };
}

function addressLines(raw: string | null | undefined, aides: string[] = []): string[] {
  if (!raw) return [];
  const aideText = normalized(aides.join(' '));
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/\(\d{3}\)\s*\d{3}-\d{4}/.test(line))
    .filter((line) => !/Senate VOIP|@fl(?:house|senate)\.gov|^Legislative Aide:/i.test(line))
    .filter((line) => {
      const key = normalized(line.replace(/\band\b/gi, ' '));
      return !key || !aideText.includes(key);
    });
}

function memberObservation(
  manifest: FloridaDirectoryManifest,
  member: ManifestMember,
): Observation {
  const isHouse = member.chamber === 'house';
  const sourceId = isHouse ? 'houseDirectory' : 'senateDirectory';
  const page = member.provenance.pageNumber;
  const aides = isHouse
    ? (member.legislativeStaff ?? []).flatMap((group) => group.names)
    : (member.legislativeAides ?? []);
  const staff = isHouse
    ? (member.legislativeStaff ?? []).flatMap((group) =>
        group.names.map((name) => ({ name, role: group.role, sourcePage: page })),
      )
    : aides.map((name) => ({ name, role: 'Legislative Aide', sourcePage: page }));
  const capitolRaw = member.contact.capitolOfficeRaw;
  const districtRaw = member.contact.districtOfficesRaw ?? member.contact.districtOfficeRaw;
  const offices = [
    {
      kind: 'capitol',
      label: isHouse ? 'Capitol office' : 'Tallahassee office',
      addressLines: addressLines(capitolRaw, aides),
      phone: member.contact.capitolPhones?.[0] ?? null,
      voip: member.contact.capitolVoip?.[0] ?? null,
      fax: null,
      sourcePage: page,
    },
    {
      kind: 'district',
      label:
        (member.contact.districtPhones?.length ?? 0) > 1 ? 'District offices' : 'District office',
      addressLines: addressLines(districtRaw, aides),
      phone: member.contact.districtPhones?.[0] ?? null,
      additionalPhones: member.contact.districtPhones?.slice(1) ?? [],
      voip: member.contact.districtVoip?.[0] ?? null,
      fax: null,
      sourcePage: page,
    },
  ].filter((office) => office.addressLines.length || office.phone || office.voip);
  const portrait = member.portrait
    ? {
        publicUrl: member.portrait.publicUrl,
        assetSha256: member.portrait.sha256,
        mimeType: member.portrait.mediaType,
        width: member.portrait.width,
        height: member.portrait.height,
        sourcePage: member.portrait.source.pageNumber,
        pdfObjectName: member.portrait.source.imageName,
      }
    : null;
  return {
    subject: {
      kind: 'legislator',
      state: 'FL',
      chamber: isHouse ? 'lower' : 'upper',
      district: String(member.district),
      directoryName: member.name ?? member.directoryName ?? '',
    },
    email: member.contact.email,
    portrait,
    leadershipTitle: member.leadershipTitles.filter(Boolean).join(' · ') || null,
    spouse: member.spouse ?? null,
    offices,
    staff,
    committeeAssignments: member.committeeMemberships.map((assignment) => ({
      name: assignment.committeeName,
      role: assignment.role,
      sourcePage: page,
    })),
    textSha256: member.provenance.textSha256,
    source: sourceFor(manifest, sourceId, [page]),
  };
}

function committeeObservation(
  manifest: FloridaDirectoryManifest,
  committee: ManifestCommittee,
  key: string,
): Observation {
  const sourceId = committee.sources[0]?.provenance.sourceId;
  if (!sourceId) throw new Error(`Committee ${key} has no source provenance`);
  const pages = committee.sources.map((source) => source.provenance.pageNumber);
  let contacts: JsonRecord[];
  if (committee.contactLine) {
    const parts = committee.contactLine
      .split('|')
      .map((part) => part.trim())
      .filter(Boolean);
    contacts = [
      {
        location: parts[0] ?? null,
        mailingAddress:
          parts
            .slice(1)
            .filter((part) => !/\(\d{3}\)/.test(part))
            .join(' | ') || null,
        phone: committee.phones[0] ?? null,
        voip: null,
        sourcePage: pages[0] ?? null,
      },
    ];
  } else {
    contacts = [
      {
        location: committee.location ?? null,
        mailingAddress: committee.mailingAddress ?? null,
        phone: committee.phones[0] ?? null,
        voip: committee.senateVoip?.[0] ?? null,
        sourcePage: pages[0] ?? null,
      },
    ];
  }
  return {
    subject: { kind: 'committee', officialSourceKey: key, name: committee.name },
    contacts,
    jurisdiction: committee.description ?? null,
    leadership: committee.leadership.map((leader) => ({
      name: leader.name,
      role: leader.role,
      sourcePage: pages[0] ?? null,
    })),
    staff: committee.staff.map((staffer) => ({
      name: staffer.name,
      role: staffer.role,
      email: null,
      phone: null,
      sourcePage: pages[0] ?? null,
    })),
    publishedRoster: committee.roster,
    textSha256: committee.sources.map((source) => source.provenance.textSha256),
    source: sourceFor(manifest, sourceId, pages),
  };
}

export function buildPlan(
  manifest: FloridaDirectoryManifest,
  inventory: Inventory,
  legislators: ExistingLegislator[],
  committees: ExistingCommittee[],
): DirectoryPlan {
  const writes: DirectoryWrite[] = [];
  const unresolved: string[] = [];
  const warnings: string[] = [];
  const members = [...manifest.house.members, ...manifest.senate.members].filter(
    (member) => !member.vacant,
  );
  for (const member of members) {
    const chamber = member.chamber === 'house' ? 'lower' : 'upper';
    const matches = legislators.filter(
      (row) =>
        row.state === 'FL' &&
        row.active &&
        row.chamber === chamber &&
        Number(row.district) === member.district,
    );
    const directoryName = member.name ?? member.directoryName ?? '';
    if (matches.length !== 1) {
      unresolved.push(
        `${chamber} district ${member.district}: expected one active row, found ${matches.length}`,
      );
      continue;
    }
    const match = matches[0]!;
    if (!namesCompatible(match.name, directoryName)) {
      unresolved.push(`${chamber} district ${member.district}: ${match.name} != ${directoryName}`);
      continue;
    }
    if (
      match.email?.trim() &&
      member.contact.email &&
      match.email.trim().toLowerCase() !== member.contact.email.toLowerCase()
    ) {
      warnings.push(
        `${chamber} district ${member.district}: canonical email ${match.email} differs from directory ${member.contact.email}`,
      );
    }
    writes.push({
      kind: 'legislator',
      id: match.id,
      label: `${chamber} district ${member.district} ${match.name}`,
      observation: memberObservation(manifest, member),
      priorSourceEvidence: match.sourceEvidence,
    });
  }

  const inventoryByIdentity = new Map(
    inventory.rows.map((row) => [`${row.chamber}:${row.officialCode}`, row]),
  );
  for (const committee of [...manifest.house.committees, ...manifest.senate.committees]) {
    const inventoryRow = inventoryByIdentity.get(`${committee.chamber}:${committee.officialCode}`);
    if (!inventoryRow) {
      unresolved.push(`committee inventory missing ${committee.chamber}:${committee.officialCode}`);
      continue;
    }
    const key = officialKey(inventoryRow);
    const matches = committees.filter((row) => row.officialSourceKey === key);
    if (matches.length !== 1) {
      unresolved.push(`committee ${key}: expected one official row, found ${matches.length}`);
      continue;
    }
    const match = matches[0]!;
    if (normalized(match.name) !== normalized(inventoryRow.name)) {
      unresolved.push(`committee ${key}: ${match.name} != ${inventoryRow.name}`);
      continue;
    }
    writes.push({
      kind: 'committee',
      id: match.id,
      label: `${key} ${match.name}`,
      observation: committeeObservation(manifest, committee, key),
      priorSourceEvidence: match.sourceEvidence,
    });
  }
  return { writes, unresolved, warnings };
}

export function mergeObservation(
  sourceEvidence: unknown,
  observation: Observation,
): { value: JsonRecord; status: 'inserted' | 'unchanged' } {
  const root = record(sourceEvidence) ?? {};
  const directoryPdf = record(root.directoryPdf) ?? {};
  const observations = Array.isArray(directoryPdf.observations)
    ? directoryPdf.observations.filter((item): item is JsonRecord => !!record(item))
    : [];
  const identity = observation.source.sha256;
  const existing = observations.find((item) => record(item.source)?.sha256 === identity);
  if (existing) {
    if (canonical(existing) !== canonical(observation)) {
      throw new Error(`Conflicting directory observation for immutable source ${identity}`);
    }
    return { value: root, status: 'unchanged' };
  }
  const next = [...observations, observation].sort((left, right) => {
    const leftDate = String(record(left.source)?.asOfDate ?? '');
    const rightDate = String(record(right.source)?.asOfDate ?? '');
    return rightDate.localeCompare(leftDate);
  });
  return {
    value: { ...root, directoryPdf: { ...directoryPdf, observations: next } },
    status: 'inserted',
  };
}

export function planHash(manifestSha256: string, plan: DirectoryPlan): string {
  return sha256(
    canonical({
      manifestSha256,
      writes: plan.writes
        .map((write) => ({
          kind: write.kind,
          id: write.id,
          observationSha256: sha256(canonical(write.observation)),
        }))
        .sort((left, right) =>
          `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`),
        ),
      unresolved: plan.unresolved,
    }),
  );
}

function validateDatabase(apply: boolean, env = process.env): URL {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const url = new URL(env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('DATABASE_URL must be PostgreSQL');
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (!local && env.ALLOW_NONLOCAL_FLORIDA_DIRECTORY_PDF_INGEST !== '1') {
    throw new Error(
      `Refusing non-local database host ${url.hostname}; set ALLOW_NONLOCAL_FLORIDA_DIRECTORY_PDF_INGEST=1`,
    );
  }
  if (apply) {
    const expected = local ? LOCAL_CONFIRMATION : NONLOCAL_CONFIRMATION;
    if (env.FLORIDA_DIRECTORY_PDF_CONFIRM !== expected)
      throw new Error(`Apply requires FLORIDA_DIRECTORY_PDF_CONFIRM=${expected}`);
  }
  return url;
}

async function snapshotFingerprint(
  tx: Prisma.TransactionClient,
): Promise<{ sha256: string; rows: number }> {
  const [legislators, committees, memberships] = await Promise.all([
    tx.stateLegislator.findMany({
      where: { state: 'FL' },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        name: true,
        state: true,
        chamber: true,
        district: true,
        party: true,
        email: true,
        image: true,
        url: true,
        committees: true,
        active: true,
        legiscanPeopleId: true,
        syncedAt: true,
      },
    }),
    tx.stateCommittee.findMany({
      where: { state: 'FL' },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        officialSourceKey: true,
        legislativeSession: true,
        sourceUrl: true,
        state: true,
        chamber: true,
        name: true,
        legiscanCommitteeId: true,
        lastSyncedAt: true,
      },
    }),
    tx.stateCommitteeMembership.findMany({
      where: { OR: [{ committee: { state: 'FL' } }, { legislator: { state: 'FL' } }] },
      orderBy: { id: 'asc' },
      select: { id: true, committeeId: true, legislatorId: true, role: true, lastSyncedAt: true },
    }),
  ]);
  const value = canonical({ legislators, committees, memberships });
  return {
    sha256: sha256(value),
    rows: legislators.length + committees.length + memberships.length,
  };
}

async function createExactBeforeSnapshots(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE fl_pdf_legislator_before ON COMMIT DROP AS
    SELECT id, name, state, chamber, district, party, email, image, url, committees,
           active, legiscan_people_id, synced_at
      FROM state_legislator WHERE state = 'FL'
  `);
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE fl_pdf_committee_before ON COMMIT DROP AS
    SELECT official_source_key, legislative_session, source_url, id, state, chamber,
           name, legiscan_committee_id, last_synced_at
      FROM state_committee WHERE state = 'FL'
  `);
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE fl_pdf_membership_before ON COMMIT DROP AS
    SELECT m.id, m.committee_id, m.legislator_id, m.role, m.last_synced_at
      FROM state_committee_membership m
      JOIN state_committee c ON c.id = m.committee_id
      JOIN state_legislator l ON l.id = m.legislator_id
     WHERE c.state = 'FL' OR l.state = 'FL'
  `);
}

async function exactNonMutationDiffs(tx: Prisma.TransactionClient): Promise<number> {
  const rows = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(`
    SELECT COUNT(*)::bigint AS count FROM (
      (SELECT * FROM fl_pdf_legislator_before EXCEPT ALL
       SELECT id, name, state, chamber, district, party, email, image, url, committees,
              active, legiscan_people_id, synced_at FROM state_legislator WHERE state = 'FL')
      UNION ALL
      (SELECT id, name, state, chamber, district, party, email, image, url, committees,
              active, legiscan_people_id, synced_at FROM state_legislator WHERE state = 'FL'
       EXCEPT ALL SELECT * FROM fl_pdf_legislator_before)
      UNION ALL
      (SELECT * FROM fl_pdf_committee_before EXCEPT ALL
       SELECT official_source_key, legislative_session, source_url, id, state, chamber,
              name, legiscan_committee_id, last_synced_at FROM state_committee WHERE state = 'FL')
      UNION ALL
      (SELECT official_source_key, legislative_session, source_url, id, state, chamber,
              name, legiscan_committee_id, last_synced_at FROM state_committee WHERE state = 'FL'
       EXCEPT ALL SELECT * FROM fl_pdf_committee_before)
      UNION ALL
      (SELECT * FROM fl_pdf_membership_before EXCEPT ALL
       SELECT m.id, m.committee_id, m.legislator_id, m.role, m.last_synced_at
         FROM state_committee_membership m
         JOIN state_committee c ON c.id = m.committee_id
         JOIN state_legislator l ON l.id = m.legislator_id
        WHERE c.state = 'FL' OR l.state = 'FL')
      UNION ALL
      (SELECT m.id, m.committee_id, m.legislator_id, m.role, m.last_synced_at
         FROM state_committee_membership m
         JOIN state_committee c ON c.id = m.committee_id
         JOIN state_legislator l ON l.id = m.legislator_id
        WHERE c.state = 'FL' OR l.state = 'FL'
       EXCEPT ALL SELECT * FROM fl_pdf_membership_before)
    ) differences
  `);
  return Number(rows[0]?.count ?? 0n);
}

async function loadInputs(): Promise<{
  manifest: FloridaDirectoryManifest;
  inventory: Inventory;
  manifestSha256: string;
}> {
  const manifestPath = join(
    __dirname,
    '../data/florida-legislative-directory/directory-enrichment.json',
  );
  const inventoryPath = join(__dirname, '../data/florida-official-committee-inventory.json');
  const [manifestBytes, inventoryBytes] = await Promise.all([
    readFile(manifestPath),
    readFile(inventoryPath),
  ]);
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as FloridaDirectoryManifest;
  const inventory = JSON.parse(inventoryBytes.toString('utf8')) as Inventory;
  if (manifest.sources.officialCommitteeInventory.sha256 !== sha256(inventoryBytes))
    throw new Error('Official committee inventory hash does not match the reviewed manifest');
  validateManifest(manifest, inventory);
  return { manifest, inventory, manifestSha256: sha256(manifestBytes) };
}

async function main(): Promise<void> {
  const apply =
    process.argv.includes('--apply') || process.env.FLORIDA_DIRECTORY_PDF_APPLY === 'true';
  const database = validateDatabase(apply);
  const { manifest, inventory, manifestSha256 } = await loadInputs();
  const assetProofSha256 = await validatePortraitAssets(manifest);
  if (apply && process.env.FLORIDA_DIRECTORY_PDF_MANIFEST_SHA256 !== manifestSha256) {
    throw new Error(`Apply requires FLORIDA_DIRECTORY_PDF_MANIFEST_SHA256=${manifestSha256}`);
  }
  const prisma = new PrismaClient();
  try {
    const result = await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('FL:directory-pdf:ingest'))`;
        const [legislators, committees] = await Promise.all([
          tx.stateLegislator.findMany({
            where: { state: 'FL' },
            select: {
              id: true,
              name: true,
              state: true,
              chamber: true,
              district: true,
              email: true,
              active: true,
              sourceEvidence: true,
            },
          }),
          tx.stateCommittee.findMany({
            where: { state: 'FL' },
            select: {
              id: true,
              name: true,
              chamber: true,
              officialSourceKey: true,
              sourceEvidence: true,
            },
          }),
        ]);
        const plan = buildPlan(manifest, inventory, legislators, committees);
        const hash = planHash(manifestSha256, plan);
        if (plan.unresolved.length) {
          return {
            mode: apply ? 'apply-refused' : 'dry-run',
            complete: false,
            manifestSha256,
            assetProofSha256,
            planHash: hash,
            planned: plan.writes.length,
            inserted: 0,
            unchanged: 0,
            unresolved: plan.unresolved,
            warnings: plan.warnings,
            canonicalSnapshotSha256: null,
          };
        }
        if (apply && process.env.FLORIDA_DIRECTORY_PDF_PLAN_SHA256 !== hash) {
          throw new Error(`Apply requires FLORIDA_DIRECTORY_PDF_PLAN_SHA256=${hash}`);
        }
        let inserted = 0;
        let unchanged = 0;
        let snapshot: { sha256: string; rows: number } | null = null;
        if (apply) {
          await createExactBeforeSnapshots(tx);
          snapshot = await snapshotFingerprint(tx);
          const currentEvidence = new Map<string, unknown>();
          for (const write of plan.writes) {
            const evidenceKey = `${write.kind}:${write.id}`;
            const merged = mergeObservation(
              currentEvidence.get(evidenceKey) ?? write.priorSourceEvidence,
              write.observation,
            );
            currentEvidence.set(evidenceKey, merged.value);
            if (merged.status === 'unchanged') {
              unchanged += 1;
              continue;
            }
            inserted += 1;
            const sourceEvidence = merged.value as Prisma.InputJsonObject;
            if (write.kind === 'legislator') {
              await tx.stateLegislator.update({
                where: { id: write.id },
                data: { sourceEvidence },
              });
            } else {
              await tx.stateCommittee.update({ where: { id: write.id }, data: { sourceEvidence } });
            }
          }
          const after = await snapshotFingerprint(tx);
          const exactDiffs = await exactNonMutationDiffs(tx);
          if (
            after.sha256 !== snapshot.sha256 ||
            after.rows !== snapshot.rows ||
            exactDiffs !== 0
          ) {
            throw new Error(
              `Canonical non-mutation postcondition failed: before=${snapshot.sha256}/${snapshot.rows}, ` +
                `after=${after.sha256}/${after.rows}, exactDiffs=${exactDiffs}`,
            );
          }
        } else {
          const currentEvidence = new Map<string, unknown>();
          for (const write of plan.writes) {
            const evidenceKey = `${write.kind}:${write.id}`;
            const merged = mergeObservation(
              currentEvidence.get(evidenceKey) ?? write.priorSourceEvidence,
              write.observation,
            );
            currentEvidence.set(evidenceKey, merged.value);
            if (merged.status === 'inserted') inserted += 1;
            else unchanged += 1;
          }
        }
        return {
          mode: apply ? 'apply' : 'dry-run',
          complete: true,
          manifestSha256,
          assetProofSha256,
          planHash: hash,
          planned: plan.writes.length,
          inserted,
          unchanged,
          unresolved: [],
          warnings: plan.warnings,
          canonicalSnapshotSha256: snapshot?.sha256 ?? null,
        };
      },
      { timeout: 120_000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    const errorCount = result.unresolved.length;
    process.stdout.write(`FLORIDA_DIRECTORY_PDF ${JSON.stringify(result)}\n`);
    process.stdout.write(
      `INGESTION_METRIC ${JSON.stringify({
        source: 'florida-legislative-directory-pdfs',
        ...result,
        error_count: errorCount,
        databaseHost: database.hostname,
      })}\n`,
    );
    if (!result.complete) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
