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
/* Header / identity extraction                                        */
/* ------------------------------------------------------------------ */

const PE_HEADER_RE = /\bPE\s+([0-9]{7}[A-Z][A-Z0-9]*)\b/i;
/* Capture the raw post-label text so we can detect internal whitespace and
 * reject codes that violate the bounded nonblank token policy. */
const PROJECT_CODE_RE = /\bproject\s+code\s*[:.\-]?\s*(\S+(?:\s+\S+)*)/i;
const PROJECT_TITLE_RE = /\bproject\s+title\s*[:.\-]?\s*(.+)/i;
const BUDGET_ACTIVITY_RE = /\bbudget\s+activity\s*[:.\-]?\s*(.+)/i;
const R2A_HEADER_RE = /\bR-2A\b/i;
const RDT_PROJECT_JUSTIFICATION_RE = /\bRDT&E\s+Project\s+Justification\b/i;

interface PageHeaderInfo {
  parentPeCode?: string;
  projectCode?: string;
  projectTitle?: string;
  budgetActivity?: string;
  isR2aPage: boolean;
}

function extractPageHeaderInfo(page: ParserPageResultV1): PageHeaderInfo {
  const info: PageHeaderInfo = { isR2aPage: false };
  const allText = page.text ?? '';
  const blockTexts = page.blocks.map((b) => b.text);

  /* Detect R-2A exhibit markers. */
  if (R2A_HEADER_RE.test(allText) || RDT_PROJECT_JUSTIFICATION_RE.test(allText)) {
    info.isR2aPage = true;
  }
  for (const text of blockTexts) {
    if (R2A_HEADER_RE.test(text) || RDT_PROJECT_JUSTIFICATION_RE.test(text)) {
      info.isR2aPage = true;
      break;
    }
  }

  /* Scan blocks for identity fields; tables are not used for identity on
   * R-2A pages (identity is in header blocks). */
  for (const text of blockTexts) {
    const peMatch = PE_HEADER_RE.exec(text);
    if (peMatch?.[1] != null && isValidPeCode(peMatch[1])) {
      info.parentPeCode = peMatch[1];
    }

    const codeMatch = PROJECT_CODE_RE.exec(text);
    if (codeMatch?.[1] != null && isValidR2aProjectCode(codeMatch[1])) {
      info.projectCode = codeMatch[1];
    }

    const titleMatch = PROJECT_TITLE_RE.exec(text);
    if (titleMatch?.[1] != null) {
      const title = titleMatch[1].trim();
      if (title.length > 0) info.projectTitle = title;
    }

    const baMatch = BUDGET_ACTIVITY_RE.exec(text);
    if (baMatch?.[1] != null) {
      const ba = baMatch[1].trim();
      if (ba.length > 0) info.budgetActivity = ba;
    }
  }

  return info;
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
    const pageHeaders: Array<{ page: number; printedPage?: string; info: PageHeaderInfo }> = [];
    const allSections: R2aProjectSection[] = [];

    for (const page of pages) {
      const info = extractPageHeaderInfo(page);
      pageHeaders.push({ page: page.page, printedPage: page.printedPage, info });

      const sections = extractR2aProjectSectionsFromPage(page);
      allSections.push(...sections);
    }

    /* Determine canonical title from the first page that provides one. */
    const titles = pageHeaders
      .map((h) => h.info.projectTitle)
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
        pages: pageHeaders.filter((h) => h.info.projectTitle != null).map((h) => h.page),
      });
    }

    /* Budget activity: printed on page wins; otherwise inherit from verified PE context. */
    const printedBa = pageHeaders
      .map((h) => h.info.budgetActivity)
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

    /* Narrative conflicts: same section kind with materially different text
     * across pages (after normalization). */
    const narrativeByKind = new Map<string, Array<{ text: string; page: number }>>();
    for (const section of allSections) {
      const key = section.kind;
      const existing = narrativeByKind.get(key) ?? [];
      existing.push({ text: section.text, page: section.page });
      narrativeByKind.set(key, existing);
    }
    for (const [kind, values] of narrativeByKind) {
      const uniqueTexts = [...new Set(values.map((v) => v.text))];
      if (uniqueTexts.length > 1) {
        conflicts.push({
          parentPeCode,
          projectCode,
          field: 'narrative',
          values: uniqueTexts,
          pages: values.map((v) => v.page),
        });
      }
    }

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
    for (const header of pageHeaders) {
      if (header.info.projectCode == null) {
        omissions.push({
          parentPeCode,
          projectCode,
          page: header.page,
          reason: 'missing_project_code_on_page',
          rawText: `page ${header.page} has no project code header`,
        });
      }
      if (header.info.parentPeCode == null) {
        omissions.push({
          parentPeCode,
          projectCode,
          page: header.page,
          reason: 'missing_parent_pe_on_page',
          rawText: `page ${header.page} has no parent PE header`,
        });
      }
    }
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
      .flatMap((g) => g.pages.flatMap((p) => extractPageHeaderInfo(p).projectTitle ?? []))
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
 * contiguous pages with the same (parentPeCode, projectCode) headers.
 * Useful when segmentation is not yet available.
 */
export function extractR2aProjectsFromPages(input: {
  pages: readonly ParserPageResultV1[];
  peContext?: {
    budgetActivity?: string;
    budgetActivityName?: string;
  };
}): R2aProjectExtractionResult {
  const { pages, peContext } = input;
  const groups: R2aProjectPageGroup[] = [];

  let currentKey: string | null = null;
  let currentPages: ParserPageResultV1[] = [];
  let currentParentPe = '';
  let currentProjectCode = '';

  const flushCurrent = (): void => {
    if (currentKey == null) return;
    groups.push({
      parentPeCode: currentParentPe,
      projectCode: currentProjectCode,
      pages: currentPages,
      ...(peContext != null ? { peContext } : {}),
    });
    currentKey = null;
    currentPages = [];
  };

  for (const page of pages) {
    const info = extractPageHeaderInfo(page);

    /* Skip non-R-2A pages. */
    if (!info.isR2aPage) continue;

    const parentPeCode = info.parentPeCode ?? '';
    const projectCode = info.projectCode ?? '';
    const key = `${parentPeCode}|${projectCode}`;

    if (currentKey === key) {
      currentPages.push(page);
    } else {
      flushCurrent();
      currentKey = key;
      currentParentPe = parentPeCode;
      currentProjectCode = projectCode;
      currentPages = [page];
    }
  }

  flushCurrent();

  return extractR2aProjectsFromGroups({ groups });
}
