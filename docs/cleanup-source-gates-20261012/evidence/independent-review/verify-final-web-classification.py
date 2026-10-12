from pathlib import Path
import collections, hashlib, json, subprocess

author=Path('/workspace/capirov2-cleanup-source-gates')
review=Path(__file__).resolve().parent
packet=author/'docs/cleanup-source-gates-20261012'
evidence=packet/'evidence'
main='4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace'
source='a0947f47ff8146cd986dd23b5e95d489aba855cf'
def git(*args): return subprocess.check_output(['git',*args],cwd=author)
def sha(data): return hashlib.sha256(data).hexdigest()
inputs={f:sha((evidence/f).read_bytes()) for f in ['web-full-source-unit.json','web-full-main-baseline.json','web-full-baseline-final-classification.json','verify-baseline-artifact-timer.cjs','qualification-overlay-initial-buffer-failure.json','qualification-overlay-first-pass.json']}
raw=[json.loads((evidence/f).read_bytes()) for f in ['web-full-source-unit.json','web-full-main-baseline.json']]
def cases(report):
    rows=[]
    for file in report['testResults']:
        suffix=file['name'].split('/apps/web/',1)[1]
        for case in file['assertionResults']: rows.append((suffix,case['fullName'],case['status']))
    return sorted(rows)
left,right=map(cases,raw)
assert len(left)==len(right)==6435
assert collections.Counter((p,n) for p,n,s in left)==collections.Counter((p,n) for p,n,s in right)
assert all((p,n)==(q,m) for (p,n,s),(q,m,t) in zip(left,right))
deltas=[{'file':p,'case':n,'candidate':s,'main':t} for (p,n,s),(q,m,t) in zip(left,right) if s!=t]
assert len(deltas)==1 and deltas[0]['file']=='src/vnext/meri/MeriArtifactCanvas.test.tsx'
assert deltas[0]['candidate']=='failed' and deltas[0]['main']=='passed'
for report,passed,failed in zip(raw,[6433,6434],[2,1]):
    assert report['numTotalTests']==6435 and report['numPassedTests']==passed and report['numFailedTests']==failed
    assert report['numPendingTests']==report['numTodoTests']==0 and report['success'] is False
    assert len(report['testResults'])==701
assert not git('diff','--name-only',main,source,'--','apps/web').strip()
assert not git('diff','--name-only',source,'HEAD','--','.',':!docs').strip()
classification=json.loads((evidence/'web-full-baseline-final-classification.json').read_bytes())
assert classification['statusDifferences']==deltas
assert classification['caseNamesEqual'] and classification['casesCompared']==6435
assert classification['nativeOrFullCleanupAcceptance'] is False
artifact=[]
failures=[]
for label,report in zip(['candidate','main'],raw):
    for file in report['testResults']:
        for case in file['assertionResults']:
            if case['status']=='failed': failures.append({'run':label,'file':file['name'].split('/apps/web/',1)[1],'case':case['fullName']})
        if file['name'].endswith('/MeriArtifactCanvas.test.tsx'):
            artifact.append({'run':label,'milliseconds':file['endTime']-file['startTime']})
            if label=='candidate':
                failed=[c for c in file['assertionResults'] if c['status']=='failed']
                assert len(failed)==1 and 'blob:saved-pdf' in '\n'.join(failed[0]['failureMessages'])
assert [x['case'] for x in failures if x['run']=='main']==[x['case'] for x in failures if x['run']=='candidate' and x['file']!=deltas[0]['file']]
probe=json.loads((review/'final-baseline-timer-probe.json').read_bytes())
assert probe['exactBaselineBytes'] and probe['delay']==30000 and probe['staleCallbackHitsNextSpy']
assert probe['nextTestCalls']==['blob:saved-pdf'] and probe['actualTimersOrNetworkOrDownloads'] is False
verifier='docs/cleanup-source-gates-20261012/evidence/verify-qualification-overlay.cjs'
old=git('show','4d7a8a7f576b47c2cb5ca46c256addefbbdc758b:'+verifier)
new=git('show','b69cc02fc788f6f285a11d0fb4357174dc33018c:'+verifier)
assert old.replace(b'{ cwd: root }',b'{ cwd: root, maxBuffer: 64 * 1024 * 1024 }')==new
first=json.loads((evidence/'qualification-overlay-first-pass.json').read_bytes())
assert first['verifiedQualificationFiles']==242 and first['preservedParentSourceEntries']==192 and first['historicalParentPacketUnchanged']
assert first['nativeOrFullCleanupAcceptance'] is False
assert not json.loads((packet/'GATE-MATRIX.json').read_bytes())['fullReleaseAcceptance']
assert not json.loads((packet/'BLOCKERS.json').read_bytes())['releaseAccepted']
assert not json.loads((packet/'RELEASE-MANIFEST.json').read_bytes())['fullReleaseAcceptance']
result={'runtimeSource':source,'runtimeTree':git('rev-parse',source+'^{tree}').decode().strip(),'observedPublication':git('rev-parse','HEAD').decode().strip(),'inputSha256':inputs,'comparedCaseMultiset':6435,'physicalFilesEach':701,'candidatePassedFailed':[6433,2],'mainPassedFailed':[6434,1],'soleStatusDifference':deltas,'artifactFileDurations':artifact,'failures':failures,'allWebTrackedBytesUnchangedToMain':True,'inertBaselineProbePassed':True,'bufferChangeOnly64MiB':True,'allVerifierAssertionsPreserved':True,'publishedQualificationHashesVerifiedByAuthor':242,'documents':{f:sha((packet/f).read_bytes()) for f in ['HANDOFF.md','QUALIFICATION.md','BLOCKERS.json','GATE-MATRIX.json','SOURCE-OVERLAY.json','RELEASE-MANIFEST.json']},'classificationAccepted':'environment-dependent inherited timer mechanism; causal attribution inferred, exact original artifact assertion not reproduced on main','candidateFailureStillRed':True,'fullCleanupOrNativeAcceptance':False,'newRuntimeChange':False}
print(json.dumps(result,indent=2))
