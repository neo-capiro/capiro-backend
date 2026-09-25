import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const DTIC_JDOCS_XML_INSPECTOR_SCHEMA_V1 = 'dtic_jdocs_xml_source_inspection_v1' as const;
export const DTIC_JDOCS_XML_ROOT_NAMESPACE_V1 =
  'http://www.dtic.mil/comptroller/xml/schema/022009/jb' as const;
export const DTIC_JDOCS_R2_NAMESPACE_V1 =
  'http://www.dtic.mil/comptroller/xml/schema/022009/r2' as const;

export const DTIC_FY2026_DTIC_CANDIDATE_PROVENANCE_V1 = {
  mirrorCommit: '5c6310d9845cd75360bf4c39a220f9d6699b65df',
  mirrorPath: 'fy2026/RDTE_DTIC_PB_2026.xml',
  mirrorUrl:
    'https://raw.githubusercontent.com/handriss/defense-budget-justification-data/5c6310d9845cd75360bf4c39a220f9d6699b65df/fy2026/RDTE_DTIC_PB_2026.xml',
  expectedMirrorSha256: '02479cd6e67dfee10bb1029d9413dbc35e81174384b25319fedfb9589d4aac6a',
  officialPdfUrl:
    'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2026/budget_justification/pdfs/03_RDT_and_E/RDTE_DTIC_PB_2026.pdf',
  officialPdfSha256: '08c867d61816f7b5ebb82924a33d4003ee03c7880984ac6dc9bc91363b6f2d63',
} as const satisfies DticJdocsXmlSourceProvenanceV1;

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_COMMIT = /^[a-f0-9]{40}$/;

export interface DticJdocsXmlSourceProvenanceV1 {
  mirrorCommit: string;
  mirrorPath: string;
  mirrorUrl: string;
  expectedMirrorSha256?: string;
  officialPdfUrl: string;
  officialPdfSha256: string;
}

export interface DticJdocsXmlSourceInspectionV1 {
  schemaVersion: typeof DTIC_JDOCS_XML_INSPECTOR_SCHEMA_V1;
  status: 'candidate_only';
  promotable: false;
  fiscalYear: number;
  budgetCycle: string;
  submissionDate: string | null;
  agency: string;
  appropriationCode: string;
  appropriationName: string;
  programElementCount: number;
  programElementIds: string[];
  duplicateProgramElementOccurrences: number;
  originalBytesSha256: string;
  mirror: {
    commit: string;
    path: string;
    url: string;
    expectedSha256: string | null;
  };
  officialPdf: {
    url: string;
    sha256: string;
  };
  limitations: readonly string[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
  preserveOrder: false,
  removeNSPrefix: false,
  processEntities: false,
});

