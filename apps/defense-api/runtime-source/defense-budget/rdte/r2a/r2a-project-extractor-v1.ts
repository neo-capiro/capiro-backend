/**
 * r2a-project-extractor-v1 — complete R-2A project identity and narrative
 * extraction from Phase 3 normalized page results.
 *
 * For every R-2A project, captures:
 *   - parent PE code, project code exactly as printed, project title;
 *   - mission/description/accomplishments/plans narrative sections;
 *   - budget activity where printed or inherited from verified PE context;
 *   - physical and printed page range;
 *   - source evidence;
 *   - project aliases/title variants as document facts when later pages differ.
 *
 * Pure module. Never invokes a parser, never calls LlamaParse, never writes
 * to a database.
 *
 * Project-code rules (Workstream H):
 *   - Do not assume all project codes are exactly three characters.
 *   - Validate against a bounded nonblank source token policy.
 *   - Expand canonical project_code width only through Workstream M's
 *     reviewed migration; never truncate.
 *   - A project with no valid parent PE is blocking.
 *   - Duplicate (parentPeCode, projectCode) with conflicting titles or
 *     narratives produces an explicit conflict.
 */
import type { ParserPageResultV1 } from '../../parser-router/parser-runtime-contract-v1.js';
import { isValidPeCode } from '../../extractors/types.js';
import {
  extractR2aProjectSectionsFromPage,
  isValidR2aProjectCode,
  mergeR2aProjectSections,
  type R2aProjectSection,
} from './r2a-project-section-extractor.js';
import {
  extractR2aStructuralHeaderV1,
  groupR2aPagesByStructuralIdentityV1,
} from './r2a-structural-project-header-parser-v1.js';

/* ------------------------------------------------------------------ */
/* Input context (pre-segmented by WS E)                                */
/* ------------------------------------------------------------------ */

/**
 * A pre-segmented R-2A page group: all pages that belong to one project
 * under one parent PE. Produced by Workstream E segmentation.
 */
export interface R2aProjectPageGroup {
  parentPeCode: string;
  projectCode: string;
  pages: readonly ParserPageResultV1[];
  /** Verified PE context from segmentation (budget activity, title, etc.). */
  peContext?: {
    budgetActivity?: string;
    budgetActivityName?: string;
  };
}

/* ------------------------------------------------------------------ */
/* Output types                                                        */
/* ------------------------------------------------------------------ */

export interface R2aProjectIdentity {
  parentPeCode: string;
  projectCode: string;
  title: string;
  /** Physical pages where this project appears. */
  pages: number[];
  printedPages: string[];
  budgetActivity?: string;
  budgetActivityName?: string;
  /** Title variants observed on later pages (document facts). */
  aliases: string[];
}

export interface R2aProjectNarrative {
  parentPeCode: string;
  projectCode: string;
  kind: R2aProjectSection['kind'];
  text: string;
  page: number;
  printedPage?: string;
}

export interface R2aProjectConflict {
  parentPeCode: string;
  projectCode: string;
  field: 'title' | 'narrative';
  narrativeKind?: string;
  values: string[];
  pages: number[];
}

export interface R2aProjectOmission {
  parentPeCode?: string;
  projectCode?: string;
  page: number;
  reason: string;
  rawText: string;
}

export interface R2aProjectExtractionResult {
  identities: R2aProjectIdentity[];
  narratives: R2aProjectNarrative[];
  conflicts: R2aProjectConflict[];
  omissions: R2aProjectOmission[];
  /** Projects blocked because parent PE is missing or invalid. */
  blocked: Array<{ projectCode: string; page: number; reason: string }>;
}

