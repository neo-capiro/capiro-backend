const nonempty = { type: 'string', minLength: 1 };
const nullableNonempty = { type: ['string', 'null'], minLength: 1 };
const sha256 = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const status = { enum: ['complete', 'empty', 'partial', 'unavailable', 'denied', 'retryable_failure', 'permanent_failure', 'unknown_outcome', 'invalid_not_executed'] };

const bindingProperties = {
  caseId: nonempty,
  runId: nonempty,
  traceId: nonempty,
};

const authorizationScope = {
  type: 'object',
  additionalProperties: false,
  required: ['sessionId', 'actorId', 'tenantId', 'clientId'],
  properties: {
    sessionId: nonempty,
    actorId: nonempty,
    tenantId: nonempty,
    clientId: nullableNonempty,
  },
};

const authRecord = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', ...Object.keys(bindingProperties), 'sessionId'],
  properties: {
    kind: { const: 'auth' },
    ...bindingProperties,
    sessionId: nonempty,
  },
};

const toolRecord = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', ...Object.keys(bindingProperties), 'callId', 'name', 'status', 'sourceIds', 'operationId', 'httpStatus', 'logicalError', 'authorizationScope'],
  properties: {
    kind: { const: 'tool' },
    ...bindingProperties,
    callId: nonempty,
    name: nonempty,
    status,
    sourceIds: { type: 'array', items: nonempty },
    operationId: nullableNonempty,
    httpStatus: { type: ['integer', 'null'], minimum: 100, maximum: 599 },
    logicalError: { type: ['string', 'null'] },
    authorizationScope,
  },
};

const sourceRecord = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', ...Object.keys(bindingProperties), 'sourceId', 'passageSha256', 'toolCallId', 'version', 'locator', 'authorizationScope'],
  properties: {
    kind: { const: 'source' },
    ...bindingProperties,
    sourceId: nonempty,
    passageSha256: sha256,
    toolCallId: nonempty,
    version: nonempty,
    locator: nonempty,
    authorizationScope,
  },
};

const proposalRecord = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', ...Object.keys(bindingProperties), 'proposalId', 'payloadSha256'],
  properties: {
    kind: { const: 'proposal' },
    ...bindingProperties,
    proposalId: nonempty,
    payloadSha256: sha256,
  },
};

const effectRecord = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', ...Object.keys(bindingProperties), 'operationId', 'proposalId', 'receiptId', 'logicalEffectId'],
  properties: {
    kind: { const: 'effect' },
    ...bindingProperties,
    operationId: nonempty,
    proposalId: nonempty,
    receiptId: nonempty,
    logicalEffectId: nonempty,
  },
};

export const traceArtifactSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'captureRunId', 'caseId', 'runId', 'conversationId', 'traceId', 'runtimeMode', 'verificationMode', 'pairId', 'previousTurns', 'injectedFaults', 'transitions', 'streamedClaims', 'records'],
  properties: {
    schemaVersion: { const: 1 },
    captureRunId: nonempty,
    caseId: nonempty,
    runId: nonempty,
    conversationId: nonempty,
    traceId: nonempty,
    runtimeMode: nonempty,
    verificationMode: nonempty,
    pairId: nonempty,
    previousTurns: { type: ['object', 'null'] },
    injectedFaults: { type: 'array', items: { type: 'object' } },
    transitions: { type: 'array', items: nonempty },
    streamedClaims: { type: 'array', items: { type: 'string' } },
    records: {
      type: 'array',
      items: { anyOf: [authRecord, toolRecord, sourceRecord, proposalRecord, effectRecord] },
    },
  },
};

