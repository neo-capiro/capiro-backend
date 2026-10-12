import pathlib,subprocess,json,hashlib
root=pathlib.Path(__file__).resolve().parents[3];p=pathlib.Path(__file__).resolve().parent
base='d587441261fd356ee5144a8fc29cb2f771d062b8';proposal='67fa9255b8a73f489d7a57c8fe270ed6d03fa016'
source='apps/web/src/vnext/pages/engagement/outreach-v3-skeleton-editing.ts'
fixture='apps/api/src/outreach-v3/state/__fixtures__/legacy-ui-contracts/outreach-v3-skeleton-editing.ts.txt'
reader='apps/api/src/outreach-v3/state/outreach-content-skeleton-boundaries.spec.ts'
control='scripts/ci/outreach-skeleton-owned-input.spec.mjs'
def get(ref,path):return subprocess.check_output(['git','show',f'{ref}:{path}'],cwd=root)
def sha(data):return hashlib.sha256(data).hexdigest()
def blob(data):return hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
original=get(base,reader)
before="join(\n      process.cwd(),\n      '..',\n      'web',\n      'src',\n      'vnext',\n      'pages',\n      'engagement',\n      'outreach-v3-skeleton-editing.ts',\n    )"
after="join(__dirname, '__fixtures__/legacy-ui-contracts/outreach-v3-skeleton-editing.ts.txt')"
assert original==(root/reader).read_bytes() and original.decode().count(before)==1
candidate=get(proposal,reader);assert original.decode().replace(before,after).encode()==candidate
assert get(proposal,fixture)==get(base,source)==(root/source).read_bytes()
assert not (root/fixture).exists() and not (root/control).exists()
rows=[{'path':path,'sha256':sha(get(proposal,path)),'blob':blob(get(proposal,path)),'bytes':len(get(proposal,path))} for path in [fixture,reader,control]]
manifest={'base':base,'baseTree':subprocess.check_output(['git','rev-parse',f'{base}^{{tree}}'],cwd=root,text=True).strip(),'proposal':proposal,'paths':rows,'originalSource':{'path':source,'sha256':sha(get(base,source)),'blob':blob(get(base,source))},'originalReader':{'path':reader,'sha256':sha(original),'blob':blob(original),'readOperand':before,'newReadOperand':after},'onlyReaderOperandChange':True,'fixtureExactCurrentWeb':True,'publishedControlUnchanged':True,'newDeniedDetailedReportReadOrCopied':False}
(p/'SOURCE-MANIFEST.json').write_text(json.dumps(manifest,indent=2)+'\n')
for row in rows:
    path=root/row['path'];path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(get(proposal,row['path']))
print(json.dumps({'paths':len(rows),'allPublishedCodeExact':True,'inverseReaderOriginalExact':True,'fixtureCurrentWebExact':True},indent=2))
