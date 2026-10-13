from pathlib import Path
import hashlib, json, re, subprocess

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).parent
AUTHOR = ROOT / 'docs/newsletter-declared-header-contract-adaptation-20261013'
BASE = '523ef9167f05a33efdbdfbbfc08d5fc2e2679012'
SOURCE = 'bdcb6b4e02b6394fd24dbb709e17648d77caa88c'
EVIDENCE = 'fd93f18f1f609e989706b8d19e0064ee63c84fa9'
PATHS = ['scripts/ci/newsletter-declared-edge.contract.spec.mjs', 'scripts/lib/newsletter-declared-edge-contract.mjs']
def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)
def sha(b):
    return hashlib.sha256(b).hexdigest()
def blob(b):
    return hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
index = json.loads((AUTHOR/'SHA256-INDEX.json').read_bytes())
for row in index['entries']:
    b = (AUTHOR/row['path']).read_bytes()
    assert len(b)==row['bytes'] and sha(b)==row['sha256'], row['path']
    assert git('show', EVIDENCE+':'+str((AUTHOR/row['path']).relative_to(ROOT)))==b
bindings = json.loads((AUTHOR/'evidence/CURRENT-BINDINGS.json').read_bytes())
model = git('show', SOURCE+':'+PATHS[1])
spec = git('show', SOURCE+':'+PATHS[0])
assert model==(AUTHOR/'evidence/candidate-model.mjs').read_bytes()
assert spec==(AUTHOR/'evidence/candidate-spec.mjs').read_bytes()
donor = (AUTHOR/'evidence/donor-model.mjs').read_bytes()
donor_spec = (AUTHOR/'evidence/donor-spec.mjs').read_bytes()
old = (AUTHOR/'evidence/pr2440-before-model.mjs').read_bytes()
old_spec = (AUTHOR/'evidence/pr2440-before-spec.mjs').read_bytes()
assert old.replace(b'const lower = {};', b'const lower = Object.create(null);')==donor
for name in ['DONOR-BINDINGS.json', 'BEFORE-BINDINGS.json']:
    for row in json.loads((AUTHOR/'evidence'/name).read_bytes())['files']:
        b=(AUTHOR/'evidence'/row['raw']).read_bytes()
        assert blob(b)==row.get('gitBlob',row.get('blob')) and len(b)==row['bytes'] and sha(b)==row['sha256']
inverse=model.replace(BASE.encode(),b'1090322d9a4067b605e91afef10cef5f86900b61')
inputs=[]
for row in bindings['sources']:
    new=f"{{ path: '{row['path']}', bytes: {row['bytes']}, sha256: '{row['sha256']}' }}".encode()
    previous=f"{{ path: '{row['path']}', bytes: {row['donorBytes']}, sha256: '{row['donorSha256']}' }}".encode()
    assert inverse.count(new)==1
    inverse=inverse.replace(new,previous)
    b=git('show',BASE+':'+row['path'])
    assert blob(b)==row['blob'] and sha(b)==row['sha256'] and len(b)==row['bytes']
    assert git('show',SOURCE+':'+row['path'])==b
    inputs.append({**row,'mode':git('ls-tree',SOURCE,'--',row['path']).decode().split()[0]})
assert inverse==donor
assert spec.replace(BASE.encode(),b'1090322d9a4067b605e91afef10cef5f86900b61')==donor_spec
begin=donor_spec.index(b"test('special-name case-variant header duplicates refuse")
end=donor_spec.index(b"test('header ambiguity and forged projection objects refuse")
assert donor_spec[:begin]+donor_spec[end:]==old_spec
def tree(ref):
    result={}
    for line in git('ls-tree','-r',ref).splitlines():
        meta,path=line.split(b'\t',1);result[path.decode()]=meta.decode()
    return result
base_tree, source_tree=tree(BASE),tree(SOURCE)
changed=sorted(p for p in base_tree.keys()|source_tree.keys() if base_tree.get(p)!=source_tree.get(p))
assert changed==PATHS
assert git('merge-base','--is-ancestor',SOURCE,EVIDENCE)==b''
for label, content in [('after',model),('before',model.replace(b'const lower = Object.create(null);',b'const lower = {};'))]:
    stage=HERE/label
    for p,b in [(PATHS[1],content),(PATHS[0],spec)]+[(row['path'],git('show',BASE+':'+row['path'])) for row in inputs]:
        dest=stage/p;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(b)
    assert len(list(stage.rglob('*.*')))==11
receipt={'base':BASE,'source':SOURCE,'sourceTree':git('rev-parse',SOURCE+'^{tree}').decode().strip(),
 'author':EVIDENCE,'authorHashesVerified':len(index['entries']),'sourcePaths':PATHS,
 'outsideTwoPathsExact':len(base_tree),'sourceModes':[{ 'path':p,'entry':source_tree[p]} for p in PATHS],
 'current9OpaqueInputs':inputs,'changedDonorPins':[r['path'] for r in inputs if r['byteChangedFromDonorPin']],
 'modelInverseDonorExact':True,'modelDonorInverseSingleNullPrototypeLineExact':True,
 'specInverseDonorExact':True,'removeTwoAddedCasesRestoresEntirePublishedBeforeSpec':True,
 'donorAndBeforeFourGitBlobHashesVerified':True,'authorSourceIsActualAncestor':True,
 'protectedReportingBodyRead':False,'deniedReportRead':False,'sourceInputBodiesExecuted':False}
(HERE/'preservation.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'verifiedAuthorHashes':len(index['entries']),'sourcePaths':changed,'outsideTwoPathsExact':len(base_tree),'currentOpaqueInputs':len(inputs),'inverses':True}))
