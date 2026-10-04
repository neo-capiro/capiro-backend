import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,mkdtempSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { CD_CASE_IDS, validateCDObservation, evaluateSavedCDCapture } from './cd-acceptance.mjs';

const sources = ['meeting', 'mail', 'debrief', 'native_tasks', 'action_items', 'monday'];
const cov = () => sources.map(source => ({ source, state: 'checked', pagesRead: 1, pagesTotal: 1 }));
const item = (extra = {}) => ({ promise: 'Deliver demo', madeAt: '2026-10-01', madeWhere: 'meeting', ownerState: 'evidenced', owner: 'Pat', dueDateState: 'evidenced', dueDate: '2026-10-08', status: 'in progress', citations: [{ source: 'meeting', locator: 'M-1' }], followUp: 'Confirm schedule', trackingSearchComplete: true, ...extra });
const base = (extra = {}) => ({ contractVersion: 1, kind: 'synthetic', scope: { tenantId: 'fixture', clientId: 'aster' }, coverage: cov(), commitments: [item()], effects: [], ...extra });
function fixture(id) {
  const o = base();
  if (id === 'CD-01') o.launcher = { skillId: 'commitments_audit', readOnly: true, requiresClient: true, permittedScopes: ['general', 'client'], promptEditable: true, selectionAutoSent: false, promptAfterClientSelection: 'Audit Aster', selectedClientId: 'aster', disabledFlagLaunched: false, telemetrySkillId: 'commitments_audit' };
  if (id === 'CD-02') { o.commitments = [item({ status: 'no record of action', citations: [{ source: 'meeting', locator: 'M-OLDER' }, { source: 'mail', locator: 'E-1' }, { source: 'debrief', locator: 'D-1' }] })]; o.suggestionAssertedAsObligation = false; o.taskCreated = false; }
  if (id === 'CD-03') { o.coverage = cov().map(c => c.source === 'mail' ? { ...c, state: 'denied', pagesRead: 0 } : c.source === 'monday' ? { ...c, state: 'unavailable', pagesRead: 0 } : c.source === 'native_tasks' ? { ...c, state: 'partial', pagesRead: 1, pagesTotal: 2 } : c); }
  if (id === 'CD-04') o.commitments = [item({ dedupKey: 'demo', existingRecordId: 'TASK-7', nativeStatus: 'in progress', nativeDate: '2026-10-02', citations: [{ source: 'meeting', locator: 'M-1' }, { source: 'mail', locator: 'E-1' }, { source: 'monday', locator: 'B-1/TASK-7' }] })];
  if (id === 'CD-05') o.action = { readOnlyAuditPreserved: true, proposalSeparate: true, approvedInsideMeri: true, operationId: 'op-1', retryOperationId: 'op-1', createdTaskCount: 1, firstStatus: 503, firstOutcome: 'not_completed', finalOutcome: 'completed', durableTaskId: 'TASK-8', durableReadbackId: 'TASK-8', durableAfterReload: true, sourceReference: 'M-OLDER', ownerState: 'unknown', dateState: 'unknown', approvalNavigation: 'meri' };
  if (id === 'CD-06') { o.variant = 'mapped'; o.board = { mapped: true, authorized: true, personalBoardIncluded: false, unrelatedRequestedBoardItemPresent: true, unrelatedRequestedBoardItemExcluded: true }; o.boardRead = true; }
  if (id === 'CD-07') o.commitments = [
    item({ status: 'completed', deliveredArtifact: 'artifact://demo', citations: [{ source: 'mail', locator: 'E-delivered' }] }),
    item({ status: 'in progress', citations: [{ source: 'native_tasks', locator: 'TASK-1' }] }),
    item({ status: 'no record of action', ownerState: 'unknown', owner: 'unknown', dueDateState: 'unknown', dueDate: 'unknown', citations: [{ source: 'meeting', locator: 'M-untracked' }] }),
  ];
  o.frozenNow = '2026-10-04T12:00:00.000Z'; o.documentsAvailable = false;
  o.userVisibleTrace = []; o.suggestions = [];
  for (const c of o.coverage) c.stopReason = c.state === 'partial' ? 'page_cap' : c.state === 'checked' ? 'complete' : c.state;
  o.mondayStatus = { checked:'checked', partial:'checked', unavailable:'unavailable', disconnected:'disconnected', not_mapped:'not mapped' }[o.coverage.find(c => c.source === 'monday').state];
  for (const c of o.commitments) {
    c.classification = 'promise';
    if (c.status === 'in progress') c.citations.push({source:'native_tasks',locator:'ACTIVE-'+id,evidenceKind:'active_task'});
    for (const cite of c.citations) Object.assign(cite, {tenantId:'fixture',clientId:'aster',authorized:true,personal:false,ethicalWall:false,sourceVersion:'1'});
    if (c.status === 'completed') { c.citations[0].locator = c.deliveredArtifact; c.citations[0].evidenceKind = 'delivered_artifact'; }
  }
  if (id === 'CD-01') Object.assign(o.launcher,{skillName:'Commitments & Deliverables',clientSelectionRequested:true,sentBeforeClientSelection:false,executedBeforeClientSelection:false,selectionMarkedComplete:false,recipeId:'commitments_audit',recipeVersion:1});
  if (id === 'CD-02') {o.commitments[0].madeAt='2026-09-20';o.untrackedPromiseFlagged=true;}
  if (id === 'CD-03') Object.assign(o,{claimsExhaustive:false,claimsAbsence:false,coverageLimitsReported:true,traceOutcomes:{mail:'denied',monday:'unavailable',native_tasks:'partial'}});
  if (id === 'CD-04') {Object.assign(o,{excludedEvidenceCited:false,excludedEvidenceInTrace:false,duplicateTaskProposed:false});o.commitments[0].citations.find(c=>c.source==='monday').recordId=o.commitments[0].existingRecordId;}
  if (id === 'CD-05') Object.assign(o.action,{explicitUserRequest:true,retryAuthorized:true,firstFailureVisible:true,firstFailurePersisted:true,proposalId:'proposal-1',approvalId:'approval-1',taskLink:'https://fixture.invalid/tasks/TASK-8',finalStatus:201,owner:'unknown',dueDate:'unknown'});
  if (id === 'CD-06') {Object.assign(o.board,{id:'BOARD-A',tenantId:'fixture',clientId:'aster',clientAccessChecked:true,tenantAccessChecked:true,providerAccessChecked:true,linkIsAccessGrant:false});o.unrelatedRequestedBoardItemClassified=false;}
  if (id === 'CD-07') {o.proposalsIncluded=false;o.unverifiedDonePromoted=false;}
  return o;
}

