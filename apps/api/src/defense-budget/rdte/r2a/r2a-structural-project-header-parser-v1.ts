/**
 * r2a-structural-project-header-parser-v1 — the single canonical structural
 * parser for R-2A "Project (Number/Name)" project identity. Phase 10B-25.
 *
 * Root cause this module fixes: three independently duplicated grouping
 * implementations (`groupR2aPages` in rdte-cycle-pipeline-v1.ts,
 * `extractPageHeaderInfo` / the grouping loop inside
 * `extractR2aProjectsFromPages` in r2a-project-extractor-v1.ts, and
 * `r2aGroups` in rdte-phase3-semantic-artifact-factory-v1.ts) all matched
 * the SAME broken inline-label regex
 * `/\bproject\s+code\s*[:.\-]?\s*(\S+(?:\s+\S+)*)/i` against unrestricted
 * page body/block text -- a literal "project code:" label that never
 * actually appears in the real Army R-2A exhibit. Because the regex never
 * matched, nearly every page carrying the R-2A exhibit marker resolved to
 * an empty project code, which then multiplied through both the identity
 * and funding extractors as blocking `invalid_identity` omissions.
 *
 * The real government layout prints project identity as a genuine
 * structural TABLE CELL whose own caption is the literal string
 * "Project (Number/Name)" (empirically confirmed against the real FY2024
 * Army R-2/R-2A 170-page fixture: `Project (Number/Name)\nAA1 / ILIR - AMC`
 * as a single cell, in the same table row as a sibling cell captioned
 * "R-1 Program Element (Number/Name)\nPE 0601102A / Defense Research
 * Sciences"). This module reads identity directly from those self-labeled
 * cells -- never from an inline body-text regex -- so a page's identity can
 * only ever be as good as its own structural evidence.
 *
 * All three duplicated call sites MUST import and use this module (either
 * directly via `extractR2aStructuralHeaderV1` or, for page-range grouping,
 * via `groupR2aPagesByStructuralIdentityV1`) so the cycle-pipeline grouper,
 * the project identity extractor, and the semantic-artifact-factory grouper
 * cannot drift apart again.
 *
 * Design rules (mission-mandated, Phase 10B-25):
 *   - project code/name/PE code/PE title come ONLY from the self-labeled
 *     structural table cells, never from unrestricted body text;
 *   - a page is only ever an R-2A identity candidate if it carries the
 *     R-2A exhibit marker (`R2A_MARKER_RE`) -- this is what correctly
 *     excludes sibling "Exhibit R-2" PE-summary pages that happen to reuse
 *     the identical "R-1 Program Element (Number/Name)" cell caption but
 *     have no project-level breakdown at all (empirically confirmed: in
 *     the real 170-page fixture, every page with a PE cell but no project
 *     cell is a genuine Exhibit R-2 page with the marker absent -- pages
 *     43-45, 126-127, 132-134, 161, 164-165);
 *   - continuation pages (no repeated header table at all) inherit
 *     identity ONLY from an immediately preceding valid page in the same
 *     open project section -- never across a reset;
 *   - identity resets at every new PE or project boundary, and at every
 *     omission (a page that fails to resolve cleanly never silently
 *     extends the previous group);
 *   - a page that merely mentions "R-2A" / "RDT&E Project Justification"
 *     in prose, with no structural identity table at all, is never treated
 *     as a project page and never produces an omission (front-matter
 *     narrative, e.g. real fixture page 6);
 *   - conflicting PE/project headers on the same page fail closed
 *     (`conflicting_headers`), never guessed;
 *   - a group is NEVER formed with an empty project code or empty parent
 *     PE code -- this is a structural invariant of `extractR2aStructuralHeaderV1`
 *     (the value-parsing regexes require a non-blank captured token and
 *     `isValidPeCode` / `isValidR2aProjectCode` are checked before a
 *     candidate is ever considered "valid"), reinforced defensively in the
 *     grouping function.
 */
