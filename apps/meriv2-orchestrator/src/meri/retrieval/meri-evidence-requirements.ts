import type {
  ClaimCategory,
  DomainEvidencePlan,
  GovernmentAffairsOperatingFrame,
  LedgerEntry,
} from '@capiro/meriv2-core';
import { resolveDocumentReferences, type DocumentReferenceCandidate } from '@capiro/meriv2-core';
import type { MeriCitation } from '@capiro/shared';
import type { MeriToolCoverageReceipt } from '../meriv3/meriv3-turn-coverage.js';

export type CoverageTemplate =
  | 'house_senate_comparison'
  | 'transcript_summary'
  | 'current_status';

export interface CoverageRequirement {
  id: string;
  requirementId: string;
  claimCategory: ClaimCategory;
  toolFamilies: string[];
  essential: boolean;
  rationale: string;
  template?: CoverageTemplate;
  route?: Record<string, unknown>;
}

export type CoverageGapStatus =
  | 'satisfied'
  | 'never_called'
  | 'called_no_usable_content'
  | 'truncated'
  | 'unavailable'
  | 'extraction_failed';

export interface CoverageGap {
  requirementId: string;
  essential: boolean;
  status: CoverageGapStatus;
  materiality: 'changes_answer' | 'supplementary';
  evidenceIds: string[];
}

export interface CoverageToolSchema {
  name: string;
  input_schema: Record<string, unknown>;
  readOnly?: boolean;
}

export interface CoverageFollowUpCall {
  name: string;
  arguments: Record<string, unknown>;
  requirementId: string;
}

export interface CoverageFollowUpPlan {
  calls: CoverageFollowUpCall[];
  reason: string;
}

