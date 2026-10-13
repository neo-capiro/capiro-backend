import hashlib,json,pathlib,subprocess
ROOT=pathlib.Path(__file__).resolve().parents[3]
PACKET=ROOT/'docs/phase26-reviewed-publication-20261013'
def git(*args): return subprocess.check_output(['git',*args],cwd=ROOT)
def digest(data): return hashlib.sha256(data).hexdigest()
base='c07d00e27fdda64dfbd13c36d0ac433c81d9f7f4'
source='d69d26c210ea9307c9b8843e3a0930738c79abdb'
paths=git('diff','--name-only',base,source,'--','.',':!docs').decode().splitlines()
expected=['package.json','scripts/check-context-plane-new-bypasses.mjs','scripts/ci/context-plane-scope.contract.spec.mjs','scripts/ci/context-plane-validation-scope.spec.mjs','scripts/lib/context-plane-scope.mjs','scripts/lib/context-plane-validation-scope.mjs','scripts/lib/knowledge-census-scope.mjs','scripts/lib/knowledge-validation-scope.mjs','scripts/validate-knowledge-plane-phase26.mjs']
assert paths==expected
candidate='31cc12a6626be8586666dfa9ccf53b68fff10311'
for path in paths[1:]: assert git('show',source+':'+path)==git('show',candidate+':'+path)==(ROOT/path).read_bytes()
prior=json.loads(git('show',base+':package.json'))
current=json.loads((ROOT/'package.json').read_text())
aliases={f'validate:knowledge-plane:phase26:{name}':'node scripts/validate-knowledge-plane-phase26.mjs --run '+flags for name,flags in [('backend','--backend-only'),('backend:typing','--backend-only --skip-tests'),('backend:source','--backend-only --source-only'),('frontend','--frontend-only')]}
for name,command in aliases.items(): assert current['scripts'].pop(name)==command
assert current==prior
indices=[]
folder=ROOT/'docs/cleanup-phase26-compatible-scopes-20261013'
for name in ['SHA256SUMS.json','ALIAS-CORRECTION-SHA256SUMS.json','HUNK-CORRECTION-SHA256SUMS.json']:
 index=json.loads((folder/name).read_text())
 for entry in index['entries']:
  data=(folder/entry['path']).read_bytes(); assert len(data)==entry['bytes'] and digest(data)==entry['sha256']
 indices.append({'path':str((folder/name).relative_to(ROOT)),'verifiedEntries':len(index['entries'])})
old_path=ROOT/'docs/native-acceptance-pr2429-20261012/SHA256SUMS.json'
assert old_path.read_bytes()==git('show',base+':'+str(old_path.relative_to(ROOT)))
old=json.loads(old_path.read_text()); replaced=[]
for path,want in old.items():
 data=(ROOT/path).read_bytes()
 if digest(data)!=want:
  assert path=='docs/cleanup-retirement-additional-reviewed-inputs-20261012/HANDOFF.md'
  assert digest((PACKET/'HANDOFF-PR2433.md').read_bytes())==want
  replaced.append(path)
assert replaced==['docs/cleanup-retirement-additional-reviewed-inputs-20261012/HANDOFF.md']
assert (PACKET/'HANDOFF-PR2433.md').read_bytes()==git('show',base+':'+replaced[0])
review='308443cb148cc5f8dc5d4fd67a838e3fe9724f20'
review_folder=ROOT/'docs/cleanup-phase26-operator-independent-review-20261013'
review_index=json.loads((review_folder/'SHA256-INDEX.json').read_text())
for entry in review_index['files']:
 data=(review_folder/entry['path']).read_bytes(); assert len(data)==entry['bytes'] and digest(data)==entry['sha256']
subprocess.run(['git','merge-base','--is-ancestor',review,'HEAD'],cwd=ROOT,check=True)
assert not git('diff','--name-only',source,'HEAD','--','.',':!docs').strip()
heads=[base,candidate,'61453eca11f5aa93d67285c2016db34f66eaf6b6','b46dad56b0025d3f1043809d3322fe936f5d501f','1ce10b97ba0aa74b66fecbf20af07417b9d4617f','8d08e2c8b17abfa2649bad073c0aeccf168ce0b4']
for head in heads: subprocess.run(['git','merge-base','--is-ancestor',head,source],cwd=ROOT,check=True)
receipt={'base':base,'source':source,'sourceTree':git('rev-parse',source+'^{tree}').decode().strip(),'sourcePaths':paths,'allEightCandidateBlobsExact':True,'onlyFourAdditiveAliases':aliases,'authorIndices':indices,'independentReview':review,'independentReviewTree':git('rev-parse',review+'^{tree}').decode().strip(),'independentEntriesVerified':len(review_index['files']),'sourceUnchangedAfterReviewMerge':True,'oldIndexEntries':len(old),'oldIndexPhysicallyUnchanged':True,'oldEntriesPhysicallyExact':len(old)-len(replaced),'intentionalSupersessions':replaced,'originalHandoffPhysicallyPreserved':True,'allOriginalAndCorrectedHeadsPreservedAsAncestors':heads,'noDatabaseProviderNativeDefaultCLIOrApplicationExecution':True}
(PACKET/'COMPOSITION-RECEIPT.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'sourcePaths':len(paths),'authorEntriesVerified':sum(x['verifiedEntries'] for x in indices),'priorEntriesVerified':len(old),'sourceTree':receipt['sourceTree'],'onlySupersession':replaced},indent=2))
