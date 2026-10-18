# Finite receiving evidence custody; no application imports, DB or network.
import argparse,base64,gzip,hashlib,json,re,subprocess
from pathlib import Path
FINITE = ['docs/backend-cleanup-receiving-20261014/HANDOFF.md', 'docs/backend-cleanup-receiving-20261014/INDEPENDENT-REVIEW.md', 'docs/backend-cleanup-receiving-20261014/api-jest.config.cjs', 'docs/backend-cleanup-receiving-20261014/check-emitted-watchlist.cjs', 'docs/backend-cleanup-receiving-20261014/check-memo-emission.cjs', 'docs/backend-cleanup-receiving-20261014/evidence/api-jest-output.raw.json', 'docs/backend-cleanup-receiving-20261014/evidence/api-jest-receipt.json', 'docs/backend-cleanup-receiving-20261014/evidence/api-jest-repaired-output.raw.json', 'docs/backend-cleanup-receiving-20261014/evidence/api-jest-repaired-receipt.json', 'docs/backend-cleanup-receiving-20261014/evidence/api-jest-results.json', 'docs/backend-cleanup-receiving-20261014/evidence/attempt0-checkout-retirement.json.gz', 'docs/backend-cleanup-receiving-20261014/evidence/attempt0-memo-materialization.json', 'docs/backend-cleanup-receiving-20261014/evidence/attempt0-quarantine-assertion.json', 'docs/backend-cleanup-receiving-20261014/evidence/dependency-provenance.json', 'docs/backend-cleanup-receiving-20261014/evidence/emitted-watchlist-artifacts.json', 'docs/backend-cleanup-receiving-20261014/evidence/intel-build-output.raw.json', 'docs/backend-cleanup-receiving-20261014/evidence/intel-build-receipt.json', 'docs/backend-cleanup-receiving-20261014/evidence/intel-emitted-syntax-output.raw.json', 'docs/backend-cleanup-receiving-20261014/evidence/intel-emitted-syntax-receipt.json', 'docs/backend-cleanup-receiving-20261014/evidence/intel-jest-output.raw.json', 'docs/backend-cleanup-receiving-20261014/evidence/intel-jest-receipt.json', 'docs/backend-cleanup-receiving-20261014/evidence/intel-jest-results.json', 'docs/backend-cleanup-receiving-20261014/evidence/intel-type-output.raw.json', 'docs/backend-cleanup-receiving-20261014/evidence/intel-type-receipt.json', 'docs/backend-cleanup-receiving-20261014/evidence/memo-canonical-type-output.raw.json', 'docs/backend-cleanup-receiving-20261014/evidence/memo-canonical-type-receipt.json', 'docs/backend-cleanup-receiving-20261014/evidence/memo-core-client-provenance.json', 'docs/backend-cleanup-receiving-20261014/evidence/memo-emitted-artifacts.json', 'docs/backend-cleanup-receiving-20261014/evidence/memo-emitted-syntax-output.raw.json', 'docs/backend-cleanup-receiving-20261014/evidence/memo-emitted-syntax-receipt.json', 'docs/backend-cleanup-receiving-20261014/evidence/memo-emitted-syntax-repaired-output.raw.json', 'docs/backend-cleanup-receiving-20261014/evidence/memo-emitted-syntax-repaired-receipt.json', 'docs/backend-cleanup-receiving-20261014/evidence/memo-failure-disposition.json', 'docs/backend-cleanup-receiving-20261014/evidence/memo-jest-output.raw.json', 'docs/backend-cleanup-receiving-20261014/evidence/memo-jest-receipt.json', 'docs/backend-cleanup-receiving-20261014/evidence/memo-jest-repaired-output.raw.json', 'docs/backend-cleanup-receiving-20261014/evidence/memo-jest-repaired-receipt.json', 'docs/backend-cleanup-receiving-20261014/evidence/memo-jest-repaired-results.json', 'docs/backend-cleanup-receiving-20261014/evidence/memo-jest-results.json', 'docs/backend-cleanup-receiving-20261014/evidence/memo-materialization-scope.json', 'docs/backend-cleanup-receiving-20261014/evidence/memo-receiving-preservation.json', 'docs/backend-cleanup-receiving-20261014/evidence/receiving-preservation.json', 'docs/backend-cleanup-receiving-20261014/evidence/shared-build-output.raw.json', 'docs/backend-cleanup-receiving-20261014/evidence/shared-build-receipt.json', 'docs/backend-cleanup-receiving-20261014/evidence/source-hygiene.json', 'docs/backend-cleanup-receiving-20261014/evidence/tracker-fixture-type-output.raw.json', 'docs/backend-cleanup-receiving-20261014/evidence/tracker-fixture-type-receipt.json', 'docs/backend-cleanup-receiving-20261014/evidence/watchlist-fixture-type-output.raw.json', 'docs/backend-cleanup-receiving-20261014/evidence/watchlist-fixture-type-receipt.json', 'docs/backend-cleanup-receiving-20261014/excluded-reporting-token.cjs', 'docs/backend-cleanup-receiving-20261014/intel-api-jest.config.cjs', 'docs/backend-cleanup-receiving-20261014/materialize-memo-graph.cjs', 'docs/backend-cleanup-receiving-20261014/memo-test-scope.json', 'docs/backend-cleanup-receiving-20261014/run-check.py', 'docs/backend-cleanup-receiving-20261014/seal-packet.py', 'docs/backend-cleanup-receiving-20261014/source-only-fence.cjs', 'docs/backend-cleanup-receiving-20261014/test-scope.json']
PACKET = 'docs/backend-cleanup-receiving-20261014'
ROOT = Path(__file__).resolve().parents[2]
EXCLUSIONS = [PACKET+'/evidence/SHA256-INDEX.json',PACKET+'/evidence/privacy-review.json']
def sha(data):return hashlib.sha256(data).hexdigest()
def read(path,rev=None):
    return subprocess.check_output(['git','show',rev+':'+path],cwd=ROOT) if rev else (ROOT/path).read_bytes()
