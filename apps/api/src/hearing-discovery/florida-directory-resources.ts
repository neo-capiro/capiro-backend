import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type JsonRecord = Record<string, unknown>;
type Chamber = 'house' | 'senate';

const MANIFEST_RELATIVE_PATH = 'data/florida-legislative-directory/directory-enrichment.json';
const REVIEWED_MANIFEST_SHA256 = '755aabc31e31b426f9cffa224fc85c96e69bebfb175651ad84cd179c3558f73c';
const HOUSE_SOURCE_SHA256 = 'd22307e5f0809fc19fb3e3964232542b288a95d868e021f8813ccbee893a37cc';
const SENATE_SOURCE_SHA256 = 'f39f6880aef73025919a73eefbc12da6f1ba23b7d547766473f8a3d1a58c152d';

const REVIEWED_COUNTS = {
  houseOfficeDirectoryPages: 31,
  senateOfficeDirectoryPages: 5,
  senateMeetingRooms: 11,
} as const;

export type FloridaDirectoryResourceSource = Readonly<{
  document: string;
  sha256: string;
  asOfDate: string;
}>;

export type FloridaOfficeDirectoryPage = Readonly<{
  chamber: Chamber;
  pageNumber: number;
  lines: readonly string[];
  phones: readonly string[];
  emails: readonly string[];
  source: FloridaDirectoryResourceSource & Readonly<{ textSha256: string }>;
}>;

export type FloridaMeetingRoom = Readonly<{
  room: string;
  description: string;
  source: FloridaDirectoryResourceSource;
}>;

export type FloridaDirectoryResources = Readonly<{
  jurisdiction: 'FL';
  legislativeSession: '2026';
  sources: Readonly<{
    house: FloridaDirectoryResourceSource;
    senate: FloridaDirectoryResourceSource;
  }>;
  officeDirectoryPages: readonly FloridaOfficeDirectoryPage[];
  meetingRooms: readonly FloridaMeetingRoom[];
}>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid Florida directory manifest: ${label}`);
  }
  return value as JsonRecord;
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error(`Invalid Florida directory manifest: ${label}`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid Florida directory manifest: ${label}`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Invalid Florida directory manifest: ${label}`);
  return value.map((entry, index) => exactString(entry, `${label}[${index}]`));
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertSha256(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Invalid Florida directory manifest: ${label}`);
  }
  return value;
}

function assertIsoDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid Florida directory manifest: ${label}`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid Florida directory manifest: ${label}`);
  }
  return value;
}

function source(
  value: unknown,
  expected: { document: string; sha256: string },
  label: string,
): FloridaDirectoryResourceSource & { pageCount: number } {
  const row = record(value, label);
  const document = exactString(row.filename, `${label}.filename`);
  const digest = assertSha256(exactString(row.sha256, `${label}.sha256`), `${label}.sha256`);
  const asOfDate = assertIsoDate(
    exactString(row.asOfDate, `${label}.asOfDate`),
    `${label}.asOfDate`,
  );
  const pageCount = positiveInteger(row.pageCount, `${label}.pageCount`);
  if (document !== expected.document || digest !== expected.sha256) {
    throw new Error(`Unreviewed Florida directory source: ${label}`);
  }
  return { document, sha256: digest, asOfDate, pageCount };
}

function officePages(
  value: unknown,
  chamber: Chamber,
  expectedCount: number,
  expectedSourceId: 'houseDirectory' | 'senateDirectory',
  sourceInfo: FloridaDirectoryResourceSource & { pageCount: number },
): FloridaOfficeDirectoryPage[] {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw new Error(`Invalid Florida directory manifest: ${chamber} office-directory count`);
  }
  const seenPages = new Set<number>();
  return value.map((entry, index) => {
    const label = `${chamber}.officeDirectoryPages[${index}]`;
    const page = record(entry, label);
    const pageNumber = positiveInteger(page.pageNumber, `${label}.pageNumber`);
    if (pageNumber > sourceInfo.pageCount || seenPages.has(pageNumber)) {
      throw new Error(`Invalid Florida directory manifest: ${label}.pageNumber`);
    }
    seenPages.add(pageNumber);

    const provenance = record(page.provenance, `${label}.provenance`);
    if (
      exactString(provenance.sourceId, `${label}.provenance.sourceId`) !== expectedSourceId ||
      exactString(provenance.sourceSha256, `${label}.provenance.sourceSha256`) !==
        sourceInfo.sha256 ||
      positiveInteger(provenance.pageNumber, `${label}.provenance.pageNumber`) !== pageNumber
    ) {
      throw new Error(`Invalid Florida directory provenance: ${label}`);
    }
    const textSha256 = assertSha256(
      exactString(provenance.textSha256, `${label}.provenance.textSha256`),
      `${label}.provenance.textSha256`,
    );
    const emails = stringArray(page.emails, `${label}.emails`);
    const officialEmail = chamber === 'house' ? /@flhouse\.gov$/i : /@flsenate\.gov$/i;
    if (emails.some((email) => !officialEmail.test(email))) {
      throw new Error(`Invalid Florida directory manifest: ${label}.emails`);
    }

    return {
      chamber,
      pageNumber,
      lines: stringArray(page.lines, `${label}.lines`),
      phones: stringArray(page.phones, `${label}.phones`),
      emails,
      source: {
        document: sourceInfo.document,
        sha256: sourceInfo.sha256,
        asOfDate: sourceInfo.asOfDate,
        textSha256,
      },
    };
  });
}

