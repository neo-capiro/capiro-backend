import pathlib,subprocess,json,hashlib,re
root=pathlib.Path('/tmp/capirov2-cleanup-meri-local-dispatch-conversion')
evidence=root/'docs/cleanup-meri-application-authority-independent-review-20261013/evidence'
base='9db4e1cd5589a05e08fb88caa38a4ac44937def5';old='d5c121973438a29a65515496f395f4ad7568d006';source='579af9e4b826be308f0db289109c233350bbf34d';oldReceipt='870d69004975c6608c8c874db92e391b33db6fd7';receipt='4061ea3fd617c8ab6f8c616b68c31aabd5da2669'
authorPacket='docs/capiro-application-authority-source-20261013/'
def git(*args):return subprocess.check_output(['git',*args],cwd=root)
def content(head,path):return git('show',head+':'+path)
def sha(b):return hashlib.sha256(b).hexdigest()
oldIndex=json.loads(content(oldReceipt,authorPacket+'SHA256-INDEX.json'))
newIndex=json.loads(content(receipt,authorPacket+'TENANT-GRANT-SHA256-INDEX.json'))
assert oldIndex['source']==old and newIndex['source']==source
oldFiles=oldIndex['packetFiles'];newFiles=newIndex['newPacketFiles'];bindings=newIndex['sourceBindings']
assert len(oldFiles)==45 and len(newFiles)==15 and len(bindings)==8
assert len({r['path'] for r in oldFiles+newFiles})==60
assert len({r['path'] for r in bindings})==8
proofs=[]
for record in oldFiles+newFiles:
 p=record['path']; b=content(receipt,p)
 assert len(b)==record['bytes'] and sha(b)==record['sha256'],p
 assert (root/p).read_bytes()==b,p
 proofs.append({'path':p,'sha256':sha(b),'bytes':len(b),'physicalEqualsGit':True})
for record in oldFiles:
 assert content(oldReceipt,record['path'])==content(receipt,record['path'])
assert content(oldReceipt,authorPacket+'SHA256-INDEX.json')==content(receipt,authorPacket+'SHA256-INDEX.json')
sourceProofs=[]
for record in bindings:
 p=record['path'];b=content(source,p)
 assert sha(b)==record['sha256'] and git('rev-parse',source+':'+p).decode().strip()==record['gitBlob']
 assert content(receipt,p)==b and (root/p).read_bytes()==b
 sourceProofs.append({**record,'bytes':len(b),'receiptAndPhysicalEqualSource':True})
expected=sorted(r['path'] for r in bindings)
changed=git('diff','--name-only',base,source).decode().splitlines()
assert sorted(p for p in changed if not p.startswith('docs/'))==expected
assert sorted(p for p in git('diff','--name-only',old,source).decode().splitlines() if not p.startswith('docs/'))==sorted(['apps/api/src/auth/application-authority.spec.ts','apps/api/src/context/context-security-scope.service.ts'])
# A consumed file is reused only if its ENTIRE byte sequence is unchanged.
reused=[]
for label,paths in [
 ('original composition and Proxy four-case replay',['apps/api/src/auth/application-authority.ts','apps/api/src/tenant/tenant-context.middleware.ts','apps/api/src/meri/meri.service.ts']),
 ('41 independent Clerk/session/tenant/impersonation owner controls',['apps/api/src/auth/application-authority.ts','apps/api/src/auth/clerk.service.ts','apps/api/src/tenant/tenant-context.middleware.ts'])]:
 for p in paths:
  assert content(old,p)==content(source,p)
  reused.append({'test':label,'path':p,'sha256':sha(content(source,p)),'entireFileByteExactD5To579':True})
oldJest=json.loads((evidence/'05-d5-actual63-jest.json').read_text());newJest=json.loads((evidence/'11-579-actual64-jest.json').read_text())
oldCases=[a['fullName'] for suite in oldJest['testResults'] for a in suite['assertionResults']]
newCases=[a['fullName'] for suite in newJest['testResults'] for a in suite['assertionResults']]
dynamic=re.compile(r'^(actual Clerk owner bounded read-only session assertion refuses current session createdAt=)[0-9]{13}$')
assert sum(bool(dynamic.match(c)) for c in oldCases)==1 and sum(bool(dynamic.match(c)) for c in newCases)==1
normalize=lambda c:dynamic.sub(r'\1<clock-derived future timestamp>',c)
normalizedOld=[normalize(c) for c in oldCases];normalizedNew=[normalize(c) for c in newCases]
assert len(oldCases)==63 and len(newCases)==64
assert [c for c in normalizedNew if c in normalizedOld]==normalizedOld

assert all(a['status']=='passed' for suite in newJest['testResults'] for a in suite['assertionResults'])
assert newJest['numFailedTests']==0 and newJest['numPendingTests']==0
newCasesOnly=[c for c in normalizedNew if c not in normalizedOld];assert len(newCasesOnly)==1
r={'acceptedSource':source,'tree':git('rev-parse',source+'^{tree}').decode().strip(),'authorEvidence':receipt,'authorEvidenceTree':git('rev-parse',receipt+'^{tree}').decode().strip(),'original45AndOriginalIndexByteExact':True,'oldPacketFilesVerified':45,'newPacketFilesVerified':15,'latestSourceBindingsVerified':8,'indexedPacketFiles':proofs,'sourceBindings':sourceProofs,'scopeExactly8CodeAndTestPaths':True,'d5To579OnlyTwoApprovedSourcePaths':True,'unchangedConsumedClosureReuse':reused,'actual64AllPassed':True,'all63OriginalCasesAndOrderRetained':True,'caseNameQualifier':'One unchanged test uses createdAt=Date.now()+1_000_000 in its name; only that single full anchored 13-digit clock value was normalized for both runs. Actual raw names remain unchanged in the two JSON receipts.','newPermanentCase':newCasesOnly,'privateBodiesCopied':False,'appDatabaseProviderOrCredentialExecution':False}
p=evidence/'16-final-custody-and-reuse.json';assert not p.exists();p.write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps({'oldPacketFiles':45,'newPacketFiles':15,'sourceBindings':8,'reuseBindings':len(reused),'actualCases':len(newCases),'newCases':len(newCasesOnly),'allPass':True}))
