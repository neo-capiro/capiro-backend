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

/**
 * Scope asserted by a governed qualification attempt.  This is deliberately
 * smaller than a production expected-source row: it can prove that the bytes
 * belong to the reviewed FY/cycle/agency/account candidate, but it cannot
 * authorize import or publication.
 */
export interface DticJdocsXmlCandidateScopeV1 {
  fiscalYear: number;
  budgetCycle: string;
  agency: string;
  appropriationCode: string;
}

export interface DticJdocsXmlCandidateV1 {
  schemaVersion: 'dtic_jdocs_xml_candidate_v1';
  status: 'candidate_only';
  promotable: false;
  scope: DticJdocsXmlCandidateScopeV1;
  inspection: DticJdocsXmlSourceInspectionV1;
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
  return directNamedChild(value, wanted)?.value;
}

function directNamedChild(value: unknown, wanted: string): { name: string; value: unknown } | null {
  const record = asRecord(value);
  if (!record) return null;
  for (const [key, child] of Object.entries(record)) {
    if (!key.startsWith('@_') && localName(key) === wanted) return { name: key, value: child };
  }
  return null;
}

function topLevelDocumentElement(
  value: unknown,
): { name: string; node: Record<string, unknown> } | null {
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

type NamespaceBindings = Record<string, string>;

function namespaceBindings(
  element: Record<string, unknown>,
  inherited: NamespaceBindings = {},
): NamespaceBindings {
  const bindings = { ...inherited };
  for (const [attribute, value] of Object.entries(element)) {
    if (typeof value !== 'string') continue;
    if (attribute === '@_xmlns') bindings[''] = value;
    else if (attribute.startsWith('@_xmlns:')) bindings[attribute.slice('@_xmlns:'.length)] = value;
  }
  return bindings;
}

function elementNamespace(name: string, bindings: NamespaceBindings): string | null {
  const colon = name.indexOf(':');
  const prefix = colon >= 0 ? name.slice(0, colon) : '';
  if (colon >= 0 && (!prefix || name.indexOf(':', colon + 1) >= 0)) return null;
  return bindings[prefix] ?? (prefix === '' ? '' : null);
}

function requireElementNamespace(
  name: string,
  bindings: NamespaceBindings,
  expectedLocalName: string,
  expectedNamespace: string,
): void {
  if (
    localName(name) !== expectedLocalName ||
    elementNamespace(name, bindings) !== expectedNamespace
  ) {
    fail(`${expectedLocalName} must resolve to the expected DTIC namespace`);
  }
}

function collectProgramElementIds(
  name: string,
  value: unknown,
  inherited: NamespaceBindings,
  output: string[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectProgramElementIds(name, item, inherited, output);
    return;
  }
  const record = asRecord(value);
  if (!record) {
    if (localName(name) === 'ProgramElementNumber') {
      requireElementNamespace(name, inherited, 'ProgramElementNumber', DTIC_JDOCS_R2_NAMESPACE_V1);
      output.push(scalar(value, 'ProgramElementNumber'));
    }
    return;
  }
  const bindings = namespaceBindings(record, inherited);
  if (localName(name) === 'ProgramElementNumber') {
    requireElementNamespace(name, bindings, 'ProgramElementNumber', DTIC_JDOCS_R2_NAMESPACE_V1);
    output.push(scalar(value, 'ProgramElementNumber'));
    return;
  }
  for (const [key, child] of Object.entries(record)) {
    if (key.startsWith('@_')) continue;
    collectProgramElementIds(key, child, bindings, output);
  }
}

function validateProvenance(value: DticJdocsXmlSourceProvenanceV1): void {
  if (!GIT_COMMIT.test(value.mirrorCommit))
    fail('mirrorCommit must be a full lowercase Git commit SHA');
  if (
    !value.mirrorPath.trim() ||
    value.mirrorPath.startsWith('/') ||
    value.mirrorPath.includes('..')
  ) {
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
  const rootBindings = namespaceBindings(root);
  requireElementNamespace(
    topLevel.name,
    rootBindings,
    'JustificationBook',
    DTIC_JDOCS_XML_ROOT_NAMESPACE_V1,
  );
  const r2ListElement = directNamedChild(root, 'ProgramElementList');
  const r2List = asRecord(r2ListElement?.value);
  if (!r2ListElement || !r2List) {
    fail('expected ProgramElementList in the DTIC R2 namespace');
  }
  const r2ListBindings = namespaceBindings(r2List, rootBindings);
  requireElementNamespace(
    r2ListElement.name,
    r2ListBindings,
    'ProgramElementList',
    DTIC_JDOCS_R2_NAMESPACE_V1,
  );

  const fiscalYearText = scalar(directChild(root, 'BudgetYear'), 'BudgetYear');
  if (!/^\d{4}$/.test(fiscalYearText)) fail('BudgetYear must be a four-digit year');
  const fiscalYear = Number(fiscalYearText);
  const budgetCycle = scalar(directChild(root, 'BudgetCycle'), 'BudgetCycle');
  const agency = scalar(directChild(root, 'ServiceAgencyName'), 'ServiceAgencyName');
  const appropriationCode = scalar(directChild(root, 'AppropriationCode'), 'AppropriationCode');
  const appropriationName = scalar(directChild(root, 'AppropriationName'), 'AppropriationName');
  const submissionDateValue = directChild(root, 'SubmissionDate');
  const submissionDate =
    submissionDateValue == null ? null : scalar(submissionDateValue, 'SubmissionDate');

  const rawIds: string[] = [];
  collectProgramElementIds(r2ListElement.name, r2List, rootBindings, rawIds);
  const programElementIds = [...new Set(rawIds)].sort((a, b) => a.localeCompare(b));
  if (programElementIds.length === 0)
    fail('R2 candidate contains no ProgramElementNumber identities');

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

function normalizedScopeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * Qualify one pinned DTIC XML candidate against an explicitly declared scope.
 *
 * This is still a read-only candidate envelope.  A scope mismatch is a hard
 * refusal rather than a warning so a document cannot be silently attributed to
 * another year, cycle, agency, or appropriation.  The returned envelope never
 * claims semantic extraction, PDF reconciliation, completeness, or promotion.
 */
export function qualifyDticJdocsXmlCandidateV1(
  bytes: Uint8Array,
  provenance: DticJdocsXmlSourceProvenanceV1,
  expectedScope: DticJdocsXmlCandidateScopeV1,
): DticJdocsXmlCandidateV1 {
  if (!Number.isInteger(expectedScope.fiscalYear) || expectedScope.fiscalYear < 1900) {
    fail('expected fiscalYear must be a valid integer year');
  }
  for (const [field, value] of [
    ['budgetCycle', expectedScope.budgetCycle],
    ['agency', expectedScope.agency],
    ['appropriationCode', expectedScope.appropriationCode],
  ] as const) {
    if (typeof value !== 'string' || value.trim() === '')
      fail(`expected ${field} must be nonblank`);
  }

  const inspection = inspectDticJdocsXmlSourceV1(bytes, provenance);
  const mismatches: string[] = [];
  if (inspection.fiscalYear !== expectedScope.fiscalYear) {
    mismatches.push(`fiscalYear=${inspection.fiscalYear} expected ${expectedScope.fiscalYear}`);
  }
  if (
    normalizedScopeText(inspection.budgetCycle) !== normalizedScopeText(expectedScope.budgetCycle)
  ) {
    mismatches.push(`budgetCycle=${inspection.budgetCycle} expected ${expectedScope.budgetCycle}`);
  }
  if (normalizedScopeText(inspection.agency) !== normalizedScopeText(expectedScope.agency)) {
    mismatches.push(`agency=${inspection.agency} expected ${expectedScope.agency}`);
  }
  if (
    normalizedScopeText(inspection.appropriationCode) !==
    normalizedScopeText(expectedScope.appropriationCode)
  ) {
    mismatches.push(
      `appropriationCode=${inspection.appropriationCode} expected ${expectedScope.appropriationCode}`,
    );
  }
  if (mismatches.length > 0) fail(`candidate scope mismatch: ${mismatches.join('; ')}`);

  return {
    schemaVersion: 'dtic_jdocs_xml_candidate_v1',
    status: 'candidate_only',
    promotable: false,
    scope: {
      fiscalYear: expectedScope.fiscalYear,
      budgetCycle: expectedScope.budgetCycle.trim(),
      agency: expectedScope.agency.trim(),
      appropriationCode: expectedScope.appropriationCode.trim(),
    },
    inspection,
  };
}
