import {
  DOSSIER_SECTIONS,
  type ContractingDetail,
  type DelegationDetail,
  type DossierSection,
  type LobbyingDetail,
  type VendorReferenceDossier,
  type VendorReferenceRow,
  type VerificationStatus,
} from './vendor-reference.types.js';

/**
 * PURE renderer: VendorReferenceDossier -> the 15_vendor_reference_pull.md
 * shape. No Nest, no I/O, no LLM. Section headers and table columns are the
 * template's, verbatim — the markdown spec diffs them against the template
 * file so a template change fails here rather than silently drifting.
 */

export const SECTION_HEADINGS: Readonly<Record<DossierSection, string>> = {
  company_identity: '## Company identity',
  federal_market_credentials: '## Federal-market credentials',
  federal_contracting_history: '## Federal contracting history',
  federal_lobbying_representation: '## Federal lobbying representation',
  congressional_delegation: '## Congressional delegation for the facility',
  litigation_adverse_history: '## Litigation and adverse history',
};

export const ITEM_TABLE_HEADER = '| Item | Finding | Source | Verification |';
export const ITEM_TABLE_SEPARATOR = '|---|---|---|---|';

export const CONTRACTING_TABLE_HEADER =
  '| Vehicle or award | Agency | Type | Value | Award date | Period of performance | Source | Verification |';
export const CONTRACTING_TABLE_SEPARATOR = '|---|---|---|---|---|---|---|---|';

export const LOBBYING_TABLE_HEADER =
  '| Registrant | Client of record | Period | Income | Issue codes | Source | Verification |';
export const LOBBYING_TABLE_SEPARATOR = '|---|---|---|---|---|---|---|';

export const DELEGATION_TABLE_HEADER =
  '| Member | Chamber | State / district | Committee | Role | Source | Verification |';
export const DELEGATION_TABLE_SEPARATOR = '|---|---|---|---|---|---|---|';

export const HANDLING_NOTES_HEADING = '## Handling notes for staff Q&A';

export const GENERATED_BY = 'Capiro (partial; see the Verification column)';

/** Template vocabulary is Confirmed / Unverified / Placeholder; not_sourced is spelled out. */
export function verificationLabel(v: VerificationStatus): string {
  switch (v) {
    case 'confirmed':
      return 'Confirmed';
    case 'unverified':
      return 'Unverified';
    case 'placeholder':
      return 'Placeholder';
    case 'not_sourced':
      return 'Unverified (not sourced)';
  }
}

