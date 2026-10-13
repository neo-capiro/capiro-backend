from pathlib import Path
import subprocess,json,hashlib,re
ROOT=Path(__file__).resolve().parents[3];HERE=Path(__file__).parent
SOURCE='0132a1c8ffd0c04d0052c992bd361add4eefc020'
BASE='e33fe1af359defbe52a9a63089f05bf7a757344f'
PREVIOUS_REVIEW='b2835dc88481bbc082dcd111087070cfeb3a1336'
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT)
def read(ref,p):return git('show',ref+':'+p)
def tree(ref):
    result={}
    for row in git('ls-tree','-rz',ref).split(b'\0'):
        if row:
            meta,p=row.split(b'\t',1);result[p.decode()]=meta.decode()
    return result
def sha(b):return hashlib.sha256(b).hexdigest()
before=tree(BASE);after=tree(SOURCE);review=tree('HEAD')
paths=sorted(p for p in before.keys()|after.keys() if before.get(p)!=after.get(p))
expected=['scripts/ci/newsletter-accepted-source-profile.spec.mjs','scripts/lib/newsletter-accepted-source-profile.json']
assert paths==expected
assert {p:v for p,v in after.items() if not p.startswith('docs/')}=={p:v for p,v in review.items() if not p.startswith('docs/')}
for ref in [BASE,PREVIOUS_REVIEW]:assert subprocess.call(['git','merge-base','--is-ancestor',ref,'HEAD'],cwd=ROOT)==0
before_policy=json.loads(read(BASE,expected[1]));policy=json.loads(read(SOURCE,expected[1]))
assert policy['runtimeProfile']==before_policy['runtimeProfile']
assert {k:v for k,v in policy.items() if k not in ['activeCommit','acceptedSources']}=={k:v for k,v in before_policy.items() if k not in ['activeCommit','acceptedSources']}
assert len(policy['acceptedSources'])==1
binding=json.loads((HERE/'QUALIFICATION-BINDING.json').read_text())
entry=policy['acceptedSources'][0]
assert policy['activeCommit']==entry['commit']==binding['runtimeSource']
assert entry['tree']==binding['runtimeTree']
assert entry['qualificationReceipt']=={'repository':'neo-capiro/capiro-frontend','commit':binding['evidencePublication'],
    'path':'docs/newsletter-receiving-final-20261013/QUALIFICATION.md','sha256':binding['qualificationSha256']}
old_stdout=(ROOT/'docs/cleanup-peer-manifests-integration-independent-review-20261013/evidence/profile-permanent-final.stdout').read_text()
new_stdout=(HERE/'activation-permanent.stdout').read_text()
def cases(text):return re.findall(r'^\s*[✔✖]\s(.+)\s\([\d.]+ms\)$',text,re.M)
old_names=cases(old_stdout);new_names=cases(new_stdout)
assert len(old_names)==19 and len(new_names)==23
assert all(new_names.count(x)==1 for x in old_names)
assert 'ℹ tests 22' in new_stdout and 'ℹ pass 22' in new_stdout and 'ℹ fail 0' in new_stdout
assert 'Historical pending-policy fixture controls (original nineteen control IDs)' in new_stdout
old=ROOT/'docs/cleanup-peer-manifests-integration-independent-review-20261013'
index=json.loads((old/'SHA256-FINAL-INDEX.json').read_text())
for row in index['entries']:
    b=(old/row['path']).read_bytes();assert len(b)==row['bytes'] and sha(b)==row['sha256']
for p in before.keys()|after.keys():
    if p not in expected:assert before.get(p)==after.get(p)
result={'source':SOURCE,'tree':'88f5de19e22b64e5441ea0c06dd15aa908efaf14','base':BASE,'sourcePaths':[
    {'path':p,'beforeEntry':before[p],'afterEntry':after[p],'sha256':sha(read(SOURCE,p))}for p in paths],
    'outsideTwoPathsExactIncludingAllDocuments':len(before)-2,'runtimeProfileUnchanged':True,
    'qualificationTupleExactReceivedPrimaryEvidence':True,'allProductionHelpersDockerCIManifestsLocksApplicationAndSchemaUnchanged':True,
    'reviewNonDocSourceExactFrozenActivation':True,'previousB283ReviewIsActualAncestor':True,
    'original19CaseNamesRetainedWithAllPassAndExplicitHistoricalFixtureLabel':old_names,
    'additionalProductionCases':3,'actualTotalCases':22,'inherited83ReviewHashesExact':True,
    'sourcePolicyActivationNotActualInstallArtifactBuildOrABIProof':True,'protectedReportingBodyOrDeniedReportRead':False}
(HERE/'ACTIVATION-PRESERVATION.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'sourcePaths':len(paths),'outsideExact':len(before)-2,'caseNamesRetained':len(old_names),'currentCases':22,'previousHashes':len(index['entries'])}))
