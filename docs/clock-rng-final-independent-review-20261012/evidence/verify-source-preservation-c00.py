import subprocess,json,hashlib,re
from pathlib import Path
frozen='f86bf11b9b6da367d464da453ee1f260fa60e06e';candidate='c00c86917af2da637c2183fd078f4390fe0ac361';base='1bf52945b9fa01496ce41a349f8eaace490ad4ac';integrated='b3e02fb8f056ab3481b5153bf1a1b2fe3a7d4a7d'
def git(*args):return subprocess.check_output(['git',*args])
paths=git('diff','--name-only',base,frozen,'--',':!docs').decode().splitlines();assert len(paths)==18
changed=git('diff','--name-only',frozen,candidate,'--',':!docs').decode().splitlines();assert changed==['scripts/check-strategy-time-bypasses.mjs','scripts/check-strategy-time-bypasses.test.mjs','scripts/strategy-time-boundaries.json']
unchanged=[];exactIntegration=[]
for p in paths:
 current=git('show',candidate+':'+p);root=git('show',integrated+':'+p);assert current==root
 exactIntegration.append({'path':p,'sha256':hashlib.sha256(current).hexdigest(),'blob':git('rev-parse',candidate+':'+p).decode().strip()})
 if p not in changed:
  assert git('show',frozen+':'+p)==current;unchanged.append(p)
old=json.loads(git('show',frozen+':scripts/strategy-time-boundaries.json'));new=json.loads(git('show',candidate+':scripts/strategy-time-boundaries.json'));added=new.pop('systemHookValueOwners');assert new==old;assert len(old['existingAmbient'])==119
names=git('show','aa1ce11fd480cf664f5b3d1902a61751368d238d:scripts/check-strategy-time-bypasses.test.mjs').decode();now=git('show',candidate+':scripts/check-strategy-time-bypasses.test.mjs').decode()
oldLiterals=re.findall(r"(?m)^test\('([^']+)'",names);newLiterals=re.findall(r"(?m)^test\('([^']+)'",now);assert oldLiterals==newLiterals
oldLog=Path('/workspace/capirov2-clock-rng-repaired-review/docs/clock-rng-repaired-independent-review-20261012/evidence/permanent-controls-aa1.stdout.log').read_bytes();newLog=Path('docs/clock-rng-final-independent-review-20261012/evidence/permanent-controls-c00.stdout.log').read_bytes()
def reportedCases(log):return re.findall(r'^✔ (.+?) \([\d.]+ms\)$',log.decode(),re.M)
oldCases=reportedCases(oldLog);newCases=reportedCases(newLog);assert oldCases==newCases;assert len(newCases)==84
out={'base':base,'originalSource':frozen,'candidateSource':candidate,'candidateTree':git('rev-parse',candidate+'^{tree}').decode().strip(),'integratedSource':integrated,'integratedTree':git('rev-parse',integrated+'^{tree}').decode().strip(),'packetPaths':18,'onlyChangedPathsFromOriginal':changed,'unchangedOriginalPaths':unchanged,'exactIntegratedBlobs':exactIntegration,'allOriginalDataFieldsExact':True,'originalAllowanceRows':119,'onlyAddedDataField':{'systemHookValueOwners':added},'all84PermanentReportedCaseNamesRetained':True,'reportedCases':newCases,'literalTestNamesRetained':oldLiterals,'inputLogHashes':{'aa1':hashlib.sha256(oldLog).hexdigest(),'72b':hashlib.sha256(newLog).hexdigest()},'carryEvidenceCommit':'97ad2352212ac127a86e0c1f75abe01d1902a4c9','carriedEvidence':{'inertRuntime':17,'requiredNestInjection':4,'parsedCIAndPackagePreservation':True,'originalDeferredAmbientSamples':123},'nativeAcceptance':False}
Path('docs/clock-rng-final-independent-review-20261012/evidence/source-preservation-c00.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({'unchangedOriginalPaths':len(unchanged),'exactIntegratedBlobs':len(exactIntegration),'originalDataFieldsEqual':True,'literalTestNamesRetained':len(oldLiterals),'reportedTestNamesRetained':len(newCases)},indent=2))