export function escapeCell(v: unknown): string {
  if (v == null) return '';
  return String(v).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

export function formatMoney(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '';
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

function row(cells: unknown[]): string {
  return `| ${cells.map(escapeCell).join(' | ')} |`;
}

export interface RenderOptions {
  /** Override the deterministic document id. */
  documentId?: string;
}

/**
 * Frontmatter follows apps/api-strategy's flat parser (frontmatter.ts):
 * `scope: strategy` REQUIRES a strategy_id and `scope: client` a client_id, so
 * the scope is derived from the ids actually supplied — never a placeholder.
 */
export function buildFrontmatter(dossier: VendorReferenceDossier, opts: RenderOptions = {}): string {
  const { clientId, strategyId } = dossier.input;
  const scope = strategyId ? 'strategy' : clientId ? 'client' : 'once';
  const documentId = opts.documentId ?? defaultDocumentId(dossier);
  const q = (v: string) => `"${v.replace(/"/g, '')}"`;
  return [
    '---',
    'document_type: vendor_reference_pull',
    `document_id: ${q(documentId)}`,
    'schema_version: "1.0"',
    'state: active',
    `scope: ${scope}`,
    `client_id: ${clientId ? q(clientId) : 'null'}`,
    `strategy_id: ${strategyId ? q(strategyId) : 'null'}`,
    'node_id: null',
    'meeting_id: null',
    `as_of: ${q(dossier.asOf)}`,
    'valid_until: null',
    'owner: "system"',
    'authority: external_authoritative',
    'source_of_truth: true',
    'supersedes: null',
    'confidentiality: client_confidential',
    `generated_by: ${q(GENERATED_BY)}`,
    '---',
  ].join('\n');
}

export function defaultDocumentId(dossier: VendorReferenceDossier): string {
  const anchor =
    dossier.identity.uei ??
    dossier.identity.inputName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40);
  return `ctx_vendor_pull_${anchor}_${dossier.asOf.replace(/-/g, '')}`;
}

const INTRO =
  '> Reference data on the performing company for an amendment strategy. Capiro fills the rows it can source (SAM.gov entity record, federal contract vehicles, Senate LDA filings, congressional delegation); every other row is entered by hand. The Verification column is part of the record: a row is Confirmed only when a human has checked it against the named source. Facts here travel in the technical annex and staff briefing, never in the funding-table or report-language text.';

const LITIGATION_NOTE =
  '> Capiro has no automated source for litigation or adverse history. This row must be confirmed or explicitly cleared by a human before it appears in any exported report, and it may never be inferred, estimated, or filled by generation.';

export function renderVendorReferenceMarkdown(
  dossier: VendorReferenceDossier,
  opts: RenderOptions = {},
): string {
  const bySection = new Map<DossierSection, VendorReferenceRow[]>();
  for (const s of DOSSIER_SECTIONS) bySection.set(s, []);
  for (const r of dossier.rows) bySection.get(r.section)?.push(r);

  const out: string[] = [buildFrontmatter(dossier, opts), '', '# Vendor reference pull', '', INTRO, ''];

  out.push(...identityBlock(dossier), '');

  for (const section of DOSSIER_SECTIONS) {
    const rows = bySection.get(section) ?? [];
    out.push(SECTION_HEADINGS[section], '');
    switch (section) {
      case 'federal_contracting_history':
        out.push(CONTRACTING_TABLE_HEADER, CONTRACTING_TABLE_SEPARATOR, ...rows.map(contractingRow));
        break;
      case 'federal_lobbying_representation':
        out.push(LOBBYING_TABLE_HEADER, LOBBYING_TABLE_SEPARATOR, ...rows.map(lobbyingRow));
        break;
      case 'congressional_delegation':
        out.push(DELEGATION_TABLE_HEADER, DELEGATION_TABLE_SEPARATOR, ...rows.map(delegationRow));
        break;
      default:
        out.push(ITEM_TABLE_HEADER, ITEM_TABLE_SEPARATOR, ...rows.map(itemRow));
    }
    out.push('');
    if (section === 'litigation_adverse_history') out.push(LITIGATION_NOTE, '');
  }

  out.push(HANDLING_NOTES_HEADING, '');
  const notes = dossier.handlingNotes.length ? dossier.handlingNotes : ['-'];
  out.push(...notes.map((n) => (n === '-' ? '-' : `- ${escapeLine(n)}`)));
  out.push('');
  return out.join('\n');
}

function escapeLine(v: string): string {
  return v.replace(/\r?\n/g, ' ').trim();
}

/** A short, non-tabular block so the strategist sees HOW the company was matched before any row. */
function identityBlock(d: VendorReferenceDossier): string[] {
  const id = d.identity;
  const lines = [
    '> **Identity basis:** ' +
      `${basisLabel(id.basis)} — ${escapeLine(id.explanation)}` +
      (id.uei ? ` UEI ${id.uei}.` : '') +
      (id.matchedName ? ` SAM legal name: ${escapeLine(id.matchedName)}.` : ''),
  ];
  if (id.ambiguous && id.candidates.length) {
    lines.push(
      '> Candidates: ' +
        id.candidates
          .map((c) => `${escapeLine(c.legalBusinessName)} (${c.uei}${c.state ? `, ${c.state}` : ''})`)
          .join('; ') +
        '. Re-pull with `uei` to anchor the dossier.',
    );
  }
  if (d.warnings.length) {
    lines.push(`> **Warnings:** ${d.warnings.map(escapeLine).join(' | ')}`);
  }
  return lines;
}

function basisLabel(b: VendorReferenceDossier['identity']['basis']): string {
  switch (b) {
    case 'uei_input':
      return 'Exact UEI (caller-supplied)';
    case 'cage_input':
      return 'Exact CAGE → UEI via SAM.gov';
    case 'sam_exact_name':
      return 'Single exact legal-name match in SAM.gov → UEI';
    case 'name_only':
      return 'Name only (no identifier established)';
  }
}

function itemRow(r: VendorReferenceRow): string {
  return row([r.item, r.finding, r.source, verificationLabel(r.verification)]);
}

function contractingRow(r: VendorReferenceRow): string {
  const d = (r.detail ?? {}) as Partial<ContractingDetail>;
  return row([
    r.item,
    d.agency ?? '',
    d.type ?? '',
    formatMoney(d.value ?? null),
    d.awardDate ?? '',
    d.periodOfPerformance ?? '',
    r.source,
    verificationLabel(r.verification),
  ]);
}

function lobbyingRow(r: VendorReferenceRow): string {
  const d = (r.detail ?? {}) as Partial<LobbyingDetail>;
  return row([
    d.registrant ?? r.item,
    d.clientOfRecord ?? '',
    d.period ?? '',
    formatMoney(d.income ?? null),
    Array.isArray(d.issueCodes) ? d.issueCodes.join(', ') : '',
    r.source,
    verificationLabel(r.verification),
  ]);
}

function delegationRow(r: VendorReferenceRow): string {
  const d = (r.detail ?? {}) as Partial<DelegationDetail>;
  return row([
    d.member ?? r.item,
    d.chamber ?? '',
    d.stateDistrict ?? '',
    d.committee ?? '',
    d.role ?? '',
    r.source,
    verificationLabel(r.verification),
  ]);
}
