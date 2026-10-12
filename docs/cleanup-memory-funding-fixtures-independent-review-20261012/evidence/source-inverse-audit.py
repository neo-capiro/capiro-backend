import pathlib,subprocess,json,hashlib
root=pathlib.Path.cwd();packet=root/'docs/cleanup-memory-funding-fixtures-independent-review-20261012';ev=packet/'evidence';base='d587441261fd356ee5144a8fc29cb2f771d062b8';candidate='44eda40f7951e73722566862649939e51a8f151a';prior='fe50dc1c2de1660a036e338cf81acdcf0f2fb26a';published='d09429a509d5b3cc2501f3736e619723e4b2c4c0'
def git(head,path):return subprocess.check_output(['git','show',head+':'+path])
def h(raw):return hashlib.sha256(raw).hexdigest()
mapping=[]
for stem in ['src/components/MemoryFileEditor.tsx','src/components/MemoryGovernanceCenterHost.tsx','src/components/MemoryReviewInbox.tsx','src/components/PendingMemoryReviewPanel.tsx','src/pages/settings/MemorySettingsPage.tsx']:
    mapping.append(('apps/web/'+stem,'apps/api/scripts/lib/__fixtures__/legacy-ui-contracts/'+stem+'.txt'))
for stem in ['FundingOpportunityV2ResultCard.tsx','funding-opportunities-domain.ts']:
    mapping.append(('apps/web/src/vnext/pages/funding-opportunities/'+stem,'apps/api/src/funding-opportunities/__fixtures__/legacy-ui-contracts/'+stem+'.txt'))
fixtures=[]
for original,dest in mapping:
    b=git(base,original);c=git(candidate,dest);assert b==c==git(prior,original)==git(published,dest)==(root/dest).read_bytes()
    fixtures.append({'original':original,'fixture':dest,'bytes':len(c),'sha256':h(c),'baseSourceBlob':subprocess.check_output(['git','rev-parse',base+':'+original],text=True).strip(),'candidateFixtureBlob':subprocess.check_output(['git','rev-parse',candidate+':'+dest],text=True).strip(),'legacyPublishedFixtureEqual':True})
specs=['apps/api/scripts/lib/memory-admin-self-approval-contract.spec.ts','apps/api/scripts/lib/memory-phase3-review-inbox-contract.spec.ts','apps/api/src/funding-opportunities/opportunity-explanation.spec.ts'];inverse=[]
for i,file in enumerate(specs):
    old=git(base,file);new=git(candidate,file);assert old==git(prior,file);assert new==(root/file).read_bytes()==git(published,file)
    restored=new
    if i<2:
        prefix=b'root' if i==0 else b'apiRoot'
        a=b"resolve("+prefix+b", 'scripts/lib/__fixtures__/legacy-ui-contracts', `${path}.txt`)";b=b"resolve("+prefix+b", '../web', path)"
        assert restored.count(a)==1;restored=restored.replace(a,b)
    else:
        for stem in ['FundingOpportunityV2ResultCard.tsx','funding-opportunities-domain.ts']:
            a=('__fixtures__/legacy-ui-contracts/'+stem+'.txt').encode();b=('../../../web/src/vnext/pages/funding-opportunities/'+stem).encode();assert restored.count(a)==1;restored=restored.replace(a,b)
    assert restored==old
    inverse.append({'path':file,'originalBytes':len(old),'candidateBytes':len(new),'originalSha256':h(old),'candidateSha256':h(new),'exactReaderOnlyInverse':True,'allCaseAssertionAndOpaqueCoreBytesPreserved':True})
source_delta=subprocess.check_output(['git','diff','--name-only',base,candidate,'--',':!docs'],text=True).splitlines();assert set(source_delta)==set(specs+[d for _,d in mapping])
orig=json.loads((ev/'02-original-destination-cached-env.jest.json').read_text());normal=json.loads((ev/'04-candidate-local-fixtures.jest.json').read_text());blocked=json.loads((ev/'05-candidate-web-unavailable.jest.json').read_text());
def case_map(data):return{(pathlib.Path(s['name']).name,a['fullName']):a['status'] for s in data['testResults'] for a in s['assertionResults']}
assert case_map(orig)==case_map(normal)==case_map(blocked);assert len(case_map(orig))==60
for r in [orig,normal,blocked]:assert r['numPassedTests']==59 and r['numFailedTests']==1 and r['numPendingTests']==0
readers=json.loads((ev/'05-candidate-web-unavailable.reader.json').read_text());assert readers['refused']==[];assert len(readers['fixtureReads'])==8 and len(set(readers['fixtureReads']))==7
baseline_block=json.loads((ev/'03-baseline-web-unavailable.jest.json').read_text());assert baseline_block['numTotalTestSuites']==3 and baseline_block['numTotalTests']==0 and baseline_block['numFailedTestSuites']==3
failed=[{'file':name[0],'case':name[1]} for name,status in case_map(orig).items() if status=='failed']
receipt={'base':base,'sourceHead':candidate,'sourceTree':subprocess.check_output(['git','rev-parse',candidate+'^{tree}'],text=True).strip(),'independentInitialBase':prior,'fixtures':fixtures,'specInverses':inverse,'exact10SourcePaths':source_delta,'allOtherTrackedSourceIncludingCurrent20QualificationPathsNineFixesSharedExportsSchemaAndFrontendUnchanged':True,'originalAndCandidateCases':60,'pass':59,'inheritedFail':1,'unchangedFailedCase':failed,'blockedWebProbe':{'baselineCollectionsRefused':3,'candidateBlockedReads':0,'candidateFixtureReads':8,'uniqueCandidateFixtures':7,'candidateSameCasesAndFailure':True},'claim':'Backend static input adoption and case/outcome preservation; inherited editor-literal RED remains open, not UI/native DB/frontend acceptance'}
(ev/'source-inverse-audit.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps({'fixtures':len(fixtures),'exactSpecInverses':len(inverse),'sourcePaths':len(source_delta),'cases':60,'pass':59,'inheritedFail':1,'blockedWebReads':0,'localFixtures':7}))
