import { kindLabel, statusLabel } from "./report-labels.js";
import { formatDate } from "./report-date.js";
import type { ExecutiveReportSnapshot, ReportContextFact, ReportNode } from "./report.types.js";

/*
 * ---------------------------------------------------------------------------
 * Amendment-type content (deterministic, no LLM).
 *
 * An amendment strategy pursues a budget line or authorizing provision through
 * a named legislative vehicle. Its report carries extra sections drawn from
 * three Context Steward templates plus "Client input required:" decision
 * steps. Everything here is a pure projection of the audience-filtered
 * snapshot: the facts in `snapshot.context.facts` already passed report-policy
 * redaction, so these helpers never widen what a client may see.
 * ---------------------------------------------------------------------------
 */

export const TARGET_BUDGET_LINE_TEMPLATE_KEY = "14_target_budget_line";
export const VENDOR_REFERENCE_TEMPLATE_KEY = "15_vendor_reference_pull";
export const ROUTE_AND_VEHICLE_TEMPLATE_KEY = "16_route_and_vehicle_status";
export const EVIDENCE_REGISTER_TEMPLATE_KEY = "08_evidence_register";

/** Plan-step title prefix Meri uses for inputs only the client can supply. */
export const CLIENT_INPUT_REQUIRED_PREFIX = "Client input required:";

/** The five hurdles an amendment clears, in order; a stage is never advanced without evidence. */
export const AMENDMENT_STATUS_LADDER = [
  "Filed",
  "Made in order",
  "Adopted",
  "Conferenced",
  "Enacted",
] as const;

/** Authorities whose facts count as confirmed without a separate confidence score. */
const CONFIRMING_AUTHORITIES = new Set<string>([
  "external_authoritative",
  "firm_approved",
  "client_approved",
]);
const CONFIRMED_CONFIDENCE_FLOOR = 0.8;

export type ValidationResult = "Confirmed" | "Unverified";

export interface ClientInputRequirement {
  /** The input name: title text after the `Client input required:` prefix. */
  input: string;
  status: string;
  /** Formatted due date (end date, else start date). */
  neededBy: string;
  node: ReportNode;
}

export interface ValidationSummaryRow {
  claim: string;
  result: ValidationResult | "Open gap";
  note: string;
}

export interface AmendmentMessageDiscipline {
  say: readonly string[];
  avoid: readonly string[];
}

export function isAmendmentStrategy(snapshot: ExecutiveReportSnapshot): boolean {
  return snapshot.strategy.type === "amendment";
}

/** Steward facts extracted from `14_target_budget_line.md` (line identity, FY baseline, requested amendment). */
export function targetBudgetLineItems(
  snapshot: ExecutiveReportSnapshot,
): ReportContextFact[] {
  return factsForTemplate(snapshot, TARGET_BUDGET_LINE_TEMPLATE_KEY);
}

/** Steward facts extracted from `16_route_and_vehicle_status.md` (vehicles, routes, status ladder, deadlines). */
export function routeAndVehicleItems(
  snapshot: ExecutiveReportSnapshot,
): ReportContextFact[] {
  return factsForTemplate(snapshot, ROUTE_AND_VEHICLE_TEMPLATE_KEY);
}

/** Steward facts extracted from `15_vendor_reference_pull.md` (company dossier rows). */
export function vendorReferenceItems(
  snapshot: ExecutiveReportSnapshot,
): ReportContextFact[] {
  return factsForTemplate(snapshot, VENDOR_REFERENCE_TEMPLATE_KEY);
}

/**
 * Included plan steps titled `Client input required: <input>`. Matched on the
 * title prefix (case-insensitive) rather than on kind so a mis-kinded step
 * still reaches the "Information required from the client" table.
 */
export function clientInputsRequired(
  snapshot: ExecutiveReportSnapshot,
): ClientInputRequirement[] {
  const prefix = new RegExp(
    `^\\s*${CLIENT_INPUT_REQUIRED_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`,
    "i",
  );
  return snapshot.nodes.flatMap((node) => {
    if (!prefix.test(node.title)) return [];
    const input = node.title.replace(prefix, "").trim() || node.title.trim();
    return [
      {
        input,
        status: statusLabel(node.status),
        neededBy: node.openEnded
          ? "Ongoing"
          : formatDate(node.endsOn ?? node.startsOn),
        node,
      },
    ];
  });
}

/**
 * The single classification rule for "is this fact confirmed?": a fact is
 * Confirmed when its recorded confidence reaches the floor OR its document
 * authority is external-authoritative / firm-approved / client-approved;
 * everything else is Unverified. Used by the validation summary and the
 * vendor appendix so the two never disagree.
 */