export const sinkArtifactSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'captureRunId', 'caseId', 'runId', 'traceId', 'operationId', 'proposalId', 'payloadSha256', 'filename', 'receipts', 'effects'],
  properties: {
    schemaVersion: { const: 1 },
    captureRunId: nonempty,
    caseId: nonempty,
    runId: nonempty,
    traceId: nonempty,
    operationId: nonempty,
    proposalId: nonempty,
    payloadSha256: sha256,
    filename: nullableNonempty,
    receipts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['receiptId', 'logicalEffectId', 'status'],
        properties: {
          receiptId: nonempty,
          logicalEffectId: nonempty,
          status: nonempty,
        },
      },
    },
    effects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['logicalEffectId', 'type', 'status'],
        properties: {
          logicalEffectId: nonempty,
          type: nonempty,
          status: nonempty,
        },
      },
    },
  },
};

export const authArtifactSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'captureRunId', 'caseId', 'runId', 'traceId', 'sessionId', 'actorId',
    'actorTenantId', 'selectedTenantId', 'selectedClientId', 'currentRoles', 'ethicalWalls', 'issuer',
  ],
  properties: {
    schemaVersion: { const: 1 }, captureRunId: nonempty, caseId: nonempty, runId: nonempty, traceId: nonempty,
    sessionId: nonempty, actorId: nonempty, actorTenantId: nonempty, selectedTenantId: nonempty,
    selectedClientId: nullableNonempty,
    currentRoles: { type: 'array', minItems: 1, items: nonempty },
    ethicalWalls: { type: 'array', items: nonempty }, issuer: nonempty,
  },
};

const uiActionSchema = {
  type: 'object', additionalProperties: false,
  required: ['actionId', 'sequence', 'sessionId', 'route', 'action', 'targetId', 'outcome', 'sourceId', 'proposalId', 'receiptId', 'statusCode', 'state', 'detail'],
  properties: {
    actionId: nonempty, sequence: { type: 'integer', minimum: 1 }, sessionId: nonempty, route: nonempty,
    action: nonempty, targetId: nullableNonempty, outcome: nonempty, sourceId: nullableNonempty,
    proposalId: nullableNonempty, receiptId: nullableNonempty,
    statusCode: { type: ['integer', 'null'], minimum: 100, maximum: 599 },
    state: nullableNonempty, detail: nullableNonempty,
  },
};

export const uiArtifactSchema = {
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'captureRunId', 'caseId', 'runId', 'traceId', 'operationId', 'proposalId', 'route', 'sessionId', 'actorId', 'tenantId', 'clientId', 'actions'],
  properties: {
    schemaVersion: { const: 1 }, captureRunId: nonempty, caseId: nonempty, runId: nonempty, traceId: nonempty,
    operationId: nullableNonempty, proposalId: nullableNonempty, route: nonempty, sessionId: nonempty,
    actorId: nonempty, tenantId: nonempty, clientId: nullableNonempty,
    actions: { type: 'array', minItems: 1, items: uiActionSchema },
  },
};

const sourceBindingSchema = {
  type: 'object', additionalProperties: false,
  required: ['sourceId', 'toolCallId', 'passageSha256', 'version', 'locator'],
  properties: { sourceId: nonempty, toolCallId: nonempty, passageSha256: sha256, version: nonempty, locator: nonempty },
};

const memoryProposalSchema = {
  type: 'object', additionalProperties: false,
  required: ['sourceId', 'proposalId', 'scope', 'clientId', 'provenanceSourceId', 'proposerActorId', 'text', 'textSha256', 'revision', 'priorState', 'state', 'versionId', 'current', 'eligibleForRecall', 'decision', 'receiptId', 'decisionActorId', 'decisionReason'],
  properties: {
    sourceId: nonempty, proposalId: nonempty, scope: { enum: ['client', 'firm', 'private'] },
    clientId: nullableNonempty, provenanceSourceId: nonempty, proposerActorId: nonempty,
    text: nullableNonempty, textSha256: { anyOf: [sha256, { type: 'null' }] },
    revision: { type: ['integer', 'null'], minimum: 1 }, priorState: { type: ['string', 'null'] },
    state: nonempty, versionId: nullableNonempty, current: { type: 'boolean' }, eligibleForRecall: { type: 'boolean' },
    decision: nullableNonempty, receiptId: nullableNonempty, decisionActorId: nullableNonempty, decisionReason: nullableNonempty,
  },
};