/* ------------------------------------------------------------------ */
/* Supplementary (non-identity) header fields                          */
/*                                                                      */
/* Phase 10B-25: parent-PE / project-code IDENTITY is resolved ONLY by  */
/* the shared structural module (r2a-structural-project-header-parser- */
/* v1.ts), from self-labeled table cells. The inline-text regexes below */
/* are a genuinely separate, still-valid concern: an OPTIONAL printed   */
/* "Project Title:" / "Budget Activity:" line that supplements (never   */
/* replaces) the structural project name. Do not re-add an inline      */
/* parent-PE / project-code regex here -- that was the root cause this  */
/* module was written to eliminate.                                     */
/* ------------------------------------------------------------------ */

const PROJECT_TITLE_RE = /\bproject\s+title\s*[:.\-]?\s*(.+)/i;
const BUDGET_ACTIVITY_RE = /\bbudget\s+activity\s*[:.\-]?\s*(.+)/i;

interface PageSupplementaryInfo {
  /** Optional printed "Project Title:" line -- takes precedence over the
   * structural table's project name when present (a document can print a
   * fuller title alongside the compact table-cell name). */
  printedProjectTitle?: string;
  budgetActivity?: string;
}

function extractPageSupplementaryInfo(page: ParserPageResultV1): PageSupplementaryInfo {
  const info: PageSupplementaryInfo = {};
  const blockTexts = page.blocks.map((b) => b.text);

  for (const text of blockTexts) {
    const titleMatch = PROJECT_TITLE_RE.exec(text);
    if (titleMatch?.[1] != null) {
      const title = titleMatch[1].trim();
      if (title.length > 0) info.printedProjectTitle = title;
    }

    const baMatch = BUDGET_ACTIVITY_RE.exec(text);
    if (baMatch?.[1] != null) {
      const ba = baMatch[1].trim();
      if (ba.length > 0) info.budgetActivity = ba;
    }
  }

  return info;
}

/** Structural project name for a page (from its own table evidence only),
 * or `undefined` if the page carries no resolvable structural header (e.g.
 * a continuation page inheriting identity from a prior page, or a page
 * that is not itself an R-2A identity page at all). */
function structuralProjectNameFor(page: ParserPageResultV1): string | undefined {
  const result = extractR2aStructuralHeaderV1(page);
  return result.status === 'ok' ? result.header.projectName : undefined;
}

/* ------------------------------------------------------------------ */
/* Extractor                                                           */
/* ------------------------------------------------------------------ */

