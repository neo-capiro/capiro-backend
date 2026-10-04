import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const CD_CASE_IDS = Object.freeze(['CD-01', 'CD-02', 'CD-03', 'CD-04', 'CD-05', 'CD-06', 'CD-07']);
const SOURCES = ['meeting', 'mail', 'debrief', 'native_tasks', 'action_items', 'monday'];
const STATUSES = ['completed', 'in progress', 'no record of action'];
const MONDAY_STATES = ['checked', 'disconnected', 'unavailable', 'not mapped', 'partial'];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o ?? {}, k);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = v => typeof v === 'string' && v.trim().length > 0;

// Supervisor follow-on: explicit observation completeness and original CD fixture joins.
// These checks validate recorded data; they never authenticate its provenance.
function strictChecks(id, o, f) {
  const need = (condition, message) => { if (!condition) f.push(message); };
  const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/.test(value) && Number.isFinite(Date.parse(value)) && (value.length === 10 ? new Date(value).toISOString().slice(0,10) === value : new Date(value).toISOString() === value);
  need(Array.isArray(o.effects) && o.effects.length === 0, 'explicit zero audit effects required');
  need(date(o.frozenNow), 'recorded frozen benchmark clock required');
  need(typeof o.documentsAvailable === 'boolean', 'relevant document availability must be recorded');
  need(o.documentsAvailable === false || o.documentsCoverage?.state === 'checked' || o.documentsCoverage?.state === 'unavailable' || o.documentsCoverage?.state === 'partial', 'available relevant documents need explicit coverage');
  need(['checked', 'disconnected', 'unavailable', 'not mapped'].includes(o.mondayStatus), 'exact Monday answer status required; partial belongs in pagination receipt');
  const monday = o.coverage.find(c => c.source === 'monday');
  const answerState = { checked: 'checked', partial: 'checked', disconnected: 'disconnected', unavailable: 'unavailable', denied: 'unavailable', not_mapped: 'not mapped' }[monday?.state];
  need(o.mondayStatus === answerState, 'Monday answer status must agree with adapter receipt');
  for (const c of o.coverage) {
    need(Number.isSafeInteger(c.pagesRead) && Number.isSafeInteger(c.pagesTotal), 'page counts must be safe integers');
    need(nonempty(c.stopReason), `source ${c.source} stop reason required`);
    if (c.state === 'checked') need(c.pagesRead > 0, 'checked coverage requires an actual source response');
    if (['denied','disconnected','unavailable','not_mapped'].includes(c.state)) need(c.pagesRead === 0, 'unread source cannot claim successful pages');
  }
  const safe = x => isObj(x) && x.tenantId === o.scope?.tenantId && x.clientId === o.scope?.clientId && x.authorized === true && x.personal === false && x.ethicalWall === false;
  for (const item of o.commitments) {
    need(date(item.madeAt), 'commitment date must be a recorded valid date');
    need(item.ownerState !== 'unknown' || item.owner === 'unknown', 'unknown owner must stay explicit unknown');
    need(item.dueDateState !== 'unknown' || item.dueDate === 'unknown', 'unknown date must stay explicit unknown');
    need(item.dueDateState !== 'evidenced' || date(item.dueDate), 'evidenced due date must be valid');
    need(item.classification === 'promise', 'only evidenced promises can be commitments');
    for (const citation of item.citations) need(safe(citation) && nonempty(citation.sourceVersion), 'citation needs exact tenant/client, access and source version');
    if (item.status === 'completed') {
      const delivery = item.deliveredArtifact || item.acceptanceEvidence;
      need(nonempty(delivery) && item.citations.some(c => c.locator === delivery && ['delivered_artifact','acceptance'].includes(c.evidenceKind)), 'completion must join a cited delivery/acceptance locator');
    }
    if (item.status === 'in progress') need(item.citations.some(c => c.evidenceKind === 'active_task'), 'in progress requires cited active task evidence');
  }
  need(Array.isArray(o.userVisibleTrace) && o.userVisibleTrace.every(safe), 'user-visible trace must be explicitly scoped and authorized');
  need(Array.isArray(o.suggestions) && o.suggestions.every(safe), 'suggestions must be explicitly scoped and authorized');
  if (id === 'CD-01') {
    const l = o.launcher;
    need(l?.skillName === 'Commitments & Deliverables' && l?.telemetrySkillId === 'commitments_audit', 'CD-01 exact visible label and skill telemetry required');
    need(l?.clientSelectionRequested === true && l?.sentBeforeClientSelection === false && l?.executedBeforeClientSelection === false && l?.selectionMarkedComplete === false, 'CD-01 client gate must precede send/execution and selection is not completed audit');
    need(Array.isArray(l?.permittedScopes) && l.permittedScopes.length === 2 && new Set(l.permittedScopes).size === 2, 'CD-01 exact general/client scope set required');
    need(nonempty(l?.recipeId) && Number.isSafeInteger(l?.recipeVersion) && l.recipeVersion > 0, 'CD-01 effective recipe/version required');
  }
  if (id === 'CD-02') {
    const item = o.commitments[0];
    need(o.commitments.length === 1 && item?.owner === 'Pat' && item?.dueDate === '2026-10-08', 'CD-02 exact one Pat/October8 promise required');
    need(item && Date.parse(o.frozenNow) - Date.parse(item.madeAt) > 7 * 86400000, 'CD-02 older promise must actually predate clock by more than seven days');
    need(item?.citations.some(c => c.source === 'mail') && item?.citations.some(c => c.source === 'debrief'), 'CD-02 mail and debrief corroboration citations required');
    need(o.suggestionAssertedAsObligation === false && o.taskCreated === false && o.untrackedPromiseFlagged === true, 'CD-02 explicit suggestion exclusion, zero task creation, untracked flag required');
  }
  if (id === 'CD-03') {
    need(o.claimsExhaustive === false && o.claimsAbsence === false && o.coverageLimitsReported === true, 'CD-03 explicit coverage limits and non-exhaustiveness required');
    need(o.traceOutcomes?.mail === 'denied' && o.traceOutcomes?.monday === 'unavailable' && o.traceOutcomes?.native_tasks === 'partial', 'CD-03 trace must match denied/partial read outcomes');
  }
  if (id === 'CD-04') {
    const item = o.commitments[0];
    need(o.commitments.length === 1, 'CD-04 repeated fixture sources must reconcile into one commitment');
    need(o.excludedEvidenceCited === false && o.excludedEvidenceInTrace === false && o.duplicateTaskProposed === false, 'CD-04 explicit scope exclusion and no duplicate task proposal required');
    need(item?.citations.some(c => c.source === 'monday' && c.recordId === item.existingRecordId), 'CD-04 existing record ID must join authorized Monday citation');
  }
  if (id === 'CD-05') {
    const a = o.action;
    need(a?.explicitUserRequest === true && a?.retryAuthorized === true && a?.firstFailureVisible === true && a?.firstFailurePersisted === true, 'CD-05 explicit separate request, authorized retry and durable first failure required');
    need(nonempty(a?.proposalId) && nonempty(a?.approvalId) && nonempty(a?.taskLink), 'CD-05 proposal/approval IDs and resulting task link required');
    need(a?.finalStatus >= 200 && a?.finalStatus < 300 && Number.isInteger(a?.finalStatus), 'CD-05 successful retry must be 2xx');
    need(a?.ownerState === 'unknown' ? a.owner === 'unknown' : nonempty(a?.owner), 'CD-05 owner must be evidenced or explicit unknown');
    need(a?.dateState === 'unknown' ? a.dueDate === 'unknown' : date(a?.dueDate), 'CD-05 date must be evidenced or explicit unknown');
  }
  if (id === 'CD-06') {
    const b = o.board;
    need(b?.linkIsAccessGrant === false && b?.personalBoardIncluded === false && o.unrelatedRequestedBoardItemClassified === false, 'CD-06 link is never access and unrelated content must be excluded');
    if (['mapped','explicit_authorized','partial'].includes(o.variant)) need(nonempty(b?.id) && b?.tenantId === o.scope.tenantId && b?.clientId === o.scope.clientId && b?.authorized === true && b?.clientAccessChecked === true && b?.tenantAccessChecked === true && b?.providerAccessChecked === true && o.boardRead === true, 'CD-06 read board must pass exact tenant/client/provider access checks');
    if (o.variant === 'explicit_authorized') need(b?.mapped === false, 'CD-06 explicit-board variant must exercise no mapping');
    if (['disconnected','not_mapped','unavailable'].includes(o.variant)) need(o.boardRead === false, 'CD-06 unread board state must be explicit');
  }
  if (id === 'CD-07') {
    need(o.proposalsIncluded === false && o.unverifiedDonePromoted === false, 'CD-07 explicit proposal and unverified-completion exclusions required');
    const primary = o.commitments.map(c => c.citations[0]?.locator);
    need(new Set(primary).size === 3, 'CD-07 statuses require distinct underlying primary records');
  }
}

