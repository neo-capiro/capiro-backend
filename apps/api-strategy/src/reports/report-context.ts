import { parseFrontmatter } from "../context/frontmatter.js";
import type { ReportAudience } from "./dto/report-export.dto.js";
import type {
  ReportContextDocument,
  ReportContextFact,
  ReportNarrativeItem,
  ReportNarrativeSection,
  ReportNarrativeSectionKey,
} from "./report.types.js";

export interface ReportContextDocumentInput {
  id: string;
  title: string;
  templateKey: string;
  content: string;
  frontmatter: unknown;
  validUntil: Date | null;
  updatedAt: Date;
  facts: Array<{
    id: string;
    fact: string;
    sourceRef: string;
    authority: string | null;
    asOf: Date | null;
    confidence: number | null;
  }>;
}

/**
 * Approval state and source-of-truth flags are provenance metadata, not export
 * gates. A client deliverable includes working-draft and un-vetted context as
 * long as it is marked client-safe; the authority label is rendered honestly
 * (e.g. "working_draft") instead of being used to withhold the content. The
 * only deliberate exclusions are confidentiality scope and freshness below.
 */
const SKIPPED_TEMPLATE_KEYS = new Set([
  "00_context_manifest",
  "07_current_plan",
  "11_agent_mission",
  "12_execution_playbook",
  "13_agent_permissions",
]);
const PLACEHOLDER_ONLY =
  /^(?:-|—|null|n\/a|none|tbd|default|primary ask|yyyy-mm-dd|low\s*\/\s*medium\s*\/\s*high|yes\s*\/\s*no)$/i;
const PLACEHOLDER_ID = /^(?:[a-z]+[_-])?(?:00*1|123|456|789)$/i;
/**
 * Import persistence wraps organized excerpts in provenance scaffolding
 * (buildImportMarkdown): an "Imported on …" disclaimer, a "Source excerpts are
 * working context …" disclaimer, and per-line `> ` quote markers. Those are
 * import metadata, not substantive strategy content — they must never surface
 * as recommendations, commitments, or narrative prose in a deliverable.
 */
const IMPORT_SCAFFOLDING =
  /^(?:imported on \d{4}-\d{2}-\d{2}\b|source excerpts are working context\b|this is the import date\b|they do not grant permissions\b|imported information \d+\b|source details\b|source\s*:\s*\S)/i;
const SECTION_TITLES: Record<ReportNarrativeSectionKey, string> = {
  situation: "Situation and stakes",
  outcomes: "Objectives and definition of success",
  ask: "Strategic ask and options",
  stakeholders: "Stakeholder landscape",
  constraints: "Constraints and decision rules",
  timing: "Timing and external windows",
  evidence: "Evidence and assumptions",
  decisions: "Decisions and commitments",
  intelligence: "Recent intelligence",
  governance: "Internal operating guidance",
};

/**
 * Convert active context-pack documents into complete, audience-safe executive
 * briefing material. This is deliberately deterministic: it preserves authored
 * statements and table rows without asking an LLM to fill gaps or infer facts.
 * Capacity enforcement belongs to the snapshot loader so an oversized report
 * fails explicitly instead of this assembler silently sampling approved input.
 */
