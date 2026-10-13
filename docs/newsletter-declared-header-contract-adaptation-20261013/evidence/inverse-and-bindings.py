from pathlib import Path
import re,json,hashlib,subprocess
p=Path(__file__).parent;base='523ef9167f05a33efdbdfbbfc08d5fc2e2679012';head='bdcb6b4e02b6394fd24dbb709e17648d77caa88c';bindings=json.loads((p/'CURRENT-BINDINGS.json').read_text());donor=(p/'donor-model.mjs').read_text();before=(p/'pr2440-before-model.mjs').read_text();candidate=(p/'candidate-model.mjs').read_text();spec=(p/'candidate-spec.mjs').read_text();oldhead='1090322d9a4067b605e91afef10cef5f86900b61'
assert before.replace('const lower = {};','const lower = Object.create(null);')==donor
inverse=candidate.replace(base,oldhead)
for r in bindings['sources']:
 new=f"{{ path: '{r['path']}', bytes: {r['bytes']}, sha256: '{r['sha256']}' }}";old=f"{{ path: '{r['path']}', bytes: {r['donorBytes']}, sha256: '{r['donorSha256']}' }}";assert inverse.count(new)==1;inverse=inverse.replace(new,old)
assert inverse==donor;assert spec.replace(base,oldhead)==(p/'donor-spec.mjs').read_text()
entries=[]
for r in bindings['sources']:
 b=subprocess.check_output(['git','show',base+':'+r['path']]);assert len(b)==r['bytes'] and hashlib.sha256(b).hexdigest()==r['sha256'];assert b==(Path(bindings['ownedInertStage'])/r['path']).read_bytes();assert subprocess.check_output(['git','rev-parse',head+':'+r['path']],text=True).strip()==r['blob'];entries.append(r)
expected=['scripts/ci/newsletter-declared-edge.contract.spec.mjs','scripts/lib/newsletter-declared-edge-contract.mjs'];assert subprocess.check_output(['git','diff','--name-only',base,head],text=True).splitlines()==expected
for path,file in [('scripts/lib/newsletter-declared-edge-contract.mjs','candidate-model.mjs'),('scripts/ci/newsletter-declared-edge.contract.spec.mjs','candidate-spec.mjs')]:assert subprocess.check_output(['git','show',head+':'+path])==(p/file).read_bytes()
def cases(name):
 data=(p/name).read_text();return [re.sub(r' \([^\n]+ms\)$','',line[2:]) for line in data.splitlines() if line.startswith(('✔ ','✖ ')) and not line.startswith('✖ failing')][:30]
a=cases('03-candidate-spec.stdout');b=cases('04-unfixed-spec.stdout');assert len(a)==len(b)==30 and sorted(a)==sorted(b)
r={'sourceHead':head,'sourceTree':'c26db6c07a817f7bc70870391d58645c8eeb1655','sourceBase':base,'candidateInverseDonorExact':True,'donorVsBeforeExactSingleDictionaryLine':True,'specInverseDonorExactExceptExpectedSourceHead':True,'current9SourceBytesUnchangedInCandidate':True,'changedPins':[r['path'] for r in entries if r['byteChangedFromDonorPin']],'sourcePaths':expected,'same30CaseNamesBeforeAfter':a,'liveVerificationFlagsUnchangedFalse':True,'otherSourceOrOperatorsRead':False,'deniedReportRead':False};(p/'07-inverse-and-bindings.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'currentInputs':len(entries),'changedDonorPins':len(r['changedPins']),'sameCases':len(a),'inverse':True},indent=2))
