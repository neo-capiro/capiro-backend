"""Continue approved tar retrieval after retained inert lifecycle-inventory assertion."""
import base64, hashlib, io, json, pathlib, tarfile, urllib.request
E=pathlib.Path(__file__).resolve().parent
R=pathlib.Path('/tmp/capiro-coverage-provider-cache-277-20261012')
CAP=5*1024*1024
initial=json.loads((E/'locked-coverage-provider-retrieval.json').read_text())
g=json.loads((E/'coverage-provider-cache-graph.json').read_text())
records=[]
def used(): return sum(p.stat().st_size for p in R.rglob('*') if p.is_file())
for node in g['missing']:
 name,version,sri=node['name'],node['version'],node['integrity']
 url=f'https://registry.npmjs.org/{name}/-/{name.rsplit("/",1)[-1]}-{version}.tgz'
 path=R/(name.replace('/','+')+'-'+version+'.tgz')
 dest=R/'packages'/(name.replace('/','+')+'@'+version)
 record=dict(name=name,version=version,url=url,expectedIntegrity=sri)
 records.append(record)
 try:
  prior=next((x for x in initial['records'] if x['name']==name),None)
  if path.exists():
   data=path.read_bytes();record.update(status=prior['status'],finalUrl=prior['finalUrl'],retainedOriginalGET=True)
  else:
   assert used()<CAP
   with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'capiro-locked-dependency-audit/1'}),timeout=30) as response:
    record.update(status=response.status,finalUrl=response.url,contentLength=response.headers.get('Content-Length'))
    assert response.url==url
    data=response.read(1024*1024+1)
   assert len(data)<=1024*1024 and used()+len(data)<CAP
  actual='sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode()
  assert actual==sri,'Locked SRI mismatch'
  record.update(actualIntegrity=actual,tarballBytes=len(data),tarballSha256=hashlib.sha256(data).hexdigest(),integrityVerifiedBeforeExtraction=True)
  if not path.exists():path.write_bytes(data)
  entries=[]
  with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as tar:
   members=tar.getmembers();seen=set()
   for m in members:
    p=pathlib.PurePosixPath(m.name)
    assert not p.is_absolute() and '..' not in p.parts and p.parts[0]=='package'
    assert m.name not in seen;seen.add(m.name)
    if m.isdir():continue
    assert m.isfile() and p.suffix.lower() not in ['.node','.so','.dll','.dylib','.exe']
    content=tar.extractfile(m).read();target=dest.joinpath(*p.parts[1:])
    if target.exists():assert target.read_bytes()==content
    else:
     assert used()+len(content)<=CAP
     target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
    entries.append(dict(path=str(p.relative_to('package')),bytes=len(content),tarMode=oct(m.mode),physicalMode=oct(target.stat().st_mode&0o777),sha256=hashlib.sha256(content).hexdigest()))
  package=json.loads((dest/'package.json').read_text())
  assert package['name']==name and package['version']==version
  hooks={k:v for k,v in package.get('scripts',{}).items() if k in ['preinstall','install','postinstall','prepare','prepack']}
  record.update(privatePackageDir=str(dest),entries=entries,packageJsonSha256=hashlib.sha256((dest/'package.json').read_bytes()).hexdigest(),lifecycleScriptsDeclared=hooks,lifecycleExecuted=False,statusOutcome='retrieved-verified-not-installed')
 except Exception as error:
  record.update(statusOutcome='failed',errorType=type(error).__name__,error=str(error))
  (E/'locked-coverage-provider-continuation.json').write_text(json.dumps(dict(records=records,privateBytesUsed=used(),capBytes=CAP),indent=2)+'\n')
  raise
result=dict(sourceHead=g['sourceHead'],lockSha256=g['lockSha256'],records=records,privateRoot=str(R),privateBytesUsed=used(),capBytes=CAP,noInstallerOrLifecycle=True,noSourceLockGlobalChanges=True,initialFailureRetained='locked-coverage-provider-retrieval.json')
(E/'locked-coverage-provider-continuation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(dict(packages=len(records),privateBytesUsed=used(),integrityAllVerified=True,lifecycleExecuted=False),indent=2))
