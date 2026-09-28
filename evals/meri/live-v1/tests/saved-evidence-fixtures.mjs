import { createHash } from 'node:crypto';
import { frozenFixture } from '../fixture.mjs';

export const savedEvidenceIds = new Set(['13', '14', '15', '16', '17', '18', '40', '41', '42', '43', '44', '45']);

const uiActionNames = {
  '13': ['proposal_submitted', 'memory_review_opened', 'pending_card_observed'],
  '14': ['memory_review_opened', 'approve_clicked', 'decision_receipt_observed', 'next_turn_recall_observed'],
  '15': ['memory_review_opened', 'reject_clicked', 'reload', 'rejected_state_observed', 'recall_absence_observed'],
  '16': ['memory_review_opened', 'approve_clicked', 'authorization_error_observed', 'pending_card_observed'],
  '17': ['reload', 'pending_list_observed'],
  '18': ['conflict_review_opened', 'stale_approve_clicked', 'stale_revision_error_observed', 'current_revision_selected', 'approve_clicked', 'decision_receipt_observed', 'next_turn_recall_observed'],
  '41': ['uploaded_deck_opened', 'slide_6_read'],
  '42': ['prior_turn_pointer_resolved', 'spreadsheet_cells_read'],
  '43': ['compare_requested', 'restricted_file_denial_observed'],
  '44': ['pending_metadata_observed', 'retry_path_shown'],
  '45': ['current_version_selected', 'initial_page_range_read', 'remaining_page_ranges_read', 'recommendations_rendered'],
};

