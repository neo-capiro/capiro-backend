import subprocess,json,hashlib,base64,tarfile,io,re
from pathlib import Path,PurePosixPath
HEAD='3684613caf831cf62dc3759281a673134503f99a';SOURCE='37d574a35cd6d9aef79239a830b588fe1bd9769f';OLD='7949d079b1b46acf9c18c86898d6eedf9290428a';ROOT='docs/shared-newsletter-receiving-packed-distribution-20261013';FINAL=ROOT+'/qualified-37d574a3';OUT=Path(__file__).parent
read=lambda p,head=HEAD:subprocess.check_output(['git','show',head+':'+p])
js=lambda p:json.loads(read(p));sha=lambda b:hashlib.sha256(b).hexdigest()
rows=[]
def check(name,fn):
 try:detail=fn();rows.append(dict(name=name,passed=True,detail=detail))
 except Exception as e:rows.append(dict(name=name,passed=False,error=repr(e)))
def require(value,message='requirement refused'):
 assert value,message
 return True
artifact=read(FINAL+'/artifact/capiro-shared-0.0.0.tgz');historical=read(ROOT+'/artifact/capiro-shared-0.0.0.tgz')
def unpack(raw):
 with tarfile.open(fileobj=io.BytesIO(raw),mode='r:gz') as t:
  members=t.getmembers();data={};meta=[]
  for m in members:
   p=PurePosixPath(m.name)
   assert m.isfile() and len(p.parts)>1 and p.parts[0]=='package' and not p.is_absolute() and '..' not in p.parts
   assert m.name not in data and m.linkname==''
   b=t.extractfile(m).read();assert len(b)==m.size;data[m.name]=b;meta.append(dict(path=m.name,bytes=len(b),sha256=sha(b),mode=oct(m.mode)))
 return data,meta
entries,meta=unpack(artifact);oldEntries,oldMeta=unpack(historical);manifest=js(FINAL+'/PACKED-MANIFEST.json');qualification=js(FINAL+'/CONSUMER-QUALIFICATION.json');final=js(ROOT+'/FINAL-QUALIFICATION.json');index=js(ROOT+'/SHA256-INDEX.json')
check('exact final tarball digest, size and SRI',lambda:require(len(artifact)==532066 and sha(artifact)=='f23e28ffa0e1a62491c2e772717d185619d947ffcb00b9864dc45b3bc5d17237' and 'sha512-'+base64.b64encode(hashlib.sha512(artifact).digest()).decode()=='sha512-fGL8ntl0hsT8YaPg1iqTgzNLh5gWqDFK4PF1glqwixHdeF0rSjfEtP1ahE1Eq85AjTVOlrrpkAVLdJ+XO8Kc7A=='))
check('187 unique regular safe tar entries match every manifest byte/hash/mode',lambda:require(len(meta)==187 and sorted(meta,key=lambda x:x['path'])==manifest['packedEntries']))
check('final source/tree binding in pack, consumer and final receipt',lambda:require(all(x['sourceHead']==SOURCE and x['sourceTree']=='ea8adba9e132a9c0d498ff7a49e0249d14b1682c' for x in [manifest,qualification,final])))
check('two pack raw command results retain exact identical final integrity',lambda:require(len(manifest['packs'])==2 and all(x['sha256']==sha(artifact) and x['bytes']==len(artifact) and x['integrity']==final['artifact']['integrity'] for x in manifest['packs']) and all(json.loads(read(FINAL+'/evidence/03-npm-pack-'+str(i)+'.stdout.log'))[0]['integrity']==final['artifact']['integrity'] for i in [1,2])))
sourceBinding=js(FINAL+'/evidence/canonical-source-binding.json');bound=[]
for r in sourceBinding['canonicalFiles']:
 b=read(r['path'],SOURCE);require(sha(b)==r['sha256'] and len(b)==r['bytes']);require(subprocess.check_output(['git','rev-parse',SOURCE+':'+r['path']],text=True).strip()==r['gitBlob']);packed='package/'+r['path'].removeprefix('packages/shared/')
 if packed in entries:require(entries[packed]==b)
 bound.append(r['path'])