function validateCommon(o, f) {
  if (!isObj(o)) { f.push('observation must be a JSON object'); return; }
  if (o.contractVersion !== 1) f.push('contractVersion must equal 1');
  if (!['synthetic', 'served_capture'].includes(o.kind)) f.push('kind must be synthetic or served_capture');
  if (!isObj(o.scope) || !nonempty(o.scope.clientId) || !nonempty(o.scope.tenantId)) f.push('scope must identify tenantId and selected clientId');
  if (!Array.isArray(o.coverage)) f.push('coverage must be an array with one receipt per required source');
  else {
    const cats = o.coverage.map(x => x?.source);
    for (const s of SOURCES) if (!cats.includes(s)) f.push(`coverage missing source ${s}`);
    if (new Set(cats).size !== cats.length) f.push('coverage source entries must be unique');
    for (const c of o.coverage) {
      if (!SOURCES.includes(c?.source) || !['checked', 'disconnected', 'unavailable', 'not_mapped', 'partial', 'denied'].includes(c?.state)) f.push('coverage entries need a known source and state');
      if (!Number.isInteger(c?.pagesRead) || c.pagesRead < 0 || !Number.isInteger(c?.pagesTotal) || c.pagesTotal < 0 || c.pagesRead > c.pagesTotal) f.push(`coverage ${c?.source ?? '?'} needs valid pagesRead/pagesTotal`);
      if (c?.state === 'checked' && c.pagesRead !== c.pagesTotal) f.push(`coverage ${c.source} cannot be checked with unread pages`);
      if (c?.state === 'partial' && c.pagesRead === c.pagesTotal) f.push(`coverage ${c.source} cannot be partial when every page was read`);
    }
  }
  if (!Array.isArray(o.commitments)) f.push('commitments must be an array');
  else {
    const ids = new Set();
    for (const [i, item] of o.commitments.entries()) {
      if (!isObj(item)) { f.push(`commitments[${i}] must be an object`); continue; }
      if (!nonempty(item.promise) || !nonempty(item.madeAt) || !nonempty(item.madeWhere)) f.push(`commitments[${i}] needs promise, madeAt, and madeWhere`);
      if (!['unknown', 'evidenced'].includes(item.ownerState) || (item.ownerState === 'evidenced' && !nonempty(item.owner))) f.push(`commitments[${i}] owner must be evidenced or unknown`);
      if (!['unknown', 'evidenced'].includes(item.dueDateState) || (item.dueDateState === 'evidenced' && !nonempty(item.dueDate))) f.push(`commitments[${i}] due date must be evidenced or unknown`);
      if (!STATUSES.includes(item.status)) f.push(`commitments[${i}] status must be one of the three canonical statuses`);
      if (!Array.isArray(item.citations) || item.citations.length === 0 || item.citations.some(c => !isObj(c) || !nonempty(c.source) || !nonempty(c.locator))) f.push(`commitments[${i}] requires source citations with locators`);
      if (Array.isArray(item.citations) && item.citations.some(c => c.clientId && c.clientId !== o.scope?.clientId || c.personal === true || c.ethicalWall === true || c.authorized === false)) f.push(`commitments[${i}] citations include out-of-scope, personal, walled, or unauthorized evidence`);
      if (!nonempty(item.followUp)) f.push(`commitments[${i}] requires specific followUp`);
      if (item.operationId !== undefined) {
        if (!nonempty(item.operationId) || ids.has(item.operationId)) f.push('operation IDs on commitments must be nonempty and unique');
        ids.add(item.operationId);
      }
      if (item.status === 'completed' && !(item.acceptanceEvidence || item.deliveredArtifact)) f.push(`commitments[${i}] completed requires delivery artifact or acceptance evidence`);
      if (item.status === 'no record of action' && (item.trackingSearchComplete !== true || !Array.isArray(o.coverage) || ['native_tasks', 'action_items'].some(s => { const c = o.coverage.find(x => x.source === s); return !c || c.state !== 'checked' || c.pagesRead !== c.pagesTotal; }))) f.push(`commitments[${i}] cannot claim no record without exhaustive task/action-item coverage`);
      if (item.sourceClientId && item.sourceClientId !== o.scope?.clientId) f.push(`commitments[${i}] leaks another client's scope`);
      if (item.personal === true || item.ethicalWall === true || item.authorized === false) f.push(`commitments[${i}] includes personal, walled, or unauthorized evidence`);
    }
  }
  if (!Array.isArray(o.effects) || o.effects.length !== 0) f.push('effects must be present as an empty array; audit observation must have zero effects');
  if (o.claimsExhaustive === true) {
    if (!Array.isArray(o.coverage) || o.coverage.some(c => c.state !== 'checked' || c.pagesRead !== c.pagesTotal)) f.push('cannot claim exhaustive coverage with denied, partial, unavailable, disconnected, or unread sources');
  }
  if (o.claimsAbsence === true && (!Array.isArray(o.coverage) || ['native_tasks', 'action_items'].some(s => { const c = o.coverage.find(x => x.source === s); return !c || c.state !== 'checked' || c.pagesRead !== c.pagesTotal; }))) f.push('absence claim requires fully read native task and action-item coverage');
}

