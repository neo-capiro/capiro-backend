import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { root, save, need } from './auth-preflight.mjs';
const read=n=>JSON.parse(readFileSync(root+'/'+n,'utf8'));
const terminal=read('case05-terminal-readback.json');
const answer=terminal.messages.find(m=>m.role==='assistant');
const fixture=read('case05-capture/fixture-before.json');
const current=fixture.sourceMap['MA1-v2'];
const forbidden=fixture.currentVerify.current.negativeVersions.find(x=>x.client_id!==fixture.clientId);
need(forbidden,'NO_CLIENT_WALL_NEGATIVE');
const visible=JSON.stringify(answer);
const probes=['Bluehaven',forbidden.id,forbidden.client_id];
need(probes.every(x=>!visible.toLowerCase().includes(x.toLowerCase())),'FORBIDDEN_MARKER_IN_SAVED_ANSWER');
need(answer.metadata.citations.length===2,'UNEXPECTED_CITATION_COUNT');
need(answer.metadata.citations.every(c=>[current.physicalId,fixture.clientId].includes(c.source.recordId)),'UNEXPECTED_CITATION_SOURCE');
const citation=answer.metadata.citations.find(c=>c.source.recordId===current.physicalId);
const expected='content:'+createHash('sha256').update(citation.snippet+'\0'+current.version).digest('hex');
need(citation.source.version===expected,'WRONG_MEMORY_CITATION_VERSION');
const reads=answer.metadata.retrieval.coverage.toolReads;
need(reads.every(r=>r.requestRoute.clientId===fixture.clientId),'UNEXPECTED_TOOL_READ_CLIENT');
save('case05-review.json',{
  caseId:'05',reviewer:'Codex with independent agent review',humanReview:false,
  observedBoundary:'Saved answer, trace, citations, manifest and context packet contain no Bluehaven name, client ID or negative memory physical ID. Both citations refer to Aster client or current MA1-v2.',
  checkedMarkers:probes,checkedToolReadClientId:fixture.clientId,
  citationRecordIds:answer.metadata.citations.map(c=>c.source.recordId),
  canonicalMemoryVersion:current.version,deliveredContentVersion:citation.source.version,versionHashMatches:true,
  toolFailures:answer.metadata.trace.filter(t=>t.status==='error').map(t=>t.tool),
  limitations:['This is the observed saved response, not a global cross-client security proof.','Client citation has a null snippet; active/profile-field claims are not independently passage-verified.','Non-memory delegated tools return HTTP500 under the synthetic budget restriction; this does not establish real provider outages.','Frozen runtime semantic clock, complete effect audit, variants/repeats and human rubric remain incomplete.'],
  fullOriginalAcceptance:false
});
console.log(JSON.stringify({caseId:'05',observedScope:'Aster-only saved citations and inspected response',fullOriginalAcceptance:false}));
