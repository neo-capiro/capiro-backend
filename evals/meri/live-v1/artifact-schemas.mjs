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