function validateCase(id, o, f) {
  const cov = s => Array.isArray(o.coverage) ? o.coverage.find(x => x.source === s) : undefined;
  const item = (o.commitments ?? []).find(x => isObj(x));
  if (isObj(o) && isObj(o.scope) && o.scope.selectedClientId !== undefined && o.scope.selectedClientId !== o.scope.clientId) f.push('selected client scope must match clientId');
  if (isObj(o) && Array.isArray(o.commitments)) {
    const ids = o.commitments.map(x => x?.operationId).filter(nonempty);
    if (new Set(ids).size !== ids.length) f.push('operation IDs must be unique across the observation');
  }
  switch (id) {
    case 'CD-01': {
      const l = o.launcher;
      if (!isObj(l) || l.skillId !== 'commitments_audit' || l.readOnly !== true || l.requiresClient !== true || !Array.isArray(l.permittedScopes) || !['general', 'client'].every(s => l.permittedScopes.includes(s))) f.push('CD-01 launcher must preserve canonical client-required, read-only client/general skill');
      if (!isObj(l) || l.promptEditable !== true || l.selectionAutoSent !== false || !nonempty(l.promptAfterClientSelection)) f.push('CD-01 requires editable prompt, no autosend, and hydrated prompt after client selection');
      if (!isObj(l) || l.selectedClientId !== o.scope?.clientId || l.disabledFlagLaunched !== false || !nonempty(l.telemetrySkillId)) f.push('CD-01 requires selected-client scope, disabled entry not launched, and skill telemetry');
      break;
    }
    case 'CD-02':
      if (!item || !item.citations.some(c => c.source === 'meeting' && c.locator === 'M-OLDER')) f.push('CD-02 must cite the older-than-seven-days M-OLDER meeting promise');
      if (!item || item.status !== 'no record of action' || item.ownerState !== 'evidenced' || item.dueDateState !== 'evidenced') f.push('CD-02 promise needs evidenced owner/date and no record of action');
      if (['meeting', 'mail', 'debrief', 'native_tasks', 'action_items', 'monday'].some(s => !cov(s) || cov(s).state !== 'checked')) f.push('CD-02 must actually check all six source categories');
      if (o.suggestionAssertedAsObligation === true || o.taskCreated === true) f.push('CD-02 must exclude suggestion and create no task');
      if (item && item.trackingSearchComplete !== true) f.push('CD-02 absent task claim requires complete task/action search');
      break;
    case 'CD-03':
      if (cov('mail')?.state !== 'denied') f.push('CD-03 mail must record denied access');
      if (cov('monday')?.state !== 'unavailable') f.push('CD-03 Monday must be unavailable');
      if (cov('native_tasks')?.state !== 'partial' || cov('native_tasks')?.pagesRead >= cov('native_tasks')?.pagesTotal) f.push('CD-03 must disclose task pagination with unread pages');
      if (o.claimsExhaustive === true || o.claimsAbsence === true || o.absenceClaim === true || (o.commitments ?? []).some(x => x.status === 'no record of action')) f.push('CD-03 cannot claim exhaustive coverage or absence with denied/unread sources');
      break;
    case 'CD-04': {
      if (!Array.isArray(o.commitments)) break;
      const keys = o.commitments.map(x => x.dedupKey).filter(nonempty);
      if (keys.length !== o.commitments.length || new Set(keys).size !== keys.length) f.push('CD-04 commitments require unique dedupKey values');
      if (!item || !nonempty(item.existingRecordId) || !nonempty(item.nativeStatus) || !nonempty(item.nativeDate)) f.push('CD-04 must retain existing record ID, native status, and date');
      if (o.excludedEvidenceCited === true || o.excludedEvidenceInTrace === true) f.push('CD-04 ethical-wall and personal evidence must not appear even in citations or trace');
      break;
    }
    case 'CD-05': {
      const a = o.action;
      if (!isObj(a) || a.readOnlyAuditPreserved !== true || a.proposalSeparate !== true || a.approvedInsideMeri !== true) f.push('CD-05 requires a separate proposal, preserved read-only audit, and in-Meri approval');
      if (!isObj(a) || !nonempty(a.operationId) || a.retryOperationId !== a.operationId || a.createdTaskCount !== 1 || (Array.isArray(o.commitments) && o.commitments.some(x => x.operationId === a.operationId))) f.push('CD-05 retry must reuse one operation ID, not collide with another operation, and create exactly one task');
      if (!isObj(a) || !Number.isInteger(a.firstStatus) || a.firstStatus < 300 || a.firstStatus > 599 || !['not_completed', 'failed'].includes(a.firstOutcome) || a.finalOutcome !== 'completed') f.push('CD-05 first non-2xx attempt is not completed; authorized retry must complete');
      if (!isObj(a) || !nonempty(a.durableTaskId) || !nonempty(a.durableReadbackId) || a.durableTaskId !== a.durableReadbackId || a.durableAfterReload !== true || !nonempty(a.sourceReference) || !['unknown', 'evidenced'].includes(a.ownerState) || (a.ownerState === 'evidenced' && !nonempty(a.owner)) || !['unknown', 'evidenced'].includes(a.dateState) || (a.dateState === 'evidenced' && !nonempty(a.date))) f.push('CD-05 requires durable exact task readback, source reference, and evidenced-or-unknown owner/date');
      if (!isObj(a) || a.approvalNavigation !== 'meri') f.push('CD-05 approval must happen inside Meri without Settings navigation');
      break;
    }
    case 'CD-06': {
      const v = o.variant;
      if (!['mapped', 'explicit_authorized', 'disconnected', 'not_mapped', 'unavailable', 'partial'].includes(v)) f.push('CD-06 variant must name one of all six board-state variants');
      const m = cov('monday');
      const expected = { mapped: 'checked', explicit_authorized: 'checked', disconnected: 'disconnected', not_mapped: 'not_mapped', unavailable: 'unavailable', partial: 'partial' }[v];
      if (!m || m.state !== expected) f.push('CD-06 Monday coverage state does not match variant');
      if (v === 'mapped' && (o.board?.mapped !== true || o.board?.authorized !== true)) f.push('CD-06 mapped board requires client mapping and provider authorization');
      if (v === 'explicit_authorized' && (o.board?.explicitIdOrLink !== true || o.board?.authorized !== true || o.board?.linkIsAccessGrant !== false)) f.push('CD-06 explicit board requires access check; link is not an access grant');
      if (['disconnected', 'not_mapped', 'unavailable'].includes(v) && (o.boardRead === true || (o.commitments ?? []).some(x => x.citations?.some(c => c.source === 'monday')))) f.push('CD-06 cannot read/cite Monday when disconnected, unmapped, or unavailable');
      if (v === 'partial' && m?.pagesRead >= m?.pagesTotal) f.push('CD-06 partial variant must disclose unread pages');
      if (o.board?.personalBoardIncluded === true || o.unrelatedRequestedBoardItemClassified === true) f.push('CD-06 excludes personal boards and unrelated items on requested boards');
      if (o.board?.unrelatedRequestedBoardItemPresent === true && o.board?.unrelatedRequestedBoardItemExcluded !== true) f.push('CD-06 unrelated item on requested board must be excluded');
      break;
    }
    case 'CD-07': {
      if (!Array.isArray(o.commitments) || o.commitments.length !== 3 || new Set(o.commitments.map(x => x.status)).size !== 3 || !STATUSES.every(s => o.commitments.some(x => x.status === s))) f.push('CD-07 requires exactly three commitments, one per canonical status');
      if ((o.commitments ?? []).some(x => x.status === 'completed' && !(x.acceptanceEvidence || x.deliveredArtifact))) f.push('CD-07 completion requires artifact or acceptance evidence');
      if (o.proposalsIncluded === true || o.unverifiedDonePromoted === true) f.push('CD-07 excludes proposals and unverified done comments');
      if ((o.commitments ?? []).some(x => (x.ownerState === 'unknown' && x.owner !== 'unknown') || (x.dueDateState === 'unknown' && x.dueDate !== 'unknown'))) f.push('CD-07 unknown owner/date must remain explicit unknown');
      break;
    }
  }
}

