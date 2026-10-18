import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import dataSearchSchema from './monday-data-search.schema.json';
import mondaySchema from './monday.schema.json';
import { documentContractV02 } from './documents-contract.js';

/**
 * Source-specific checks for the two retained 0.2 reads. These functions do not
 * authenticate a Meri call, obtain source credentials, or grant client access.
 * Their inputs must come from the task-bound receiver and the current Core
 * source owners, never from the model's `{input, metadata}` body.
 */
export class RetainedDocumentsMondayRefusal extends Error {
  readonly code = 'RETAINED_SOURCE_UNAVAILABLE';
  constructor(message: string) { super(message); this.name = 'RetainedDocumentsMondayRefusal'; }
}

type JsonObject = Record<string, unknown>;
type ReadSubject = {
  kind: string;
  entityType: string;
  entityIds: string[];
  tenantId: string;
  actorId: string;
};

export interface TrustedClientReadContext {
  binding: JsonObject & { tenantId: string; actorId: string };
  subject: ReadSubject & JsonObject;
  selectedClientId: string;
}

export interface CurrentManagedBoardMapping {
  tenantId: string;
  userId: string;
  clientId: string;
  mappingVersionId: string;
  boardIds: string[];
  /** Current owner authorizes these request-scoped boards as a subset of boardIds. */
  requestBoardIds?: string[];
}

export interface CurrentSourceReceipt {
  resultSha256: string;
  observedAt: string;
  /** Exact latest mapping row/version observed after retrieval. */
  mappingVersionId?: string;
}

export interface DocumentPricingEvidence {
  vision: {
    model: string;
    inputMicrousdPerMillionTokens: number;
    outputMicrousdPerMillionTokens: number;
    maxInputTokens: number;
    coreSourceCommit: string;
    coreImageDigest: string;
    configurationSha256: string;
  };
  transcription: {
    model: 'whisper-1';
    microusdPerMinute: number;
    maxAudioSeconds: number;
    coreSourceCommit: string;
    coreImageDigest: string;
    configurationSha256: string;
  };
  /** Measured, enforced in the running Core extraction owner before a paid call. */
  runtimeMaxAudioSeconds: number;
  runtimeCapEnforced: true;
}

/** Owner-enforced provider exclusion, not pricing evidence for Meri allocation. */
export type DocumentExecutionPolicy = DocumentPricingEvidence | { providerCalls: 'forbidden' };
export const NO_DOCUMENT_PROVIDER_CALLS = Object.freeze({ providerCalls: 'forbidden' } as const);
function providerCallsForbidden(policy: DocumentExecutionPolicy | undefined): boolean {
  return !!policy && 'providerCalls' in policy && policy.providerCalls === 'forbidden' &&
    Object.keys(policy).length === 1;
}

function fail(reason: string): never { throw new RetainedDocumentsMondayRefusal(reason); }
const object = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : fail('Expected object');
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.trim() === value;
const sha256 = (value: unknown) => createHash('sha256').update(canonicalizeCoreRetainedJson(value)).digest('hex');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const timestamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));

// Byte-exact Meri PR158 0.2 output schemas, pinned by the focused spec.
// Shape validation supplements the current mapping and row-scope checks below.
const mondayAjv = new Ajv2020({ strict: true, allErrors: true });
addFormats(mondayAjv);
mondayAjv.addSchema(dataSearchSchema);
mondayAjv.addSchema(mondaySchema);
const mondayOutputShape = mondayAjv.compile({
  $ref: `${mondaySchema.$id}#/$defs/ClientKnowledgeMondayOutput`,
});

function assertCurrentClient(input: JsonObject, current: TrustedClientReadContext): string {
  const { binding, subject, selectedClientId } = current;
  if (!uuid(input.clientId) || !uuid(selectedClientId) || input.clientId !== selectedClientId ||
    !uuid(binding?.tenantId) || !nonempty(binding?.actorId) ||
    subject?.kind !== 'client' || subject.entityType !== 'client' ||
    subject.tenantId !== binding.tenantId || subject.actorId !== binding.actorId ||
    !Array.isArray(subject.entityIds) || subject.entityIds.length !== 1 ||
    subject.entityIds[0] !== selectedClientId) fail('Current client subject or selector is missing');
  return selectedClientId;
}

