import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const out=path.dirname(fileURLToPath(import.meta.url));
const base='C:/dev/main/outputs/meri-c2-20261003/';
const repo='C:/dev/main/meri-c1-20261002/';
const hash=b=>createHash('sha256').update(b).digest('hex');
const stable=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))])):v);
const names={execution:'case14-live-operator-v1/result.json',checkpoint:'case14-live-operator-v1/aggregate-final.json',prepared:'case14-live-operator-v1/prepared.json',operator:'case14-live-operator-v1/operator.mjs',config:'case14-live-operator-v1/recall-config.json',setup:'case14-live-operator-v1/native-setup-authority-proof.json',approval:'case14-live-operator-v1/artifacts-ui/case14-approval/evidence.json',approvalBound:'case14-live-operator-v1/artifacts-ui/case14-approval/cost-bound.json',approvalAck:'case14-live-operator-v1/artifacts-ui/case14-approval/approval-acknowledgement.json',manifest:'case14-live-operator-v1/artifacts-recall/capture-manifest.json',blocked:'case14-live-operator-v1/artifacts-recall/blocked.json',intent:'case14-live-operator-v1/artifacts-recall/submission-intent.json',admission:'case14-live-operator-v1/artifacts-recall/admission.json',builds:'case14-live-operator-v1/artifacts-recall/immutable-builds.json',savedMessages:'case14-live-operator-v1/artifacts-recall/saved-messages-observation.json',stream:'case14-live-operator-v1/artifacts-recall/stream-response-observation.json',diagnosticConversation:'case14-terminal-read-v1/conversation.json',diagnosticMessages:'case14-terminal-read-v1/messages.json',diagnosticMe:'case14-terminal-read-v1/me.json',rates:'reviewed-rates-c2-v3-20261004.json'};
const input={},pins={};
for(const key of ['diagnosticConversation','diagnosticMessages','diagnosticMe'])names[key]=names[key].replace('terminal-read-v1','terminal-read-v2');
names.predeadlineSummary='case14-terminal-read-v2/summary.json';
names.predeadlineCleanup='case14-terminal-read-v2/session-cleanup.json';
names.predeadlineJournal='case14-terminal-read-v2/journal-preserved.json';
names.predeadlineReader='read-case14-terminal-evidence-v2.mjs';
for(const[name,p]of Object.entries(names)){const bytes=fs.readFileSync(base+p);pins[name]={path:base+p,bytes:bytes.length,sha256:hash(bytes)};if(p.endsWith('.json')){input[name]=name==='approvalBound'?bytes.toString('utf8'):JSON.parse(bytes);pins[name].semanticSha256=hash(stable(input[name]));}}
const previous=fs.readFileSync(repo+'docs/meri/releases/2026-10-03/c2-terminal-cost-and-case14-read/journal24-exact.jsonl');
if(hash(previous)!=='8f20134f71dde90e32fc0c3c2aba2da2d5b93dd13fffea31b83105d1621bc3e5')throw Error('ARCHIVE_PREFIX_DRIFT');
const row=input.checkpoint.snapshot.runs[input.checkpoint.snapshot.activeRun];
const reconstructed=Buffer.concat([previous,Buffer.from(stable(row)+'\n')]);
if(hash(reconstructed)!==input.checkpoint.state.files['fresh-spend.jsonl'].sha256||reconstructed.length!==15913)throw Error('RECONSTRUCTED_PREFIX_MISMATCH');
fs.writeFileSync(path.join(out,'journal25-reconstructed-from-retained.jsonl'),reconstructed,{flag:'wx'});
fs.writeFileSync(path.join(out,'retained-input.json'),JSON.stringify(input,null,2)+'\n',{flag:'wx'});
fs.writeFileSync(path.join(out,'retained-pins.json'),JSON.stringify(pins,null,2)+'\n',{flag:'wx'});
fs.writeFileSync(path.join(out,'fixed.mjs'),'export const RETAINED_PINS='+JSON.stringify(pins,null,2)+';\n'+
 'export const SCOPE='+JSON.stringify({caseId:'14',captureRunId:row.captureRunId,reservationId:row.reservationId,conversationId:input.intent.conversationId,tenantId:input.config.scope.actors.PRIYA.tenantPhysicalId,userId:input.config.scope.actors.PRIYA.userId,actorUserId:input.config.scope.actors.PRIYA.userId,clientId:input.config.scope.clients.ASTER.physicalId,sourceSha:'c0f393f863bf73bd4e65e7a94e17c073e7be021e',turnId:input.diagnosticMessages.value[0].id,assistantMessageId:input.diagnosticMessages.value[1].id,providerStateSha256:hash(stable(input.diagnosticConversation.value.metadata.serverCaptureProviderBudget)),journal25Sha256:hash(reconstructed),journal25Bytes:reconstructed.length,approvalBoundSha256:row.approvalBoundSha256,providerDeadlineAtMs:Date.parse('2026-10-04T06:23:21.190Z'),approvalDeadlineAtMs:input.setup.value.approvalWindow.deadlineAtMs},null,2)+';\n',{flag:'wx'});
console.log(JSON.stringify({status:'LOCAL_RETAINED_PREPARATION_ONLY',pins:Object.keys(pins).length,journal25Sha256:hash(reconstructed),liveJournalRead:false}));
