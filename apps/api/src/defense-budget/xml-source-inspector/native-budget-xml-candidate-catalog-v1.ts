import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { parseCanonicalDecimalString } from '../contracts/decimal-string.js';
export const NATIVE_XML_CATALOG_MAX_BYTES_V1 = 64 * 1024 * 1024;
const JB = 'http://www.dtic.mil/comptroller/xml/schema/022009/jb';
const R2 = 'http://www.dtic.mil/comptroller/xml/schema/022009/r2';
const PROC = 'http://www.dtic.mil/comptroller/xml/schema/20100219/procurement';
type JsonNode = Record<string, unknown>;
type Bindings = Record<string, string>;
export interface NativeXmlCatalogInput {
  origin?: 'donor_mirror' | 'synthetic_fixture';
  syntheticFixtureId?: string;
  donorRepository: 'handriss/defense-budget-justification-data';
  donorCommit: string;
  donorPath: string;
  donorBytes: Uint8Array;
  expectedDonorSha256: string;
  officialXml?: { url: string; bytes: Uint8Array; archiveVersionId: string | null };
  officialPdf?: { url: string; bytes: Uint8Array; archiveVersionId: string | null };
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const object = (v: unknown): JsonNode | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonNode) : null;
function bindings(node: JsonNode, inherited: Bindings = {}): Bindings {
  const result = { ...inherited };
  for (const [key, value] of Object.entries(node))
    if (typeof value === 'string' && key.startsWith('@_xmlns'))
      result[key === '@_xmlns' ? '' : key.slice(8)] = value;
  return result;
}
function expanded(name: string, b: Bindings): string {
  const colon = name.indexOf(':');
  return `{${b[colon < 0 ? '' : name.slice(0, colon)] ?? ''}}${colon < 0 ? name : name.slice(colon + 1)}`;
}
function children(node: JsonNode, parentBindings: Bindings, ns: string, local: string) {
  const result: { node: unknown; name: string; bindings: Bindings; index: number }[] = [];
  for (const [name, value] of Object.entries(node)) {
    if (name.startsWith('@_') || name.startsWith('?') || name === '#text') continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      const b = bindings(object(child) ?? {}, parentBindings);
      if (expanded(name, b) === `{${ns}}${local}`)
        result.push({ node: child, name, bindings: b, index: result.length });
    }
  }
  return result;
}
function text(node: JsonNode, b: Bindings, ns: string, local: string): string | null {
  const rows = children(node, b, ns, local);
  if (rows.length !== 1) return null;
  const v = rows[0]!.node;
  return typeof v === 'string'
    ? v.trim() || null
    : typeof object(v)?.['#text'] === 'string'
      ? String(object(v)!['#text']).trim() || null
      : null;
}
function officialIdentity(
  binding: NativeXmlCatalogInput['officialXml'] | NativeXmlCatalogInput['officialPdf'],
) {
  if (!binding) return null;
  const url = new URL(binding.url);
  if (
    url.protocol !== 'https:' ||
    !['comptroller.war.gov', 'comptroller.defense.gov'].includes(url.hostname)
  )
    throw new Error('Official binding must identify the approved authoritative Comptroller host');
  return {
    url: binding.url,
    sha256: hash(binding.bytes),
    archiveVersionId: binding.archiveVersionId,
  };
}
/** Read-only candidate inventory. No parser artifact, persistence, qualification, review or promotion occurs. */
export function catalogNativeBudgetXmlCandidate(input: NativeXmlCatalogInput) {
  if (input.donorRepository !== 'handriss/defense-budget-justification-data')
    throw new Error('Unexpected donor reference');
  if (input.origin === 'synthetic_fixture' && !input.syntheticFixtureId?.trim())
    throw new Error('Synthetic fixture identity is required');
  if (
    !/^[a-f0-9]{40}$/.test(input.donorCommit) ||
    !input.donorPath ||
    input.donorPath.startsWith('/') ||
    input.donorPath.includes('..')
  )
    throw new Error('Invalid pinned donor identity');
  if (input.donorBytes.byteLength > NATIVE_XML_CATALOG_MAX_BYTES_V1)
    throw new Error('Native XML candidate exceeds 64 MiB bound');
  const originalBytesSha256 = hash(input.donorBytes);
  if (originalBytesSha256 !== input.expectedDonorSha256)
    throw new Error('Donor byte digest mismatch');
  const xmlText = Buffer.from(input.donorBytes).toString('utf8');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xmlText))
    throw new Error('DOCTYPE and ENTITY declarations are unsupported for candidate inventory');
  if (XMLValidator.validate(xmlText) !== true) throw new Error('XML is malformed');
  const parsed = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: true,
    removeNSPrefix: false,
  }).parse(xmlText) as JsonNode;
  const roots = Object.entries(parsed).filter(
    ([name]) => !name.startsWith('?') && !name.startsWith('@_') && name !== '#text',
  );
  if (roots.length !== 1) throw new Error('Expected exactly one document root');
  const [rootName, rootValue] = roots[0]!;
  const root = object(rootValue);
  if (!root) throw new Error('Root must contain native metadata');
  const rootBindings = bindings(root);
  const officialXml = officialIdentity(input.officialXml),
    officialPdf = officialIdentity(input.officialPdf);
  const source = {
    origin: input.origin ?? 'donor_mirror',
    syntheticFixtureId: input.origin === 'synthetic_fixture' ? input.syntheticFixtureId : null,
    donorRepository: input.origin === 'synthetic_fixture' ? null : input.donorRepository,
    donorCommit: input.origin === 'synthetic_fixture' ? null : input.donorCommit,
    donorPath: input.origin === 'synthetic_fixture' ? null : input.donorPath,
    originalBytesSha256,
    officialXml,
    officialPdf,
  };
  const physicalByteBinding = !officialXml
    ? 'not_checked'
    : officialXml.sha256 === originalBytesSha256
      ? 'same_bytes'
      : 'different_bytes';
  const base = {
    schemaVersion: 'native_budget_xml_candidate_catalog_v1' as const,
    status: 'candidate_only' as const,
    promotable: false as const,
    source,
    physicalByteBinding,
    denominator: { state: 'unknown', complete: false },
    limitations: [
      'Candidate inventory is not qualification, admission, publication or corpus completeness.',
      'PB XML does not establish all congressional/enacted/execution stages.',
      'Source-native period labels do not infer an exact funding FY or authority stage.',
      'This bounded catalog inventories top-level PE/line observations only; project, schedule and narrative mappings remain separate.',
    ],
  };
  if (rootName === 'TaggedPDF-doc')
    return {
      ...base,
      parserClass: 'tagged_pdf' as const,
      metadata: null,
      records: [],
      rawFundingAssertions: [],
    };
  if (expanded(rootName, rootBindings) !== `{${JB}}JustificationBook`)
    throw new Error('Unsupported native namespace/root');
  const metadata = {
    budgetYear: text(root, rootBindings, JB, 'BudgetYear'),
    budgetCycle: text(root, rootBindings, JB, 'BudgetCycle'),
    submissionDate: text(root, rootBindings, JB, 'SubmissionDate'),
    serviceAgencyName: text(root, rootBindings, JB, 'ServiceAgencyName'),
    appropriationCode: text(root, rootBindings, JB, 'AppropriationCode'),
  };
  const r2 = children(root, rootBindings, R2, 'ProgramElementList'),
    procurement = children(root, rootBindings, PROC, 'LineItemList');
  if (r2.length > 1 || procurement.length > 1 || r2.length > 0 === procurement.length > 0)
    throw new Error('Expected one supported native exhibit family');
  const parserClass = r2.length ? ('native_rdte' as const) : ('native_procurement' as const);
  const list = (r2.length ? r2 : procurement)[0]!;
  const listNode = object(list.node);
  if (!listNode) throw new Error('Native list must be an object');
  const ns = r2.length ? R2 : PROC,
    name = r2.length ? 'ProgramElement' : 'LineItem';
  const records = children(listNode, list.bindings, ns, name).map((row) => {
    const n = object(row.node);
    if (!n) throw new Error('Native record must be an object');
    const locator = `${expanded(list.name, list.bindings)}[${list.index}]/${expanded(row.name, row.bindings)}[${row.index}]`;
    const scope = {
      requestEditionBudgetYear: text(n, row.bindings, ns, 'BudgetYear') ?? metadata.budgetYear,
      budgetCycle: text(n, row.bindings, ns, 'BudgetCycle') ?? metadata.budgetCycle,
      submissionDate: text(n, row.bindings, ns, 'SubmissionDate') ?? metadata.submissionDate,
      serviceAgencyName:
        text(n, row.bindings, ns, 'ServiceAgencyName') ?? metadata.serviceAgencyName,
      appropriationCode:
        text(n, row.bindings, ns, r2.length ? 'AppropriationCode' : 'AppropriationNumber') ??
        metadata.appropriationCode,
    };
    const identity = r2.length
      ? {
          kind: 'RDTE_PE',
          peCode: text(n, row.bindings, ns, 'ProgramElementNumber'),
          r1LineNumber: text(n, row.bindings, ns, 'R1LineNumber'),
        }
      : {
          kind: 'PROCUREMENT_BLIN',
          lineItemNumber: text(n, row.bindings, ns, 'LineItemNumber'),
          p1LineNumber: text(n, row.bindings, ns, 'P1LineNumber'),
        };
    if (
      Object.values(scope).some((value) => !value) ||
      (r2.length
        ? !(identity as any).peCode
        : !(identity as any).lineItemNumber || !(identity as any).p1LineNumber)
    )
      throw new Error('Native observation requires edition/component/account/exhibit identity');
    const rawUnits = r2.length
      ? { monetaryUnit: n['@_monetaryUnit'] ?? null }
      : {
          totalCostUnits: n['@_totalCostUnits'] ?? null,
          unitCostUnits: n['@_unitCostUnits'] ?? null,
          quantityUnits: n['@_quantityUnits'] ?? null,
          quantityUnitName: n['@_quantityUnitName'] ?? null,
        };
    // Raw cells are inventory observations only; no artifact assertions or financial sums.
    const rawCells: { measure: string; periodLabel: string; rawValue: string; locator: string }[] =
      [];
    const recordFunding = children(
      n,
      row.bindings,
      ns,
      r2.length ? 'ProgramElementFunding' : 'ResourceSummary',
    );
    for (const block of recordFunding) {
      const blockNode = object(block.node);
      if (!blockNode) continue;
      const groups = r2.length
        ? [{ node: blockNode, name: block.name, bindings: block.bindings, index: 0 }]
        : [
            'TotalCost',
            'NetProcurementP1',
            'TotalObligationAuthority',
            'Quantity',
            'UnitCost',
          ].flatMap((measure) => children(blockNode, block.bindings, ns, measure));
      for (const group of groups) {
        const gn = object(group.node);
        if (!gn) continue;
        for (const periodLabel of [
          'AllPriorYears',
          'PriorYear',
          'CurrentYear',
          'BudgetYearOneBase',
          'BudgetYearOne',
        ]) {
          const rawValue = text(gn, group.bindings, ns, periodLabel);
          if (rawValue !== null)
            rawCells.push({
              measure: r2.length ? 'ProgramElementFunding' : group.name.split(':').pop()!,
              periodLabel,
              rawValue,
              locator:
                locator +
                '/' +
                expanded(block.name, block.bindings) +
                '[0]/' +
                (r2.length ? '' : expanded(group.name, group.bindings) + '[0]/') +
                `{${ns}}${periodLabel}[0]`,
            });
        }
      }
    }
    const monetaryUnits = Object.entries(rawUnits).filter(
      ([key]) => key === 'monetaryUnit' || key === 'totalCostUnits' || key === 'unitCostUnits',
    );
    const candidateOmissions = monetaryUnits
      .filter(([, unit]) => !['Millions', 'Thousands', 'Dollars'].includes(String(unit)))
      .map(([field]) => ({ field, reason: 'unknown_or_missing_native_monetary_unit' }));
    for (const cell of rawCells) {
      try {
        parseCanonicalDecimalString(cell.rawValue);
      } catch {
        candidateOmissions.push({ field: cell.locator, reason: 'non_numeric_raw_cell' });
      }
    }
    return {
      scope,
      identity,
      candidateOmissions,
      semanticObservationKey: JSON.stringify({ scope, identity }),
      occurrenceKey: JSON.stringify({
        origin: source.origin,
        donorRepository: source.donorRepository,
        donorCommit: source.donorCommit,
        donorPath: source.donorPath,
        syntheticFixtureId: source.syntheticFixtureId,
        originalBytesSha256,
        locator,
      }),
      locator,
      rawUnits,
      rawCells,
    };
  });
  return { ...base, parserClass, metadata, records, rawFundingAssertions: [] };
}
/** Semantic dedup retains independent byte/path occurrences and reports conflicts without summing. */
export function deduplicateNativeCatalogRecords(
  records: readonly {
    semanticObservationKey: string;
    occurrenceKey: string;
    rawCells: readonly { measure: string; periodLabel: string; rawValue: string }[];
    rawUnits: unknown;
  }[],
) {
  const groups = new Map<string, typeof records>();
  for (const row of records)
    groups.set(row.semanticObservationKey, [
      ...(groups.get(row.semanticObservationKey) ?? []),
      row,
    ]);
  const normalizeDecimal = (value: string) => {
    try {
      return parseCanonicalDecimalString(value);
    } catch {
      return value;
    }
  };
  const signature = (row: (typeof records)[number]) =>
    JSON.stringify({
      units: row.rawUnits,
      cells: row.rawCells
        .map((cell) => ({
          measure: cell.measure,
          periodLabel: cell.periodLabel,
          value: normalizeDecimal(cell.rawValue),
        }))
        .sort((left, right) =>
          (left.measure + '|' + left.periodLabel).localeCompare(
            right.measure + '|' + right.periodLabel,
          ),
        ),
    });
  return [...groups.entries()].map(([semanticObservationKey, rows]) => ({
    semanticObservationKey,
    occurrenceKeys: [...new Set(rows.map((row) => row.occurrenceKey))],
    duplicateObservations: rows.length - 1,
    conflict: new Set(rows.map(signature)).size > 1,
  }));
}