export function validateCDObservation(caseId, observation) {
  const failures = [];
  if (!CD_CASE_IDS.includes(caseId)) return { valid: false, failures: [`unknown caseId: ${String(caseId)}`] };
  if (!isObj(observation) || !Array.isArray(observation.coverage) || !observation.coverage.every(isObj) || !Array.isArray(observation.commitments) || !observation.commitments.every(x => isObj(x) && Array.isArray(x.citations) && x.citations.every(isObj))) return { valid: false, failures: ['malformed observation/coverage/commitment/citation shape'] };
  validateCommon(observation, failures);
  strictChecks(caseId, observation, failures);
  if (isObj(observation)) validateCase(caseId, observation, failures);
  return { valid: failures.length === 0, failures: [...new Set(failures)] };
}

export function evaluateSavedCDCapture(caseId, observation) {
  const result = validateCDObservation(caseId, observation);
  const native = observation?.kind === 'served_capture';
  const required = ['authenticatedSession', 'uiCapture', 'traceCapture', 'sourceEvidence'];
  const evidenceFailures = [];
  if (!native) evidenceFailures.push('synthetic/local JSON is not served-product evidence');
  if (native) for (const key of required) if (!nonempty(observation?.evidence?.[key])) evidenceFailures.push(`missing native evidence reference: ${key}`);
  const evidenceReady = native && evidenceFailures.length === 0 && result.valid;
  return {
    failures: result.failures,
    evidenceReadiness: { ready: evidenceReady, state: evidenceReady ? 'NATIVE_EVIDENCE_REFERENCES_PRESENT_REQUIRES_INDEPENDENT_CHECK' : 'NOT_READY', failures: evidenceFailures },
    status: result.valid && !native ? 'LOCAL_CONTRACT_PASS' : result.valid ? 'NATIVE_EVIDENCE_UNVERIFIED' : 'INVALID',
    productPass: false,
  };
}

async function cli(argv) {
  if (argv.length !== 4 || argv.filter(x => x === '--case').length !== 1 || argv.filter(x => x === '--observation').length !== 1) { console.error('Exactly --case ID --observation PATH is required'); process.exitCode = 2; return; }
  const caseArg = argv.indexOf('--case');
  const obsArg = argv.indexOf('--observation');
  if (caseArg < 0 || obsArg < 0 || !argv[caseArg + 1] || !argv[obsArg + 1]) {
    console.error('Usage: node candidate/cd-acceptance.mjs --case CD-02 --observation saved.json');
    process.exitCode = 2; return;
  }
  try {
    const text = await readFile(argv[obsArg + 1], 'utf8');
    const observation = JSON.parse(text);
    const report = evaluateSavedCDCapture(argv[caseArg + 1], observation);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'INVALID' ? 1 : 2; // No native authenticity verifier is installed; CLI never claims acceptance.
  } catch (e) {
    console.error(`Invalid/missing observation: ${e.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await cli(process.argv.slice(2));