function meetingRooms(
  value: unknown,
  sourceInfo: FloridaDirectoryResourceSource,
): FloridaMeetingRoom[] {
  if (!Array.isArray(value) || value.length !== REVIEWED_COUNTS.senateMeetingRooms) {
    throw new Error('Invalid Florida directory manifest: senate meeting-room count');
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const label = `senate.meetingRooms[${index}]`;
    const roomEntry = record(entry, label);
    const room = exactString(roomEntry.room, `${label}.room`);
    const description = exactString(roomEntry.description, `${label}.description`);
    const identity = `${room}\u0000${description}`;
    if (seen.has(identity)) throw new Error(`Duplicate Florida directory meeting room: ${room}`);
    seen.add(identity);
    return { room, description, source: sourceInfo };
  });
}

function assertReviewedManifest(manifest: JsonRecord): void {
  if (
    manifest.schemaVersion !== 1 ||
    manifest.parserVersion !== '1.0.0' ||
    manifest.jurisdiction !== 'FL' ||
    manifest.legislativeSession !== '2026'
  ) {
    throw new Error('Unreviewed Florida directory manifest contract');
  }
  const counts = record(manifest.counts, 'counts');
  for (const [key, expected] of Object.entries(REVIEWED_COUNTS)) {
    if (counts[key] !== expected) {
      throw new Error(`Invalid Florida directory manifest: counts.${key}`);
    }
  }
  const validation = record(manifest.validation, 'validation');
  if (
    !Object.values(validation).length ||
    Object.values(validation).some((value) => value !== true)
  ) {
    throw new Error('Florida directory manifest validation is incomplete');
  }
}

/**
 * Project only reviewed, source-bound chamber directory records. Office-page
 * lines deliberately remain source excerpts: the PDFs provide no stable IDs
 * that would support canonical staff or office identities.
 */
export function projectFloridaDirectoryResources(
  manifestValue: unknown,
): FloridaDirectoryResources {
  const manifest = record(manifestValue, 'root');
  assertReviewedManifest(manifest);
  const sources = record(manifest.sources, 'sources');
  const houseSource = source(
    sources.houseDirectory,
    { document: 'HouseDirectory.pdf', sha256: HOUSE_SOURCE_SHA256 },
    'sources.houseDirectory',
  );
  const senateSource = source(
    sources.senateDirectory,
    { document: 'SDIR.pdf', sha256: SENATE_SOURCE_SHA256 },
    'sources.senateDirectory',
  );
  const house = record(manifest.house, 'house');
  const senate = record(manifest.senate, 'senate');
  const publicHouseSource: FloridaDirectoryResourceSource = {
    document: houseSource.document,
    sha256: houseSource.sha256,
    asOfDate: houseSource.asOfDate,
  };
  const publicSenateSource: FloridaDirectoryResourceSource = {
    document: senateSource.document,
    sha256: senateSource.sha256,
    asOfDate: senateSource.asOfDate,
  };

  return deepFreeze({
    jurisdiction: 'FL',
    legislativeSession: '2026',
    sources: { house: publicHouseSource, senate: publicSenateSource },
    officeDirectoryPages: [
      ...officePages(
        house.officeDirectoryPages,
        'house',
        REVIEWED_COUNTS.houseOfficeDirectoryPages,
        'houseDirectory',
        houseSource,
      ),
      ...officePages(
        senate.officeDirectoryPages,
        'senate',
        REVIEWED_COUNTS.senateOfficeDirectoryPages,
        'senateDirectory',
        senateSource,
      ),
    ],
    meetingRooms: meetingRooms(senate.meetingRooms, publicSenateSource),
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  }
  return value;
}

let cachedResources: FloridaDirectoryResources | undefined;

function manifestPath(): string {
  const candidates = [
    resolve(process.cwd(), MANIFEST_RELATIVE_PATH),
    resolve(process.cwd(), 'apps/api', MANIFEST_RELATIVE_PATH),
    resolve(__dirname, '..', '..', MANIFEST_RELATIVE_PATH),
    resolve(__dirname, '..', '..', '..', MANIFEST_RELATIVE_PATH),
  ];
  const path = [...new Set(candidates)].find((candidate) => existsSync(candidate));
  if (!path) throw new Error('Reviewed Florida directory manifest is unavailable');
  return path;
}

/** Load, verify and cache the manifest included in both source and API release layouts. */
export function loadFloridaDirectoryResources(): FloridaDirectoryResources {
  if (cachedResources) return cachedResources;
  const bytes = readFileSync(manifestPath());
  if (sha256(bytes) !== REVIEWED_MANIFEST_SHA256) {
    throw new Error('Unreviewed Florida directory manifest bytes');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('Invalid Florida directory manifest JSON');
  }
  cachedResources = projectFloridaDirectoryResources(parsed);
  return cachedResources;
}