export function classifyValidationResult(fact: {
  confidence: number | null;
  authority: string | null;
}): ValidationResult {
  if (
    fact.confidence !== null &&
    Number.isFinite(fact.confidence) &&
    fact.confidence >= CONFIRMED_CONFIDENCE_FLOOR
  ) {
    return "Confirmed";
  }
  if (fact.authority && CONFIRMING_AUTHORITIES.has(fact.authority)) {
    return "Confirmed";
  }
  return "Unverified";
}

/**
 * Claim-by-claim validation table: evidence-register and target-budget-line
 * facts classified Confirmed / Unverified, followed by open-gap rows for stale
 * context, unresolved material conflicts, and client inputs still outstanding.
 */
export function validationSummary(
  snapshot: ExecutiveReportSnapshot,
): ValidationSummaryRow[] {
  const facts = [
    ...factsForTemplate(snapshot, EVIDENCE_REGISTER_TEMPLATE_KEY),
    ...targetBudgetLineItems(snapshot),
  ].filter(
    (fact, index, all) =>
      all.findIndex((candidate) => candidate.id === fact.id) === index,
  );
  const rows: ValidationSummaryRow[] = facts.map((fact) => ({
    claim: fact.text,
    result: classifyValidationResult(fact),
    note: factProvenance(fact),
  }));
  if (snapshot.context.staleDocuments > 0) {
    rows.push({
      claim: "Context documents past their review date",
      result: "Open gap",
      note: `${snapshot.context.staleDocuments} context document${snapshot.context.staleDocuments === 1 ? " is" : "s are"} past review; refresh before external use.`,
    });
  }
  if (snapshot.context.openMaterialConflicts > 0) {
    rows.push({
      claim: "Unresolved material conflicts between context sources",
      result: "Open gap",
      note: `${snapshot.context.openMaterialConflicts} open material conflict${snapshot.context.openMaterialConflicts === 1 ? "" : "s"}; resolve before the figures are cited.`,
    });
  }
  for (const requirement of clientInputsRequired(snapshot)) {
    if (requirement.node.status === "completed") continue;
    rows.push({
      claim: requirement.input,
      result: "Open gap",
      note: `Client input · ${requirement.status} · needed by ${requirement.neededBy}`,
    });
  }
  return rows;
}

/**
 * Fixed, fact-free message discipline for an amendment ask. These lines carry
 * no numbers, dates, names or client facts by design, so they can never be
 * ungrounded; the unit test enforces the no-digit rule.
 */
export function amendmentMessageDiscipline(): AmendmentMessageDiscipline {
  return AMENDMENT_MESSAGE_DISCIPLINE;
}

const AMENDMENT_MESSAGE_DISCIPLINE: AmendmentMessageDiscipline = {
  say: [
    "State the request as a program increase to a specific line within an actively funded account, not as a new program.",
    "Explain that the increase accelerates fielding of a qualified capability against a validated requirement.",
    "Emphasize that the increase is executable in the current year under an existing contract vehicle.",
    "Describe the effort as supporting domestic capacity, keeping the statement general until it is independently documented.",
    "Present the request as a sponsored amendment with a specific offset, carried in parallel into the other chamber and into conference.",
    "Identify the next fiscal-year request window as the backstop if the current vehicle closes.",
  ],
  avoid: [
    "Never describe the request as enacted, appropriated, secured, or received.",
    "Never misdescribe the account type; procurement and research, development, test and evaluation funds follow different rules.",
    "Never name a single vendor in the funding table or report language, and never call the request a directed buy.",
    "Never cite figures from a different line item or program element as the baseline.",
    "Never represent the amendment as made in order or adopted until the Rules Committee report or the recorded vote says so.",
    "Never commit to floor timing; describe unscheduled floor windows as not yet scheduled.",
    "Never use company, district, or jobs claims until they are independently documented.",
  ],
};

function factsForTemplate(
  snapshot: ExecutiveReportSnapshot,
  templateKey: string,
): ReportContextFact[] {
  return snapshot.context.facts.filter(
    (fact) => fact.templateKey === templateKey,
  );
}

function factProvenance(fact: ReportContextFact): string {
  return [
    fact.documentTitle,
    fact.asOf ? `as of ${formatDate(fact.asOf)}` : null,
    fact.authority ? kindLabel(fact.authority) : null,
    fact.confidence === null
      ? null
      : `${Math.round(fact.confidence * 100)}% confidence`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}
