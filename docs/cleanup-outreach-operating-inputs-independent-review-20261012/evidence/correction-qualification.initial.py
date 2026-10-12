# Preserved reviewer metadata failure: a guessed full old digest was incorrect.
# No product/validator discrepancy; the correction derives the digest from immutable original Git bytes.
import pathlib,json,subprocess,hashlib
root=pathlib.Path.cwd();p=root/'docs/cleanup-outreach-operating-inputs-independent-review-20261012/evidence';a=json.loads((p/'04-marker-negative-probe.json').read_text());b=json.loads((p/'06-corrected-marker-negative-probe.json').read_text());assert[(r['name'],r['expectedValid'])for r in a['rows']]==[(r['name'],r['expectedValid'])for r in b['rows']];assert a['failed']==6 and b['failed']==0 and a['documentSha256']==b['documentSha256'];assert a['sourceSha256']!=b['sourceSha256']
base='d587441261fd356ee5144a8fc29cb2f771d062b8';initial='1ed986c092b4b0998c82007e895463255d6f4901';corrected='7a425df71ce2162bbfdfd430a10d285a179e2832';verifier='scripts/verify-outreach-v3-p1-architecture.mjs';ci='scripts/ci/outreach-operating-inputs.spec.mjs';contract='docs/contracts/outreach-v3-verification-inputs-v1.md'
def git(h,path):return subprocess.check_output(['git','show',h+':'+path])
assert git(initial,contract)==git(corrected,contract);assert git(corrected,contract)==git('67fa9255b8a73f489d7a57c8fe270ed6d03fa016',contract)
for f in[verifier,ci,contract]:assert (root/f).read_bytes()==git(corrected,f)
old_ci=git('67fa9255b8a73f489d7a57c8fe270ed6d03fa016',ci);adopted_ci=git(initial,ci);old_hash=b'2544c3b6878e0724dd7b1f93e76943ecdb8115955895f72734ec4e62fd36ca68';new_hash=hashlib.sha256(git(base,verifier)).hexdigest().encode();assert old_ci.count(old_hash)==1;assert old_ci.replace(old_hash,new_hash)==adopted_ci