export function assembleReportContext(
  documents: readonly ReportContextDocumentInput[],
  audience: ReportAudience,
  asOf: string,
): {
  documents: ReportContextDocument[];
  facts: ReportContextFact[];
  sections: ReportNarrativeSection[];
  excludedDocuments: number;
} {
  const included: ReportContextDocument[] = [];
  const facts: ReportContextFact[] = [];
  const items = new Map<ReportNarrativeSectionKey, ReportNarrativeItem[]>();
  let excludedDocuments = 0;

  for (const document of documents) {
    const metadata = contextMetadata(document);
    if (
      (audience === "client" &&
        SKIPPED_TEMPLATE_KEYS.has(document.templateKey)) ||
      !includeContextDocument(metadata, document.validUntil, audience, asOf)
    ) {
      excludedDocuments += 1;
      continue;
    }

    const highlights = SKIPPED_TEMPLATE_KEYS.has(document.templateKey)
      ? []
      : extractHighlights(document.content, document.templateKey, audience);
    included.push({
      id: document.id,
      title: document.title,
      templateKey: document.templateKey,
      authority: metadata.authority,
      confidentiality: metadata.confidentiality,
      asOf: metadata.asOf,
      validUntil: isoDate(document.validUntil),
      updatedAt: document.updatedAt.toISOString(),
      highlightCount: highlights.length,
    });

    for (const highlight of highlights) {
      const category = categoryFor(document.templateKey, highlight.heading);
      pushUnique(items, category, {
        text: highlight.text,
        label: highlight.heading,
        sourceTitle: document.title,
        sourceRef: highlight.ref,
        authority: metadata.authority,
        asOf: metadata.asOf,
        confidence: null,
      });
    }

    for (const fact of document.facts) {
      const factAuthority = fact.authority ?? metadata.authority;
      if (
        audience === "client" &&
        !includeHighlightHeading(
          headingFromSourceRef(fact.sourceRef),
          audience,
        )
      ) {
        continue;
      }
      const text = cleanValue(fact.fact);
      if (!text) continue;
      const reportFact: ReportContextFact = {
        id: fact.id,
        text,
        documentTitle: document.title,
        templateKey: document.templateKey,
        sourceRef: fact.sourceRef,
        authority: factAuthority,
        asOf: isoDate(fact.asOf) ?? metadata.asOf,
        confidence: boundedConfidence(fact.confidence),
      };
      if (!facts.some((candidate) => candidate.id === reportFact.id)) {
        facts.push(reportFact);
      }
      pushUnique(items, categoryFor(document.templateKey, fact.sourceRef), {
        text,
        label: "Established context",
        sourceTitle: document.title,
        sourceRef: fact.sourceRef,
        authority: factAuthority,
        asOf: reportFact.asOf,
        confidence: reportFact.confidence,
      });
    }
  }

  const orderedKeys: ReportNarrativeSectionKey[] = [
    "situation",
    "outcomes",
    "ask",
    "stakeholders",
    "constraints",
    "timing",
    "decisions",
    "intelligence",
    "evidence",
    "governance",
  ];
  return {
    documents: included,
    facts,
    sections: orderedKeys.flatMap((key) => {
      const sectionItems = items.get(key) ?? [];
      return sectionItems.length
        ? [{ key, title: SECTION_TITLES[key], items: sectionItems }]
        : [];
    }),
    excludedDocuments,
  };
}

export function isClientSafeContextFrontmatter(frontmatter: unknown): boolean {
  const record = asRecord(frontmatter);
  const confidentiality = stringValue(record?.confidentiality);
  // Client-safe == explicitly marked shareable with the client. Approval
  // authority and source-of-truth are provenance, not a gate.
  return confidentiality === "client_confidential";
}

function includeContextDocument(
  metadata: ReturnType<typeof contextMetadata>,
  validUntil: Date | null,
  audience: ReportAudience,
  asOf: string,
): boolean {
  if (audience === "internal") return true;
  // Deliberate exclusions only: internal-scope confidentiality and staleness.
  return (
    (!validUntil || validUntil.getTime() >= Date.parse(`${asOf}T00:00:00Z`)) &&
    metadata.confidentiality === "client_confidential"
  );
}

function contextMetadata(document: ReportContextDocumentInput): {
  authority: string | null;
  confidentiality: string | null;
  asOf: string | null;
  sourceOfTruth: boolean | null;
} {
  const stored = asRecord(document.frontmatter);
  const parsed = parseFrontmatter(document.content).frontmatter;
  const source = stored ?? parsed;
  return {
    authority: stringValue(source?.authority),
    confidentiality: stringValue(source?.confidentiality),
    asOf: dateValue(source?.as_of),
    sourceOfTruth:
      typeof source?.source_of_truth === "boolean"
        ? source.source_of_truth
        : null,
  };
}