const memoryAttemptSchema = {
  type: 'object', additionalProperties: false,
  required: ['attemptId', 'sourceId', 'proposalId', 'toolCallId', 'sessionId', 'requestedDecision', 'actorId', 'authorityRole', 'expectedRevision', 'observedRevision', 'statusCode', 'outcome', 'logicalEffectCount', 'receiptId'],
  properties: {
    attemptId: nonempty, sourceId: nonempty, proposalId: nonempty, toolCallId: nonempty, sessionId: nonempty,
    requestedDecision: { enum: ['approve', 'reject'] }, actorId: nonempty, authorityRole: nonempty,
    expectedRevision: { type: ['integer', 'null'], minimum: 1 }, observedRevision: { type: ['integer', 'null'], minimum: 1 },
    statusCode: { type: 'integer', minimum: 100, maximum: 599 }, outcome: nonempty,
    logicalEffectCount: { type: 'integer', minimum: 0 }, receiptId: nullableNonempty,
  },
};

const memoryRecallSchema = {
  type: 'object', additionalProperties: false,
  required: ['sourceId', 'proposalId', 'versionId', 'textSha256', 'state', 'recalled', 'turnOffset'],
  properties: {
    sourceId: nonempty, proposalId: nonempty, versionId: nullableNonempty,
    textSha256: { anyOf: [sha256, { type: 'null' }] }, state: nonempty,
    recalled: { type: 'boolean' }, turnOffset: { type: 'integer', minimum: 0 },
  },
};

const memoryListSchema = {
  type: 'object', additionalProperties: false,
  required: ['afterReload', 'complete', 'total', 'pageCount', 'nextCursor', 'itemSourceIds'],
  properties: {
    afterReload: { type: 'boolean' }, complete: { type: 'boolean' }, total: { type: 'integer', minimum: 0 },
    pageCount: { type: 'integer', minimum: 1 }, nextCursor: nullableNonempty,
    itemSourceIds: { type: 'array', items: nonempty },
  },
};

const memorySessionSchema = {
  type: 'object', additionalProperties: false,
  required: ['sessionId', 'actorId', 'tenantId', 'clientId', 'currentRoles', 'ethicalWalls'],
  properties: {
    sessionId: nonempty, actorId: nonempty, tenantId: nonempty, clientId: nullableNonempty,
    currentRoles: { type: 'array', minItems: 1, items: nonempty },
    ethicalWalls: { type: 'array', items: nonempty },
  },
};

const memoryEvidenceSchema = {
  type: 'object', additionalProperties: false, required: ['proposals', 'attempts', 'recall', 'list', 'sessions'],
  properties: {
    proposals: { type: 'array', items: memoryProposalSchema }, attempts: { type: 'array', items: memoryAttemptSchema },
    recall: { anyOf: [memoryRecallSchema, { type: 'null' }] }, list: { anyOf: [memoryListSchema, { type: 'null' }] },
    sessions: { type: 'array', minItems: 1, items: memorySessionSchema },
  },
};

const documentSectionSchema = {
  type: 'object', additionalProperties: false,
  required: ['kind', 'locator', 'ordinal', 'text', 'textSha256', 'numericValue', 'cellRef'],
  properties: {
    kind: { enum: ['page', 'slide', 'speaker_notes', 'cell', 'recommendation', 'metadata'] }, locator: nonempty,
    ordinal: { type: 'integer', minimum: 1 }, text: { type: ['string', 'null'] },
    textSha256: { anyOf: [sha256, { type: 'null' }] }, numericValue: { type: ['integer', 'null'] }, cellRef: nullableNonempty,
  },
};

const documentRangeSchema = {
  type: 'object', additionalProperties: false, required: ['start', 'end', 'toolCallId'],
  properties: { start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 }, toolCallId: nonempty },
};

