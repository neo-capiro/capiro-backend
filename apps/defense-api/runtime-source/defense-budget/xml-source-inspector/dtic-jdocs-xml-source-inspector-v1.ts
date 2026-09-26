import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const DTIC_JDOCS_XML_INSPECTOR_SCHEMA_V1 = 'dtic_jdocs_xml_source_inspection_v1' as const;
export const DTIC_JDOCS_XML_ROOT_NAMESPACE_V1 =
  'http://www.dtic.mil/comptroller/xml/schema/022009/jb' as const;
export const DTIC_JDOCS_R2_NAMESPACE_V1 =
  'http://www.dtic.mil/comptroller/xml/schema/022009/r2' as const;
export const DTIC_JDOCS_XML_LOCATOR_INVENTORY_SCHEMA_V1 =
  'dtic_jdocs_xml_locator_inventory_v1' as const;
export const DTIC_JDOCS_XML_SEMANTIC_CANDIDATE_SCHEMA_V1 =
  'dtic_jdocs_xml_semantic_candidate_v1' as const;

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

export interface DticJdocsXmlElementPathSegmentV1 {
  namespace: string;
  localName: string;
  siblingIndex: number;
}

export interface DticJdocsXmlProgramElementLocatorV1 {
  elementPath: string;
  path: DticJdocsXmlElementPathSegmentV1[];
  value: string;
}

export interface DticJdocsXmlLocatorInventoryV1 {
  schemaVersion: typeof DTIC_JDOCS_XML_LOCATOR_INVENTORY_SCHEMA_V1;
  status: 'candidate_only';
  promotable: false;
  originalBytesSha256: string;
  programElementLocators: DticJdocsXmlProgramElementLocatorV1[];
  limitations: readonly string[];
}

export interface DticJdocsXmlSemanticFieldLocatorV1 {
  field:
    | 'programElementNumber'
    | 'programElementTitle'
    | 'budgetYear'
    | 'programElementFunding'
    | 'allPriorYears'
    | 'priorYear'
    | 'currentYear'
    | 'budgetYearOne'
    | 'budgetYearOneBase'
    | 'programElementMissionDescription';
  locator: DticJdocsXmlProgramElementLocatorV1;
}

export interface DticJdocsXmlSemanticCandidateRecordV1 {
  programElementNumber: string;
  programElementTitle: string;
  budgetYear: number;
  monetaryUnit: string;
  funding: {
    allPriorYears: string;
    priorYear: string;
    currentYear: string;
    budgetYearOne: string;
    budgetYearOneBase: string;
  };
  missionDescription?: string;
  locators: DticJdocsXmlSemanticFieldLocatorV1[];
}

export interface DticJdocsXmlSemanticCandidateV1 {
  schemaVersion: typeof DTIC_JDOCS_XML_SEMANTIC_CANDIDATE_SCHEMA_V1;
  status: 'candidate_only';
  promotable: false;
  originalBytesSha256: string;
  records: DticJdocsXmlSemanticCandidateRecordV1[];
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

function expandedPathSegment(
  name: string,
  bindings: NamespaceBindings,
  siblingIndex: number,
): DticJdocsXmlElementPathSegmentV1 {
  const namespace = elementNamespace(name, bindings);
  if (!namespace) fail(`cannot resolve namespace for ${name}`);
  return { namespace, localName: localName(name), siblingIndex };
}

function expandedPathString(path: readonly DticJdocsXmlElementPathSegmentV1[]): string {
  return path
    .map((segment) => `{${segment.namespace}}${segment.localName}[${segment.siblingIndex}]`)
    .join('/');
}

function directNamedChildren(
  value: unknown,
  wanted: string,
): Array<{ name: string; value: unknown; siblingIndex: number }> {
  const record = asRecord(value);
  if (!record) return [];
  const matches: Array<{ name: string; value: unknown; siblingIndex: number }> = [];
  for (const [key, child] of Object.entries(record)) {
    if (key.startsWith('@_') || localName(key) !== wanted) continue;
    const values = Array.isArray(child) ? child : [child];
    values.forEach((entry, siblingIndex) =>
      matches.push({ name: key, value: entry, siblingIndex }),
    );
  }
  return matches;
}

function numericText(value: unknown, field: string): string {
  const text = scalar(value, field);
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text))
    fail(`${field} must be a canonical decimal string`);
  return text;
}