function extractHighlights(
  raw: string,
  templateKey: string,
  audience: ReportAudience,
): Array<{ heading: string; text: string; ref: string }> {
  const body = parseFrontmatter(raw).body;
  const lines = body.split(/\r?\n/);
  const results: Array<{ heading: string; text: string; ref: string }> = [];
  let heading = sectionTitleForTemplate(templateKey);
  let tableHeaders: string[] | null = null;
  let tableRow = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) {
      tableHeaders = null;
      continue;
    }
    // Import scaffolding is provenance, never narrative/commitment content.
    if (IMPORT_SCAFFOLDING.test(line)) continue;
    const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      const candidate = cleanInline(headingMatch[2]!) || heading;
      // Import "Imported information N" container headings are scaffolding, not
      // a substantive section label — keep the prior meaningful heading.
      heading = IMPORT_SCAFFOLDING.test(candidate) ? heading : candidate;
      tableHeaders = null;
      tableRow = 0;
      continue;
    }
    if (/^\|(?:\s*:?-+:?\s*\|)+$/.test(line)) continue;
    if (/^\|.*\|$/.test(line)) {
      const cells = splitTableCells(line);
      const next = lines[index + 1]?.trim() ?? "";
      if (/^\|(?:\s*:?-+:?\s*\|)+$/.test(next)) {
        tableHeaders = cells;
        tableRow = 0;
        continue;
      }
      tableRow += 1;
      const text = formatTableRow(tableHeaders, cells);
      if (text && includeHighlightHeading(heading, audience)) {
        pushHighlight(results, {
          heading,
          text,
          ref: `row:${heading}:${tableRow}`,
        });
      }
      continue;
    }

    tableHeaders = null;
    // Strip import quote markers (`> `) so excerpts render as prose, not raw
    // Markdown; the source statement itself is preserved verbatim.
    const unquoted = line.replace(/^>+\s?/, "");
    const bullet = /^(?:[-*+]\s+|\d+[.)]\s+)(.*)$/.exec(unquoted)?.[1] ?? unquoted;
    const text = cleanValue(bullet);
    if (!text || !includeHighlightHeading(heading, audience)) continue;
    pushHighlight(results, {
      heading,
      text,
      ref: `heading:${heading}`,
    });
  }
  return results;
}

/**
 * Client-safe documents can still contain practitioner-only operating sections.
 * Keep those sections available to internal reports without allowing their raw
 * bullets or table rows to bypass the audience policy for client deliverables.
 */
function includeHighlightHeading(
  heading: string,
  audience: ReportAudience,
): boolean {
  if (audience === "internal") return true;
  const normalized = heading.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return !(
    /\binstructions?\b.*\bmeri\b/i.test(normalized) ||
    /^meri\s+(?:may|must|requires)\b/i.test(normalized) ||
    /^watcher\s+rules?\b/i.test(normalized) ||
    /^proposed\s+firm\s+reference\s+changes?\b/i.test(normalized) ||
    /^internal\s+(?:operating|governance|implementation)\b/i.test(normalized)
  );
}

function headingFromSourceRef(sourceRef: string): string {
  const heading = /^heading:(.+)$/i.exec(sourceRef)?.[1];
  if (heading) return heading;
  const row = /^row:(.*):\d+$/i.exec(sourceRef)?.[1];
  return row ?? sourceRef;
}

function formatTableRow(
  headers: string[] | null,
  cells: string[],
): string | null {
  if (headers) {
    const primaryIndex = headers.findIndex((header) =>
      /^(?:constraint|option|name|event|claim|decision|commitment|intelligence|action|question|assumption|objection|if)$/i.test(
        cleanInline(header),
      ),
    );
    if (primaryIndex >= 0 && !cleanValue(cells[primaryIndex])) return null;
  }
  const values = cells.map(cleanValue);
  if (values.every((value) => !value)) return null;
  const labelled = values.flatMap((value, index) => {
    if (!value) return [];
    const label = cleanValue(headers?.[index] ?? "");
    return [label ? `${label}: ${value}` : value];
  });
  return labelled.length ? labelled.join(" · ") : null;
}

