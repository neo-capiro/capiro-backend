import hashlib,io,json,pathlib,subprocess
repo=pathlib.Path('C:/dev/main/meri-closeout-c0-20261002')
root=pathlib.Path('C:/dev/main/outputs/meri-c0-completion-20261002')
read=lambda p:json.loads(p.read_text(encoding='utf-8-sig'))
sha=lambda b:hashlib.sha256(b).hexdigest()
git=lambda *a:subprocess.check_output(['git',*a],cwd=repo)
result=read(root/'schema-result.json');x=result['receipts'][0]
assert result['exitCode']==0 and x['readOnly'] and x['tlsVerified'] and x['mutations']==0
assert x['missingSourceMigrations']==[] and x['ambiguousSourceMigrations']==[] and x['unfinished']==[]
def source_manifest(ref):
 paths=sorted(p for p in git('ls-tree','-r','--name-only',ref,'apps/api/prisma/migrations').decode().splitlines() if p.endswith('/migration.sql'))
 stream=io.BytesIO(subprocess.check_output(['git','cat-file','--batch'],cwd=repo,input=''.join(ref+':'+p+'\n' for p in paths).encode()))
 manifest=[]
 for p in paths:
  header=stream.readline().decode().strip().split();assert len(header)==3 and header[1]=='blob'
  b=stream.read(int(header[2]));assert stream.read(1)==b'\n'
  manifest.append({'name':p.split('/')[-2],'sha256':sha(b)})
 return manifest
api=read(root/'api-current.json')
assert source_manifest(api['sourceSha'])==x['packagedManifest']
assert source_manifest('723735ed1f5c562ab10e6077c67261285ea102fd')==x['packagedManifest']
assert source_manifest(api['previousArtifact']['sourceSha'])==x['packagedManifest']
old_path=repo/'docs/meri/releases/2026-10-02/memory-kind-release/forward450-verified/forward450-diagnostic-execution.json'
old=read(old_path)['ownerReceipts'][0]['ledger']['historicalChecksumDifferences']
old_normalized=[{'name':r['name'],'source':r['sourceSha256'],'applied':r['appliedSha256']} for r in old]
assert old_normalized==x['historicalChecksumDifferences']
compat=read(repo/'docs/meri/releases/2026-10-02/memory-kind-release/forward450-verified/compatibility-addendum.json')
checks={c['conname']:sha(c['definition'].encode()) for c in x['constraints']}
assert all(c['convalidated'] for c in x['constraints']) and checks==compat['afterCheckSha256']
assert len(x['syntheticFixtureClaims'])==4 and all(c['present'] and c['status']=='STARTED' for c in x['syntheticFixtureClaims'].values())
cleanup=read(root/'schema-cleanup.json');assert cleanup['taskStopped'] and cleanup['status']=='INACTIVE'
assessment={'status':'PASS_BASELINE_READBACK_WITH_HISTORICAL_DRIFT_RETAINED','schemaMutations':0,'sourceApi':api['sourceSha'],'sourceMain':'723735ed1f5c562ab10e6077c67261285ea102fd','apiRollbackSource':api['previousArtifact']['sourceSha'],'packagedSourceMigrations':len(x['packagedManifest']),'packagedManifestMatchesApiSource':True,'packagedManifestMatchesMain':True,'packagedManifestMatchesApiRollback':True,'allSourceMigrationNamesApplied':True,'unfinishedMigrations':0,'ledgerRows':len(x['ledger']),'activeLedgerRows':sum(bool(r['finished_at']) and not r['rolled_back_at'] for r in x['ledger']),'rolledBackHistoricalRows':sum(bool(r['rolled_back_at']) for r in x['ledger']),'checksumDifferences':len(old),'checksumDifferencesExactlyMatchHistoricalDiagnostic':True,'historicalDiagnostic':str(old_path.relative_to(repo)).replace('\\','/'),'currentConstraintHashesMatchQualifiedForward450':checks,'currentSyntheticClaims':x['syntheticFixtureClaims'],'claimHashAlgorithm':'SHA256(JSON.stringify(value)); current observation only, not compared to old canonical-sorted claim hashes','rollbackLimit':'Artifact availability and migration-tree compatibility are verified; no rollback rehearsal or general database drift repair was performed. Retain current API/web for the next orchestrator-only C1 patch.','taskCleanupVerified':True}
(root/'schema-assessment.json').write_text(json.dumps(assessment,indent=2)+'\n',encoding='utf-8',newline='\n')
print(json.dumps({'status':assessment['status'],'migrations':451,'historicalDifferencesUnchanged':61,'liveClaims':'4 STARTED; preserved','cleanup':'STOPPED/INACTIVE'}))
