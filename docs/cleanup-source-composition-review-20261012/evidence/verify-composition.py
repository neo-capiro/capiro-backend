import subprocess,json,hashlib,re
from pathlib import Path
BASE='1bf52945b9fa01496ce41a349f8eaace490ad4ac';PE='fbdba6db6a995845727f4b57007da0a7f6aa5a6c';CLOCK='acd663314fffcad32e64e20217da6f4b018e8599';UNION='d70bb9724cf06dfee4863037d295942a9624b7ac';MAIN='4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace'
OUT=Path('docs/cleanup-source-composition-review-20261012/evidence')
def git(*args):return subprocess.check_output(['git',*args])
def ancestor(head,target=UNION):return subprocess.run(['git','merge-base','--is-ancestor',head,target],capture_output=True).returncode==0
def tree(head):
 result={}
 for record in git('ls-tree','-rz',head).split(b'\0'):
  if not record:continue
  meta,path=record.split(b'\t',1);mode,kind,blob=meta.decode().split();result[path.decode()]={'mode':mode,'kind':kind,'blob':blob}
 return result
def delta(a,b):return sorted(path for path in a.keys()|b.keys() if a.get(path)!=b.get(path))
def source(paths):return [path for path in paths if not path.startswith('docs/')]
base,pe,clock,union=map(tree,[BASE,PE,CLOCK,UNION]);pePaths=source(delta(base,pe));clockPaths=source(delta(base,clock));unionPaths=source(delta(base,union))
assert len(pePaths)==4;assert len(clockPaths)==18;assert len(unionPaths)==22;assert set(pePaths).isdisjoint(clockPaths);assert unionPaths==sorted(pePaths+clockPaths)
parents=git('rev-list','--parents','-n','1',UNION).decode().strip().split()[1:];assert parents==[PE,CLOCK]
assert ancestor(BASE) and ancestor(PE) and ancestor(CLOCK) and ancestor(MAIN)
common=git('merge-base',PE,CLOCK).decode().strip();assert common==BASE
records=[]
for role,head,ownerTree,paths in [('public-law',PE,pe,pePaths),('clock-rng',CLOCK,clock,clockPaths)]:
 for path in paths:
  assert union[path]==ownerTree[path]
  blob=git('show',UNION+':'+path)
  records.append({'path':path,'owner':role,'publishedHead':head,'mode':union[path]['mode'],'gitBlob':union[path]['blob'],'sha256':hashlib.sha256(blob).hexdigest(),'bytes':len(blob)})
unchanged=[p for p in base if p not in unionPaths and base[p]==union.get(p)]
changedOutsideUnion=[p for p in base if p not in unionPaths and base[p]!=union.get(p)];assert changedOutsideUnion==[]
baseDocs=[p for p in base if p.startswith('docs/')];assert all(base[p]==union.get(p) for p in baseDocs)
newSource=[p for p in union if p not in base and not p.startswith('docs/')];assert set(newSource).issubset(unionPaths)
schemasMigrations=[p for p in base if p.endswith('.prisma') or '/migrations/' in p];assert all(base[p]==union.get(p) for p in schemasMigrations)
packetPrefixes=['docs/rebuild-integrated-rc-20261012/','docs/cleanup-source-gates-20261012/','docs/cleanup-executable-prereqs-20261012/'];packetPaths=[p for p in base if any(p.startswith(prefix) for prefix in packetPrefixes)];assert all(base[p]==union.get(p) for p in packetPaths)
addedPeDocs=[p for p in delta(base,pe) if p.startswith('docs/')];addedClockDocs=[p for p in delta(base,clock) if p.startswith('docs/')]
for p in addedPeDocs:assert union[p]==pe[p]
for p in addedClockDocs:assert union[p]==clock[p]
docOverlap=sorted(set(addedPeDocs)&set(addedClockDocs));assert all(pe[p]==clock[p] for p in docOverlap)
release=json.loads(git('show',UNION+':docs/rebuild-integrated-rc-20261012/RELEASE-MANIFEST.json'))
candidates=[]
for ref in release['candidateRefs']:
 result={k:ref[k] for k in ['pr','head','inclusion']};result['actualAncestor']=ancestor(ref['head'])
 if 'full original history retained as an ancestor' in ref['inclusion']:assert result['actualAncestor'],result
 else:result['historyPolicy']='Published selective carrier remains an immutable referenced source; no invented full merge ancestry.'
 candidates.append(result)
sourceManifests=[]
for name,owner,expected in [('docs/cleanup-public-law-containment-20261012/SOURCE-MANIFEST.json',PE,4),('docs/cleanup-clock-injection-20261012/SOURCE-MANIFEST.json',CLOCK,18)]:
 manifest=json.loads(git('show',UNION+':'+name));items=manifest.get('files',manifest.get('paths'));assert len(items)==expected
 for item in items:
  blob=git('show',UNION+':'+item['path']);assert hashlib.sha256(blob).hexdigest()==item['sha256'];assert union[item['path']]['blob']==item.get('gitBlob',item.get('blob'))
 sourceManifests.append({'path':name,'entriesVerified':len(items),'owner':owner,'manifestBlob':union[name]['blob']})
remote=[]
for number,head in [(2409,PE),(2410,CLOCK)]:
 info=json.loads((OUT/f'remote-pr{number}.json').read_text());assert info['head']==head;assert info['draft'] and info['state']=='open' and not info['merged'];assert info['base_sha']==BASE;remote.append(info)
mainInfo=json.loads((OUT/'remote-main.json').read_text());assert mainInfo['sha']==MAIN
result={'acceptedCompositionSource':UNION,'tree':git('rev-parse',UNION+'^{tree}').decode().strip(),'commonBase':BASE,'parents':parents,'publishedSourcePaths':{'publicLaw':4,'clockRng':18,'union':22,'overlap':[]},'sourceUnionRecords':records,'onlyNonDocDeltaIsExactUnion':True,'outsideUnionBasePathsByteIdentical':len(unchanged),'allBaseDocumentationPathsUnchanged':len(baseDocs),'schemaMigrationPathsUnchanged':len(schemasMigrations),'originalImmutablePacketPathsUnchanged':len(packetPaths),'publishedPublicLawDocumentationPreserved':len(addedPeDocs),'publishedClockDocumentationPreserved':len(addedClockDocs),'publishedNewDocOverlap':docOverlap,'sourceManifestsVerified':sourceManifests,'originalCandidateHistoryEvidence':candidates,'remotePublishedHeads':remote,'remoteMain':mainInfo,'compositionReviewBranch':git('symbolic-ref','--short','HEAD').decode().strip(),'runtimeChecksExecuted':False,'unpublishedReportingAccessed':False,'nativeAcceptance':False,'wholeCleanupAcceptance':False}
(OUT/'composition-verification.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:result[k] for k in ['acceptedCompositionSource','tree','publishedSourcePaths','outsideUnionBasePathsByteIdentical','allBaseDocumentationPathsUnchanged','schemaMigrationPathsUnchanged','originalImmutablePacketPathsUnchanged','publishedPublicLawDocumentationPreserved','publishedClockDocumentationPreserved','publishedNewDocOverlap']},indent=2))