function assertSourceReceipt(body: unknown, receipt: CurrentSourceReceipt): void {
  if (!hash(receipt?.resultSha256) || sha256(body) !== receipt.resultSha256 ||
    !timestamp(receipt.observedAt)) fail('Current source result hash or observation is missing');
}

/** Prepare the exact legacy selector only after a trusted task-selected client. */
export function prepareMondayRead(input: JsonObject, current: TrustedClientReadContext,
  mapping: CurrentManagedBoardMapping): JsonObject {
  const clientId = assertCurrentClient(input, current);
  if (Object.keys(input).some((key) => !['clientId', 'boardContext', 'cursor', 'pageSize', 'requireComplete'].includes(key)) ||
    input.requireComplete !== (input.pageSize === null && input.cursor === null))
    fail('Monday normalized selection differs from canonical 0.2 input');
  if (mapping?.tenantId !== current.binding.tenantId || mapping.userId !== current.binding.actorId ||
    mapping.clientId !== clientId || !nonempty(mapping.mappingVersionId) ||
    !Array.isArray(mapping.boardIds) || mapping.boardIds.length === 0 || mapping.boardIds.length > 20 ||
    mapping.boardIds.some((id) => typeof id !== 'string' || !/^[0-9]{1,24}$/.test(id)) ||
    new Set(mapping.boardIds).size !== mapping.boardIds.length) fail('Current managed board mapping is missing');
  if (mapping.requestBoardIds !== undefined && (!Array.isArray(mapping.requestBoardIds) ||
    mapping.requestBoardIds.some((id) => !mapping.boardIds.includes(id)) ||
    new Set(mapping.requestBoardIds).size !== mapping.requestBoardIds.length))
    fail('Requested boards exceed the current managed mapping');
  if (input.boardContext !== null && input.boardContext !== undefined &&
    (typeof input.boardContext !== 'string' || input.boardContext.length > 2000)) fail('Invalid board context');
  if (input.cursor !== null && input.cursor !== undefined &&
    (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 512)) fail('Invalid Monday cursor');
  if (input.pageSize !== null && input.pageSize !== undefined && !integer(input.pageSize, 1, 100))
    fail('Invalid Monday page size');
  // boardContext is an inert search hint. It never expands the mapped board set.
  return {
    clientId,
    ...(input.boardContext ? { boardContext: input.boardContext } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.pageSize ? { pageSize: input.pageSize } : {}),
  };
}