check('all copied source/config Git blobs and included source bytes bound to37',lambda:dict(count=len(bound),allExact=True))
package=json.loads(entries['package/package.json']);check('package metadata/export maps identical published original; no new subpath',lambda:require(entries['package/package.json']==read('packages/shared/package.json','c07d00e27fdda64dfbd13c36d0ac433c81d9f7f4')))
check('no corpus, fixture, native binary, cache, build-state or dependency package inside tar',lambda:require(not any('corpus' in p or 'fixture' in p or any(q in PurePosixPath(p).parts for q in ['node_modules','build-state','npm-cache']) or p.endswith(('.node','.wasm','.tgz','.tsbuildinfo')) for p in entries)))
check('map sources strictly relative and resolve to included package/src entries',lambda:require(all(m['sourceRoot']=='' and all(not PurePosixPath(s).is_absolute() and '/tmp/' not in s and '/workspace/' not in s and '..' not in PurePosixPath('package/src/'+s).parts[:-len(PurePosixPath(s).parts)] for s in m['sources']) for m in [json.loads(b) for p,b in entries.items() if p.endswith('.map')])))
# Resolve map paths using POSIX normalization, retaining actual package containment.
import posixpath
mapSources=[]
for name,b in entries.items():
 if name.endswith('.map'):
  m=json.loads(b);require(m.get('sourceRoot')=='')
  for s in m['sources']:
   resolved=posixpath.normpath(posixpath.join(posixpath.dirname(name),s));require(resolved.startswith('package/src/') and resolved in entries);mapSources.append(dict(map=name,source=s,resolved=resolved))
check('every source and declaration map resolves actual packed source',lambda:dict(mapEdges=len(mapSources),allPresent=True))
# All declaration bodies, not only newsletter or hash receipts, are compared directly.
dts=sorted(p for p in entries if p.endswith('.d.ts'));oldDts=sorted(p for p in oldEntries if p.endswith('.d.ts'));equal=[]
require(dts==oldDts)
for p in dts:equal.append(dict(path=p,bytes=len(entries[p]),sha256=sha(entries[p]),byteEqual794=entries[p]==oldEntries[p]))
check('all37 final declarations byte-equal794 consumed by Core',lambda:require(len(equal)==37 and all(r['byteEqual794'] for r in equal)))
# Independent physical emitted-body corroboration; this does not regenerate or execute clients.
for head,label in [(SOURCE,'37d574a3'),(OLD,'7949d079')]:
 stage=Path('/workspace/capiro-shared-newsletter-receiving-dist-'+label+'-20261013/packages/shared/dist')
 actual=sorted(str(f.relative_to(stage)) for f in stage.rglob('*.d.ts'))
 require(actual==[p.removeprefix('package/dist/') for p in dts]);require(all((stage/p.removeprefix('package/dist/')).read_bytes()==entries[p] for p in dts))
check('both original emission directories corroborate all declaration bytes',lambda:dict(declarationsEach=37,exact=True))
legacy=js(FINAL+'/DECLARATION-AND-LEGACY-CONTINUITY.json');check('declaration continuity receipt matches actual tar bytes',lambda:require(all(entries['package/'+r['path']]==oldEntries['package/'+r['path']] and sha(entries['package/'+r['path']])==r['sha256'] for r in legacy['allDeclarationBytesUnchanged'])))
verified=[]
for r in index['entries']:
 require(not PurePosixPath(r['path']).is_absolute() and '..' not in PurePosixPath(r['path']).parts);b=read(ROOT+'/'+r['path']);verified.append(dict(path=r['path'],passed=sha(b)==r['sha256'] and len(b)==r['bytes']))
check('all100 sealed author index entries verify against Git bytes',lambda:require(len(verified)==100 and all(r['passed'] for r in verified)))
# The full new artifact is distinct from the rejected intermediate and preserved legacy.
check('historical794 tar remains distinct and raw',lambda:require(sha(historical)=='4c293521172c5981e1d8fb2f049495da781b24a93883b68313230b186f90c291' and historical!=artifact))
old=read('docs/shared-newsletter-packed-distribution-20261012/artifact/capiro-shared-0.0.0.tgz');check('previous697d immutable artifact unchanged',lambda:require(sha(old)=='697d826647e88e7f8559da386be7de1ae6408dc61c73877b86c2e17275fd63ab'))
output=dict(artifactEvidenceHead=HEAD,artifactEvidenceTree='476a4d28a3abd222269e5b521ecb334b1d70cf56',sourceHead=SOURCE,tarball=dict(bytes=len(artifact),sha256=sha(artifact),integrity=final['artifact']['integrity'],entries=len(meta)),checks=rows,passed=sum(r['passed'] for r in rows),failed=sum(not r['passed'] for r in rows),declarations=equal,packedEntries=meta,sourcePaths=bound,verifiedAuthorEntries=verified,coreTypecheckReuse='Only declaration-surface equivalence to794; source provenance/typecheck authority remains root-owned.',noRepack=True,noProviderOrNative=True)
(OUT/'02-tar-source-declaration-audit.json').write_text(json.dumps(output,indent=2)+'\n');print(json.dumps({'checks':len(rows),'passed':output['passed'],'failed':output['failed'],'dts':len(equal),'entries':len(meta),'authorHashEntries':len(verified)},indent=2));raise SystemExit(bool(output['failed']))