import type {
  ParsedTableCellV1,
  ParserPageResultV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import { isValidPeCode } from '../../extractors/types.js';
import { isValidR2aProjectCode } from './r2a-project-section-extractor.js';

/** Shared R-2A exhibit marker -- also used by callers that need to know
 * whether a page belongs to the R-2A exhibit at all (e.g. to gate other,
 * unrelated per-page logic) without re-deriving their own copy. */
export const R2A_MARKER_RE = /\bR-2A\b|RDT&E\s+Project\s+Justification/i;

const PE_CELL_CAPTION_RE = /^R-1\s+Program\s+Element\s*\(Number\/Name\)\s*/i;
const PROJECT_CELL_CAPTION_RE = /^Project\s*\(Number\/Name\)\s*/i;
/** Value line format: "PE <peCode> / <peTitle>". */
const PE_VALUE_RE = /^PE\s+(\S+)\s*\/\s*(\S.*)$/i;
/** Value line format: "<projectCode> / <projectName>". */
const PROJECT_VALUE_RE = /^(\S+)\s*\/\s*(\S.*)$/;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function hasR2aMarker(page: ParserPageResultV1): boolean {
  if (R2A_MARKER_RE.test(page.text ?? '')) return true;
  return page.blocks.some((block) => R2A_MARKER_RE.test(block.text ?? ''));
}

export interface R2aStructuralPeAnchorV1 {
  peCode: string;
  peTitle: string;
  tableIndex: number;
  rowIndex: number;
  columnIndex: number;
}

export interface R2aStructuralProjectAnchorV1 {
  projectCode: string;
  projectName: string;
  tableIndex: number;
  rowIndex: number;
  columnIndex: number;
}

interface CollectedAnchors {
  peAnchors: R2aStructuralPeAnchorV1[];
  projectAnchors: R2aStructuralProjectAnchorV1[];
  /** Raw cell text of every cell whose caption matched, whether or not the
   * value parsed into a valid identity -- used for omission diagnostics. */
  rawPeCandidates: string[];
  rawProjectCandidates: string[];
}

function collectAnchors(page: ParserPageResultV1): CollectedAnchors {
  const peAnchors: R2aStructuralPeAnchorV1[] = [];
  const projectAnchors: R2aStructuralProjectAnchorV1[] = [];
  const rawPeCandidates: string[] = [];
  const rawProjectCandidates: string[] = [];

  for (const table of page.tables) {
    for (const cell of table.cells as ParsedTableCellV1[]) {
      const text = cell.text ?? '';
      if (PE_CELL_CAPTION_RE.test(text)) {
        rawPeCandidates.push(text);
        const value = normalizeWhitespace(text.replace(PE_CELL_CAPTION_RE, ''));
        const match = PE_VALUE_RE.exec(value);
        const peCode = match?.[1];
        const peTitle = match?.[2];
        if (peCode != null && peTitle != null && isValidPeCode(peCode)) {
          peAnchors.push({
            peCode,
            peTitle: peTitle.trim(),
            tableIndex: table.tableIndex,
            rowIndex: cell.rowIndex,
            columnIndex: cell.columnIndex,
          });
        }
        continue;
      }
      if (PROJECT_CELL_CAPTION_RE.test(text)) {
        rawProjectCandidates.push(text);
        const value = normalizeWhitespace(text.replace(PROJECT_CELL_CAPTION_RE, ''));
        const match = PROJECT_VALUE_RE.exec(value);
        const projectCode = match?.[1];
        const projectName = match?.[2];
        if (
          projectCode != null &&
          projectName != null &&
          isValidR2aProjectCode(projectCode)
        ) {
          projectAnchors.push({
            projectCode,
            projectName: projectName.trim(),
            tableIndex: table.tableIndex,
            rowIndex: cell.rowIndex,
            columnIndex: cell.columnIndex,
          });
        }
      }
    }
  }
  return { peAnchors, projectAnchors, rawPeCandidates, rawProjectCandidates };
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) seen.set(key(item), item);
  return [...seen.values()];
}