assert.deepEqual(CD_CASE_IDS, ['CD-01', 'CD-02', 'CD-03', 'CD-04', 'CD-05', 'CD-06', 'CD-07']);
for (const id of CD_CASE_IDS) test(`${id} positive and meaningful negative fixture`, () => {
  const good = fixture(id);
  assert.deepEqual(validateCDObservation(id, good), { valid: true, failures: [] });
  const bad = structuredClone(good);
  if (id === 'CD-01') bad.launcher.selectionAutoSent = true;
  if (id === 'CD-02') bad.coverage.find(c => c.source === 'meeting').state = 'unavailable';
  if (id === 'CD-03') bad.claimsExhaustive = true;
  if (id === 'CD-04') bad.commitments.push(structuredClone(bad.commitments[0]));
  if (id === 'CD-05') bad.action.retryOperationId = 'different-operation';
  if (id === 'CD-06') bad.board.linkIsAccessGrant = true;
  if (id === 'CD-07') { delete bad.commitments[0].deliveredArtifact; delete bad.commitments[0].acceptanceEvidence; }
  assert.equal(validateCDObservation(id, bad).valid, false);
});

test('CD-06 every variant is separately accepted only with matching coverage', () => {
  const variants = [['mapped','checked'],['explicit_authorized','checked'],['disconnected','disconnected'],['not_mapped','not_mapped'],['unavailable','unavailable'],['partial','partial']];
  for (const [variant, state] of variants) {
    const o = fixture('CD-06'); o.variant = variant;
    const c = o.coverage.find(x => x.source === 'monday'); c.state = state;
    o.board = { ...o.board, mapped: variant === 'mapped', explicitIdOrLink: variant === 'explicit_authorized', authorized: ['mapped','explicit_authorized','partial'].includes(variant), linkIsAccessGrant: false, personalBoardIncluded: false, unrelatedRequestedBoardItemPresent: true, unrelatedRequestedBoardItemExcluded: true };
    o.mondayStatus = {checked:'checked',disconnected:'disconnected',not_mapped:'not mapped',unavailable:'unavailable',partial:'checked'}[state];
    if (['disconnected','not_mapped','unavailable'].includes(variant)) { c.pagesRead = 0; c.pagesTotal = 0; o.boardRead = false; o.commitments[0].citations = o.commitments[0].citations.filter(cite=>cite.source !== 'monday'); }
    if (variant === 'partial') { c.pagesRead = 1; c.pagesTotal = 2; }
    assert.equal(validateCDObservation('CD-06', o).valid, true, variant);
    const bad = structuredClone(o); bad.board.personalBoardIncluded = true;
    assert.equal(validateCDObservation('CD-06', bad).valid, false, `${variant} personal-board leak`);
  }
});