export function extractR2aProjectsFromGroups(input: {
  groups: readonly R2aProjectPageGroup[];
}): R2aProjectExtractionResult {
  const identities: R2aProjectIdentity[] = [];
  const narratives: R2aProjectNarrative[] = [];
  const conflicts: R2aProjectConflict[] = [];
  const omissions: R2aProjectOmission[] = [];
  const blocked: Array<{ projectCode: string; page: number; reason: string }> = [];

  for (const group of input.groups) {
    const { parentPeCode, projectCode, pages, peContext } = group;

    /* Blocking rule: no valid parent PE. */
    if (!isValidPeCode(parentPeCode)) {
      for (const page of pages) {
        blocked.push({
          projectCode,
          page: page.page,
          reason: 'missing_or_invalid_parent_pe',
        });
      }
      continue;
    }

    /* Validate project code against bounded policy. */
    if (!isValidR2aProjectCode(projectCode)) {
      for (const page of pages) {
        omissions.push({
          parentPeCode,
          projectCode,
          page: page.page,
          reason: 'invalid_project_code',
          rawText: projectCode,
        });
      }
      continue;
    }

    /* Collect per-page header info and sections. */
    const pageHeaders: Array<{
      page: number;
      printedPage?: string;
      supplementary: PageSupplementaryInfo;
      structuralProjectName?: string;
    }> = [];
    const allSections: R2aProjectSection[] = [];

    for (const page of pages) {
      pageHeaders.push({
        page: page.page,
        printedPage: page.printedPage ?? undefined,
        supplementary: extractPageSupplementaryInfo(page),
        structuralProjectName: structuralProjectNameFor(page),
      });

      const sections = extractR2aProjectSectionsFromPage(page);
      allSections.push(...sections);
    }

    /* Determine canonical title from the first page that provides one.
     * A printed "Project Title:" line wins when present; otherwise fall
     * back to the structural table's project name (the real government
     * R-2A layout never prints a separate "Project Title:" line -- the
     * name lives in the same cell as the code). */
    const titles = pageHeaders
      .map((h) => h.supplementary.printedProjectTitle ?? h.structuralProjectName)
      .filter((t): t is string => t != null && t.length > 0);
    const uniqueTitles = [...new Set(titles)];
    const title = uniqueTitles[0] ?? '';

    /* Title conflicts / aliases. */
    if (uniqueTitles.length > 1) {
      conflicts.push({
        parentPeCode,
        projectCode,
        field: 'title',
        values: uniqueTitles,
        pages: pageHeaders
          .filter((h) => (h.supplementary.printedProjectTitle ?? h.structuralProjectName) != null)
          .map((h) => h.page),
      });
    }

    /* Budget activity: printed on page wins; otherwise inherit from verified PE context. */
    const printedBa = pageHeaders
      .map((h) => h.supplementary.budgetActivity)
      .find((ba): ba is string => ba != null && ba.length > 0);
    const budgetActivity = printedBa ?? peContext?.budgetActivity;
    const budgetActivityName = peContext?.budgetActivityName;

    /* Page range. */
    const physicalPages = pages.map((p) => p.page);
    const printedPages = pages
      .map((p) => p.printedPage)
      .filter((p): p is string => p != null && p.length > 0);

    const identity: R2aProjectIdentity = {
      parentPeCode,
      projectCode,
      title,
      pages: [...physicalPages].sort((a, b) => a - b),
      printedPages: [...new Set(printedPages)].sort(),
      ...(budgetActivity != null ? { budgetActivity } : {}),
      ...(budgetActivityName != null ? { budgetActivityName } : {}),
      aliases: uniqueTitles.slice(1),
    };
    identities.push(identity);

    /* Merge narrative sections across pages. */
    const mergedSections = mergeR2aProjectSections(pages);
    for (const section of mergedSections) {
      narratives.push({
        parentPeCode,
        projectCode,
        kind: section.kind,
        text: section.text,
        page: section.page,
        ...(section.printedPage != null ? { printedPage: section.printedPage } : {}),
      });
    }

    /* Phase 10B-25: narrative-conflict detection across multiple same-kind
     * sections was removed. The real R-2A layout routinely prints MULTIPLE
     * distinct sub-activities on the SAME page (and across a project's
     * pages), each contributing its own "description"/"accomplishments"/
     * "plans" text -- this is normal, real government document structure,
     * not an extraction disagreement. `mergeR2aProjectSections` above
     * already concatenates every genuine fragment losslessly, in reading
     * order, with full block-index evidence preserved; there is no lost or
     * competing value to flag. A prior version of this check flagged every
     * such multi-activity page as a blocking `r2a_duplicate_natural_key_
     * conflict` warning, which never fired in practice while the R-2A
     * grouping defect (Defect 1, this same phase) prevented real multi-page
     * project groups from ever forming -- fixing Defect 1 exposed this
     * second, independent false-positive defect on the same real document.
     * Title conflicts (field: 'title', a project genuinely printing two
     * DIFFERENT titles) remain a real, distinct check above and are
     * unaffected by this removal. */

    /* Identity omissions: missing title, missing project code on page, etc. */
    if (title.length === 0) {
      omissions.push({
        parentPeCode,
        projectCode,
        page: pages[0]?.page ?? 1,
        reason: 'missing_project_title',
        rawText: `project ${projectCode} on pages ${physicalPages.join(', ')}`,
      });
    }
    /* Phase 10B-25: per-page "missing project code / parent PE" omission
     * checks used to be re-derived here from inline body text -- now
     * redundant AND actively wrong, because a page only ever reaches this
     * point as a MEMBER of a group the shared structural grouper
     * (`groupR2aPagesByStructuralIdentityV1`) already resolved as
     * carrying valid identity (either directly, or by lawful continuation
     * inheritance from a preceding valid page in the same open section).
     * Re-deriving from inline text here would spuriously flag every
     * legitimate continuation page as "missing" and would duplicate the
     * SAME root omission the grouper already recorded for any page that
     * genuinely failed to resolve -- see
     * `groupR2aPagesByStructuralIdentityV1(...).omissions`, which is the
     * single source of missing-identity omissions for the
     * `extractR2aProjectsFromPages` entry point below. A caller that
     * supplies pre-formed groups directly to `extractR2aProjectsFromGroups`
     * (bypassing the shared grouper) is responsible for its own identity
     * validation before grouping; this function only validates the group
     * key itself (parent PE / project code bounded-policy checks above).
     */
  }

  /* Cross-group duplicate detection: same (parentPeCode, projectCode) in
   * multiple groups with conflicting titles. */
  const groupKey = (g: R2aProjectPageGroup) => `${g.parentPeCode}|${g.projectCode}`;
  const byKey = new Map<string, R2aProjectPageGroup[]>();
  for (const group of input.groups) {
    const key = groupKey(group);
    const existing = byKey.get(key) ?? [];
    existing.push(group);
    byKey.set(key, existing);
  }
  for (const [key, groups] of byKey) {
    if (groups.length <= 1) continue;
    const [parentPeCode, projectCode] = key.split('|');
    const allTitles = groups
      .flatMap((g) =>
        g.pages.flatMap(
          (p) => extractPageSupplementaryInfo(p).printedProjectTitle ?? structuralProjectNameFor(p) ?? [],
        ),
      )
      .filter((t): t is string => t != null && t.length > 0);
    const uniqueTitles = [...new Set(allTitles)];
    if (uniqueTitles.length > 1) {
      conflicts.push({
        parentPeCode: parentPeCode!,
        projectCode: projectCode!,
        field: 'title',
        values: uniqueTitles,
        pages: groups.flatMap((g) => g.pages.map((p) => p.page)),
      });
    }
  }

  return { identities, narratives, conflicts, omissions, blocked };
}