function sha(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function proposalId(id, sourceId) {
  return `proposal-${id}-${sourceId}`;
}

function versionId(id, sourceId) {
  return `version-${id}-${sourceId}`;
}

function sourceText(sourceId) {
  return frozenFixture.sources[sourceId].facts.proposedText ?? null;
}

function proposal(id, sourceId, overrides = {}) {
  const fixture = frozenFixture.sources[sourceId];
  const text = sourceText(sourceId);
  return {
    sourceId,
    proposalId: proposalId(id, sourceId),
    scope: fixture.facts.scope ?? (fixture.clientId ? 'client' : 'firm'),
    clientId: fixture.clientId,
    provenanceSourceId: sourceId,
    proposerActorId: id === '17' ? 'PRIYA' : id === '16' ? 'PRIYA' : 'PAT',
    text,
    textSha256: text === null ? null : sha(text),
    revision: fixture.facts.revision ?? 1,
    priorState: fixture.facts.initialState,
    state: fixture.facts.initialState,
    versionId: null,
    current: false,
    eligibleForRecall: false,
    decision: null,
    receiptId: null,
    decisionActorId: null,
    decisionReason: null,
    ...overrides,
  };
}

function attempt(context, sourceId, suffix, overrides) {
  return {
    attemptId: `attempt-${context.suffix}-${suffix}`,
    sourceId,
    proposalId: proposalId(context.id, sourceId),
    toolCallId: `action-${context.suffix}-${suffix}`,
    sessionId: context.sessionId,
    requestedDecision: 'approve',
    actorId: context.actorId,
    authorityRole: context.roles.at(-1),
    expectedRevision: 1,
    observedRevision: 1,
    statusCode: 200,
    outcome: 'approved',
    logicalEffectCount: 1,
    receiptId: context.receiptId,
    ...overrides,
  };
}

export function savedPayloadValue(context) {
  const { id } = context;
  if (id === '13') {
    const sourceId = 'MEM-PROPOSAL-13';
    const text = sourceText(sourceId);
    return { kind: 'memory_proposal', sourceId, proposalId: proposalId(id, sourceId), scope: 'client', clientId: 'ASTER', proposerActorId: 'PAT', text, textSha256: sha(text) };
  }
  const sourceById = { '14': 'MEM-PROPOSAL-14', '15': 'MEM-PROPOSAL-15', '18': 'MEM-CONFLICT-18-B' };
  const sourceId = sourceById[id];
  if (!sourceId) return null;
  return {
    kind: 'memory_decision',
    sourceId,
    proposalId: proposalId(id, sourceId),
    decision: id === '15' ? 'reject' : 'approve',
    expectedRevision: frozenFixture.sources[sourceId].facts.revision ?? 1,
    actorId: 'PRIYA',
    authorityRole: 'institutional_memory_reviewer',
  };
}

export function savedExtraToolSpecs(context) {
  const values = [];
  const add = (suffix, sourceId, status = 'complete', httpStatus = 200, logicalError = null) => values.push({
    callId: `action-${context.suffix}-${suffix}`,
    name: `controlled-${suffix}`,
    status,
    sourceIds: [sourceId],
    operationId: context.operationId,
    httpStatus,
    logicalError,
  });
  if (context.id === '14') add('approve', 'MEM-PROPOSAL-14');
  if (context.id === '15') add('reject', 'MEM-PROPOSAL-15');
  if (context.id === '16') add('approve', 'MEM-FIRM-PENDING-16', 'denied', 403, 'reviewer role required');
  if (context.id === '18') {
    add('stale', 'MEM-CONFLICT-18-A', 'complete', 409, 'stale revision');
    values.at(-1).authorizationSessionId = `${context.sessionId}-secondary`;
    add('current', 'MEM-CONFLICT-18-B');
  }
  if (context.id === '43') add('restricted', 'FILE-B-1', 'denied', 403, 'client scope denied');
  if (context.id === '45') {
    add('pages-21-40', 'REPORT-A-v2');
    add('pages-41-60', 'REPORT-A-v2');
    add('pages-61-80', 'REPORT-A-v2');
  }
  return values;
}

export function savedUiActions(context) {
  const names = uiActionNames[context.id] ?? ['controlled_unit_ui_observed'];
  return names.map((action, index) => {
    const stale = context.id === '18' && ['stale_approve_clicked', 'stale_revision_error_observed'].includes(action);
    const denied = ['authorization_error_observed', 'restricted_file_denial_observed'].includes(action);
    const receiptAction = action === 'decision_receipt_observed';
    const sourceId = context.id === '18'
      ? (stale ? 'MEM-CONFLICT-18-A' : 'MEM-CONFLICT-18-B')
      : context.sourceIds[0] ?? null;
    return {
      actionId: `ui-${context.suffix}-${index + 1}`,
      sequence: index + 1,
      sessionId: stale ? `${context.sessionId}-secondary` : context.sessionId,
      route: '/meri',
      action,
      targetId: sourceId,
      outcome: denied || action.includes('error') ? 'denied' : 'observed',
      sourceId,
      proposalId: context.hasEffect || ['16', '18'].includes(context.id) ? proposalId(context.id, sourceId) : null,
      receiptId: receiptAction ? context.receiptId : null,
      statusCode: denied ? 403 : action === 'stale_revision_error_observed' ? 409 : null,
      state: action.includes('pending') ? 'pending' : action.includes('rejected') ? 'rejected' : null,
      detail: action === 'authorization_error_observed' ? 'reviewer role required' : null,
    };
  });
}

export function documentAttachmentSpec(id) {
  const values = {
    '40': ['D-A-1', 'application/pdf', 'controlled-pdf-reader'],
    '41': ['DECK-A-1', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'controlled-ooxml-reader'],
    '42': ['SHEET-A-1', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'controlled-ooxml-reader'],
    '43': ['D-A-1', 'application/pdf', 'controlled-pdf-reader'],
    '45': ['REPORT-A-v2', 'application/pdf', 'controlled-pdf-reader'],
  };
  const value = values[id];
  if (!value) return null;
  const [sourceId, mediaType, parser] = value;
  return {
    sourceId,
    mediaType,
    parser,
    parserVersion: 'unit-1',
    sourceVersion: id === '45' ? 'v2' : 'controlled-unit-v1',
    bytes: Buffer.from(`UNIT_FIXTURE_NOT_LIVE\n${sourceId}\n${JSON.stringify(frozenFixture.sources[sourceId].facts)}\n`, 'utf8'),
  };
}

function section(kind, locator, ordinal, text = null, numericValue = null, cellRef = null) {
  return { kind, locator, ordinal, text, textSha256: text === null ? null : sha(text), numericValue, cellRef };
}

function documentReceipt(context, attachment) {
  const sourceId = context.id === '44' ? 'PDF-PENDING-1' : attachment.sourceId;
  const baseCall = context.sourceBindings.find((binding) => binding.sourceId === sourceId).toolCallId;
  const base = {
    sourceId,
    attachmentId: attachment?.sourceId ?? null,
    toolCallIds: [baseCall],
    mediaType: attachment?.mediaType ?? 'application/pdf',
    byteSha256: attachment?.byteSha256 ?? null,
    readReceiptId: attachment?.readReceiptId ?? `metadata-receipt-${context.suffix}`,
    sourceVersion: attachment?.sourceVersion ?? 'controlled-unit-v1',
    current: null,
    extractionState: 'complete',
    metadataSha256: null,
    pageCount: null,
    readRanges: [],
    sections: [],
    format: {
      authorityClass: 'UNIT_FIXTURE_NOT_LIVE',
      parser: attachment?.parser ?? 'controlled-metadata-reader',
      parserVersion: attachment?.parserVersion ?? 'unit-1',
      result: attachment ? 'valid' : 'metadata_only',
    },
  };
  if (context.id === '40' || context.id === '43') {
    base.readRanges = [{ start: 4, end: 4, toolCallId: baseCall }];
    base.sections = [section('page', 'page:4', 4, frozenFixture.sources['D-A-1'].facts.passage)];
  } else if (context.id === '41') {
    const facts = frozenFixture.sources['DECK-A-1'].facts;
    base.readRanges = [{ start: 6, end: 6, toolCallId: baseCall }];
    base.sections = [section('slide', 'slide:6', 6, facts.slideText), section('speaker_notes', 'slide:6:notes', 6, facts.speakerNotes)];
  } else if (context.id === '42') {
    const facts = frozenFixture.sources['SHEET-A-1'].facts;
    base.readRanges = [{ start: 1, end: 2, toolCallId: baseCall }];
    base.sections = [section('cell', 'cell:A1', 1, String(facts.cells[0]), facts.cells[0], 'A1'), section('cell', 'cell:A2', 2, String(facts.cells[1]), facts.cells[1], 'A2')];
  } else if (context.id === '44') {
    base.extractionState = 'pending';
    base.metadataSha256 = sha('PDF-PENDING-1:metadata:extraction=pending');
  } else if (context.id === '45') {
    const extras = ['pages-21-40', 'pages-41-60', 'pages-61-80'].map((suffix) => `action-${context.suffix}-${suffix}`);
    base.toolCallIds.push(...extras);
    base.current = true;
    base.extractionState = 'paginated_complete';
    base.pageCount = 80;
    base.readRanges = [
      { start: 1, end: 20, toolCallId: baseCall },
      { start: 21, end: 40, toolCallId: extras[0] },
      { start: 41, end: 60, toolCallId: extras[1] },
      { start: 61, end: 80, toolCallId: extras[2] },
    ];
    base.sections = frozenFixture.sources['REPORT-A-v2'].facts.recommendations.map((text, index) => section('recommendation', `recommendation:${index + 1}`, index + 1, text));
  }
  return base;
}

function memoryEvidence(context) {
  const session = {
    sessionId: context.sessionId, actorId: context.actorId, tenantId: context.tenantId,
    clientId: context.clientId, currentRoles: context.roles, ethicalWalls: context.ethicalWalls,
  };
  if (context.id === '13') {
    const sourceId = 'MEM-PROPOSAL-13';
    return { proposals: [proposal(context.id, sourceId, { state: 'pending', receiptId: context.receiptId })], attempts: [], recall: null, list: null, sessions: [session] };
  }
  if (context.id === '14') {
    const sourceId = 'MEM-PROPOSAL-14';
    const value = proposal(context.id, sourceId, { state: 'approved', versionId: versionId(context.id, sourceId), current: true, eligibleForRecall: true, decision: 'approved', receiptId: context.receiptId, decisionActorId: 'PRIYA' });
    return {
      proposals: [value],
      attempts: [attempt(context, sourceId, 'approve', {})],
      recall: { sourceId, proposalId: value.proposalId, versionId: value.versionId, textSha256: value.textSha256, state: 'approved', recalled: true, turnOffset: 1 },
      list: null, sessions: [session],
    };
  }
  if (context.id === '15') {
    const sourceId = 'MEM-PROPOSAL-15';
    const value = proposal(context.id, sourceId, { state: 'rejected', decision: 'rejected', receiptId: context.receiptId, decisionActorId: 'PRIYA', decisionReason: 'the source does not support it' });
    return {
      proposals: [value],
      attempts: [attempt(context, sourceId, 'reject', { requestedDecision: 'reject', outcome: 'rejected' })],
      recall: { sourceId, proposalId: value.proposalId, versionId: null, textSha256: value.textSha256, state: 'rejected', recalled: false, turnOffset: 1 },
      list: null, sessions: [session],
    };
  }
  if (context.id === '16') {
    const sourceId = 'MEM-FIRM-PENDING-16';
    return {
      proposals: [proposal(context.id, sourceId)],
      attempts: [attempt(context, sourceId, 'approve', { authorityRole: 'ordinary_actor', statusCode: 403, outcome: 'denied', logicalEffectCount: 0, receiptId: null })],
      recall: null, list: null, sessions: [session],
    };
  }
  if (context.id === '17') {
    const ids = ['MEM-PENDING-17-A', 'MEM-PENDING-17-B', 'MEM-PENDING-17-C', 'MEM-PENDING-17-D', 'MEM-PENDING-17-E', 'MEM-PENDING-17-F'];
    const proposals = ids.map((sourceId) => proposal(context.id, sourceId, {
      scope: sourceId.endsWith('-E') ? 'firm' : sourceId.endsWith('-F') ? 'private' : 'client',
    }));
    return { proposals, attempts: [], recall: null, list: { afterReload: true, complete: true, total: 6, pageCount: 1, nextCursor: null, itemSourceIds: ids }, sessions: [session] };
  }
  const staleId = 'MEM-CONFLICT-18-A';
  const currentId = 'MEM-CONFLICT-18-B';
  const current = proposal(context.id, currentId, { state: 'approved', versionId: versionId(context.id, currentId), current: true, eligibleForRecall: true, decision: 'approved', receiptId: context.receiptId, decisionActorId: 'PRIYA' });
  return {
    proposals: [proposal(context.id, staleId), current],
    attempts: [
      attempt(context, staleId, 'stale', { sessionId: `${context.sessionId}-secondary`, expectedRevision: 1, observedRevision: 2, statusCode: 409, outcome: 'stale_revision', logicalEffectCount: 0, receiptId: null }),
      attempt(context, currentId, 'current', { expectedRevision: 2, observedRevision: 2 }),
    ],
    recall: { sourceId: currentId, proposalId: current.proposalId, versionId: current.versionId, textSha256: current.textSha256, state: 'approved', recalled: true, turnOffset: 1 },
    list: null,
    sessions: [session, { ...session, sessionId: `${context.sessionId}-secondary` }],
  };
}

export function savedAcceptanceValue(context, attachment) {
  const uiActionIds = context.uiActions.map((action) => action.actionId);
  const common = {
    schemaVersion: 1,
    kind: ['13', '14', '15', '16', '17', '18'].includes(context.id) ? 'memory-workspace-receipt' : 'document-read-receipt',
    captureRunId: context.captureRunId,
    caseId: context.id,
    runId: context.runId,
    traceId: context.traceId,
    sessionId: context.sessionId,
    actorId: context.actorId,
    tenantId: context.tenantId,
    clientId: context.clientId,
    route: context.id === '40' ? null : '/meri',
    authorityClass: 'UNIT_FIXTURE_NOT_LIVE',
    sourceBindings: context.sourceBindings,
    uiActionIds,
  };
  if (common.kind === 'memory-workspace-receipt') return { ...common, memory: memoryEvidence(context), document: null };
  const sourceReceipt = documentReceipt(context, attachment);
  const priorTurn = context.id === '42' ? {
    sourceId: 'SHEET-A-1', conversationId: context.conversationId, attachmentTurnOffset: 3,
    pointerId: `pointer-${context.suffix}`, pointerSha256: attachment.byteSha256,
    compactedBeforePrompt: true, authorizedAtRead: true, cellRange: 'A1:A2',
  } : null;
  const accessDecisions = context.id === '43' ? [{
    sourceId: 'FILE-B-1', toolCallId: `action-${context.suffix}-restricted`, actorId: 'PAT', tenantId: 'T1',
    clientId: 'BLUEHAVEN', decision: 'denied', reason: 'client scope denied', returnedDetailHashes: [],
  }] : [];
  return { ...common, memory: null, document: { receipts: [sourceReceipt], priorTurn, accessDecisions } };
}
