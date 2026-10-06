import { createHash } from 'node:crypto';
import type { DurableResearchStepReceipt } from './meri-research-durable-step.js';
import { researchJsonSha256 } from './meri-research-durable-result.js';
import { researchMetadata, type ResearchRunState } from './meri-research-run-state.js';

export const PUBLIC_RESEARCH_SOURCE_TOOLS = [
  'get_email_thread',
  'list_emails',
  'read_client_documents',
  'search_emails',
  'search_memory',
  'query_debriefs',
  'read_client_meetings',
  'query_tasks',
  'query_action_items',
  'read_monday_client_boards',
  'get_bill_status',
  'read_bill_text',
  'scrape_web_page',
  'read_chat_attachments',
  'get_research_evidence',
] as const;

const PUBLIC_RESEARCH_SOURCE_TOOL_SET = new Set<string>(PUBLIC_RESEARCH_SOURCE_TOOLS);
const SHA256_RE = /^[a-f0-9]{64}$/;

export interface ResearchReportProvenanceV1 {
  version: 1;
  artifactVersion: 1;
  artifactId: string;
  messageId: string | null;
  sessionId: string;
  tenantId: string;
  userId: string;
  clientId: string | null;
  conversationId: string;
  kind: 'research_report';
  runId: string;
  leaseEpoch: number;
  bodySha256: string;
  receiptManifestSha256: string;
  toolsUsed: string[];
  sourceMode: 'durable_receipts' | 'producer_proven_source_free' | 'producer_current_inputs';
  producerInputSha256: string;
  producerInputMode: 'source_free' | 'covered_inputs' | 'governed_inputs';
  clientContextSha256: string | null;
  /** Present only for governed inputs: the pinned manifest in private session metadata. */
  producerInputManifestSha256?: string;
}

export interface ResearchProducerInputCertificate {
  producerInputSha256: string;
  producerInputMode: 'source_free' | 'covered_inputs' | 'unsupported_private_inputs';
  clientContextSha256: string | null;
  /** Counts per refused category, for the publication refusal log. */
  producerInputCategories: { unsupported: Record<string, number>; covered: Record<string, number> };
}

/**
 * Production-owned classification of every non-user input visible to synthesis.
 * Hashing binds bytes; it does not confer authority. Inputs without a canonical
 * read adapter are reported as unsupported so publication can fail closed.
 */
export function certifyResearchProducerInputs(input: {
  hashMaterial: unknown;
  toolsUsed: string[];
  clientContext: string | null | undefined;
  handoffSummaryPresent: boolean;
  handoffAttachmentCount: number;
  assistantHandoffTurns: number;
  inheritedCitationCount: number;
  inheritedUnavailableCount: number;
  inheritedOmittedCount: number;
  contextPacketItemCount: number;
  unreceiptedLedgerEntryCount: number;
}): ResearchProducerInputCertificate {
  const clientContextSha256 = input.clientContext
    ? createHash('sha256').update(input.clientContext).digest('hex')
    : null;
  const unsupportedPrivateInputs =
    input.handoffSummaryPresent ||
    input.handoffAttachmentCount > 0 ||
    input.assistantHandoffTurns > 0 ||
    input.inheritedCitationCount > 0 ||
    input.inheritedUnavailableCount > 0 ||
    input.inheritedOmittedCount > 0 ||
    input.contextPacketItemCount > 0 ||
    input.unreceiptedLedgerEntryCount > 0;
  const hasCoveredPrivateInputs = input.toolsUsed.length > 0 || Boolean(clientContextSha256);
  const unsupported = Object.fromEntries(
    (
      [
        ['handoff_summary', input.handoffSummaryPresent ? 1 : 0],
        ['handoff_attachments', input.handoffAttachmentCount],
        ['assistant_handoff_turns', input.assistantHandoffTurns],
        ['inherited_citations', input.inheritedCitationCount],
        ['inherited_unavailable', input.inheritedUnavailableCount],
        ['inherited_omitted', input.inheritedOmittedCount],
        ['context_packet_items', input.contextPacketItemCount],
        ['unreceipted_ledger_entries', input.unreceiptedLedgerEntryCount],
      ] as const
    ).filter(([, count]) => count > 0),
  );
  return {
    producerInputSha256: researchJsonSha256({
      version: 1,
      hashMaterial: input.hashMaterial,
      toolsUsed: [...new Set(input.toolsUsed)].sort(),
      clientContextSha256,
      handoffSummaryPresent: input.handoffSummaryPresent,
      handoffAttachmentCount: input.handoffAttachmentCount,
      assistantHandoffTurns: input.assistantHandoffTurns,
      inheritedCitationCount: input.inheritedCitationCount,
      inheritedUnavailableCount: input.inheritedUnavailableCount,
      inheritedOmittedCount: input.inheritedOmittedCount,
      contextPacketItemCount: input.contextPacketItemCount,
      unreceiptedLedgerEntryCount: input.unreceiptedLedgerEntryCount,
    }),
    producerInputMode: unsupportedPrivateInputs
      ? 'unsupported_private_inputs'
      : hasCoveredPrivateInputs
        ? 'covered_inputs'
        : 'source_free',
    clientContextSha256,
    producerInputCategories: { unsupported, covered: {} },
  };
}

