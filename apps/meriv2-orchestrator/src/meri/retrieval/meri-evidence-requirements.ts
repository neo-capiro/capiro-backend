import type {
  ClaimCategory,
  DomainEvidencePlan,
  GovernmentAffairsOperatingFrame,
  LedgerEntry,
} from '@capiro/meriv2-core';
import {
  resolveDocumentReferences,
  type DocumentReference,
  type DocumentReferenceCandidate,
} from '@capiro/meriv2-core';
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

/** Content evidence from a document read: the document identity plus non-empty text. */
export interface DocumentContentEvidence {
  documentId: string;
  recordIds: string[];
}

/** Tools whose result without a `documentId` is a file listing, never document content. */
const DOCUMENT_CONTENT_TOOLS = new Set(['read_client_documents']);
const DOCUMENT_KEYWORD =
  /\b(?:summari[sz]e|review|extract|from)\b[\s\S]{0,80}\b(?:transcript|document|attachment|file|memo|report|minutes)\b/i;
const CHAMBER_PATTERNS: Readonly<Record<string, RegExp>> = {
  house: /\b(?:house|hasc|hac[-_\s]?d)\b/i,
  senate: /\b(?:senate|sasc|sac[-_\s]?d)\b/i,
};

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

/**
 * A document read is content only when it names the document AND carries
 * extracted text. A file listing (`documents: [...]`), a metadata-only document
 * object, or an empty extraction never counts as content.
 */
export function documentContentEvidence(value: unknown): DocumentContentEvidence | null {
  const record = object(value);
  if (!record || record.error || record.blocked) return null;
  const document = object(record.document);
  const documentId =
    typeof document?.id === 'string'
      ? document.id
      : typeof record.documentId === 'string'
        ? record.documentId
        : null;
  if (!documentId) return null;
  const rows = Array.isArray(record.records) ? record.records.map(object) : [];
  const texts = [record.text, record.content, ...rows.map((row) => object(row?.payload)?.text)].filter(
    (text): text is string => typeof text === 'string' && text.trim().length > 0,
  );
  if (!texts.length) return null;
  const recordIds = rows.flatMap((row) => {
    const id = row?.recordId ?? row?.id;
    return typeof id === 'string' ? [id] : [];
  });
  return { documentId, recordIds };
}

function isDocumentContentRequirement(requirement: CoverageRequirement): boolean {
  return requirement.template === 'transcript_summary' || typeof requirement.route?.documentId === 'string';
}