test('scope leaks, ethical-wall citations, and personal evidence fail', () => {
  const a = fixture('CD-02'); a.commitments[0].sourceClientId = 'bluehaven'; assert.equal(validateCDObservation('CD-02', a).valid, false);
  const b = fixture('CD-04'); b.commitments[0].citations.push({ source: 'mail', locator: 'WALL', ethicalWall: true }); assert.equal(validateCDObservation('CD-04', b).valid, false);
  const c = fixture('CD-04'); c.excludedEvidenceInTrace = true; assert.equal(validateCDObservation('CD-04', c).valid, false);
});

test('false coverage/absence and unread pages are rejected', () => {
  const a = fixture('CD-02'); a.coverage.find(c => c.source === 'native_tasks').pagesRead = 0; a.claimsAbsence = true; assert.equal(validateCDObservation('CD-02', a).valid, false);
  const b = fixture('CD-03'); b.absenceClaim = true; assert.equal(validateCDObservation('CD-03', b).valid, false);
  const c = fixture('CD-02'); c.claimsExhaustive = true; c.coverage[0].pagesTotal = 2; assert.equal(validateCDObservation('CD-02', c).valid, false);
});

test('CD-05 incomplete approval, failed attempt, mutable/duplicated operation identity, and fake completion fail', () => {
  for (const mutate of [x => { x.action.approvedInsideMeri = false; }, x => { x.action.durableAfterReload = false; }, x => { x.action.firstStatus = 200; x.action.firstOutcome = 'completed'; }, x => { x.action.retryOperationId = 'op-2'; }, x => { x.action.createdTaskCount = 2; }, x => { x.action.durableReadbackId = 'OTHER'; }]) {
    const x = fixture('CD-05'); mutate(x); assert.equal(validateCDObservation('CD-05', x).valid, false);
  }
});

test('CD-02 must retain M-OLDER and cannot convert suggestion into obligation', () => {
  const x = fixture('CD-02'); x.commitments[0].citations[0].locator = 'M-RECENT'; assert.equal(validateCDObservation('CD-02', x).valid, false);
  const y = fixture('CD-02'); y.suggestionAssertedAsObligation = true; assert.equal(validateCDObservation('CD-02', y).valid, false);
});