/** Check the canonical owner projection against the *current* mapping receipt. */
export function projectMondayRead(body: unknown, input: JsonObject, current: TrustedClientReadContext,
  mapping: CurrentManagedBoardMapping, receipt: CurrentSourceReceipt): JsonObject {
  prepareMondayRead(input, current, mapping);
  assertSourceReceipt(body, receipt);
  if (!mondayOutputShape(body)) fail('Monday result differs from the 0.2 output schema');
  if (receipt.mappingVersionId !== mapping.mappingVersionId) fail('Managed board mapping changed during the read');
  const data = object(body), coverage = object(data.coverage), rows = data.records;
  if (data.tool !== 'read_monday_client_boards' || data.authoritativeOwner !== 'managed_monday_mcp' ||
    data.clientId !== current.selectedClientId || !Array.isArray(rows) || rows.length > 3000 ||
    !Array.isArray(coverage.requestedDomains) || coverage.requestedDomains.length !== 1 ||
    coverage.requestedDomains[0] !== 'monday' || !Array.isArray(coverage.sources) || coverage.sources.length !== 1 ||
    object(coverage.sources[0]).domain !== 'monday' ||
    data.currentStatus !== object(coverage.sources[0]).sourceStatus ||
    coverage.recordsReturned !== rows.length ||
    (input.pageSize !== null && input.pageSize !== undefined && rows.length > (input.pageSize as number)))
    fail('Monday source identity, scope, or coverage differs');
  const seen = new Set<string>();
  for (const candidate of rows) {
    const row = object(candidate), payload = object(row.payload), origin = object(payload.origin), provenance = object(row.provenance);
    const boardId = origin.boardId;
    if (row.domain !== 'monday' || payload.clientId !== current.selectedClientId ||
      payload.sourceActorUserId !== current.binding.actorId ||
      typeof boardId !== 'string' || !mapping.boardIds.includes(boardId) ||
      typeof origin.itemId !== 'string' || !/^[0-9]{1,80}$/.test(origin.itemId) ||
      row.recordId !== `${boardId}:${origin.itemId}` || seen.has(row.recordId as string) ||
      provenance.source !== 'managed_monday_mcp' || provenance.boardId !== boardId ||
      provenance.itemId !== origin.itemId ||
      provenance.parentItemId !== origin.parentItemId ||
      ((origin.itemType === 'subitem') !== (typeof origin.parentItemId === 'string' && !!origin.parentItemId)) ||
      (payload.status !== null && (!nonempty(payload.status))) ||
      (payload.url !== null && (typeof payload.url !== 'string' ||
        !/^https:\/\/[a-z0-9-]+\.monday\.com\//i.test(payload.url))) ||
      (origin.scope !== 'saved_mapping' && origin.scope !== 'request') ||
      (mapping.requestBoardIds !== undefined && origin.scope !== 'request') ||
      (mapping.requestBoardIds === undefined && origin.scope !== 'saved_mapping') ||
      (origin.scope === 'request' && !mapping.requestBoardIds?.includes(boardId)))
      fail('Monday row is outside the current mapped board or client');
    seen.add(row.recordId as string);
  }
  return data;
}

/** A source/price assertion, never a way to infer a cap from upload bytes. */
export function assertDocumentPricing(evidence: DocumentPricingEvidence | undefined): void {
  if (!evidence || evidence.runtimeCapEnforced !== true ||
    !integer(evidence.runtimeMaxAudioSeconds, 1) ||
    !integer(evidence.transcription?.maxAudioSeconds, 1) ||
    evidence.runtimeMaxAudioSeconds !== evidence.transcription.maxAudioSeconds ||
    evidence.transcription.model !== 'whisper-1' ||
    !integer(evidence.transcription.microusdPerMinute, 0) ||
    !integer(evidence.transcription.maxAudioSeconds, 1, 86400) ||
    !nonempty(evidence.vision?.model) || !integer(evidence.vision.maxInputTokens, 1, 2000000) ||
    !integer(evidence.vision.inputMicrousdPerMillionTokens, 0) ||
    !integer(evidence.vision.outputMicrousdPerMillionTokens, 0) ||
    !/^[a-f0-9]{40}$/.test(evidence.vision.coreSourceCommit) ||
    !/^[a-f0-9]{40}$/.test(evidence.transcription.coreSourceCommit) ||
    evidence.vision.coreSourceCommit !== evidence.transcription.coreSourceCommit ||
    !/^sha256:[a-f0-9]{64}$/.test(evidence.vision.coreImageDigest) ||
    evidence.vision.coreImageDigest !== evidence.transcription.coreImageDigest ||
    !hash(evidence.vision.configurationSha256) ||
    evidence.vision.configurationSha256 !== evidence.transcription.configurationSha256)
    fail('Measured document prices and enforced whisper duration cap are required');
}

/** Keep the public Meri selector unchanged for the canonical Core document handler. */
export function prepareDocumentRead(input: JsonObject, current: TrustedClientReadContext,
  evidence: DocumentExecutionPolicy | undefined): JsonObject {
  const clientId = assertCurrentClient(input, current);
  if (!providerCallsForbidden(evidence)) assertDocumentPricing(evidence as DocumentPricingEvidence | undefined);
  const allowed = ['mode', 'clientId', 'documentId', 'query', 'section', 'characterOffset', 'limit', 'cursor', 'cursorBinding', 'listAfter'];
  if (Object.keys(input).some((key) => !allowed.includes(key)) ||
    (input.mode !== 'list' && input.mode !== 'read') ||
    typeof input.query !== 'string' || input.query.length > 240 ||
    !integer(input.section, 1) || !integer(input.characterOffset, 0) ||
    !integer(input.limit, 1, input.mode === 'list' ? 50 : 6000) ||
    (input.cursor !== null && (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 4096)))
    fail('Invalid normalized document selection');
  const documentId = input.documentId;
  if (input.mode === 'list') {
    if (documentId !== null || input.section !== 1 || input.characterOffset !== 0 || input.cursorBinding !== null ||
      (input.listAfter !== null && (!nonempty(input.listAfter) || input.cursor !== `documents:${input.listAfter}`)) ||
      (input.listAfter === null && input.cursor !== null)) fail('Document list cursor or mode changed');
  } else {
    if (!nonempty(documentId) || documentId.length > 80 || input.listAfter !== null ||
      ((input.cursor === null) !== (input.cursorBinding === null))) fail('Document section identity or cursor changed');
    if (input.cursor !== null) {
      const token = input.cursor as string;
      if (!/^document:[A-Za-z0-9_-]+$/.test(token)) fail('Invalid document cursor');
      let decoded: JsonObject;
      try { decoded = object(JSON.parse(Buffer.from(token.slice(9), 'base64url').toString('utf8'))); }
      catch { fail('Invalid document cursor JSON'); }
      if (sha256(decoded) !== sha256(input.cursorBinding) || decoded.version !== 1 ||
        decoded.clientId !== clientId || decoded.documentId !== documentId ||
        decoded.query !== input.query || decoded.section !== input.section ||
        decoded.offset !== input.characterOffset || !hash(decoded.contentHash))
        fail('Document continuation changed client, document, or source hash');
    }
  }
  const legacyInput = {
    clientId,
    ...(documentId ? { documentId } : {}),
    ...(input.query ? { query: input.query } : {}),
    limit: input.limit,
    ...(input.cursor ? { cursor: input.cursor } :
      input.mode === 'read' ? { section: input.section, characterOffset: input.characterOffset } : {}),
  };
  const normalized = documentContractV02.normalizeClientDocumentsInput(legacyInput,
    { binding: current.binding, subject: current.subject });
  if (sha256(normalized) !== sha256(input)) fail('Document selection differs from pinned normalizer');
  return legacyInput;
}

/** Meri 0.2 expects binding/subject alongside the canonical Core data page. */
export function projectDocumentRead(body: unknown, input: JsonObject, current: TrustedClientReadContext,
  evidence: DocumentExecutionPolicy | undefined, receipt: CurrentSourceReceipt): JsonObject {
  const legacyInput = prepareDocumentRead(input, current, evidence);
  assertSourceReceipt(body, receipt);
  const data = object(body), coverage = object(data.coverage);
  if (data.tool !== 'read_client_documents' || data.clientId !== current.selectedClientId ||
    !timestamp(data.generatedAt) || Date.parse(data.generatedAt as string) > Date.parse(receipt.observedAt))
    fail('Document current source identity or timestamp differs');
  if (input.mode === 'list') {
    if (!Array.isArray(data.documents) || !integer(coverage.returned, 0, 50) ||
      coverage.returned !== data.documents.length ||
      data.documents.some((candidate: unknown) => !nonempty(object(candidate).id)))
      fail('Document inventory is incomplete');
  } else {
    const document = object(data.document);
    if (document.id !== input.documentId || !hash(document.contentHash) ||
      !Array.isArray(data.records) || data.records.length > 1) fail('Document source hash or identity is missing');
    for (const candidate of data.records) {
      const row = object(candidate), payload = object(row.payload), provenance = object(row.provenance);
      if (payload.documentId !== document.id || provenance.sourceRecordId !== document.id ||
        provenance.clientId !== current.selectedClientId || provenance.contentHash !== document.contentHash ||
        !hash(provenance.sectionHash) || typeof payload.text !== 'string' ||
        (coverage.sectionComplete === true &&
          createHash('sha256').update(payload.text).digest('hex') !== provenance.sectionHash))
        fail('Document result lacks source content and section hash lineage');
    }
    const metadata = coverage.extractionMetadata;
    const extraction = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? metadata as JsonObject : null;
    const extractionReadability = extraction?.readability;
    if (providerCallsForbidden(evidence) && (data.records.some((candidate: unknown) =>
        object(object(candidate).payload).source === 'transcription') ||
        coverage.readability !== null && object(coverage.readability).method === 'openai_pdf' ||
        extraction?.source === 'transcription' ||
        extractionReadability && typeof extractionReadability === 'object' &&
          !Array.isArray(extractionReadability) && object(extractionReadability).method === 'openai_pdf'))
      fail('Provider extraction is forbidden for this source read');
  }
  return documentContractV02.assertClientDocumentsResult(
    { binding: current.binding, subject: current.subject, data }, legacyInput,
    { binding: current.binding, subject: current.subject });
}