/** Whether one ledger entry supplies evidence for the requirement (and its route). */
function entryProvidesEvidence(entry: LedgerEntry, requirement: CoverageRequirement): boolean {
  if (isDocumentContentRequirement(requirement) || DOCUMENT_CONTENT_TOOLS.has(entry.tool)) {
    const content = documentContentEvidence(entry.result);
    if (!content) return false;
    const documentId = requirement.route?.documentId;
    return typeof documentId === 'string' ? content.documentId === documentId : true;
  }
  if (!payloadHasUsableContent(entry.result)) return false;
  const chamber = requirement.route?.chamber;
  const pattern = typeof chamber === 'string' ? CHAMBER_PATTERNS[chamber] : undefined;
  if (!pattern) return true;
  const haystack = entry.result !== undefined ? safeJson(entry.result) : entry.serialized;
  return pattern.test(haystack);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
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

function evidenceIdsFor(
  requirement: CoverageRequirement,
  called: readonly string[],
  usable: readonly LedgerEntry[],
  input: { ledgerEntries: readonly LedgerEntry[]; citations: readonly MeriCitation[] },
): string[] {
  const documentId = requirement.route?.documentId;
  if (typeof documentId === 'string') {
    return [
      ...new Set([
        ...input.citations
          .filter((citation) => citation.documentEvidence?.documentId === documentId)
          .flatMap((citation) => [citation.id, ...(citation.stableId ? [citation.stableId] : [])]),
        ...usable.flatMap((entry) => documentContentEvidence(entry.result)?.recordIds ?? []),
      ]),
    ];
  }
  if (isDocumentContentRequirement(requirement)) {
    return [...new Set(usable.flatMap((entry) => documentContentEvidence(entry.result)?.recordIds ?? []))];
  }
  return [...new Set(called.flatMap((tool) => idsForTool(tool, input.ledgerEntries, input.citations)))];
}

function add(
  output: CoverageRequirement[],
  requirement: CoverageRequirement,
): void {
  if (!output.some((item) => item.id === requirement.id)) output.push(requirement);
}

function documentRequirement(
  reference: DocumentReference,
  essential: boolean,
  clientId: string | null | undefined,
): CoverageRequirement {
  return {
    id: `template:transcript_summary:${reference.id}`,
    requirementId: `document-content.${reference.id}`,
    claimCategory: 'report_language',
    toolFamilies: ['read_client_documents'],
    essential,
    rationale: essential
      ? `Readable content from ${reference.filename} is required; metadata or a filename is not evidence.`
      : `Readable content from ${reference.filename} would confirm the document-specific parts of the answer; the reference is heuristic.`,
    template: 'transcript_summary',
    route: { documentId: reference.id, documentName: reference.filename, clientId },
  };
}

export function buildCoverageRequirements(input: {
  plan: DomainEvidencePlan;
  request: string;
  frame: GovernmentAffairsOperatingFrame;
  attachments?: readonly CoverageAttachment[];
  /** Document ids the user selected for this turn (apps/api forwards them). */
  selectedDocumentIds?: readonly string[];
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

  // A document requirement is essential only for a concrete document the turn
  // actually references: a selected/attached id or a filename that resolves
  // against the provided references. Keyword matches alone are a hint.
  const attachments = input.attachments ?? [];
  const selectedIds = [
    ...new Set([
      ...(input.selectedDocumentIds ?? []),
      ...attachments.filter((item) => item.selected).map((item) => item.id),
    ]),
  ];
  const references = resolveDocumentReferences({
    userText: input.request,
    selectedAttachmentIds: selectedIds,
    priorTurnManifest: attachments.filter((item) => item.kind !== 'client_document'),
    clientDocuments: attachments.filter((item) => item.kind === 'client_document'),
    clientId: input.clientId,
  });
  const concrete = references.filter((item) => item.resolution !== 'pronoun_heuristic');
  const heuristic = references.filter((item) => item.resolution === 'pronoun_heuristic');
  for (const reference of concrete) add(output, documentRequirement(reference, true, input.clientId));
  for (const id of selectedIds.filter((selected) => !references.some((item) => item.id === selected))) {
    add(output, {
      id: `template:transcript_summary:${id}`,
      requirementId: `document-content.${id}`,
      claimCategory: 'report_language',
      toolFamilies: ['read_client_documents'],
      essential: true,
      rationale: 'Readable content from the selected document is required; metadata or a filename is not evidence.',
      template: 'transcript_summary',
      route: { documentId: id, clientId: input.clientId },
    });
  }
  if (!output.some((item) => item.template === 'transcript_summary')) {
    if (heuristic[0]) add(output, documentRequirement(heuristic[0], false, input.clientId));
    else if (DOCUMENT_KEYWORD.test(input.request)) {
      add(output, {
        id: 'template:transcript_summary:hint',
        requirementId: 'document-content.hint',
        claimCategory: 'report_language',
        toolFamilies: ['read_client_documents'],
        essential: false,
        rationale:
          'The request mentions a document, but no attached or selected client document was referenced; reading a client file is optional.',
        template: 'transcript_summary',
      });
    }
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
    const usable = entries.filter((entry) => entryProvidesEvidence(entry, requirement));
    const unavailable = receipts.some((receipt) => receipt.status === 'unavailable');
    const failed = receipts.some((receipt) => receipt.status === 'error') || entries.some((entry) => {
      const result = object(entry.result);
      return Boolean(result?.error || result?.blocked);
    });
    const truncated = receipts.some(
      (receipt) => receipt.truncated || receipt.paginationComplete === false,
    );
    // Any usable result satisfies the requirement. Failed, unavailable or
    // truncated reads classify the gap only when nothing usable was retrieved,
    // so one paginated listing or one retried error never pins the status.
    const status: CoverageGapStatus =
      called.length === 0
        ? 'never_called'
        : usable.length
          ? 'satisfied'
          : unavailable
            ? 'unavailable'
            : failed
              ? 'extraction_failed'
              : truncated
                ? 'truncated'
                : 'called_no_usable_content';
    return {
      requirementId: requirement.requirementId,
      essential: requirement.essential,
      status,
      materiality: requirement.essential ? 'changes_answer' : 'supplementary',
      evidenceIds: evidenceIdsFor(requirement, called, usable, input),
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
    if (!requirement) continue;
    for (const name of requirement.toolFamilies) {
      const schema = input.toolSchemas.find((item) => item.name === name && item.readOnly !== false);
      if (!schema) continue;
      const properties = requestedProperties(schema);
      const candidates = { ...identity, ...requirement.route };
      const args = Object.fromEntries(
        Object.entries(candidates).filter(
          ([key, value]) => properties.has(key) && value !== undefined && value !== null,
        ),
      );
      const required = Array.isArray(schema.input_schema.required)
        ? schema.input_schema.required.filter((key): key is string => typeof key === 'string')
        : [];
      if (required.some((key) => args[key] === undefined)) continue;
      // A document-content follow-up needs the document itself. A call with only
      // the client id would be a file listing, which can never satisfy content.
      if (
        (DOCUMENT_CONTENT_TOOLS.has(name) || isDocumentContentRequirement(requirement)) &&
        (typeof args.documentId !== 'string' || !args.documentId.trim())
      )
        continue;
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
