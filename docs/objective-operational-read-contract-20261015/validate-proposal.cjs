// Offline proposal conformance. Not an application selector, authorization check or DB proof.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Ajv = require(process.argv[2] ? path.resolve(process.argv[2]) : 'ajv');
const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));
const schema = read('CONTRACT.schema.json');
const composite = JSON.parse(fs.readFileSync(path.join(__dirname, '../objective-workload-authority-20261015/PROPOSED-COMPOSITE.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, format: 'full' });
assert(ajv.validateSchema(schema), JSON.stringify(ajv.errors));
assert(ajv.validateSchema(composite), JSON.stringify(ajv.errors));
ajv.addSchema(composite); ajv.addSchema(schema);
const validators = Object.fromEntries(Object.keys(schema.definitions).map(k => [k, ajv.compile({ $ref: `${schema.$id}#/definitions/${k}` })]));
const clone = x => JSON.parse(JSON.stringify(x));
const canonical = x => x === null || typeof x !== 'object' ? JSON.stringify(x) : Array.isArray(x) ? `[${x.map(canonical).join(',')}]` : `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
const digest = x => crypto.createHash('sha256').update(canonical(x)).digest('hex');
const key = x => `${x.kind}:${x.id}`;
const equal = (a, b) => canonical(a) === canonical(b);
function readSemantics(x) {
  if (!validators.ReadResponse(x)) return false;
  if (Date.parse(x.asOf) > Date.parse(x.observedAt)) return false;
  const current = { id: x.scope.currentRevisionId, version: x.scope.objectiveVersion };
  const validRevision = r => r.version <= current.version && (r.version !== current.version || r.id === current.id);
  const resources = new Map(), tasks = new Map(), proposals = new Map(), strategies = new Map();
  for (const [name, section] of Object.entries(x.sections)) {
    if (Date.parse(section.observedAt) > Date.parse(x.observedAt)) return false;
    if (section.coverage === 'complete') {
      if (x.associationSetVersion === null || section.snapshotId === null || section.total === null || section.reasons.length || section.total < section.items.length) return false;
      if (section.nextCursor !== null && section.total <= section.items.length) return false;
      if (section.total === 0 && (section.items.length || section.nextCursor !== null)) return false;
    } else {
      if (section.total !== null || section.reasons.length === 0) return false;
      if (section.coverage !== 'partial' && (section.items.length || section.nextCursor !== null || section.snapshotId !== null)) return false;
      if ((section.items.length || section.nextCursor !== null) && section.snapshotId === null) return false;
    }
    const seen = new Set();
    for (const row of section.items) {
      const resource = row.resource || row.task || row.session;
      const rowKey = name === 'decisions' ? `${row.kind}:${resource.selection.id}:${row.proposalId || ''}` : key(resource.selection);
      if (seen.has(rowKey)) return false; seen.add(rowKey);
      if (!row.provenance.every(p => validRevision(p.linkedRevision || p.sourceRevision))) return false;
      if (Date.parse(resource.observedAt) > Date.parse(x.observedAt)) return false;
      const resourceKey = key(resource.selection), prior = resources.get(resourceKey);
      if (prior && !equal(prior, resource)) return false;
      resources.set(resourceKey, resource);
      if (row.kind === 'planner_approval') tasks.set(resource.selection.id, resource.ownerVersion);
      if (row.kind === 'outreach_proposal') proposals.set(`${resource.selection.id}:${row.proposalId}`, resource.ownerVersion);
      if (name === 'strategies') {
        const pins = new Set();
        for (const pin of row.savedVersions) {
          if (!validRevision(pin.sourceRevision) || pins.has(pin.receiptId)) return false;
          pins.add(pin.receiptId);
          if (!row.provenance.some(p => p.kind === 'application_receipt' && p.receiptId === pin.receiptId && equal(p.sourceRevision, pin.sourceRevision))) return false;
        }
        strategies.set(resource.selection.id, row.savedVersions);
      }
      if (name === 'engagements' && Date.parse(row.startsAt) < Date.parse(x.asOf)) return false;
    }
  }
  const m = x.plannerMetrics;
  if (Date.parse(m.observedAt) > Date.parse(x.observedAt) || m.asOf !== x.asOf || Date.parse(m.asOf) > Date.parse(m.observedAt)) return false;
  if (m.coverage === 'complete') {
    if (x.associationSetVersion === null || [m.taskCount, m.doneCount, m.overdueCount].includes(null) || m.reasons.length || m.doneCount + m.overdueCount > m.taskCount) return false;
  } else if ([m.taskCount, m.doneCount, m.overdueCount].some(n => n !== null) || m.reasons.length === 0) return false;
  if (x.automation.availability === 'available') {
    const c = x.automation.projection, s = x.scope, o = c.objective;
    if (o.clientId !== s.clientId || o.id !== s.objectiveId || o.currentRevisionId !== s.currentRevisionId || o.version !== s.objectiveVersion || o.status !== s.objectiveStatus) return false;
    // The inherited complete stage/application/receipt witness rules remain separately required.
  }
  for (const action of x.actions) {
    if (['edit_objective', 'request_review', 'confirm_ready'].includes(action.kind)) {
      if (action.expectedObjectiveVersion !== x.scope.objectiveVersion) return false;
    } else if (action.kind === 'open_resource') {
      const resource = resources.get(key(action.resource));
      if (!resource || !equal(resource.ownerVersion, action.ownerVersion)) return false;
      if (action.savedStrategyVersionId !== null && (action.resource.kind !== 'strategy' || !strategies.get(action.resource.id)?.some(p => p.id === action.savedStrategyVersionId))) return false;
    } else if (action.kind === 'review_planner_approval') {
      if (!equal(tasks.get(action.taskId), {kind:'counter', value:action.taskVersion})) return false;
    } else if (!equal(proposals.get(`${action.sessionId}:${action.proposalId}`), {kind:'counter', value:action.expectedStateVersion})) return false;
  }
  return true;
}
function receiptMatches(r, command, linkingRevision) {
  if (!validators.AssociationReceipt(r) || !validators.AssociationCommand(command)) return false;
  for (const k of ['requestId','clientId','objectiveId','action']) if (r[k] !== command[k]) return false;
  if (r.payloadDigest !== digest(command) || r.commandRevision.version !== command.expectedObjectiveVersion) return false;
  if (linkingRevision && !equal(r.associationLinkedRevision, linkingRevision)) return false;
  if (r.outcome === 'linked' && !equal(r.commandRevision, r.associationLinkedRevision)) return false;
  if (command.action === 'unlink' && command.associationId !== r.associationId) return false;
  return r.resultSetVersion === command.expectedAssociationSetVersion + (r.outcome === 'unchanged' ? 0 : 1);
}
// Synthetic canonical-owner witnesses illustrate required selectors; no owner/runtime executes.
function metricWitness(tasks, associatedProjects, explicitTasks, asOf) {
  const unique = new Map();
  for (const task of tasks) if (task.readable && !task.archived && (explicitTasks.has(task.id) || task.projects.some(p => associatedProjects.has(p)))) unique.set(task.id, task);
  const list = [...unique.values()];
  return {taskCount:list.length,doneCount:list.filter(t => t.status === 'done').length,overdueCount:list.filter(t => t.status !== 'done' && t.canonicalDeadline !== null && t.canonicalDeadline < asOf).length};
}
const examples = read('WIRE-EXAMPLES.json').examples;
const results = [];
function check(name, fn) { fn(); results.push({name,status:'passed'}); }
for (const e of examples) check(`strict example: ${e.name}`, () => {assert(validators[e.type](e.value),JSON.stringify(validators[e.type].errors));if(e.type === 'ReadResponse'){assert(readSemantics(e.value));const {projectionDigest,...rest}=e.value;assert.equal(projectionDigest,digest(rest));}});
const observed = examples.find(e => e.name === 'explicit-manual-and-current-owned-resources').value;
const partial = examples.find(e => e.name === 'hidden-strategy-visible-project-partial').value;
const command = examples.find(e => e.type === 'AssociationCommand').value;
const receipt = examples.find(e => e.type === 'AssociationReceipt').value;
function bad(name, mutate, start = observed) {check(name, () => {const x = clone(start);mutate(x);assert.equal(readSemantics(x),false);});}
bad('partial must not claim exact count', x => x.sections.projects.total = 1, partial);
bad('unimplemented cannot contain rows', x => x.sections.strategies.coverage = 'not_implemented');
bad('unavailable cannot expose cursor', x => {x.sections.projects.coverage='unavailable';x.sections.projects.total=null;x.sections.projects.reasons=['source_unverifiable'];x.sections.projects.items=[];x.sections.projects.snapshotId=null;x.sections.projects.nextCursor='secret-cursor';});
bad('complete count needs implemented association reader', x => x.associationSetVersion = null);
bad('complete section needs exact total', x => x.sections.projects.total = null);
bad('complete section needs owner snapshot', x => x.sections.projects.snapshotId = null);
bad('complete cannot hide partial coverage reason', x => x.sections.projects.reasons = ['owner_unavailable']);
bad('duplicate shared project rows refused', x => x.sections.projects.items.push(clone(x.sections.projects.items[0])));
bad('partial metric cannot carry zeros', x => {x.plannerMetrics.coverage='partial';x.plannerMetrics.reasons=['owner_unavailable'];});
bad('done and overdue cannot exceed total', x => x.plannerMetrics.doneCount = 3);
bad('future applied membership revision refused', x => x.sections.projects.items[0].provenance[0].linkedRevision.version = 4);
bad('same revision version cannot use different ID', x => x.sections.projects.items[0].provenance[0].linkedRevision.version = 3);
bad('future observation cannot be claimed as-of read', x => x.sections.projects.observedAt = '2027-01-01T00:00:00.000Z');
bad('calendar cutoffs cannot silently differ', x => x.plannerMetrics.asOf = '2026-10-14T12:00:00.000Z');
bad('past meeting cannot become next engagement', x => x.sections.engagements.items[0].startsAt = '2026-10-14T12:00:00.000Z');
bad('question KPI cannot be invented', x => {x.sections.questions.coverage='complete';x.sections.questions.total=4;});
bad('fake active Objective enum refused', x => x.scope.objectiveStatus = 'active');
bad('old objective action version refused', x => x.actions[0].expectedObjectiveVersion = 2);
bad('hidden resource action refused', x => x.actions.push({kind:'open_resource',resource:{kind:'strategy',id:command.resource.id},ownerVersion:{kind:'counter',value:5},savedStrategyVersionId:null}), partial);
bad('non-Strategy cannot carry saved Strategy version', x => x.actions[2].savedStrategyVersionId = command.resource.id);
bad('review needs visible approval task', x => x.sections.decisions.items=[]);
bad('review task version drift refused', x => x.actions[1].taskVersion = 6);
bad('manual link cannot manufacture saved-version pin', x => x.sections.strategies.items[0].savedVersions.push({receiptId:command.requestId,sourceRevision:{id:observed.scope.currentRevisionId,version:3},id:command.requestId,digest:'b'.repeat(64)}));
check('link receipt exact request/source/set match', () => assert(receiptMatches(receipt, command)));
for (const [name, mutate] of [
  ['opposite receipt outcome', x => x.outcome='unlinked'],
  ['changed payload digest', x => x.payloadDigest='b'.repeat(64)],
  ['wrong receipt request', x => x.requestId=command.resource.id],
  ['wrong scope', x => x.clientId=command.resource.id],
  ['wrong result set version', x => x.resultSetVersion=4],
  ['new link cannot relabel original revision', x => x.associationLinkedRevision.version=2]
]) check(`refuse ${name}`, () => {const x=clone(receipt);mutate(x);assert.equal(receiptMatches(x,command),false);});
check('unlink preserves original linking revision', () => {const c={...command,action:'unlink',associationId:receipt.associationId};delete c.resource;delete c.cycles;const r={...receipt,action:'unlink',outcome:'unlinked',payloadDigest:digest(c),associationLinkedRevision:{id:command.resource.id,version:2}};assert(receiptMatches(r,c,r.associationLinkedRevision));});
check('non-Strategy cycle annotation refused', () => {const c=clone(command);c.resource.kind='meeting';assert.equal(validators.AssociationCommand(c),false);});
check('no invented first-class question association', () => {const c=clone(command);c.resource.kind='intelligence_question';assert.equal(validators.AssociationCommand(c),false);});
check('internal cycle not an independent work-item link', () => {const c=clone(command);c.resource.kind='defense_budget_cycle';assert.equal(validators.AssociationCommand(c),false);});
check('missing receipt never claims no writes', () => {const e=clone(examples.find(e => e.type==='Error').value);e.outcome='rejected';assert.equal(validators.Error(e),false);});
check('safe error allowlist refuses arbitrary message', () => {const e=clone(examples.find(e => e.type==='Error').value);e.message='SQL secret';assert.equal(validators.Error(e),false);});
check('page limit is not total task cap', () => {const x=clone(observed);x.plannerMetrics.taskCount=10000;assert(readSemantics(x));});
check('synthetic authorized union deduplicates shared tasks and excludes unlinked/denied/archive', () => {
  const facts=[{id:'a',projects:['p','q'],readable:true,archived:false,status:'done',canonicalDeadline:1},{id:'a',projects:['p','q'],readable:true,archived:false,status:'done',canonicalDeadline:1},{id:'b',projects:[],readable:true,archived:false,status:'todo',canonicalDeadline:1},{id:'c',projects:['unlinked'],readable:true,archived:false,status:'todo',canonicalDeadline:1},{id:'d',projects:['p'],readable:false,archived:false,status:'todo',canonicalDeadline:1},{id:'e',projects:['p'],readable:true,archived:true,status:'todo',canonicalDeadline:1}];
  assert.deepEqual(metricWitness(facts,new Set(['p','q']),new Set(['b']),2),{taskCount:2,doneCount:1,overdueCount:1});
});
check('normal task default pending approval is not a decision', () => {const facts=[{subtype:'task',approval:'pending'},{subtype:'approval',approval:'pending'},{subtype:'approval',approval:'approved'}];assert.equal(facts.filter(t=>t.subtype==='approval'&&t.approval==='pending').length,1);});
check('untitled linked Outreach session remains representable', () => {const x=clone(observed),row=x.sections.decisions.items[0];x.sections.decisions.items=[{kind:'outreach_proposal',session:{...row.task,selection:{kind:'outreach_session',id:command.requestId},title:null},proposalId:receipt.associationId,state:'pending',title:'Review proposal',provenance:row.provenance}];x.actions=[x.actions[0],{kind:'review_outreach_proposal',sessionId:command.requestId,proposalId:receipt.associationId,expectedStateVersion:5}];assert(readSemantics(x));});
const pendingComposite={schemaVersion:1,observedAt:observed.observedAt,projectionDigest:'a'.repeat(64),objective:{clientId:observed.scope.clientId,id:observed.scope.objectiveId,currentRevisionId:observed.scope.currentRevisionId,version:observed.scope.objectiveVersion,status:observed.scope.objectiveStatus},association:null,requestedRevision:{id:observed.scope.currentRevisionId,version:observed.scope.objectiveVersion},strategyAppliedRevision:null,planAppliedRevision:null,generation:{state:'pending',attemptId:null,receiptId:null,failureCode:'runtime_authority_unconnected'},planner:{state:'not_recorded',attemptId:null,receiptId:null,failureCode:null},strategy:{availability:'unbound',id:null,versionId:null,versionDigest:null},project:{availability:'unbound',sourceLineageAvailability:'unbound',id:null,sourceStrategyVersionId:null,sourceStrategyVersionDigest:null},notices:[],issues:[],requestedIntentId:command.requestId,strategyAppliedIntentId:null,planAppliedIntentId:null};
check('available inherited composite must match outer Objective identity',()=>{const x=clone(observed);x.automation={availability:'available',projection:clone(pendingComposite)};assert(readSemantics(x));x.automation.projection.objective.id=command.requestId;assert.equal(readSemantics(x),false);});
check('inherited stage matrix remains strict',()=>{const x=clone(observed);x.automation={availability:'available',projection:clone(pendingComposite)};x.automation.projection.generation.state='running';assert.equal(readSemantics(x),false);});
const report={schemaVersion:1,verdict:'OFFLINE_PROPOSAL_CONFORMANCE_ONLY',passed:results.length,failed:0,results,limits:['No runtime selectors, ACL, persistence, cursors, DB or native checks executed','Inherited composite complete semantic/receipt witness gate remains required','Synthetic owner facts do not prove source implementation']};
process.stdout.write(JSON.stringify(report,null,2)+'\n');