test('CD-07 exact three statuses, artifacts, unknowns; unverified done/proposal excluded', () => {
  const x = fixture('CD-07'); x.proposalsIncluded = true; assert.equal(validateCDObservation('CD-07', x).valid, false);
  const y = fixture('CD-07'); y.commitments[0].unverifiedDoneComment = 'done'; delete y.commitments[0].deliveredArtifact; assert.equal(validateCDObservation('CD-07', y).valid, false);
  const z = fixture('CD-07'); z.commitments[2].owner = 'Pat'; assert.equal(validateCDObservation('CD-07', z).valid, false);
});

test('trusted/approved/verified unknown fields never create product PASS', () => {
  const x = fixture('CD-02'); Object.assign(x, { trusted: true, approved: true, verified: true, productPass: true });
  const report = evaluateSavedCDCapture('CD-02', x);
  assert.equal(report.status, 'LOCAL_CONTRACT_PASS'); assert.equal(report.productPass, false); assert.equal(report.evidenceReadiness.ready, false);
  assert.ok(report.evidenceReadiness.failures.some(f => f.includes('synthetic')));
});

test('served capture references remain independently unverified and incomplete refs are not ready', () => {
  const x = fixture('CD-02'); x.kind = 'served_capture'; x.evidence = { authenticatedSession: 'auth://1', uiCapture: 'ui://1', traceCapture: 'trace://1', sourceEvidence: 'sources://1' };
  const r = evaluateSavedCDCapture('CD-02', x); assert.equal(r.status, 'NATIVE_EVIDENCE_UNVERIFIED'); assert.equal(r.productPass, false); assert.equal(r.evidenceReadiness.ready, true);
  delete x.evidence.uiCapture; assert.equal(evaluateSavedCDCapture('CD-02', x).evidenceReadiness.ready, false);
});

test('invalid values and unknown case IDs fail deterministically', () => {
  assert.deepEqual(validateCDObservation('CD-75', {}), { valid: false, failures: ['unknown caseId: CD-75'] });
  assert.equal(validateCDObservation('CD-02', null).valid, false);
  assert.deepEqual(validateCDObservation('CD-02', fixture('CD-02')), validateCDObservation('CD-02', fixture('CD-02')));
});

// Fixtures are in-memory synthetic JSON only; this suite has no dependencies or external side effects.
// Run: node --test candidate/cd-acceptance.test.mjs
// CLI: node candidate/cd-acceptance.mjs --case CD-02 --observation saved.json

