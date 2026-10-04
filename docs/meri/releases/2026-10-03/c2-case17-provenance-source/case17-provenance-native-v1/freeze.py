from pathlib import Path
import hashlib,json,subprocess,shutil,datetime
repo=Path('C:/dev/main/meri-c1-20261002');out=Path(__file__).parent
draft=out.parent/'case17-provenance-draft-v1'
prior=json.loads((draft/'supervised-v3-checkpoint.json').read_text())
paths=[x['path'] for x in prior['files']]
hash=lambda b:hashlib.sha256(b).hexdigest()
files=[]
for entry in prior['files']:
    f=repo/entry['path'];b=f.read_bytes();assert b'\r' not in b
    if not entry['path'].endswith('governed-memory-candidate.service.spec.ts'):assert hash(b)==entry['sha256']
    mirror=out/'source'/entry['path'];mirror.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(f,mirror)
    files.append({'path':str(f),'relativePath':entry['path'],'sha256':hash(b),'bytes':len(b),'baseSha256':entry['baseSha256'],'priorV3Sha256':entry['sha256'],'mirror':str(mirror)})
(out/'candidate.patch').write_bytes(subprocess.check_output(['git','diff','--binary','--',*paths],cwd=repo))
check=subprocess.run(['git','diff','--check','--',*paths],cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
(out/'diff-check.log').write_bytes(check.stdout);assert check.returncode==0
rows=[
('api-jest-initial.log',repo,'pnpm -C apps/api exec jest src/memory/governed-memory-candidate.service.spec.ts --runInBand --forceExit',0,{'passed':25}),
('web-vitest-initial.log',repo,'pnpm -C apps/web exec vitest run src/vnext/meri/MeriMemoryTab.targets.test.tsx src/vnext/meri/MeriMemoryTab.test.ts --poolOptions.threads.singleThread --testTimeout=20000 --hookTimeout=20000',0,{'passed':37,'suites':2}),
('api-typecheck-initial.log',repo,'pnpm -C apps/api exec tsc --noEmit --rootDir . --incremental false',134,{'failure':'Default 4GB Node heap exhausted'}),
('web-typecheck-initial.log',repo,'pnpm -C apps/web run typecheck',0,{}),
('api-typecheck-8gb.log',repo/'apps/api','node --max-old-space-size=8192 node_modules/typescript/bin/tsc --noEmit --rootDir . --incremental false',2,{'errors':7,'ownedSpecErrors':3,'unrelatedUnchangedSpecErrors':4}),
('api-jest-final.log',repo,'pnpm -C apps/api exec jest src/memory/governed-memory-candidate.service.spec.ts --runInBand --forceExit',0,{'passed':25}),
('api-typecheck-final.log',repo/'apps/api','node --max-old-space-size=8192 node_modules/typescript/bin/tsc --noEmit --rootDir . --incremental false',2,{'errors':4,'ownedSpecErrors':0,'unrelatedUnchangedSpecErrors':4}),
]
checks=[{'command':cmd,'cwd':str(cwd),'exitCode':code,'log':str(out/log),'sha256':hash((out/log).read_bytes()),**rest} for log,cwd,cmd,code,rest in rows]
(out/'checks.json').write_text(json.dumps(checks,indent=2)+'\n')
unchanged=[]
for p in ['apps/api/src/meri/meri-capture-clock-packets.spec.ts','apps/api/src/meri/meri-memory-proposal-read.spec.ts']:
    head=subprocess.check_output(['git','show','HEAD:'+p],cwd=repo);assert (repo/p).read_bytes()==head
    unchanged.append({'path':str(repo/p),'sha256':hash(head),'matchesHead':True})
checkpoint={'status':'FOCUSED_PASS_API_TYPECHECK_BLOCKED_BY_UNCHANGED_TESTS','frozenAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceHead':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo).decode().strip(),'sourcePatchSha256':hash((out/'candidate.patch').read_bytes()),'originalReviewedPatchSha256':hash((draft/'candidate-v3.patch').read_bytes()),'files':files,'checks':checks,'unchangedResidualErrorFiles':unchanged,'diffCheckExit':0,'changesAfterReviewedV3':['Only owned API spec: guard pre-existing optional fixture row before spreading it; optional-chain first returned candidate without weakening expected value; explicit mutable Jest.each tuple type.','Three production files and both Web files remain byte-identical to reviewed v3.'],'remaining':['API full typecheck still fails in two unchanged prior clock/proposal specs (four errors); not claimed PASS.','No immutable API/Web build, deployment or served Case17 verification.','No fixture/provider/auth/cloud/journal actions; original human rubric not assessed.'],'evidence':[]}
for p in sorted(out.iterdir()):
    if p.is_file() and p.name!='checkpoint.json':checkpoint['evidence'].append({'path':str(p),'sha256':hash(p.read_bytes()),'bytes':p.stat().st_size})
(out/'checkpoint.json').write_bytes((json.dumps(checkpoint,indent=2)+'\n').encode())
print(json.dumps({'checkpointSha256':hash((out/'checkpoint.json').read_bytes()),'patchSha256':checkpoint['sourcePatchSha256'],'files':files}))
