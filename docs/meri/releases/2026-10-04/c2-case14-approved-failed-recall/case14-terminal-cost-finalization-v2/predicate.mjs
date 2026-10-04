// Codex local draft. Pure inspection only until authentic postdeadline evidence is frozen.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {RETAINED_PINS as pins,SCOPE as s} from './fixed.mjs';
export const stable=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))])):v);
export const hash=v=>createHash('sha256').update(v).digest('hex');
export const semantic=v=>hash(stable(v));
const need=(v,label)=>{if(!v)throw Error('CASE14_TERMINAL_COST_REJECTED:'+label);};
const equal=(a,b,label)=>need(isDeepStrictEqual(a,b),label);
const scope=(v,fields,label)=>fields.forEach(k=>need(v?.[k]===s[k],label+':'+k));
const price=(tokens,rate)=>{need(Number.isSafeInteger(tokens)&&tokens>=0&&Number.isSafeInteger(rate)&&rate>=0,'price inputs');return Number((BigInt(tokens)*BigInt(rate)+999999n)/1000000n);};
function observation(v,p,after){
 need(v?.observation?.path===p&&v.observation.status===200&&v.observation.apiReleaseSha===s.sourceSha,'HTTP scope/source');
 const at=Date.parse(v.observation.observedAt);need(Number.isFinite(at)&&(after?at>s.providerDeadlineAtMs:at<s.providerDeadlineAtMs),'observation deadline');
 need(v.observation.bodySha256===hash(JSON.stringify(v.value))&&v.observation.bodyBytes===Buffer.byteLength(JSON.stringify(v.value)),'raw HTTP body join');
 return at;
}
/** Caller data never supplies a WeakMap capability or append authority. */
export function inspectCase14TerminalCost(r,post){
 for(const[name,p]of Object.entries(pins))if(p.semanticSha256)need(semantic(r[name])===p.semanticSha256,'retained pin '+name);
 const e=r.execution,cp=r.checkpoint,key='14:'+s.captureRunId,row=cp.snapshot.runs[key];
 need(e.kind==='case14-combined-owned-live-operator-result'&&e.status==='BLOCKED_RECONCILE_BEFORE_RETRY'&&e.captureRunId===s.captureRunId&&e.approvalSubmissions===1&&e.recallSubmissions===1,'one submitted approval/recall');
 need(e.apiSessionRevoked===true&&e.browserSessionsCreated===1&&e.browserSessionsCleaned===1&&e.automaticRetryAllowed===false,'cleanup/no replay');
 need(e.approvalBilledActualMicros===null&&e.conservativeApprovalCeilingMicros===1000000&&e.recallCeilingMicros===14000000&&e.combinedHoldMicros===15000000,'cost partition');
 need(e.originalPromptSubmission==='NOT_RUN'&&e.humanRubric==='NOT_RUN'&&e.fullOriginalRow14Acceptance===false&&e.fullFile01Acceptance===false,'acceptance preserved');
 equal(e.recallOutcome,r.blocked,'blocked outcome');equal(r.manifest.summary,r.blocked,'manifest outcome');
 need(r.blocked.status==='CAPTURE_UNCERTAIN'&&r.blocked.acceptanceStatus==='NOT_RUN'&&r.blocked.reason==='CASE01_SOURCE_TOOL_JOIN_MISMATCH'&&r.blocked.synthesisSubmissionCount===1,'failure preserved');
 need(e.preparedSha256===pins.prepared.sha256&&r.prepared.sourceFiles.some(x=>x.path.endsWith('/operator.mjs')&&x.sha256===pins.operator.sha256),'operator/preparation pins');
 need(cp.kind==='meri-fresh-capture-spend-checkpoint'&&cp.version===1&&cp.snapshot.eventCount===25&&cp.snapshot.activeRun===key&&cp.snapshot.knownSettledCostMicros===13631058&&cp.snapshot.conservativeApprovalCostMicros===0&&cp.snapshot.committedCostMicros===28631058,'exact held snapshot');
 need(cp.state.files['fresh-spend.jsonl'].sha256===s.journal25Sha256&&cp.state.files['fresh-spend.jsonl'].bytes===s.journal25Bytes&&cp.state.files['run-authorization.json'].sha256==='e07822e83a7c7b531606519ecd4fdf1027f2fa7cbaefd4bad92a2084590262fe','native checkpoint pins');
 scope(row,['caseId','captureRunId','reservationId'],'held');need(row.sequence===25&&row.ceilingMicros===15000000&&row.approvalCeilingMicros===1000000&&row.recallCeilingMicros===14000000&&row.approvalBoundSha256===s.approvalBoundSha256,'exact reservation partition');
 const actor=r.config.scope.actors.PRIYA;need(actor.userId===s.userId&&actor.tenantPhysicalId===s.tenantId&&actor.role==='user_admin'&&r.config.scope.clients.ASTER.physicalId===s.clientId&&r.config.limits.maxSpendUsd===14,'original actor/config');
 scope(r.intent,['caseId','captureRunId','conversationId'],'intent');need(r.intent.maxCostMicros===14000000,'intent ceiling');
 for(const[ref,name]of[['blocked.json','blocked'],['admission.json','admission'],['saved-messages-observation.json','savedMessages'],['stream-response-observation.json','stream'],['submission-intent.json','intent'],['immutable-builds.json','builds']]){const d=r.manifest.artifacts.find(x=>x.ref===ref);need(d?.sha256===pins[name].sha256&&d.bytes===pins[name].bytes,'original descriptor '+name);}
 const setup=r.setup.value,projection=setup.results['projection-terminal'];
 need(setup.status==='RECALL_BOUND_AND_BUDGET_INSTALLED'&&setup.sourceSha===s.sourceSha&&setup.captureRunId===s.captureRunId&&setup.approvalEvidenceSha256===pins.approval.sha256&&e.approvalOutcome.evidence.sha256===pins.approval.sha256,'owned postapproval setup');
 need(r.approval.sessionRevoked===true&&r.approval.synthesisSubmissionCount===0&&r.approval.response.status===201&&r.approval.response.releaseSha===s.sourceSha&&r.approval.response.value.outcome==='activated','approval receipt');
 equal(r.approval.response,r.approvalAck,'approval acknowledgement');
 need(projection.status==='BOTH_APPROVAL_PROJECTION_BRANCHES_PERSISTED'&&projection.captureRunId===s.captureRunId&&projection.approvalEvidenceSha256===pins.approval.sha256&&projection.sourceSha===s.sourceSha,'projection joins');
 need(projection.providerUsageMeasured===false&&projection.approvalBilledActualMicros===null&&projection.matchingInstitutionalVectorRows===1&&projection.matchingLegacyVectorRows===1&&projection.exactOutboxRows===1&&projection.otherOutboxRows===0&&projection.outbox.status==='completed'&&projection.outbox.attempts===0,'terminal approval branches');
 need(projection.canonicalOwner.candidateId==='6f4545a1-dcd5-5eba-8606-db2043b238ac'&&projection.canonicalOwner.state==='approved'&&projection.canonicalOwner.reviewerUserId===s.userId&&projection.canonicalOwner.item.id==='a740d74f-2c61-4888-bb59-5c9eea502e3f','exact approved owner');
 need(Date.parse(projection.observedAt)<s.approvalDeadlineAtMs&&Date.parse(e.completedAt)<s.approvalDeadlineAtMs,'capture window');
 // cost-bound.json is retained byte-for-byte even though the source serializer
 // emitted undefined imageDigest for unrelated tasks. Never silently repair it.
 need(typeof r.approvalBound==='string'&&r.approvalBound.includes('"approvalBoundSha256":"'+s.approvalBoundSha256+'"'),'opaque bound artifact');
 const before=r.diagnosticConversation,raw=r.diagnosticMessages,me=r.diagnosticMe;
 observation(before,'/api/clio/conversations/'+s.conversationId,false);observation(raw,'/api/clio/conversations/'+s.conversationId+'/messages',false);observation(me,'/api/me',false);
 need(r.predeadlineCleanup.status==='revoked','predeadline session cleanup');
 const state=before.value.metadata.serverCaptureProviderBudget,l=state.ledger,q=state.qualification;
 need(semantic(state)===s.providerStateSha256&&state.qualificationSha256===semantic(q)&&state.version===1&&l.activation==='enforced'&&l.version===1,'provider state');
 need(q.caseId==='14'&&q.captureRunId===s.captureRunId&&q.maxCostMicros===14000000&&l.limits.maxCostMicros===14000000&&q.maxTokens===500000&&l.limits.maxTokens===500000&&q.maxAttempts===32&&l.limits.maxAttempts===32,'limits');
 need(Date.parse(l.limits.deadlineAt)===s.providerDeadlineAtMs&&Date.parse(q.rateEvidenceExpiresAt)>s.providerDeadlineAtMs&&q.rateEvidenceSha256==='1c9106e5d98f73b061f0de9918bf33c8fb28b0f0bc5be5ae4bc7d20e0da2a348'&&semantic(r.rates)===q.rateEvidenceSha256,'reviewed rate bound');
 need(raw.value.length===2,'exact messages');const[user,assistant]=raw.value;
 scope(user,['conversationId','tenantId','userId','clientId'],'user');scope(assistant,['conversationId','tenantId','userId','clientId'],'assistant');
 need(user.role==='user'&&user.id===s.turnId&&assistant.role==='assistant'&&assistant.id===s.assistantMessageId&&hash(user.body)===r.intent.promptSha256,'message identities');
 const envelope=assistant.metadata.serverCaptureEvidenceReceipt,receipt=envelope.receipt,authority=assistant.metadata.case14CaptureAuthority,policy=assistant.metadata.serverReadonlyCapturePolicy;
 for(const value of[receipt,authority,policy])scope(value,['caseId','captureRunId','conversationId','tenantId','actorUserId','clientId'],'signed scope');
 for(const field of['turnId','policyId','requestId','traceId'])need(receipt[field]===authority[field]&&receipt[field]===policy[field],'signed identity '+field);
 need(authority.messageId===assistant.id&&authority.answerSha256===hash(assistant.body)&&authority.envelopeSha256===semantic(envelope)&&envelope.purpose==='server_capture_evidence'&&envelope.audience==='capiro:meri:server-readonly-capture:evidence:v1'&&/^[a-f0-9]{64}$/.test(envelope.signature),'signed envelope');
 need(receipt.status==='BLOCKED'&&receipt.blockers.length===3&&receipt.releases.api.releaseRevision.value===s.sourceSha&&receipt.releases.orchestrator.releaseRevision.value===s.sourceSha,'blocked/source');
 need(state.policySha256===semantic({...policy,turnId:null})&&state.turnId===s.turnId&&authority.fixture.currentVerifySha256===q.currentVerifySha256&&r.admission.admission.providerBudget.qualificationSha256===state.qualificationSha256,'policy/admission joins');
 const signed=receipt.providerBudget;need(signed.status==='SETTLED'&&signed.boundary==='case14_memory_turn'&&signed.ledgerSha256===semantic(state)&&signed.qualificationSha256===state.qualificationSha256&&signed.turnId===state.turnId&&signed.admissionId===state.admissionId&&signed.attempts===3&&signed.chargedTokens===62396&&signed.chargedCostMicros===1569851&&signed.maxCostMicros===14000000,'receipt cost joins');equal(signed.unaccountedBoundaries,[],'no unaccounted recall boundary');
 need(policy.expiresAt===s.providerDeadlineAtMs&&receipt.expiresAt===s.providerDeadlineAtMs&&policy.issuedAt<=receipt.startedAt&&receipt.startedAt<=receipt.completedAt&&receipt.completedAt<=Date.parse(e.completedAt),'receipt time');
 need(r.savedMessages.status===200&&r.savedMessages.redacted===true&&r.savedMessages.releaseSha===s.sourceSha&&r.stream.status===201&&r.stream.releaseSha===s.sourceSha,'original observations');
 const original=JSON.parse(r.savedMessages.text),savedAssistant=original.find(x=>x.role==='assistant');
 need(original.length===2&&savedAssistant.id===assistant.id&&savedAssistant.metadata.serverCaptureEvidenceReceipt.signature===envelope.signature&&savedAssistant.metadata.case14CaptureAuthority.envelopeSha256===authority.envelopeSha256&&r.stream.text.includes(envelope.signature),'original signed identity');
 let cost=0,tokens=0,openaiInput=0,openaiOutput=0;need(l.attempts.length===3&&new Set(l.attempts.map(a=>a.attemptId)).size===3&&new Set(l.attempts.map(a=>a.reservationId)).size===3,'attempt identities');
 for(const a of l.attempts){
  need(a.status==='settled'&&a.priceKnown===true&&a.runId===state.admissionId&&a.leaseEpoch===1&&a.retryOfAttemptId===null,'terminal attempt');
  need(a.attemptId===a.logicalOperationId+(a.kind==='openai_responses'?':0':''),'attempt owner');
  need(Date.parse(a.reservedAt)>=policy.issuedAt&&Date.parse(a.settledAt)>=Date.parse(a.reservedAt)&&Date.parse(a.settledAt)<=receipt.completedAt,'attempt times');
  const rates=q.rates.filter(x=>x.kind===a.kind&&x.provider===a.provider&&x.model===a.model);need(rates.length===1,'exact attempt rate');const rate=rates[0];
  const actual=price(a.actualInputTokens,rate.inputMicrosPerMillion)+price(a.actualOutputTokens,rate.outputMicrosPerMillion);
  need(actual===a.actualCostMicros&&actual<=a.reservedCostMicros&&a.actualInputTokens<=a.reservedInputTokens&&a.actualOutputTokens<=a.reservedOutputTokens&&a.reservedCostMicros===price(a.reservedInputTokens,rate.inputMicrosPerMillion)+price(a.reservedOutputTokens,rate.outputMicrosPerMillion),'attempt arithmetic');
  cost+=actual;tokens+=a.actualInputTokens+a.actualOutputTokens;if(a.kind==='openai_responses'){openaiInput+=a.actualInputTokens;openaiOutput+=a.actualOutputTokens;}
 }
 need(cost===1569851&&tokens===62396&&l.chargedCostMicros===cost&&l.chargedTokens===tokens&&l.chargedAttempts===3,'exact aggregate recall cost');
 need(receipt.usage.inputTokens.status==='OBSERVED'&&receipt.usage.inputTokens.value===openaiInput&&receipt.usage.outputTokens.status==='OBSERVED'&&receipt.usage.outputTokens.value===openaiOutput,'OpenAI-only receipt usage');
 // Correct predeadline raw body is evidence; expired message read is not required.
 const p=post.summary;need(p?.kind==='case14-postdeadline-owned-provider-budget-readback'&&p.status==='READBACK_CAPTURED'&&p.sessionRevoked===true&&p.journalUnchanged===true&&p.afterProviderDeadline===true&&p.messagesReadAfterDeadline===false&&p.captureAuthority===false&&p.applicationWrites===0&&p.modelSubmissions===0&&p.journalMutations===0,'postdeadline read boundary');
 scope(p,['captureRunId','conversationId','tenantId','userId'],'postdeadline scope');
 need(p.priorMessagesSha256===pins.diagnosticMessages.sha256&&p.priorExecutionSha256===pins.execution.sha256&&p.priorCheckpointSha256===pins.checkpoint.sha256,'retained postdeadline joins');
 const observed=observation(post.conversation,'/api/clio/conversations/'+s.conversationId,true);observation(post.me,'/api/me',true);
 equal(p.reads,[post.me.observation,post.conversation.observation],'post read inventory');
 need(Date.parse(p.startedAt)>s.providerDeadlineAtMs&&Date.parse(p.finishedAt)>=observed&&post.cleanup.status==='revoked','post read times/cleanup');
 for(const m of[me,post.me])need(m.value.tenant.id===s.tenantId&&m.value.user.id===s.userId&&m.value.user.clerkUserId===actor.clerkUserId&&m.value.role==='user_admin','authenticated actor');
 for(const c of[before,post.conversation]){scope(c.value,['tenantId','userId','clientId'],'conversation');need(c.value.id===s.conversationId&&c.value.archivedAt===null,'conversation state');}
 equal(post.conversation.value.metadata.serverCaptureProviderBudget,state,'exact postdeadline provider state');
 return {caseId:s.caseId,captureRunId:s.captureRunId,reservationId:s.reservationId,conversationId:s.conversationId,
 chargedCostMicros:cost,conservativeApprovalCostMicros:1000000,approvalBilledActualMicros:null,combinedCommittedCostMicros:2569851,
 approvalBoundSha256:s.approvalBoundSha256,approvalOutcomeSha256:semantic(e.approvalOutcome),projectionTerminalSha256:semantic(projection),
 providerTokens:tokens,providerAttempts:3,pendingProviderAttempts:0,ledgerSha256:semantic(l),providerStateSha256:semantic(state),
 providerDeadlineAtMs:s.providerDeadlineAtMs,observedAtMs:observed,executionCompletedAtMs:Date.parse(e.completedAt),
 retainedEvidenceSha256:semantic(pins),postdeadlineReadbackSha256:semantic(post),journalBeforeSha256:s.journal25Sha256,
 disposition:'FAILED_CAPTURE_TERMINAL_RECALL_COST_RECONCILED_WITH_CONSERVATIVE_APPROVAL',captureAuthority:false,
 answerGrade:'NOT_EVALUATED',captureStatus:'CAPTURE_UNCERTAIN',failure:e.recallOutcome.reason};
}
// Deliberately no callable mint/consume API in this draft. Root must first obtain
// and freeze real postdeadline files, review their byte pins and this predicate,
// then add fixed-file loader + one-use WeakMap consume-time revalidation exactly
// as existing Case20. A JSON proof or UNIT fixture cannot become append authority.
export function prepareCase14TerminalCostAuthority(){throw Error('CASE14_POSTDEADLINE_AUTHORITY_NOT_FROZEN');}