const documentFormatSchema = {
  type: 'object', additionalProperties: false, required: ['authorityClass', 'parser', 'parserVersion', 'result'],
  properties: {
    authorityClass: { enum: ['UNIT_FIXTURE_NOT_LIVE', 'AUTHORITATIVE_CAPTURE'] }, parser: nonempty,
    parserVersion: nonempty, result: { enum: ['valid', 'metadata_only'] },
  },
};

const documentReceiptSchema = {
  type: 'object', additionalProperties: false,
  required: ['sourceId', 'attachmentId', 'toolCallIds', 'mediaType', 'byteSha256', 'readReceiptId', 'sourceVersion', 'current', 'extractionState', 'metadataSha256', 'pageCount', 'readRanges', 'sections', 'format'],
  properties: {
    sourceId: nonempty, attachmentId: nullableNonempty, toolCallIds: { type: 'array', minItems: 1, items: nonempty },
    mediaType: nonempty, byteSha256: { anyOf: [sha256, { type: 'null' }] }, readReceiptId: nonempty,
    sourceVersion: nonempty, current: { type: ['boolean', 'null'] },
    extractionState: { enum: ['complete', 'pending', 'paginated_complete', 'paginated_partial'] },
    metadataSha256: { anyOf: [sha256, { type: 'null' }] }, pageCount: { type: ['integer', 'null'], minimum: 1 },
    readRanges: { type: 'array', items: documentRangeSchema }, sections: { type: 'array', items: documentSectionSchema },
    format: documentFormatSchema,
  },
};

const priorTurnSchema = {
  type: 'object', additionalProperties: false,
  required: ['sourceId', 'conversationId', 'attachmentTurnOffset', 'pointerId', 'pointerSha256', 'compactedBeforePrompt', 'authorizedAtRead', 'cellRange'],
  properties: {
    sourceId: nonempty, conversationId: nonempty, attachmentTurnOffset: { type: 'integer', minimum: 0 },
    pointerId: nonempty, pointerSha256: sha256, compactedBeforePrompt: { type: 'boolean' },
    authorizedAtRead: { type: 'boolean' }, cellRange: nonempty,
  },
};

const accessDecisionSchema = {
  type: 'object', additionalProperties: false,
  required: ['sourceId', 'toolCallId', 'actorId', 'tenantId', 'clientId', 'decision', 'reason', 'returnedDetailHashes'],
  properties: {
    sourceId: nonempty, toolCallId: nonempty, actorId: nonempty, tenantId: nonempty, clientId: nullableNonempty,
    decision: { enum: ['allowed', 'denied'] }, reason: nonempty, returnedDetailHashes: { type: 'array', items: sha256 },
  },
};

const documentEvidenceSchema = {
  type: 'object', additionalProperties: false, required: ['receipts', 'priorTurn', 'accessDecisions'],
  properties: {
    receipts: { type: 'array', items: documentReceiptSchema }, priorTurn: { anyOf: [priorTurnSchema, { type: 'null' }] },
    accessDecisions: { type: 'array', items: accessDecisionSchema },
  },
};

export const acceptanceEvidenceSchema = {
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'kind', 'captureRunId', 'caseId', 'runId', 'traceId', 'sessionId', 'actorId', 'tenantId', 'clientId', 'route', 'authorityClass', 'sourceBindings', 'uiActionIds', 'memory', 'document'],
  properties: {
    schemaVersion: { const: 1 }, kind: { enum: ['memory-workspace-receipt', 'document-read-receipt'] },
    captureRunId: nonempty, caseId: nonempty, runId: nonempty, traceId: nonempty, sessionId: nonempty,
    actorId: nonempty, tenantId: nonempty, clientId: nullableNonempty, route: nullableNonempty,
    authorityClass: { enum: ['UNIT_FIXTURE_NOT_LIVE', 'AUTHORITATIVE_CAPTURE'] },
    sourceBindings: { type: 'array', items: sourceBindingSchema }, uiActionIds: { type: 'array', items: nonempty },
    memory: { anyOf: [memoryEvidenceSchema, { type: 'null' }] }, document: { anyOf: [documentEvidenceSchema, { type: 'null' }] },
  },
};