export interface R2aStructuralHeaderV1 {
  parentPeCode: string;
  parentPeTitle: string;
  projectCode: string;
  projectName: string;
  page: number;
  evidence: {
    tableIndex: number;
    rowIndex: number;
    peColumnIndex: number;
    projectColumnIndex: number;
  };
}

export type R2aStructuralHeaderResultV1 =
  | { status: 'ok'; header: R2aStructuralHeaderV1 }
  /** No R-2A exhibit marker, or marker present with zero structural
   * identity cells at all (front-matter prose) -- never a project page. */
  | { status: 'not_r2a_page' }
  | { status: 'missing_parent_pe'; page: number; rawText: string; projectCode?: string }
  | {
      status: 'missing_project_code';
      page: number;
      parentPeCode: string;
      parentPeTitle: string;
      rawText: string;
    }
  | { status: 'conflicting_headers'; page: number; rawText: string };

/**
 * Extract the R-2A structural project-identity header for exactly one page,
 * from its own structural table evidence only. This is the ONE lawful
 * source of R-2A project/PE identity -- callers must never independently
 * re-derive identity from body text.
 */
export function extractR2aStructuralHeaderV1(page: ParserPageResultV1): R2aStructuralHeaderResultV1 {
  if (!hasR2aMarker(page)) {
    return { status: 'not_r2a_page' };
  }

  const { peAnchors, projectAnchors, rawPeCandidates, rawProjectCandidates } = collectAnchors(page);

  if (rawPeCandidates.length === 0 && rawProjectCandidates.length === 0) {
    /* Marker text present (e.g. front-matter prose explaining what an R-2A
     * exhibit is) but no structural identity table at all -- never becomes
     * a project page, and never an omission (there is no field to omit). */
    return { status: 'not_r2a_page' };
  }

  const distinctPe = dedupeBy(peAnchors, (a) => `${a.peCode}|${a.peTitle}`);
  const distinctProject = dedupeBy(projectAnchors, (a) => `${a.projectCode}|${a.projectName}`);

  if (distinctPe.length > 1 || distinctProject.length > 1) {
    return {
      status: 'conflicting_headers',
      page: page.page,
      rawText: `conflicting R-2A headers on page ${page.page}: pe candidates=[${rawPeCandidates.join(' ; ')}] project candidates=[${rawProjectCandidates.join(' ; ')}]`,
    };
  }

  const pe = distinctPe[0];
  const project = distinctProject[0];

  if (pe == null) {
    return {
      status: 'missing_parent_pe',
      page: page.page,
      rawText:
        rawPeCandidates[0] ??
        `page ${page.page} carries R-2A project identity with no parent PE header`,
      ...(project != null ? { projectCode: project.projectCode } : {}),
    };
  }
  if (project == null) {
    return {
      status: 'missing_project_code',
      page: page.page,
      parentPeCode: pe.peCode,
      parentPeTitle: pe.peTitle,
      rawText:
        rawProjectCandidates[0] ??
        `page ${page.page} carries parent PE ${pe.peCode} with no project code header`,
    };
  }

  /* Defensive structural invariant: never return `ok` with an empty code,
   * even though `isValidPeCode` / `isValidR2aProjectCode` already reject
   * blank tokens above. */
  if (pe.peCode.trim().length === 0 || project.projectCode.trim().length === 0) {
    return {
      status: 'missing_parent_pe',
      page: page.page,
      rawText: `page ${page.page} resolved an empty identity code -- refusing to form a group`,
    };
  }

  return {
    status: 'ok',
    header: {
      parentPeCode: pe.peCode,
      parentPeTitle: pe.peTitle,
      projectCode: project.projectCode,
      projectName: project.projectName,
      page: page.page,
      evidence: {
        tableIndex: project.tableIndex,
        rowIndex: project.rowIndex,
        peColumnIndex: pe.columnIndex,
        projectColumnIndex: project.columnIndex,
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Shared page-range grouping (all three duplicated call sites)         */
/* ------------------------------------------------------------------ */

export interface R2aStructuralGroupV1 {
  parentPeCode: string;
  parentPeTitle: string;
  projectCode: string;
  projectName: string;
  pages: ParserPageResultV1[];
}

export interface R2aStructuralOmissionV1 {
  page: number;
  parentPeCode?: string;
  projectCode?: string;
  reason: 'missing_parent_pe_on_page' | 'missing_project_code_on_page' | 'conflicting_headers_on_page';
  rawText: string;
}

export interface R2aStructuralGroupingResultV1 {
  groups: R2aStructuralGroupV1[];
  omissions: R2aStructuralOmissionV1[];
}

/**
 * Group a document's pages into contiguous R-2A project sections using ONLY
 * the structural identity from `extractR2aStructuralHeaderV1`. This is the
 * single shared grouper for all three call sites (the cycle-pipeline
 * funding grouper, the project identity extractor, and the
 * semantic-artifact-factory funding grouper) -- none of them may
 * independently re-derive grouping logic.
 *
 * Continuation semantics: a page with no repeated header table
 * (`not_r2a_page`) inherits the currently active section's identity ONLY if
 * a section is currently open; a page with no active section never starts
 * one. Every other status (`missing_parent_pe`, `missing_project_code`,
 * `conflicting_headers`) closes whatever section was open and records
 * exactly one omission for that page -- it never silently extends the
 * previous group past a page it could not resolve.
 */
export function groupR2aPagesByStructuralIdentityV1(
  pages: readonly ParserPageResultV1[],
): R2aStructuralGroupingResultV1 {
  const sorted = [...pages].sort((a, b) => a.page - b.page);
  const groups: R2aStructuralGroupV1[] = [];
  const omissions: R2aStructuralOmissionV1[] = [];

  let active: {
    parentPeCode: string;
    parentPeTitle: string;
    projectCode: string;
    projectName: string;
  } | null = null;
  let activePages: ParserPageResultV1[] = [];

  const flush = (): void => {
    if (active == null || activePages.length === 0) {
      active = null;
      activePages = [];
      return;
    }
    /* Never form a group keyed by an empty project code or parent PE --
     * belt-and-suspenders on top of the per-page invariant above. */
    if (active.parentPeCode.trim().length > 0 && active.projectCode.trim().length > 0) {
      groups.push({ ...active, pages: [...activePages] });
    }
    active = null;
    activePages = [];
  };

  for (const page of sorted) {
    const result = extractR2aStructuralHeaderV1(page);

    if (result.status === 'not_r2a_page') {
      if (active != null) activePages.push(page);
      continue;
    }

    if (result.status === 'missing_parent_pe') {
      flush();
      omissions.push({
        page: page.page,
        reason: 'missing_parent_pe_on_page',
        rawText: result.rawText,
        ...(result.projectCode != null ? { projectCode: result.projectCode } : {}),
      });
      continue;
    }

    if (result.status === 'missing_project_code') {
      flush();
      omissions.push({
        page: page.page,
        parentPeCode: result.parentPeCode,
        reason: 'missing_project_code_on_page',
        rawText: result.rawText,
      });
      continue;
    }

    if (result.status === 'conflicting_headers') {
      flush();
      omissions.push({
        page: page.page,
        reason: 'conflicting_headers_on_page',
        rawText: result.rawText,
      });
      continue;
    }

    /* status === 'ok' */
    const { header } = result;
    if (
      active != null &&
      active.parentPeCode === header.parentPeCode &&
      active.projectCode === header.projectCode
    ) {
      activePages.push(page);
    } else {
      flush();
      active = {
        parentPeCode: header.parentPeCode,
        parentPeTitle: header.parentPeTitle,
        projectCode: header.projectCode,
        projectName: header.projectName,
      };
      activePages = [page];
    }
  }
  flush();

  return { groups, omissions };
}