export function publicResearchSourceTool(value: unknown): string | null {
  return typeof value === 'string' && PUBLIC_RESEARCH_SOURCE_TOOL_SET.has(value) ? value : null;
}

export function reportBodySha256(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

export function reportReceiptManifest(
  receipts: DurableResearchStepReceipt[],
  run: Pick<ResearchRunState, 'id' | 'leaseEpoch'>,
  toolsUsed?: string[],
): Array<Record<string, unknown>> {
  const declaredTools = toolsUsed ? new Set(toolsUsed) : null;
  return receipts
    .filter(
      (receipt) =>
        receipt.version === 2 &&
        receipt.status === 'complete' &&
        (declaredTools
          ? declaredTools.has(receipt.tool)
          : receipt.runId === run.id && receipt.leaseEpoch === run.leaseEpoch),
    )
    .map((receipt) => ({
      receiptId: receipt.receiptId,
      sequence: receipt.sequence,
      executionId: receipt.executionId,
      providerCallId: receipt.providerCallId,
      tool: receipt.tool,
      toolVersion: receipt.toolVersion,
      inputSha256: receipt.inputSha256,
      resultSha256: receipt.resultSha256,
      resultBodySha256: receipt.resultBodySha256,
      resultRef: receipt.resultRef,
      classifier: receipt.classifier,
    }))
    .sort(
      (left, right) =>
        Number(left.sequence) - Number(right.sequence) ||
        String(left.receiptId).localeCompare(String(right.receiptId)),
    );
}

export function reportReceiptManifestSha256(
  receipts: DurableResearchStepReceipt[],
  run: Pick<ResearchRunState, 'id' | 'leaseEpoch'>,
  toolsUsed?: string[],
): string {
  return researchJsonSha256(reportReceiptManifest(receipts, run, toolsUsed));
}

export function buildResearchReportProvenance(
  input: Omit<
    ResearchReportProvenanceV1,
    'version' | 'artifactVersion' | 'kind' | 'bodySha256' | 'receiptManifestSha256' | 'sourceMode'
  > & {
    body: string;
    receipts: DurableResearchStepReceipt[];
  },
): ResearchReportProvenanceV1 {
  const toolsUsed = [...new Set(input.toolsUsed)].sort();
  if (toolsUsed.some((tool) => !publicResearchSourceTool(tool))) {
    throw new Error('A research report provenance receipt contains an unsupported source owner.');
  }
  if (!SHA256_RE.test(input.producerInputSha256)) {
    throw new Error('A research report provenance receipt requires producer input authority.');
  }
  if (
    (input.producerInputMode === 'governed_inputs') !==
    SHA256_RE.test(String(input.producerInputManifestSha256 ?? ''))
  ) {
    throw new Error('Governed producer inputs require exactly one pinned input manifest.');
  }
  if (
    input.producerInputMode === 'source_free' &&
    (toolsUsed.length > 0 || input.clientContextSha256)
  ) {
    throw new Error('A source-free report contains covered private producer inputs.');
  }
  if (
    toolsUsed.length === 0 &&
    input.receipts.some((receipt) => receipt.version === 2 && receipt.status === 'complete')
  ) {
    throw new Error('A source-free report cannot inherit a durable source receipt.');
  }
  const manifest = reportReceiptManifest(
    input.receipts,
    {
      id: input.runId,
      leaseEpoch: input.leaseEpoch,
    },
    toolsUsed,
  );
  if (toolsUsed.length === 0 && manifest.length !== 0) {
    throw new Error('A source-free report cannot inherit a durable source receipt.');
  }

  if (
    toolsUsed.length > 0 &&
    toolsUsed.some((tool) => !manifest.some((receipt) => receipt.tool === tool))
  ) {
    throw new Error('A research report source declaration is missing its durable receipt.');
  }
  return {
    version: 1,
    artifactVersion: 1,
    artifactId: input.artifactId,
    messageId: input.messageId,
    sessionId: input.sessionId,
    tenantId: input.tenantId,
    userId: input.userId,
    clientId: input.clientId,
    conversationId: input.conversationId,
    kind: 'research_report',
    runId: input.runId,
    leaseEpoch: input.leaseEpoch,
    bodySha256: reportBodySha256(input.body),
    receiptManifestSha256: researchJsonSha256(manifest),
    toolsUsed,
    sourceMode: toolsUsed.length
      ? 'durable_receipts'
      : input.producerInputMode === 'source_free'
        ? 'producer_proven_source_free'
        : 'producer_current_inputs',
    producerInputSha256: input.producerInputSha256,
    producerInputMode: input.producerInputMode,
    clientContextSha256: input.clientContextSha256,
    ...(input.producerInputManifestSha256
      ? { producerInputManifestSha256: input.producerInputManifestSha256 }
      : {}),
  };
}

export function readResearchReportProvenance(value: unknown): ResearchReportProvenanceV1 | null {
  const raw = researchMetadata(value).reportProvenance;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const proof = raw as Partial<ResearchReportProvenanceV1>;
  const toolsUsed = Array.isArray(proof.toolsUsed)
    ? proof.toolsUsed.filter((tool): tool is string => Boolean(publicResearchSourceTool(tool)))
    : [];
  if (
    proof.version !== 1 ||
    proof.artifactVersion !== 1 ||
    typeof proof.artifactId !== 'string' ||
    !(proof.messageId === null || typeof proof.messageId === 'string') ||
    typeof proof.sessionId !== 'string' ||
    typeof proof.tenantId !== 'string' ||
    typeof proof.userId !== 'string' ||
    !(proof.clientId === null || typeof proof.clientId === 'string') ||
    typeof proof.conversationId !== 'string' ||
    proof.kind !== 'research_report' ||
    typeof proof.runId !== 'string' ||
    !Number.isSafeInteger(proof.leaseEpoch) ||
    !SHA256_RE.test(String(proof.bodySha256)) ||
    !SHA256_RE.test(String(proof.receiptManifestSha256)) ||
    !SHA256_RE.test(String(proof.producerInputSha256)) ||
    !['source_free', 'covered_inputs', 'governed_inputs'].includes(
      String(proof.producerInputMode),
    ) ||
    (proof.producerInputMode === 'governed_inputs'
      ? !SHA256_RE.test(String(proof.producerInputManifestSha256))
      : proof.producerInputManifestSha256 !== undefined) ||
    !(proof.clientContextSha256 === null || SHA256_RE.test(String(proof.clientContextSha256))) ||
    !Array.isArray(proof.toolsUsed) ||
    toolsUsed.length !== proof.toolsUsed.length ||
    new Set(toolsUsed).size !== toolsUsed.length ||
    !['durable_receipts', 'producer_proven_source_free', 'producer_current_inputs'].includes(
      String(proof.sourceMode),
    ) ||
    (proof.sourceMode === 'durable_receipts') !== toolsUsed.length > 0 ||
    (proof.sourceMode === 'producer_proven_source_free') !==
      (toolsUsed.length === 0 && proof.producerInputMode === 'source_free') ||
    (proof.sourceMode === 'producer_current_inputs') !==
      (toolsUsed.length === 0 &&
        (proof.producerInputMode === 'covered_inputs' ||
          proof.producerInputMode === 'governed_inputs')) ||
    (proof.producerInputMode === 'source_free' &&
      (toolsUsed.length > 0 || proof.clientContextSha256))
  ) {
    return null;
  }
  return { ...proof, toolsUsed } as ResearchReportProvenanceV1;
}

export function sameResearchReportProvenance(
  left: ResearchReportProvenanceV1,
  right: ResearchReportProvenanceV1,
): boolean {
  return researchJsonSha256(left) === researchJsonSha256(right);
}