function cleanValue(value: string | null | undefined): string | null {
  if (!value) return null;
  let inline = cleanInline(value);
  // Drop import scaffolding and strip residual quote markers from fact text.
  inline = inline.replace(/^>+\s?/, "").trim();
  if (!inline || IMPORT_SCAFFOLDING.test(inline)) return null;
  if (/^[^:]{1,160}:\s*(?:`?YYYY-MM-DD`?|null)?\s*$/i.test(inline)) return null;
  const cleaned = inline
    .replace(/^`|`$/g, "")
    .replace(/:\s*(?:`?YYYY-MM-DD`?|null)?\s*$/i, "")
    .trim();
  if (
    !cleaned ||
    PLACEHOLDER_ONLY.test(cleaned) ||
    PLACEHOLDER_ID.test(cleaned)
  )
    return null;
  if (/^[^/]+(?:\s*\/\s*[^/]+){1,}$/.test(cleaned)) return null;
  const afterColon = cleaned.includes(":")
    ? cleaned.slice(cleaned.indexOf(":") + 1).trim()
    : cleaned;
  if (!afterColon || PLACEHOLDER_ONLY.test(afterColon)) return null;
  return cleaned;
}

function cleanInline(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~]/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\\\|/g, "|")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTableCells(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cleanInline(cell));
}

function categoryFor(
  templateKey: string,
  headingOrRef: string,
): ReportNarrativeSectionKey {
  const heading = headingOrRef.toLowerCase();
  if (/decision|commitment/.test(heading)) return "decisions";
  if (/stakeholder|audience|decision-maker|objection/.test(heading))
    return "stakeholders";
  if (/deadline|calendar|timing|date|window|lead time/.test(heading))
    return "timing";
  if (/evidence|assumption|fact|confidence|source|gap|question/.test(heading))
    return "evidence";
  if (
    /constraint|approval|prohibit|never|rule|stop condition|sensitivity/.test(
      heading,
    )
  )
    return "constraints";
  if (/ask|option|fallback|acceptable|tradeoff/.test(heading)) return "ask";
  if (/goal|success|outcome|scope|achieve|failure condition/.test(heading))
    return "outcomes";
  if (
    /intelligence|signal|meeting|what has happened|current position/.test(
      heading,
    )
  )
    return "intelligence";

  if (templateKey.startsWith("01_")) return "situation";
  if (templateKey.startsWith("02_") || templateKey.startsWith("06_"))
    return "constraints";
  if (templateKey.startsWith("03_")) return "ask";
  if (templateKey.startsWith("04_")) return "stakeholders";
  if (templateKey.startsWith("05_")) return "timing";
  if (templateKey.startsWith("08_")) return "evidence";
  if (templateKey.startsWith("09_")) return "intelligence";
  if (templateKey.startsWith("10_")) return "decisions";
  return "governance";
}

function sectionTitleForTemplate(templateKey: string): string {
  return templateKey
    .replace(/^\d+_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function pushUnique(
  map: Map<ReportNarrativeSectionKey, ReportNarrativeItem[]>,
  key: ReportNarrativeSectionKey,
  value: ReportNarrativeItem,
): void {
  const rows = map.get(key) ?? [];
  if (
    !rows.some((row) => row.text.toLowerCase() === value.text.toLowerCase())
  ) {
    rows.push(value);
    map.set(key, rows);
  }
}

function pushHighlight(
  target: Array<{ heading: string; text: string; ref: string }>,
  value: { heading: string; text: string; ref: string },
): void {
  if (
    !target.some((item) => item.text.toLowerCase() === value.text.toLowerCase())
  )
    target.push(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function dateValue(value: unknown): string | null {
  const text = stringValue(value);
  return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function isoDate(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function boundedConfidence(value: number | null): number | null {
  return value === null || !Number.isFinite(value)
    ? null
    : Math.max(0, Math.min(1, value));
}
