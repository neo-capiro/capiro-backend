import subprocess,pathlib,json,hashlib
root=pathlib.Path(__file__).resolve().parents[3]
p=pathlib.Path(__file__).resolve().parent
proposal='d09429a509d5b3cc2501f3736e619723e4b2c4c0'
base='d587441261fd356ee5144a8fc29cb2f771d062b8'
fixtures={
'apps/api/scripts/lib/__fixtures__/legacy-ui-contracts/src/components/MemoryFileEditor.tsx.txt':'apps/web/src/components/MemoryFileEditor.tsx',
'apps/api/scripts/lib/__fixtures__/legacy-ui-contracts/src/components/MemoryGovernanceCenterHost.tsx.txt':'apps/web/src/components/MemoryGovernanceCenterHost.tsx',
'apps/api/scripts/lib/__fixtures__/legacy-ui-contracts/src/components/MemoryReviewInbox.tsx.txt':'apps/web/src/components/MemoryReviewInbox.tsx',
'apps/api/scripts/lib/__fixtures__/legacy-ui-contracts/src/components/PendingMemoryReviewPanel.tsx.txt':'apps/web/src/components/PendingMemoryReviewPanel.tsx',
'apps/api/scripts/lib/__fixtures__/legacy-ui-contracts/src/pages/settings/MemorySettingsPage.tsx.txt':'apps/web/src/pages/settings/MemorySettingsPage.tsx',
'apps/api/src/funding-opportunities/__fixtures__/legacy-ui-contracts/FundingOpportunityV2ResultCard.tsx.txt':'apps/web/src/vnext/pages/funding-opportunities/FundingOpportunityV2ResultCard.tsx',
'apps/api/src/funding-opportunities/__fixtures__/legacy-ui-contracts/funding-opportunities-domain.ts.txt':'apps/web/src/vnext/pages/funding-opportunities/funding-opportunities-domain.ts',
}
readers=[
('apps/api/scripts/lib/memory-admin-self-approval-contract.spec.ts',[("const readWeb = (path: string) => readFileSync(resolve(root, '../web', path), 'utf8');", "const readWeb = (path: string) => readFileSync(resolve(root, 'scripts/lib/__fixtures__/legacy-ui-contracts', `${path}.txt`), 'utf8');")]),
('apps/api/scripts/lib/memory-phase3-review-inbox-contract.spec.ts',[("const readWeb = (path: string) =>\n  readFileSync(resolve(apiRoot, '../web', path), 'utf8');", "const readWeb = (path: string) =>\n  readFileSync(resolve(apiRoot, 'scripts/lib/__fixtures__/legacy-ui-contracts', `${path}.txt`), 'utf8');")]),
('apps/api/src/funding-opportunities/opportunity-explanation.spec.ts',[("'../../../web/src/vnext/pages/funding-opportunities/FundingOpportunityV2ResultCard.tsx'", "'__fixtures__/legacy-ui-contracts/FundingOpportunityV2ResultCard.tsx.txt'"),("'../../../web/src/vnext/pages/funding-opportunities/funding-opportunities-domain.ts'", "'__fixtures__/legacy-ui-contracts/funding-opportunities-domain.ts.txt'")])]
def get(ref,path):return subprocess.check_output(['git','show',f'{ref}:{path}'],cwd=root)
def sha(v):return hashlib.sha256(v).hexdigest()
def blob(v):return hashlib.sha1(b'blob '+str(len(v)).encode()+b'\0'+v).hexdigest()
rows=[]
for target,source in fixtures.items():
    original=get(base,source);candidate=get(proposal,target)
    assert candidate==original==(root/source).read_bytes()
    assert not (root/target).exists()
    rows.append({'path':target,'source':source,'bytes':len(candidate),'sha256':sha(candidate),'blob':blob(candidate),'sourceExact':True,'proposalExact':True})
for target,replacements in readers:
    original=get(base,target);candidate=get(proposal,target)
    assert original==(root/target).read_bytes()
    value=original.decode()
    for before,after in replacements:
        assert value.count(before)==1
        value=value.replace(before,after)
    assert value.encode()==candidate
    rows.append({'path':target,'originalSha256':sha(original),'originalBlob':blob(original),'sha256':sha(candidate),'blob':blob(candidate),'bytes':len(candidate),'replacements':[{'before':b,'after':a} for b,a in replacements],'onlyReadOperandsChanged':True,'proposalExact':True})
(p/'SOURCE-MANIFEST.json').write_text(json.dumps({'base':base,'baseTree':subprocess.check_output(['git','rev-parse',f'{base}^{{tree}}'],cwd=root,text=True).strip(),'proposal':proposal,'fixtures':rows[:7],'readers':rows[7:]},indent=2)+'\n')
for row in rows:
    data=get(proposal,row['path']);target=root/row['path'];target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
print(json.dumps({'paths':len(rows),'fixturesExactCurrentWeb':7,'readerOnlyReadOperandDelta':3,'allProposalExact':True},indent=2))