function fieldLocator(
  parent: Record<string, unknown>,
  parentPath: readonly DticJdocsXmlElementPathSegmentV1[],
  parentBindings: NamespaceBindings,
  wanted: string,
  field: DticJdocsXmlSemanticFieldLocatorV1['field'],
): { value: string; locator: DticJdocsXmlSemanticFieldLocatorV1 } {
  const children = directNamedChildren(parent, wanted);
  if (children.length !== 1) fail(`${wanted} must occur exactly once`);
  const child = children[0]!;
  requireElementNamespace(child.name, parentBindings, wanted, DTIC_JDOCS_R2_NAMESPACE_V1);
  const path = [...parentPath, expandedPathSegment(child.name, parentBindings, child.siblingIndex)];
  return {
    value: scalar(child.value, wanted),
    locator: {
      field,
      locator: { elementPath: expandedPathString(path), path, value: scalar(child.value, wanted) },
    },
  };
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

/**
 * Produce stable, prefix-independent XML element locators for the R2 PE
 * identities in a pinned DTIC document. This is deliberately an evidence
 * primitive only: it does not interpret funding values, claim PDF equivalence,
 * register a source, or authorize import/publication.
 */
export function inventoryDticJdocsXmlProgramElementLocatorsV1(
  bytes: Uint8Array,
  provenance: DticJdocsXmlSourceProvenanceV1,
): DticJdocsXmlLocatorInventoryV1 {
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
  const rootBindings = namespaceBindings(topLevel.node);
  requireElementNamespace(
    topLevel.name,
    rootBindings,
    'JustificationBook',
    DTIC_JDOCS_XML_ROOT_NAMESPACE_V1,
  );
  const r2ListElement = directNamedChild(topLevel.node, 'ProgramElementList');
  const r2List = asRecord(r2ListElement?.value);
  if (!r2ListElement || !r2List) fail('expected ProgramElementList in the DTIC R2 namespace');
  const r2ListBindings = namespaceBindings(r2List, rootBindings);
  requireElementNamespace(
    r2ListElement.name,
    r2ListBindings,
    'ProgramElementList',
    DTIC_JDOCS_R2_NAMESPACE_V1,
  );

  const listPath = [expandedPathSegment(r2ListElement.name, r2ListBindings, 0)];
  const locators: DticJdocsXmlProgramElementLocatorV1[] = [];
  for (const programElement of directNamedChildren(r2List, 'ProgramElement')) {
    const programRecord = asRecord(programElement.value);
    if (!programRecord) fail('R2 ProgramElement must be an object');
    const programBindings = namespaceBindings(programRecord, r2ListBindings);
    requireElementNamespace(
      programElement.name,
      programBindings,
      'ProgramElement',
      DTIC_JDOCS_R2_NAMESPACE_V1,
    );
    const numberChildren = directNamedChildren(programRecord, 'ProgramElementNumber');
    if (numberChildren.length === 0) fail('R2 ProgramElement has no ProgramElementNumber');
    numberChildren.forEach((numberChild) => {
      requireElementNamespace(
        numberChild.name,
        programBindings,
        'ProgramElementNumber',
        DTIC_JDOCS_R2_NAMESPACE_V1,
      );
      const value = scalar(numberChild.value, 'ProgramElementNumber');
      const path = [
        ...listPath,
        expandedPathSegment(programElement.name, programBindings, programElement.siblingIndex),
        expandedPathSegment(numberChild.name, programBindings, numberChild.siblingIndex),
      ];
      locators.push({ elementPath: expandedPathString(path), path, value });
    });
  }
  if (locators.length === 0) fail('R2 candidate contains no ProgramElementNumber identities');

  return {
    schemaVersion: DTIC_JDOCS_XML_LOCATOR_INVENTORY_SCHEMA_V1,
    status: 'candidate_only',
    promotable: false,
    originalBytesSha256,
    programElementLocators: locators,
    limitations: [
      'element_locators_only_no_funding_semantic_extraction',
      'does_not_establish_annual_family_or_component_completeness',
      'prefix_independent_paths_are_bound_to_the_original_source_sha256',
      'not_promotable_and_not_authorized_for_production_import',
    ],
  };
}

/**
 * Extract the typed PE-level values present in a pinned DTIC R2 document.
 * Every value is paired with a prefix-independent expanded-QName locator and
 * the whole candidate is bound to the original XML byte SHA. This remains a
 * qualification primitive: it does not assert family completeness, reconcile
 * against the PDF, persist a semantic artifact, or authorize publication.
 */
export function extractDticJdocsXmlSemanticCandidateV1(
  bytes: Uint8Array,
  provenance: DticJdocsXmlSourceProvenanceV1,
): DticJdocsXmlSemanticCandidateV1 {
  validateProvenance(provenance);
  const originalBytesSha256 = createHash('sha256').update(bytes).digest('hex');
  if (provenance.expectedMirrorSha256 && originalBytesSha256 !== provenance.expectedMirrorSha256) {
    fail('original byte SHA-256 does not match expectedMirrorSha256');
  }
  const validation = XMLValidator.validate(Buffer.from(bytes).toString('utf8'));
  if (validation !== true) fail('XML is not well formed');
  let document: unknown;
  try {
    document = parser.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    fail('XML parser could not read the document');
  }
  const topLevel = topLevelDocumentElement(document);
  if (!topLevel || localName(topLevel.name) !== 'JustificationBook') {
    fail('expected JustificationBook as the single top-level document element');
  }
  const rootBindings = namespaceBindings(topLevel.node);
  requireElementNamespace(
    topLevel.name,
    rootBindings,
    'JustificationBook',
    DTIC_JDOCS_XML_ROOT_NAMESPACE_V1,
  );
  const r2ListElement = directNamedChild(topLevel.node, 'ProgramElementList');
  const r2List = asRecord(r2ListElement?.value);
  if (!r2ListElement || !r2List) fail('expected ProgramElementList in the DTIC R2 namespace');
  const r2ListBindings = namespaceBindings(r2List, rootBindings);
  requireElementNamespace(
    r2ListElement.name,
    r2ListBindings,
    'ProgramElementList',
    DTIC_JDOCS_R2_NAMESPACE_V1,
  );
  const listPath = [expandedPathSegment(r2ListElement.name, r2ListBindings, 0)];
  const records: DticJdocsXmlSemanticCandidateRecordV1[] = [];
  for (const programElement of directNamedChildren(r2List, 'ProgramElement')) {
    const programRecord = asRecord(programElement.value);
    if (!programRecord) fail('R2 ProgramElement must be an object');
    const programBindings = namespaceBindings(programRecord, r2ListBindings);
    requireElementNamespace(
      programElement.name,
      programBindings,
      'ProgramElement',
      DTIC_JDOCS_R2_NAMESPACE_V1,
    );
    const programPath = [
      ...listPath,
      expandedPathSegment(programElement.name, programBindings, programElement.siblingIndex),
    ];
    const number = fieldLocator(
      programRecord,
      programPath,
      programBindings,
      'ProgramElementNumber',
      'programElementNumber',
    );
    const title = fieldLocator(
      programRecord,
      programPath,
      programBindings,
      'ProgramElementTitle',
      'programElementTitle',
    );
    const year = fieldLocator(
      programRecord,
      programPath,
      programBindings,
      'BudgetYear',
      'budgetYear',
    );
    const budgetYear = Number(year.value);
    if (!/^\d{4}$/.test(year.value) || !Number.isInteger(budgetYear))
      fail('ProgramElement BudgetYear must be a four-digit year');
    const monetaryUnit = programRecord['@_monetaryUnit'];
    if (typeof monetaryUnit !== 'string' || monetaryUnit.trim() === '')
      fail('ProgramElement monetaryUnit attribute is required');
    const fundingChild = directNamedChildren(programRecord, 'ProgramElementFunding');
    if (fundingChild.length !== 1) fail('ProgramElementFunding must occur exactly once');
    const funding = fundingChild[0]!;
    requireElementNamespace(
      funding.name,
      programBindings,
      'ProgramElementFunding',
      DTIC_JDOCS_R2_NAMESPACE_V1,
    );
    const fundingRecord = asRecord(funding.value);
    if (!fundingRecord) fail('ProgramElementFunding must be an object');
    const fundingBindings = namespaceBindings(fundingRecord, programBindings);
    const fundingPath = [
      ...programPath,
      expandedPathSegment(funding.name, fundingBindings, funding.siblingIndex),
    ];
    const fields = [
      ['AllPriorYears', 'allPriorYears'],
      ['PriorYear', 'priorYear'],
      ['CurrentYear', 'currentYear'],
      ['BudgetYearOne', 'budgetYearOne'],
      ['BudgetYearOneBase', 'budgetYearOneBase'],
    ] as const;
    const fundingValues = Object.fromEntries(
      fields.map(([xmlName, field]) => {
        const result = fieldLocator(fundingRecord, fundingPath, fundingBindings, xmlName, field);
        return [field, { value: numericText(result.value, xmlName), locator: result.locator }];
      }),
    ) as Record<
      (typeof fields)[number][1],
      { value: string; locator: DticJdocsXmlSemanticFieldLocatorV1 }
    >;
    const missionChild = directNamedChildren(programRecord, 'ProgramElementMissionDescription');
    let missionDescription: string | undefined;
    let missionLocator: DticJdocsXmlSemanticFieldLocatorV1 | undefined;
    if (missionChild.length > 1) fail('ProgramElementMissionDescription must occur at most once');
    if (missionChild.length === 1) {
      const mission = fieldLocator(
        programRecord,
        programPath,
        programBindings,
        'ProgramElementMissionDescription',
        'programElementMissionDescription',
      );
      missionDescription = mission.value;
      missionLocator = mission.locator;
    }
    records.push({
      programElementNumber: number.value,
      programElementTitle: title.value,
      budgetYear,
      monetaryUnit: monetaryUnit.trim(),
      funding: {
        allPriorYears: fundingValues.allPriorYears.value,
        priorYear: fundingValues.priorYear.value,
        currentYear: fundingValues.currentYear.value,
        budgetYearOne: fundingValues.budgetYearOne.value,
        budgetYearOneBase: fundingValues.budgetYearOneBase.value,
      },
      ...(missionDescription != null ? { missionDescription } : {}),
      locators: [
        number.locator,
        title.locator,
        year.locator,
        {
          field: 'programElementFunding',
          locator: {
            elementPath: expandedPathString(fundingPath),
            path: fundingPath,
            value: '[object]',
          },
        },
        ...fields.map(([, field]) => fundingValues[field].locator),
        ...(missionLocator != null ? [missionLocator] : []),
      ],
    });
  }
  if (records.length === 0) fail('R2 candidate contains no ProgramElement records');
  return {
    schemaVersion: DTIC_JDOCS_XML_SEMANTIC_CANDIDATE_SCHEMA_V1,
    status: 'candidate_only',
    promotable: false,
    originalBytesSha256,
    records,
    limitations: [
      'field_level_xml_candidate_only_no_pdf_reconciliation',
      'does_not_establish_annual_family_or_component_completeness',
      'prefix_independent_paths_are_bound_to_the_original_source_sha256',
      'not_promotable_and_not_authorized_for_production_import',
    ],
  };
}