def seal(rev=None):
    rows=[];findings=[];decoded=0
    patterns={'private-key':rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----','aws-key':rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b','clerk-key':rb'\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9+/=]{15,}','openai-key':rb'\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}','github-token':rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})','bearer-token':rb'(?i)Bearer\s+[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_.-]+'}
    for path in FINITE:
        data=read(path,rev);rows.append({'path':path,'bytes':len(data),'sha256':sha(data)});observations=[data]
        if path.endswith('-output.raw.json'):
            record=json.loads(data);value=base64.b64decode(record['data'],validate=True)
            assert len(value)==record['bytes'] and sha(value)==record['sha256']
            observations.append(value);decoded+=1
        if path==PACKET+'/evidence/attempt0-checkout-retirement.json.gz':
            observations.append(gzip.decompress(data));decoded+=1
        for raw in observations:
            for kind,pattern in patterns.items():
                if re.search(pattern,raw):findings.append({'path':path,'kind':kind})
    assert not findings, json.dumps(findings)
    index={'finite_exclusions':EXCLUSIONS,'reason':'index cannot hash itself and privacy report is derived','rows':rows}
    privacy={'result':'PASS','finite_files_scanned':len(FINITE),'decoded_raw_observations':decoded,'patterns':list(patterns),'findings':findings,'scope':'hash-bound source/dependency metadata and synthetic source-check observations; no live account records','independent_review_required':True}
    if rev:
        assert json.loads(read(EXCLUSIONS[0],rev))==index
        assert json.loads(read(EXCLUSIONS[1],rev))==privacy
        actual=subprocess.check_output(['git','ls-tree','-r','--name-only',rev,'--',PACKET],cwd=ROOT).decode().splitlines()
        assert sorted(actual)==sorted(FINITE+EXCLUSIONS)
    else:
        actual=sorted(str(p.relative_to(ROOT)) for p in (ROOT/PACKET).rglob('*') if p.is_file())
        assert actual in [sorted(FINITE),sorted(FINITE+EXCLUSIONS)], 'Finite worktree mismatch'
        (ROOT/EXCLUSIONS[0]).write_text(json.dumps(index,indent=2)+'\n');(ROOT/EXCLUSIONS[1]).write_text(json.dumps(privacy,indent=2)+'\n')
    print(json.dumps({'result':'PASS','rows':len(rows),'decoded_raw_observations':decoded,'scope':rev or 'worktree'}))
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--verify-commit');args=parser.parse_args()
    if args.verify_commit:assert re.fullmatch('[a-f0-9]{40}',args.verify_commit)
    seal(args.verify_commit)