export interface CoverageAttachment extends DocumentReferenceCandidate {
  selected?: boolean;
  kind?: 'attachment' | 'client_document';
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const arrays = ['records', 'results', 'data', 'items', 'documents', 'messages', 'rows'] as const;

function payloadHasUsableContent(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  const record = object(value);
  if (!record || record.error || record.blocked) return false;
  if (
    ['text', 'content', 'body', 'snippet', 'summary', 'transcript'].some(
      (key) => typeof record[key] === 'string' && String(record[key]).trim().length > 0,
    )
  )
    return true;
  if (arrays.some((key) => Array.isArray(record[key]) && (record[key] as unknown[]).length > 0))
    return true;
  // A document object commonly contains only id/filename metadata. Its content
  // is usable only through text/records checked above.
  return Boolean(object(record.record) || object(record.resolvedEntity));
}

function idsForTool(
  tool: string,
  ledgerEntries: readonly LedgerEntry[],
  citations: readonly MeriCitation[],
): string[] {
  return [
    ...new Set([
      ...citations.filter((citation) => citation.tool === tool).map((citation) => citation.id),
      ...ledgerEntries
        .filter((entry) => entry.tool === tool)
        .flatMap((entry) => arrays.flatMap((key) => {
          const rows = object(entry.result)?.[key];
          return Array.isArray(rows)
            ? rows.flatMap((row) => {
                const item = object(row);
                const id = item?.id ?? item?.recordId ?? item?.documentId;
                return typeof id === 'string' ? [id] : [];
              })
            : [];
        })),
    ]),
  ];
}

function add(
  output: CoverageRequirement[],
  requirement: CoverageRequirement,
): void {
  if (!output.some((item) => item.id === requirement.id)) output.push(requirement);
}

export function buildCoverageRequirements(input: {
  plan: DomainEvidencePlan;
  request: string;
  frame: GovernmentAffairsOperatingFrame;
  attachments?: readonly CoverageAttachment[];
  clientId: string | null | undefined;
}): CoverageRequirement[] {
  const output: CoverageRequirement[] = [];
  for (const requirementId of input.plan.requiredRequirementIds) {
    const requirement = input.plan.requirements.find((item) => item.id === requirementId);
    if (!requirement) continue;
    add(output, {
      id: `plan:${requirement.id}`,
      requirementId: requirement.id,
      claimCategory: requirement.claimCategory,
      toolFamilies: [...requirement.toolFamilies],
      essential: true,
      rationale: requirement.reason,
    });
  }

  const comparison =
    /\bhouse\s+(?:vs\.?|versus|and)\s+senate\b/i.test(input.request) ||
    /\bhac-?d\b[\s\S]*\bsac-?d\b|\bsac-?d\b[\s\S]*\bhac-?d\b/i.test(input.request) ||
    (/\bhouse\b/i.test(input.request) && /\bsenate\b/i.test(input.request) && /\bcompar/i.test(input.request));
  if (comparison) {
    for (const chamber of ['House', 'Senate'] as const) {
      add(output, {
        id: `template:house_senate_comparison:${chamber.toLowerCase()}`,
        requirementId: `house-senate-comparison.${chamber.toLowerCase()}`,
        claimCategory: 'budget_delta',
        toolFamilies: ['get_pe_budget_timeline', 'get_funding_positions'],
        essential: true,
        rationale: `${chamber} source evidence is required for the requested chamber comparison.`,
        template: 'house_senate_comparison',
        route: { chamber: chamber.toLowerCase() },
      });
    }
  }

  const attachments = input.attachments ?? [];
  const references = resolveDocumentReferences({
    userText: input.request,
    selectedAttachmentIds: attachments.filter((item) => item.selected).map((item) => item.id),
    priorTurnManifest: attachments.filter((item) => item.kind !== 'client_document'),
    clientDocuments: attachments.filter((item) => item.kind === 'client_document'),
    clientId: input.clientId,
  });
  const documentSpecific =
    /\b(?:summari[sz]e|review|extract|from)\b[\s\S]{0,80}\b(?:transcript|document|attachment|file|memo|report|minutes)\b/i.test(
      input.request,
    ) || references.length > 0;
  if (documentSpecific) {
    const reference = references[0];
    add(output, {
      id: `template:transcript_summary:${reference?.id ?? 'unresolved'}`,
      requirementId: `document-content.${reference?.id ?? 'requested'}`,
      claimCategory: 'report_language',
      toolFamilies: ['read_client_documents'],
      essential: true,
      rationale: `Readable content${reference ? ` from ${reference.filename}` : ' from the requested document'} is required; metadata or a filename is not evidence.`,
      template: 'transcript_summary',
      ...(reference ? { route: { documentId: reference.id, documentName: reference.filename, clientId: input.clientId } } : {}),
    });
  }

  if (/\b(?:currently|current status|in production|latest status|as of (?:now|today))\b/i.test(input.request)) {
    const category = input.plan.requestCategories.find((item) => item !== 'general_background') ?? 'general_background';
    const families = input.plan.requirements
      .filter((item) => input.plan.requiredRequirementIds.includes(item.id))
      .flatMap((item) => item.toolFamilies);
    add(output, {
      id: 'template:current_status',
      requirementId: 'current-status.dated-source',
      claimCategory: category,
      toolFamilies: [...new Set(families)],
      essential: true,
      rationale: 'The requested current-status claim requires an observed or effective date within its freshness policy.',
      template: 'current_status',
    });
  }
  return output;
}

export function compareCoverage(input: {
  requirements: readonly CoverageRequirement[];
  toolsUsed: readonly string[];
  receipts: readonly MeriToolCoverageReceipt[];
  ledgerEntries: readonly LedgerEntry[];
  citations: readonly MeriCitation[];
}): CoverageGap[] {
  return input.requirements.map((requirement) => {
    const called = requirement.toolFamilies.filter((tool) => input.toolsUsed.includes(tool));
    const receipts = input.receipts.filter((receipt) => called.includes(receipt.tool));
    const entries = input.ledgerEntries.filter((entry) => called.includes(entry.tool));
    const evidenceIds = called.flatMap((tool) => idsForTool(tool, input.ledgerEntries, input.citations));
    const unavailable = receipts.some((receipt) => receipt.status === 'unavailable');
    const failed = receipts.some((receipt) => receipt.status === 'error') || entries.some((entry) => {
      const result = object(entry.result);
      return Boolean(result?.error || result?.blocked);
    });
    const truncated = receipts.some(
      (receipt) => receipt.truncated || receipt.paginationComplete === false,
    );
    const usable = entries.some((entry) => payloadHasUsableContent(entry.result));
    const status: CoverageGapStatus =
      called.length === 0
        ? 'never_called'
        : unavailable
          ? 'unavailable'
          : failed
            ? 'extraction_failed'
            : truncated
              ? 'truncated'
              : usable
                ? 'satisfied'
                : 'called_no_usable_content';
    return {
      requirementId: requirement.requirementId,
      essential: requirement.essential,
      status,
      materiality: requirement.essential ? 'changes_answer' : 'supplementary',
      evidenceIds: [...new Set(evidenceIds)],
    };
  });
}

function requestedProperties(schema: CoverageToolSchema): Set<string> {
  return new Set(Object.keys(object(schema.input_schema.properties) ?? {}));
}

function requestIdentities(request: string): Record<string, unknown> {
  const pe = request.match(/\b\d{7}[A-Z]\b/i)?.[0];
  const bill = request.match(/\b(?:H\.?R\.?|S\.?)\s*\d+\b/i)?.[0];
  const opportunity = request.match(/\b(?:opportunity|notice|award)\s*(?:id|number)?\s*[:#]?\s*([A-Z0-9_-]{4,})\b/i)?.[1];
  return {
    ...(pe ? { peCode: pe.toUpperCase(), code: pe.toUpperCase() } : {}),
    ...(bill ? { billId: bill.replace(/\s+/g, '') } : {}),
    ...(opportunity ? { opportunityId: opportunity, awardId: opportunity } : {}),
  };
}

export function planFollowUp(input: {
  gaps: readonly CoverageGap[];
  requirements?: readonly CoverageRequirement[];
  toolSchemas: readonly CoverageToolSchema[];
  request: string;
  frame: GovernmentAffairsOperatingFrame;
}): CoverageFollowUpPlan | null {
  const calls: CoverageFollowUpCall[] = [];
  const identity = { ...requestIdentities(input.request), clientId: input.frame.clientId ?? undefined };
  for (const gap of input.gaps) {
    if (!gap.essential || gap.status === 'satisfied') continue;
    const requirement = input.requirements?.find((item) => item.requirementId === gap.requirementId);
    for (const name of requirement?.toolFamilies ?? []) {
      const schema = input.toolSchemas.find((item) => item.name === name && item.readOnly !== false);
      if (!schema) continue;
      const properties = requestedProperties(schema);
      const candidates = { ...identity, ...requirement?.route };
      const args = Object.fromEntries(
        Object.entries(candidates).filter(
          ([key, value]) => properties.has(key) && value !== undefined && value !== null,
        ),
      );
      const required = Array.isArray(schema.input_schema.required)
        ? schema.input_schema.required.filter((key): key is string => typeof key === 'string')
        : [];
      if (required.some((key) => args[key] === undefined)) continue;
      calls.push({ name, arguments: args, requirementId: gap.requirementId });
      break;
    }
    if (calls.length >= 2) break;
  }
  return calls.length ? { calls, reason: 'essential_coverage_gap' } : null;
}

export function appendClaimTiedCoverageDisclosure(
  reply: string,
  gaps: readonly CoverageGap[],
  requirements: readonly CoverageRequirement[],
): string {
  const gap = gaps.find((item) => item.essential && item.status !== 'satisfied');
  if (!gap || /\*\*Evidence limitation:\*\*/i.test(reply)) return reply;
  const requirement = requirements.find((item) => item.requirementId === gap.requirementId);
  if (!requirement) return reply;
  const subject = requirement.rationale.replace(/[.]+$/, '');
  const note = `${subject}; that part of the answer remains limited because the source was ${gap.status.replaceAll('_', ' ')}.`
    .replace(/\[\d{1,3}\]/g, '')
    .slice(0, 320);
  return `${reply.trim()}\n\n> **Evidence limitation:** ${note}`.trim();
}
