import { createHash } from 'node:crypto';
import { frozenFixture } from './fixture.mjs';

export const savedEvidenceCaseIds = Object.freeze([
  '13', '14', '15', '16', '17', '18', '40', '41', '42', '43', '44', '45',
]);

const SAVED_EVIDENCE_CASES = new Set(savedEvidenceCaseIds);
const MEMORY_CASES = new Set(['13', '14', '15', '16', '17', '18']);
const REVIEWER_ROLE = 'institutional_memory_reviewer';

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function folded(value) {
  return String(value ?? '').normalize('NFC').toLocaleLowerCase('en-US').replace(/[’']/gu, "'").replace(/\s+/gu, ' ').trim();
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function same(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function exactSet(values) {
  return [...new Set(values)].sort();
}

function requireValue(defects, condition, message) {
  if (!condition) defects.push(message);
}

function sourceBindingDefects(capture, artifacts, receipt) {
  const defects = [];
  const citations = capture.evidence.sources.citations;
  const expectedIds = exactSet(citations.map((citation) => citation.sourceId));
  const actualIds = exactSet(receipt.sourceBindings.map((binding) => binding.sourceId));
  requireValue(defects, receipt.sourceBindings.length === actualIds.length, 'saved predicate source bindings contain duplicates');
  requireValue(defects, same(actualIds, expectedIds), 'saved predicate source bindings do not match the cited source set');
  for (const binding of receipt.sourceBindings) {
    const citation = citations.find((item) => item.sourceId === binding.sourceId);
    const passage = artifacts.passages.get(binding.sourceId);
    const sourceRecord = artifacts.trace.records.find((record) => record.kind === 'source' && record.sourceId === binding.sourceId);
    requireValue(defects, Boolean(citation && passage && sourceRecord), `saved predicate source binding is incomplete for ${binding.sourceId}`);
    if (!citation || !passage || !sourceRecord) continue;
    requireValue(defects,
      binding.toolCallId === sourceRecord.toolCallId
        && binding.passageSha256 === passage.sha256
        && binding.passageSha256 === citation.passageSha256
        && binding.version === citation.version
        && binding.version === sourceRecord.version
        && binding.locator === citation.locator
        && binding.locator === sourceRecord.locator,
      `saved predicate source binding does not match source/tool/version/hash/locator evidence for ${binding.sourceId}`);
  }
  return defects;
}

function uiActionDefects(capture, artifacts, receipt) {
  const defects = [];
  const allActions = artifacts.ui.flatMap((artifact) => artifact.actions ?? []);
  const actionIds = allActions.map((action) => action.actionId);
  requireValue(defects, actionIds.length === new Set(actionIds).size, 'saved UI action IDs are not unique');
  requireValue(defects, same(actionIds, receipt.uiActionIds), 'saved predicate UI action IDs do not exactly match saved UI artifacts');
  for (const action of allActions) {
    requireValue(defects, action.route === '/meri' && !folded(action.action).includes('settings'), `UI action ${action.actionId} did not remain on the exact /meri route`);
    requireValue(defects, action.sessionId === receipt.sessionId || receipt.memory?.sessions.some((session) => session.sessionId === action.sessionId), `UI action ${action.actionId} is not bound to a captured session`);
  }
  if (capture.evidence.ui.applicable) {
    requireValue(defects, receipt.route === '/meri' && capture.evidence.ui.route === '/meri', 'workspace saved evidence is not bound to the exact /meri route');
  } else {
    requireValue(defects, receipt.route === null && allActions.length === 0 && receipt.uiActionIds.length === 0, 'API saved evidence unexpectedly contains UI actions');
  }
  return defects;
}

function commonDefects(capture, artifacts, receipt, captureRunId) {
  const defects = [];
  const actor = frozenFixture.actors[capture.evidence.auth.actorId];
  if (!receipt) return ['canonical saved predicate artifact is missing'];
  const expectedKind = MEMORY_CASES.has(capture.caseId) ? 'memory-workspace-receipt' : 'document-read-receipt';
  const expected = {
    captureRunId,
    caseId: capture.caseId,
    runId: capture.evidence.run.runId,
    traceId: capture.evidence.run.traceId,
    sessionId: artifacts.auth.sessionId,
    actorId: capture.evidence.auth.actorId,
    tenantId: capture.evidence.auth.selectedTenantId,
    clientId: capture.evidence.auth.selectedClientId,
  };
  requireValue(defects, receipt.kind === expectedKind, `case ${capture.caseId} has the wrong saved predicate artifact kind`);
  for (const [key, value] of Object.entries(expected)) requireValue(defects, receipt[key] === value, `saved predicate ${key} is not bound to capture/auth`);
  requireValue(defects, same(artifacts.auth.currentRoles, actor.currentRoles), 'saved auth current roles do not exactly match the frozen current actor roles');
  requireValue(defects, same(artifacts.auth.ethicalWalls, actor.ethicalWalls), 'saved auth ethical walls do not exactly match the frozen current actor walls');
  requireValue(defects, receipt.authorityClass === 'UNIT_FIXTURE_NOT_LIVE' || receipt.authorityClass === 'AUTHORITATIVE_CAPTURE', 'saved predicate authority class is invalid');
  defects.push(...sourceBindingDefects(capture, artifacts, receipt));
  defects.push(...uiActionDefects(capture, artifacts, receipt));
  return defects;
}

function actionNames(artifacts) {
  return artifacts.ui.flatMap((artifact) => artifact.actions ?? []).sort((left, right) => left.sequence - right.sequence).map((action) => action.action);
}

function requireActions(defects, artifacts, expected) {
  requireValue(defects, same(actionNames(artifacts), expected), `saved UI actions are not the exact ordered contract: ${expected.join(' → ')}`);
}

function proposalBySource(memory, sourceId) {
  return memory.proposals.find((proposal) => proposal.sourceId === sourceId);
}

function validateMemorySessions(defects, receipt) {
  const expectedActor = frozenFixture.actors[receipt.actorId];
  requireValue(defects, receipt.memory.sessions.length === new Set(receipt.memory.sessions.map((session) => session.sessionId)).size, 'memory browser session receipts are not unique');
  for (const session of receipt.memory.sessions) {
    requireValue(defects,
      session.actorId === receipt.actorId
        && session.tenantId === receipt.tenantId
        && session.clientId === receipt.clientId
        && same(session.currentRoles, expectedActor.currentRoles)
        && same(session.ethicalWalls, expectedActor.ethicalWalls),
      `memory session ${session.sessionId} uses a different actor/scope/current-role authority`);
  }
}

function validateAttemptTools(defects, artifacts, memory) {
  for (const attempt of memory.attempts) {
    const tool = artifacts.trace.records.find((record) => record.kind === 'tool' && record.callId === attempt.toolCallId);
    const session = memory.sessions.find((item) => item.sessionId === attempt.sessionId);
    requireValue(defects, Boolean(tool && session), `memory attempt ${attempt.attemptId} lacks a saved tool/session join`);
    if (!tool || !session) continue;
    requireValue(defects,
      tool.sourceIds.length === 1
        && tool.sourceIds[0] === attempt.sourceId
        && tool.authorizationScope.sessionId === attempt.sessionId
        && tool.authorizationScope.actorId === attempt.actorId
        && tool.authorizationScope.tenantId === session.tenantId
        && tool.authorizationScope.clientId === session.clientId,
      `memory attempt ${attempt.attemptId} is not bound to its source/actor/scope/tool call`);
  }
}

function validateProposal(defects, proposal, expected) {
  requireValue(defects, Boolean(proposal), `canonical proposal receipt is missing for ${expected.sourceId}`);
  if (!proposal) return;
  for (const [key, value] of Object.entries(expected)) requireValue(defects, same(proposal[key], value), `proposal ${expected.sourceId} ${key} does not match the frozen contract`);
  if (proposal.text !== null) requireValue(defects, proposal.textSha256 === sha256Text(proposal.text), `proposal ${expected.sourceId} text hash does not match saved text`);
}

function payloadObject(artifacts, defects) {
  if (!artifacts.payload) return null;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(artifacts.payload.bytes));
  } catch {
    defects.push('saved memory payload bytes are not canonical UTF-8 JSON');
    return null;
  }
}

function validateEffectReceipt(defects, artifacts, proposal, expectedKind) {
  const sinkReceipt = artifacts.sink?.receipts.find((item) => item.receiptId === proposal.receiptId);
  const sinkEffect = artifacts.sink?.effects.find((item) => item.logicalEffectId === sinkReceipt?.logicalEffectId);
  requireValue(defects, Boolean(sinkReceipt && sinkEffect), `proposal ${proposal.sourceId} lacks its authoritative sink receipt/effect`);
  if (sinkEffect) requireValue(defects, sinkEffect.type === expectedKind && sinkEffect.status === 'succeeded', `proposal ${proposal.sourceId} sink effect type/status is wrong`);
}

function memoryPredicate(capture, artifacts) {
  const defects = [];
  const memory = artifacts.acceptance?.memory;
  if (!memory) return ['canonical memory state/decision receipt is missing'];
  requireValue(defects, artifacts.acceptance.document === null, 'memory receipt contains document evidence');
  validateMemorySessions(defects, artifacts.acceptance);
  validateAttemptTools(defects, artifacts, memory);
  const id = capture.caseId;
  const source = (sourceId) => frozenFixture.sources[sourceId].facts;
  const textHash = (sourceId) => source(sourceId).proposedText ? sha256Text(source(sourceId).proposedText) : null;
  const proposalId = (sourceId) => `proposal-${id}-${sourceId}`;
  const versionId = (sourceId) => `version-${id}-${sourceId}`;
  const uiActions = {
    '13': ['proposal_submitted', 'memory_review_opened', 'pending_card_observed'],
    '14': ['memory_review_opened', 'approve_clicked', 'decision_receipt_observed', 'next_turn_recall_observed'],
    '15': ['memory_review_opened', 'reject_clicked', 'reload', 'rejected_state_observed', 'recall_absence_observed'],
    '16': ['memory_review_opened', 'approve_clicked', 'authorization_error_observed', 'pending_card_observed'],
    '17': ['reload', 'pending_list_observed'],
    '18': ['conflict_review_opened', 'stale_approve_clicked', 'stale_revision_error_observed', 'current_revision_selected', 'approve_clicked', 'decision_receipt_observed', 'next_turn_recall_observed'],
  };
  requireActions(defects, artifacts, uiActions[id]);

  if (id === '13') {
    const sourceId = 'MEM-PROPOSAL-13';
    const proposal = proposalBySource(memory, sourceId);
    validateProposal(defects, proposal, {
      sourceId, proposalId: proposalId(sourceId), scope: 'client', clientId: 'ASTER', provenanceSourceId: sourceId,
      proposerActorId: 'PAT', text: source(sourceId).proposedText, textSha256: textHash(sourceId), revision: 1,
      priorState: 'absent', state: 'pending', versionId: null, current: false, eligibleForRecall: false,
      decision: null, receiptId: artifacts.sink?.receipts[0]?.receiptId ?? null, decisionActorId: null, decisionReason: null,
    });
    requireValue(defects, memory.proposals.length === 1 && memory.attempts.length === 0 && memory.recall === null, 'case 13 must contain one pending proposal and no decision/recall receipt');
    if (proposal) validateEffectReceipt(defects, artifacts, proposal, 'memory_proposal');
    const payload = payloadObject(artifacts, defects);
    requireValue(defects, same(payload, {
      kind: 'memory_proposal', sourceId, proposalId: proposalId(sourceId), scope: 'client', clientId: 'ASTER',
      proposerActorId: 'PAT', text: source(sourceId).proposedText, textSha256: textHash(sourceId),
    }), 'case 13 actual payload bytes are not the exact pending proposal contract');
  } else if (id === '14') {
    const sourceId = 'MEM-PROPOSAL-14';
    const proposal = proposalBySource(memory, sourceId);
    validateProposal(defects, proposal, {
      sourceId, proposalId: proposalId(sourceId), scope: 'client', clientId: 'ASTER', provenanceSourceId: sourceId,
      proposerActorId: 'PAT', text: source(sourceId).proposedText, textSha256: textHash(sourceId), revision: 1,
      priorState: 'pending', state: 'approved', versionId: versionId(sourceId), current: true, eligibleForRecall: true,
      decision: 'approved', receiptId: artifacts.sink?.receipts[0]?.receiptId ?? null, decisionActorId: 'PRIYA', decisionReason: null,
    });
    const attempt = memory.attempts[0];
    requireValue(defects, memory.attempts.length === 1 && attempt?.requestedDecision === 'approve' && attempt?.actorId === 'PRIYA'
      && attempt?.authorityRole === REVIEWER_ROLE && attempt?.statusCode === 200 && attempt?.outcome === 'approved'
      && attempt?.logicalEffectCount === 1 && attempt?.receiptId === proposal?.receiptId,
    'case 14 lacks one role-authorized, receipt-bound approval attempt');
    requireValue(defects, memory.recall?.sourceId === sourceId && memory.recall?.versionId === proposal?.versionId
      && memory.recall?.textSha256 === textHash(sourceId) && memory.recall?.state === 'approved'
      && memory.recall?.recalled === true && memory.recall?.turnOffset === 1,
    'case 14 next-turn recall is not bound to the approved version/text hash');
    if (proposal) validateEffectReceipt(defects, artifacts, proposal, 'memory_decision');
    const payload = payloadObject(artifacts, defects);
    requireValue(defects, same(payload, {
      kind: 'memory_decision', sourceId, proposalId: proposalId(sourceId), decision: 'approve', expectedRevision: 1,
      actorId: 'PRIYA', authorityRole: REVIEWER_ROLE,
    }), 'case 14 actual payload bytes are not the exact role-bound approval contract');
  } else if (id === '15') {
    const sourceId = 'MEM-PROPOSAL-15';
    const proposal = proposalBySource(memory, sourceId);
    validateProposal(defects, proposal, {
      sourceId, proposalId: proposalId(sourceId), scope: 'client', clientId: 'ASTER', provenanceSourceId: sourceId,
      proposerActorId: 'PAT', text: source(sourceId).proposedText, textSha256: textHash(sourceId), revision: 1,
      priorState: 'pending', state: 'rejected', versionId: null, current: false, eligibleForRecall: false,
      decision: 'rejected', receiptId: artifacts.sink?.receipts[0]?.receiptId ?? null, decisionActorId: 'PRIYA',
      decisionReason: 'the source does not support it',
    });
    const attempt = memory.attempts[0];
    requireValue(defects, memory.attempts.length === 1 && attempt?.requestedDecision === 'reject' && attempt?.authorityRole === REVIEWER_ROLE
      && attempt?.statusCode === 200 && attempt?.outcome === 'rejected' && attempt?.logicalEffectCount === 1
      && attempt?.receiptId === proposal?.receiptId,
    'case 15 lacks one role-authorized, receipt-bound rejection attempt');
    requireValue(defects, memory.recall?.sourceId === sourceId && memory.recall?.recalled === false
      && memory.recall?.state === 'rejected' && memory.recall?.versionId === null,
    'case 15 rejected candidate was not deterministically excluded from recall');
    if (proposal) validateEffectReceipt(defects, artifacts, proposal, 'memory_decision');
    const payload = payloadObject(artifacts, defects);
    requireValue(defects, same(payload, {
      kind: 'memory_decision', sourceId, proposalId: proposalId(sourceId), decision: 'reject', expectedRevision: 1,
      actorId: 'PRIYA', authorityRole: REVIEWER_ROLE,
    }), 'case 15 actual payload bytes are not the exact role-bound rejection contract');
  } else if (id === '16') {
    const sourceId = 'MEM-FIRM-PENDING-16';
    const proposal = proposalBySource(memory, sourceId);
    validateProposal(defects, proposal, {
      sourceId, proposalId: proposalId(sourceId), scope: 'firm', clientId: null, provenanceSourceId: sourceId,
      proposerActorId: 'PRIYA', text: source(sourceId).proposedText, textSha256: textHash(sourceId), revision: 1,
      priorState: 'pending', state: 'pending', versionId: null, current: false, eligibleForRecall: false,
      decision: null, receiptId: null, decisionActorId: null, decisionReason: null,
    });
    const attempt = memory.attempts[0];
    const tool = artifacts.trace.records.find((record) => record.kind === 'tool' && record.callId === attempt?.toolCallId);
    requireValue(defects, same(artifacts.auth.currentRoles, ['ordinary_actor']) && memory.attempts.length === 1
      && attempt?.requestedDecision === 'approve' && attempt?.actorId === 'PAT' && attempt?.authorityRole === 'ordinary_actor'
      && attempt?.statusCode === 403 && attempt?.outcome === 'denied' && attempt?.logicalEffectCount === 0 && attempt?.receiptId === null
      && tool?.status === 'denied',
    'case 16 denial is not bound to Pat’s current non-reviewer role and denied decision call');
    requireValue(defects, artifacts.sink === null && artifacts.payload === null && capture.evidence.effects.observedLogicalEffectCount === 0
      && capture.evidence.effects.receiptIds.length === 0,
    'case 16 unauthorized decision produced a payload, receipt, or logical effect');
  } else if (id === '17') {
    const ids = ['MEM-PENDING-17-A', 'MEM-PENDING-17-B', 'MEM-PENDING-17-C', 'MEM-PENDING-17-D', 'MEM-PENDING-17-E', 'MEM-PENDING-17-F'];
    const scopes = ['client', 'client', 'client', 'client', 'firm', 'private'];
    const clients = ['ASTER', 'ASTER', 'ASTER', 'BLUEHAVEN', null, null];
    ids.forEach((sourceId, index) => validateProposal(defects, proposalBySource(memory, sourceId), {
      sourceId, proposalId: proposalId(sourceId), scope: scopes[index], clientId: clients[index], provenanceSourceId: sourceId,
      proposerActorId: 'PRIYA', text: null, textSha256: null, revision: 1, priorState: 'pending', state: 'pending',
      versionId: null, current: false, eligibleForRecall: false, decision: null, receiptId: null,
      decisionActorId: null, decisionReason: null,
    }));
    requireValue(defects, memory.proposals.length === 6 && same(memory.list, {
      afterReload: true, complete: true, total: 6, pageCount: 1, nextCursor: null, itemSourceIds: ids,
    }), 'case 17 saved reload/list manifest is not exactly the six independent pending proposals');
    requireValue(defects, memory.attempts.length === 0 && memory.recall === null && artifacts.sink === null, 'case 17 read-only listing contains decision/effect evidence');
  } else if (id === '18') {
    const staleId = 'MEM-CONFLICT-18-A';
    const currentId = 'MEM-CONFLICT-18-B';
    const stale = proposalBySource(memory, staleId);
    const current = proposalBySource(memory, currentId);
    validateProposal(defects, stale, {
      sourceId: staleId, proposalId: proposalId(staleId), scope: 'client', clientId: 'ASTER', provenanceSourceId: staleId,
      proposerActorId: 'PAT', text: source(staleId).proposedText, textSha256: textHash(staleId), revision: 1,
      priorState: 'pending', state: 'pending', versionId: null, current: false, eligibleForRecall: false,
      decision: null, receiptId: null, decisionActorId: null, decisionReason: null,
    });
    validateProposal(defects, current, {
      sourceId: currentId, proposalId: proposalId(currentId), scope: 'client', clientId: 'ASTER', provenanceSourceId: currentId,
      proposerActorId: 'PAT', text: source(currentId).proposedText, textSha256: textHash(currentId), revision: 2,
      priorState: 'pending', state: 'approved', versionId: versionId(currentId), current: true, eligibleForRecall: true,
      decision: 'approved', receiptId: artifacts.sink?.receipts[0]?.receiptId ?? null, decisionActorId: 'PRIYA', decisionReason: null,
    });
    const staleAttempt = memory.attempts.find((attempt) => attempt.sourceId === staleId);
    const currentAttempt = memory.attempts.find((attempt) => attempt.sourceId === currentId);
    requireValue(defects, memory.sessions.length === 2 && memory.attempts.length === 2
      && staleAttempt?.expectedRevision === 1 && staleAttempt?.observedRevision === 2 && staleAttempt?.statusCode === 409
      && staleAttempt?.outcome === 'stale_revision' && staleAttempt?.logicalEffectCount === 0 && staleAttempt?.receiptId === null
      && currentAttempt?.expectedRevision === 2 && currentAttempt?.observedRevision === 2 && currentAttempt?.statusCode === 200
      && currentAttempt?.outcome === 'approved' && currentAttempt?.logicalEffectCount === 1 && currentAttempt?.receiptId === current?.receiptId,
    'case 18 does not prove a zero-effect stale rejection plus one receipt-bound current revision approval');
    requireValue(defects, memory.recall?.sourceId === currentId && memory.recall?.versionId === current?.versionId
      && memory.recall?.textSha256 === textHash(currentId) && memory.recall?.recalled === true,
    'case 18 recall does not resolve to the intended current version/hash');
    if (current) validateEffectReceipt(defects, artifacts, current, 'memory_decision');
    const payload = payloadObject(artifacts, defects);
    requireValue(defects, same(payload, {
      kind: 'memory_decision', sourceId: currentId, proposalId: proposalId(currentId), decision: 'approve', expectedRevision: 2,
      actorId: 'PRIYA', authorityRole: REVIEWER_ROLE,
    }), 'case 18 actual payload bytes are not the exact current-revision decision contract');
  }
  return defects;
}

function toolRecord(artifacts, callId) {
  return artifacts.trace.records.find((record) => record.kind === 'tool' && record.callId === callId);
}

function validateDocumentReceipt(capture, artifacts, receipt) {
  const defects = [];
  const download = receipt.attachmentId ? artifacts.downloads.get(receipt.attachmentId) : null;
  const readback = receipt.attachmentId ? artifacts.downloadReceipts.get(receipt.attachmentId) : null;
  if (receipt.attachmentId) {
    requireValue(defects, Boolean(download && readback), `source ${receipt.sourceId} lacks owned source bytes/readback receipt`);
    requireValue(defects, receipt.attachmentId === receipt.sourceId, `source ${receipt.sourceId} attachment ID is not canonical`);
    requireValue(defects, download?.sha256 === receipt.byteSha256 && readback?.byteSha256 === receipt.byteSha256,
      `source ${receipt.sourceId} byte hash is not bound across owned bytes/readback/predicate receipt`);
    requireValue(defects,
      readback?.readReceiptId === receipt.readReceiptId
        && readback?.sourceId === receipt.sourceId
        && readback?.attachmentId === receipt.attachmentId
        && readback?.mediaType === receipt.mediaType
        && readback?.sourceVersion === receipt.sourceVersion
        && readback?.parser === receipt.format.parser
        && readback?.parserVersion === receipt.format.parserVersion
        && readback?.result === receipt.format.result
        && readback?.authorizationScope?.sessionId === artifacts.auth.sessionId
        && readback?.authorizationScope?.actorId === artifacts.auth.actorId
        && readback?.authorizationScope?.tenantId === artifacts.auth.selectedTenantId
        && readback?.authorizationScope?.clientId === artifacts.auth.selectedClientId,
      `source ${receipt.sourceId} canonical byte/read receipt metadata is not joined`);
  } else {
    requireValue(defects, receipt.byteSha256 === null, `metadata-only source ${receipt.sourceId} unexpectedly claims file bytes`);
  }
  for (const callId of receipt.toolCallIds) {
    const tool = toolRecord(artifacts, callId);
    requireValue(defects, Boolean(tool?.sourceIds.includes(receipt.sourceId)), `source ${receipt.sourceId} read range references an unbound source call ${callId}`);
  }
  requireValue(defects, receipt.format.authorityClass === artifacts.acceptance.authorityClass, `source ${receipt.sourceId} format/read authority class is inconsistent`);
  for (const section of receipt.sections) {
    if (section.text !== null) requireValue(defects, section.textSha256 === sha256Text(section.text), `source ${receipt.sourceId} ${section.locator} extracted text hash is wrong`);
    else requireValue(defects, section.textSha256 === null, `source ${receipt.sourceId} ${section.locator} has a hash without text`);
  }
  return defects;
}

function exactCoverage(ranges, pageCount) {
  const pages = [];
  for (const range of ranges) {
    if (range.end < range.start) return false;
    for (let page = range.start; page <= range.end; page += 1) pages.push(page);
  }
  return same(pages, Array.from({ length: pageCount }, (_, index) => index + 1));
}

function documentPredicate(capture, artifacts) {
  const defects = [];
  const document = artifacts.acceptance?.document;
  if (!document) return ['canonical document byte/cell/section receipt is missing'];
  requireValue(defects, artifacts.acceptance.memory === null, 'document receipt contains memory evidence');
  document.receipts.forEach((receipt) => defects.push(...validateDocumentReceipt(capture, artifacts, receipt)));
  const receipt = (sourceId) => document.receipts.find((item) => item.sourceId === sourceId);
  const section = (sourceId, kind) => receipt(sourceId)?.sections.filter((item) => item.kind === kind) ?? [];
  const answer = folded(artifacts.answer.text);
  const id = capture.caseId;

  if (id === '40') {
    const value = receipt('D-A-1');
    const pages = section('D-A-1', 'page');
    requireValue(defects, document.receipts.length === 1 && value?.mediaType === 'application/pdf' && value?.extractionState === 'complete'
      && value?.format.result === 'valid' && value?.readRanges.some((range) => range.start <= 4 && range.end >= 4),
    'case 40 lacks an authoritative PDF byte/read receipt covering page 4');
    requireValue(defects, pages.length === 1 && pages[0].locator === 'page:4' && pages[0].ordinal === 4
      && pages[0].text === frozenFixture.sources['D-A-1'].facts.passage,
    'case 40 saved page-4 extracted fact does not match the frozen passage');
    requireValue(defects, answer.includes('unmanned maritime sensors') && answer.includes('page 4') && answer.includes('d-a-1'),
      'case 40 answer does not faithfully identify D-A-1 page 4 and the seeded capability');
  } else if (id === '41') {
    const value = receipt('DECK-A-1');
    const slides = section('DECK-A-1', 'slide');
    const notes = section('DECK-A-1', 'speaker_notes');
    requireValue(defects, value?.mediaType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      && value?.format.result === 'valid' && value?.extractionState === 'complete',
    'case 41 lacks an authoritative PPTX byte/slide receipt');
    requireValue(defects, slides.length === 1 && slides[0].locator === 'slide:6' && slides[0].ordinal === 6
      && slides[0].text === frozenFixture.sources['DECK-A-1'].facts.slideText
      && notes.length === 1 && notes[0].locator === 'slide:6:notes'
      && notes[0].text === frozenFixture.sources['DECK-A-1'].facts.speakerNotes,
    'case 41 slide 6 text/notes receipts do not match the frozen distinct facts');
    requireValue(defects, answer.includes('autonomy evaluation') && answer.includes('demo risk') && answer.includes('notes'),
      'case 41 answer does not distinguish slide text from speaker notes');
    requireActions(defects, artifacts, ['uploaded_deck_opened', 'slide_6_read']);
  } else if (id === '42') {
    const value = receipt('SHEET-A-1');
    const cells = section('SHEET-A-1', 'cell');
    const prior = document.priorTurn;
    requireValue(defects, value?.mediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      && value?.format.result === 'valid' && value?.extractionState === 'complete',
    'case 42 lacks an authoritative XLSX byte/cell receipt');
    requireValue(defects, same(cells.map((item) => ({ cellRef: item.cellRef, value: item.numericValue })), [
      { cellRef: 'A1', value: 6178000 }, { cellRef: 'A2', value: 2811000 },
    ]), 'case 42 saved cells/order do not match the frozen spreadsheet values');
    const total = cells.reduce((sum, item) => sum + item.numericValue, 0);
    requireValue(defects, total === frozenFixture.sources['SHEET-A-1'].facts.total && answer.includes('8,989,000'),
      'case 42 result is not computed from the two saved cell receipts');
    requireValue(defects, prior?.sourceId === 'SHEET-A-1' && prior?.conversationId === capture.evidence.run.conversationId
      && prior?.attachmentTurnOffset === 3 && prior?.compactedBeforePrompt === true && prior?.authorizedAtRead === true
      && prior?.cellRange === 'A1:A2' && prior?.pointerSha256 === value?.byteSha256,
    'case 42 prior-turn pointer/compaction/auth/range is not bound to the saved spreadsheet bytes');
    requireActions(defects, artifacts, ['prior_turn_pointer_resolved', 'spreadsheet_cells_read']);
  } else if (id === '43') {
    const allowed = receipt('D-A-1');
    const denial = document.accessDecisions.find((item) => item.sourceId === 'FILE-B-1');
    const deniedTool = toolRecord(artifacts, denial?.toolCallId);
    requireValue(defects, allowed?.format.result === 'valid' && allowed?.byteSha256 !== null, 'case 43 lacks authorized Aster file byte/read evidence');
    requireValue(defects, denial?.actorId === 'PAT' && denial?.tenantId === 'T1' && denial?.clientId === 'BLUEHAVEN'
      && denial?.decision === 'denied' && denial?.returnedDetailHashes.length === 0
      && deniedTool?.status === 'denied' && deniedTool?.sourceIds.includes('FILE-B-1'),
    'case 43 Bluehaven denial is not bound to Pat/source/call with zero returned details');
    requireValue(defects, !artifacts.acceptance.sourceBindings.some((binding) => binding.sourceId === 'FILE-B-1')
      && !artifacts.downloads.has('FILE-B-1') && /(access|permission|scope|authorized)/u.test(answer),
    'case 43 leaked Bluehaven details or omitted the truthful access limitation');
    requireActions(defects, artifacts, ['compare_requested', 'restricted_file_denial_observed']);
  } else if (id === '44') {
    const value = receipt('PDF-PENDING-1');
    const facts = frozenFixture.sources['PDF-PENDING-1'].facts;
    requireValue(defects, value?.attachmentId === null && value?.byteSha256 === null && value?.format.result === 'metadata_only'
      && value?.extractionState === facts.extraction && value?.metadataSha256 !== null && value?.sections.length === 0,
    'case 44 lacks a metadata-only pending extraction receipt with no invented content sections');
    requireValue(defects, capture.evidence.status.terminal === 'partial' && capture.evidence.sources.coverage === 'partial'
      && answer.includes('pending') && /(retry|try again)/u.test(answer) && !answer.includes('conclude'),
    'case 44 does not preserve pending/partial state and a usable retry path without a conclusion');
    requireActions(defects, artifacts, ['pending_metadata_observed', 'retry_path_shown']);
  } else if (id === '45') {
    const value = receipt('REPORT-A-v2');
    const recommendations = section('REPORT-A-v2', 'recommendation');
    requireValue(defects, value?.sourceVersion === frozenFixture.sources['REPORT-A-v2'].facts.version && value?.current === true
      && value?.pageCount === 80 && value?.format.result === 'valid'
      && !document.receipts.some((item) => item.sourceId === 'REPORT-A-v1'),
    'case 45 is not bound to the current v2 80-page report bytes/manifest');
    if (capture.evidence.status.terminal === 'complete') {
      requireValue(defects, value?.extractionState === 'paginated_complete' && exactCoverage(value?.readRanges ?? [], 80),
        'case 45 complete claim lacks exact ordered page 1–80 range coverage');
      requireValue(defects, same(recommendations.map((item) => item.text), frozenFixture.sources['REPORT-A-v2'].facts.recommendations)
        && recommendations.every((item, index) => item.ordinal === index + 1),
      'case 45 recommendation receipts do not match the frozen current-version order');
      for (const recommendation of frozenFixture.sources['REPORT-A-v2'].facts.recommendations) {
        requireValue(defects, answer.includes(folded(recommendation)), `case 45 answer omits saved recommendation: ${recommendation}`);
      }
    } else {
      requireValue(defects, capture.evidence.status.terminal === 'partial' && value?.extractionState === 'paginated_partial'
        && !exactCoverage(value?.readRanges ?? [], 80) && /(incomplete|remaining|partial)/u.test(answer)
        && !/(every|all recommendations)/u.test(answer),
      'case 45 partial branch overclaims completeness or lacks bounded incomplete pagination evidence');
    }
    requireActions(defects, artifacts, ['current_version_selected', 'initial_page_range_read', 'remaining_page_ranges_read', 'recommendations_rendered']);
  }
  return defects;
}

export function evaluateSavedEvidenceCase(capture, artifacts, captureRunId) {
  if (!SAVED_EVIDENCE_CASES.has(capture.caseId)) return [];
  const defects = commonDefects(capture, artifacts, artifacts.acceptance, captureRunId);
  if (!artifacts.acceptance) return defects;
  defects.push(...(MEMORY_CASES.has(capture.caseId) ? memoryPredicate(capture, artifacts) : documentPredicate(capture, artifacts)));
  return defects;
}
