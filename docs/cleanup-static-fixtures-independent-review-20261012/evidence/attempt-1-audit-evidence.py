import pathlib,subprocess,json,hashlib,collections
root=pathlib.Path(__file__).resolve().parents[3]
packet=pathlib.Path(__file__).resolve().parent
def git(ref,path):return subprocess.check_output(['git','show',ref+':'+path],cwd=root)
authors=[('c482325819e6d41ab8a4e4d2cf95b41bc6f0c1a9','docs/cleanup-intelligence-meri-fixture-adoption-20261012'),('501b426533fdeff74ce8d7a3552626d2e65e83a0','docs/cleanup-outreach-skeleton-owned-input-adoption-20261012')]
counts=[]
for ref,prefix in authors:
    index=json.loads(git(ref,prefix+'/SHA256-INDEX.json'))
    for row in index['files']:
        data=git(ref,row['path']);assert hashlib.sha256(data).hexdigest()==row['sha256'] and len(data)==row['bytes']
    counts.append({'head':ref,'bindingsVerified':len(index['files'])})
current=json.loads((packet/'all46-results.json').read_text())
def cases(value):return collections.Counter((pathlib.Path(suite['name']).name,row['fullName'],row['status']) for suite in value['testResults'] for row in suite['assertionResults'])
expected=collections.Counter()
for ref,prefix,logs in [(authors[0][0],authors[0][1],['before-jest-results.json','after-jest-results.json']),(authors[1][0],authors[1][1],['before-results.json','after-results.json','web-refused-results.json'])]:
    results=[json.loads(git(ref,prefix+'/evidence/'+name)) for name in logs]
    assert all(cases(value)==cases(results[0]) for value in results)
    assert all(value['numFailedTests']==0 and value['numPendingTests']==0 and value['numTodoTests']==0 for value in results)
    expected.update(cases(results[0]))
assert cases(current)==expected
assert current['numTotalTests']==current['numPassedTests']==46 and current['numFailedTests']==current['numPendingTests']==current['numTodoTests']==0
union=json.loads((packet/'SOURCE-UNION.json').read_text());paths=[row['path'] for row in union['exactPublishedCodeBlobsAndModes']]
head=union['reviewSource'];baseline=union['baseline']
command=['git','diff','--check',baseline,head,'--']+paths
result=subprocess.run(command,cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
(packet/'source-nine-whitespace.log').write_bytes(result.stdout)
assert result.returncode==2 and result.stdout.count(b'new blank line at EOF.')==1
source_map={name:git(head,name) for name in paths}
hashes={row['path']:row['sha256'] for row in union['exactPublishedCodeBlobsAndModes']}
def failures(values):return [name for name,sha in hashes.items() if name not in values or hashlib.sha256(values[name]).hexdigest()!=sha]
assert failures(source_map)==[]
refusals=[]
for path in paths:
    altered=dict(source_map);altered[path]+=b'\n\xe2\x80\x8b'
    assert failures(altered)==[path]
    refusals.append({'kind':'byte drift, no source execution','path':path,'rejected':True})
    altered=dict(source_map);del altered[path]
    assert failures(altered)==[path]
    refusals.append({'kind':'missing declared input','path':path,'rejected':True})
for path in [name for name in paths if name.endswith('.spec.ts')]:
    altered=dict(source_map);altered[path]=git(baseline,path)
    assert failures(altered)==[path]
    refusals.append({'kind':'fallback to original live-Web reader','path':path,'rejected':True})
(packet/'source-map-refusals.json').write_text(json.dumps({'canonicalNineInputsPass':True,'refusals':refusals,'rejected':len(refusals),'mutatedCodeExecuted':False},indent=2)+'\n')
receipt={'authorIndices':counts,'all46BeforeAfterCurrentCaseStatusesEqual':True,'currentSuiteCounts':{pathlib.Path(suite['name']).name:len(suite['assertionResults']) for suite in current['testResults']},'sourceMapIndependentRefusals':len(refusals),'sourceWhitespaceCommand':command,'sourceWhitespaceExit':result.returncode,'sourceWhitespaceReason':'one inherited exact opaque Intelligence snapshot EOF blank line','rawSourceWarningPreserved':True,'fullFloorAcceptance':'OPEN','noProductWhitespaceMutation':True,'hostTypeDiagnostics':False,'nativeFrontendAcceptance':False,'sourceApplicationRuntimeUntouched':True}
(packet/'EVIDENCE-AUDIT.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt))