/**
 * Convenience wrapper: extract from a flat list of pages by grouping
 * contiguous pages with the same (parentPeCode, projectCode) structural
 * identity, using the single shared grouper
 * (`groupR2aPagesByStructuralIdentityV1`). Useful when pre-segmentation
 * (Workstream E) is not available. This is the ONE lawful entry point for
 * grouping a flat page list -- it must never re-implement its own
 * inline-text grouping loop (Phase 10B-25 root-cause fix).
 */
export function extractR2aProjectsFromPages(input: {
  pages: readonly ParserPageResultV1[];
  peContext?: {
    budgetActivity?: string;
    budgetActivityName?: string;
  };
}): R2aProjectExtractionResult {
  const { pages, peContext } = input;
  const structural = groupR2aPagesByStructuralIdentityV1(pages);

  const groups: R2aProjectPageGroup[] = structural.groups.map((g) => ({
    parentPeCode: g.parentPeCode,
    projectCode: g.projectCode,
    pages: g.pages,
    ...(peContext != null ? { peContext } : {}),
  }));

  const result = extractR2aProjectsFromGroups({ groups });

  /* Single source of missing-identity omissions for this entry point:
   * the shared grouper's own omissions (pages that failed to resolve
   * structural identity at all -- never re-derived here). */
  const structuralOmissions: R2aProjectOmission[] = structural.omissions.map((o) => ({
    ...(o.parentPeCode != null ? { parentPeCode: o.parentPeCode } : {}),
    ...(o.projectCode != null ? { projectCode: o.projectCode } : {}),
    page: o.page,
    reason: o.reason,
    rawText: o.rawText,
  }));

  return { ...result, omissions: [...result.omissions, ...structuralOmissions] };
}