function fail(message: string): never {
  throw new Error(`DTIC/JDOCS XML inspection rejected: ${message}`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function scalar(value: unknown, field: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  fail(`missing or invalid ${field}`);
}

function localName(name: string): string {
  const colon = name.lastIndexOf(':');
  return colon >= 0 ? name.slice(colon + 1) : name;
}

function directChild(value: unknown, wanted: string): unknown {
  const record = asRecord(value);
  if (!record) return undefined;
  for (const [key, child] of Object.entries(record)) {
    if (!key.startsWith('@_') && localName(key) === wanted) return child;
  }
  return undefined;
}

function findNamedNode(value: unknown, wanted: string): Record<string, unknown> | null {
  return asRecord(directChild(value, wanted));
}

function topLevelDocumentElement(value: unknown): { name: string; node: Record<string, unknown> } | null {
  const record = asRecord(value);
  if (!record) return null;
  const elements = Object.entries(record).filter(
    ([key]) => !key.startsWith('@_') && !key.startsWith('?') && !key.startsWith('!'),
  );
  if (elements.length !== 1) return null;
  const [name, node] = elements[0]!;
  const parsedNode = asRecord(node);
  return parsedNode ? { name, node: parsedNode } : null;
}

function collectProgramElementIds(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectProgramElementIds(item, output);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [key, child] of Object.entries(record)) {
    if (key.startsWith('@_')) continue;
    if (localName(key) === 'ProgramElementNumber') {
      output.push(scalar(child, 'ProgramElementNumber'));
    } else {
      collectProgramElementIds(child, output);
    }
  }
}

function validateProvenance(value: DticJdocsXmlSourceProvenanceV1): void {
  if (!GIT_COMMIT.test(value.mirrorCommit)) fail('mirrorCommit must be a full lowercase Git commit SHA');
  if (!value.mirrorPath.trim() || value.mirrorPath.startsWith('/') || value.mirrorPath.includes('..')) {
    fail('mirrorPath must be a non-empty repository-relative path');
  }
  for (const [name, url] of [
    ['mirrorUrl', value.mirrorUrl],
    ['officialPdfUrl', value.officialPdfUrl],
  ] as const) {
    try {
      if (new URL(url).protocol !== 'https:') fail(`${name} must use HTTPS`);
    } catch {
      fail(`${name} must be an absolute HTTPS URL`);
    }
  }
  if (!SHA256.test(value.officialPdfSha256)) fail('officialPdfSha256 must be lowercase SHA-256');
  if (value.expectedMirrorSha256 != null && !SHA256.test(value.expectedMirrorSha256)) {
    fail('expectedMirrorSha256 must be lowercase SHA-256');
  }
}

/**
 * Read-only, deterministic catalog inspection for a pinned DTIC JDOCS XML file.
 * This does not make a semantic artifact, assert family completeness, or create
 * a promotion-ready source record.
 */
export function inspectDticJdocsXmlSourceV1(
  bytes: Uint8Array,
  provenance: DticJdocsXmlSourceProvenanceV1,
): DticJdocsXmlSourceInspectionV1 {
  validateProvenance(provenance);
  const originalBytesSha256 = createHash('sha256').update(bytes).digest('hex');
  if (provenance.expectedMirrorSha256 && originalBytesSha256 !== provenance.expectedMirrorSha256) {
    fail('original byte SHA-256 does not match expectedMirrorSha256');
  }

  const xml = Buffer.from(bytes).toString('utf8');
  const validation = XMLValidator.validate(xml);
  if (validation !== true) fail('XML is not well formed');
  let document: unknown;
  try {
    document = parser.parse(xml);
  } catch {
    fail('XML parser could not read the document');
  }
  const topLevel = topLevelDocumentElement(document);
  if (!topLevel || localName(topLevel.name) !== 'JustificationBook') {
    fail('expected JustificationBook as the single top-level document element');
  }
  const root = topLevel.node;
  if (root['@_xmlns:jb'] !== DTIC_JDOCS_XML_ROOT_NAMESPACE_V1) {
    fail('JustificationBook must declare the expected DTIC JB namespace');
  }
  const r2List = findNamedNode(root, 'ProgramElementList');
  if (!r2List || r2List['@_xmlns:r2'] !== DTIC_JDOCS_R2_NAMESPACE_V1) {
    fail('ProgramElementList must declare the expected DTIC R2 namespace');
  }

  const fiscalYearText = scalar(directChild(root, 'BudgetYear'), 'BudgetYear');
  if (!/^\d{4}$/.test(fiscalYearText)) fail('BudgetYear must be a four-digit year');
  const fiscalYear = Number(fiscalYearText);
  const budgetCycle = scalar(directChild(root, 'BudgetCycle'), 'BudgetCycle');
  const agency = scalar(directChild(root, 'ServiceAgencyName'), 'ServiceAgencyName');
  const appropriationCode = scalar(
    directChild(root, 'AppropriationCode'),
    'AppropriationCode',
  );
  const appropriationName = scalar(
    directChild(root, 'AppropriationName'),
    'AppropriationName',
  );
  const submissionDateValue = directChild(root, 'SubmissionDate');
  const submissionDate = submissionDateValue == null
    ? null
    : scalar(submissionDateValue, 'SubmissionDate');

  const rawIds: string[] = [];
  collectProgramElementIds(r2List, rawIds);
  const programElementIds = [...new Set(rawIds)].sort((a, b) => a.localeCompare(b));
  if (programElementIds.length === 0) fail('R2 candidate contains no ProgramElementNumber identities');

  return {
    schemaVersion: DTIC_JDOCS_XML_INSPECTOR_SCHEMA_V1,
    status: 'candidate_only',
    promotable: false,
    fiscalYear,
    budgetCycle,
    submissionDate,
    agency,
    appropriationCode,
    appropriationName,
    programElementCount: programElementIds.length,
    programElementIds,
    duplicateProgramElementOccurrences: rawIds.length - programElementIds.length,
    originalBytesSha256,
    mirror: {
      commit: provenance.mirrorCommit,
      path: provenance.mirrorPath,
      url: provenance.mirrorUrl,
      expectedSha256: provenance.expectedMirrorSha256 ?? null,
    },
    officialPdf: {
      url: provenance.officialPdfUrl,
      sha256: provenance.officialPdfSha256,
    },
    limitations: [
      'catalog_metadata_only_no_semantic_extraction_or_verification',
      'does_not_establish_annual_family_or_component_completeness',
      'mirror_bytes_and_official_pdf_are_separately_hash_bound_but_not_content_equivalent_proof',
      'not_promotable_and_not_authorized_for_production_import',
    ],
  };
}