for (const [id,label,mutate] of [
 ['CD-01','wrong telemetry',o=>o.launcher.telemetrySkillId='unrelated'],
 ['CD-01','extra scope',o=>o.launcher.permittedScopes.push('portfolio')],
 ['CD-01','no client-selection gate',o=>delete o.launcher.clientSelectionRequested],
 ['CD-01','executed without client',o=>o.launcher.executedBeforeClientSelection=true],
 ['CD-01','selection claimed completed',o=>o.launcher.selectionMarkedComplete=true],
 ['CD-02','recent mislabeled M-OLDER',o=>o.commitments[0].madeAt='2026-10-03'],
 ['CD-02','invalid date',o=>o.commitments[0].madeAt='yesterday'],
 ['CD-02','missing mail corroboration',o=>o.commitments[0].citations=o.commitments[0].citations.filter(c=>c.source!=='mail')],
 ['CD-02','missing no-write receipt',o=>delete o.effects],
 ['CD-02','no suggestion exclusion',o=>delete o.suggestionAssertedAsObligation],
 ['CD-02','wrong promise owner',o=>o.commitments[0].owner='Invented'],
 ['CD-02','wrong due date',o=>o.commitments[0].dueDate='2026-10-09'],
 ['CD-02','false zero-page checked',o=>Object.assign(o.coverage[0],{pagesRead:0,pagesTotal:0})],
 ['CD-02','foreign tenant citation',o=>o.commitments[0].citations[0].tenantId='other'],
 ['CD-02','missing citation authorization',o=>delete o.commitments[0].citations[0].authorized],
 ['CD-02','documents silently omitted',o=>o.documentsAvailable=true],
 ['CD-03','false successful mail trace',o=>o.traceOutcomes.mail='success'],
 ['CD-03','coverage limits omitted',o=>delete o.coverageLimitsReported],
 ['CD-04','same promise with different dedup key',o=>o.commitments.push({...o.commitments[0],dedupKey:'different'})],
 ['CD-04','wrong existing record join',o=>o.commitments[0].existingRecordId='TASK-OTHER'],
 ['CD-04','duplicate task proposal',o=>o.duplicateTaskProposed=true],
 ['CD-04','walled visible trace',o=>o.userVisibleTrace.push({tenantId:'fixture',clientId:'bluehaven',authorized:false,personal:false,ethicalWall:true})],
 ['CD-04','personal suggestion',o=>o.suggestions.push({tenantId:'fixture',clientId:'aster',authorized:true,personal:true,ethicalWall:false})],
 ['CD-05','2xx mislabeled first failure',o=>o.action.firstStatus=200],
 ['CD-05','invalid HTTP status',o=>o.action.firstStatus=999],
 ['CD-05','missing explicit separate request',o=>delete o.action.explicitUserRequest],
 ['CD-05','unapproved retry',o=>o.action.retryAuthorized=false],
 ['CD-05','failed retry called complete',o=>o.action.finalStatus=500],
 ['CD-05','lost first failure on reload',o=>o.action.firstFailurePersisted=false],
 ['CD-05','missing result link',o=>delete o.action.taskLink],
 ['CD-05','unknown owner overwritten',o=>o.action.owner='Inferred'],
 ['CD-06','mapped link grants access',o=>o.board.linkIsAccessGrant=true],
 ['CD-06','wrong board client',o=>o.board.clientId='bluehaven'],
 ['CD-06','missing provider access',o=>o.board.providerAccessChecked=false],
 ['CD-06','wrong answer status',o=>o.mondayStatus='partial'],
 ['CD-06','missing stop reason',o=>delete o.coverage.find(c=>c.source==='monday').stopReason],
 ['CD-07','uncited delivery',o=>o.commitments[0].deliveredArtifact='invented'],
 ['CD-07','bare boolean completion',o=>o.commitments[0].deliveredArtifact=true],
 ['CD-07','in-progress without active task',o=>o.commitments[1].citations.forEach(c=>delete c.evidenceKind)],
 ['CD-07','suggestion presented as promise',o=>o.commitments[2].classification='suggestion'],
]) test(`${id} rejects ${label}`,()=>{const o=fixture(id);mutate(o);assert.equal(validateCDObservation(id,o).valid,false);});

for (const malformed of [null,[],{}, {coverage:{},commitments:[]},{coverage:[null],commitments:[]},{coverage:[],commitments:[{citations:null}]},{coverage:[],commitments:[{citations:[null]}]}]) test('malformed input returns diagnostics without throwing '+JSON.stringify(malformed),()=>{for(const id of CD_CASE_IDS)assert.equal(validateCDObservation(id,malformed).valid,false);});

test('CLI diagnoses synthetic, served, invalid and malformed arguments without acceptance',()=>{
 const dir=mkdtempSync(fileURLToPath(new URL('../cli-fixtures-',import.meta.url)));
 const cli=fileURLToPath(new URL('./cd-acceptance.mjs',import.meta.url));
 for(const mode of ['synthetic','served','invalid']){
  const o=fixture('CD-02');
  if(mode==='served'){o.kind='served_capture';o.evidence={authenticatedSession:'auth',uiCapture:'ui',traceCapture:'trace',sourceEvidence:'source'};}
  if(mode==='invalid')o.effects=['write'];
  const path=dir+'/'+mode+'.json';writeFileSync(path,JSON.stringify(o),{flag:'wx'});
  const r=spawnSync(process.execPath,[cli,'--case','CD-02','--observation',path],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(r.status,mode==='invalid'?1:2,r.stderr);const result=JSON.parse(r.stdout);assert.equal(result.productPass,false);
 }
 const args=spawnSync(process.execPath,[cli,'--case','CD-02','--observation','missing','--trust'],{encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(args.status,2);
});
