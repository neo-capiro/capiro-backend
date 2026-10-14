# Finite docs/evidence custody only. No application imports, credentials, DB or network.
import argparse, base64, hashlib, json, re, subprocess
from pathlib import Path

FINITE = {'docs/preview-readonly-native-20261013': ['docs/preview-readonly-native-20261013/CURRENT-OWNER-FUNCTIONAL-MODE.md', 'docs/preview-readonly-native-20261013/HANDOFF.md', 'docs/preview-readonly-native-20261013/INDEPENDENT-REVIEW.md', 'docs/preview-readonly-native-20261013/RUNTIME-ENTRYPOINT-CORRECTION.md', 'docs/preview-readonly-native-20261013/RUNTIME-PERMISSIONS-CORRECTION.md', 'docs/preview-readonly-native-20261013/evidence/OWNED-TARGET-PLAN.json', 'docs/preview-readonly-native-20261013/evidence/attempt0-catalog-native-connect.strace', 'docs/preview-readonly-native-20261013/evidence/attempt0-catalog-native-results.json', 'docs/preview-readonly-native-20261013/evidence/attempt0-catalog-native.stderr', 'docs/preview-readonly-native-20261013/evidence/attempt0-catalog-native.stdout', 'docs/preview-readonly-native-20261013/evidence/attempt0-entrypoint-emit-receipt.json', 'docs/preview-readonly-native-20261013/evidence/attempt0-entrypoint-emit.stderr.raw.json', 'docs/preview-readonly-native-20261013/evidence/attempt0-entrypoint-emit.stdout', 'docs/preview-readonly-native-20261013/evidence/attempt0-entrypoint-source-hygiene.json', 'docs/preview-readonly-native-20261013/evidence/attempt0-launcher-receipt.json', 'docs/preview-readonly-native-20261013/evidence/attempt0-liveness-command.json', 'docs/preview-readonly-native-20261013/evidence/attempt0-liveness.stderr', 'docs/preview-readonly-native-20261013/evidence/attempt0-liveness.stdout', 'docs/preview-readonly-native-20261013/evidence/attempt0-publication-seal-repair.json', 'docs/preview-readonly-native-20261013/evidence/catalog-after.json', 'docs/preview-readonly-native-20261013/evidence/catalog-after.raw.txt', 'docs/preview-readonly-native-20261013/evidence/catalog-before.json', 'docs/preview-readonly-native-20261013/evidence/catalog-before.raw.txt', 'docs/preview-readonly-native-20261013/evidence/catalog-native-command.json', 'docs/preview-readonly-native-20261013/evidence/catalog-native-connect.strace', 'docs/preview-readonly-native-20261013/evidence/catalog-native-probe.cjs', 'docs/preview-readonly-native-20261013/evidence/catalog-native-query-events.json', 'docs/preview-readonly-native-20261013/evidence/catalog-native-results.json', 'docs/preview-readonly-native-20261013/evidence/catalog-native.stderr', 'docs/preview-readonly-native-20261013/evidence/catalog-native.stdout', 'docs/preview-readonly-native-20261013/evidence/container-capacity.txt', 'docs/preview-readonly-native-20261013/evidence/entrypoint-emit-command.json', 'docs/preview-readonly-native-20261013/evidence/entrypoint-emit-results.json', 'docs/preview-readonly-native-20261013/evidence/entrypoint-emit.cjs', 'docs/preview-readonly-native-20261013/evidence/entrypoint-emit.stderr', 'docs/preview-readonly-native-20261013/evidence/entrypoint-emit.stdout', 'docs/preview-readonly-native-20261013/evidence/entrypoint-emitted.js.txt', 'docs/preview-readonly-native-20261013/evidence/entrypoint-runtime-retirement.json', 'docs/preview-readonly-native-20261013/evidence/fixture-projection.json', 'docs/preview-readonly-native-20261013/evidence/fixture-schema.sql', 'docs/preview-readonly-native-20261013/evidence/fixture-seed.sql', 'docs/preview-readonly-native-20261013/evidence/liveness-command.json', 'docs/preview-readonly-native-20261013/evidence/liveness-probe.cjs', 'docs/preview-readonly-native-20261013/evidence/liveness-results.json', 'docs/preview-readonly-native-20261013/evidence/liveness.stderr', 'docs/preview-readonly-native-20261013/evidence/liveness.stdout', 'docs/preview-readonly-native-20261013/evidence/owned-runtime-retirement.json', 'docs/preview-readonly-native-20261013/evidence/path-shared-build.log', 'docs/preview-readonly-native-20261013/evidence/prepare-fixture.cjs', 'docs/preview-readonly-native-20261013/evidence/preservation.json', 'docs/preview-readonly-native-20261013/evidence/preview-container-invocation.json', 'docs/preview-readonly-native-20261013/evidence/runtime-path-source-bindings.json', 'docs/preview-readonly-native-20261013/evidence/shared-build.log', 'docs/preview-readonly-native-20261013/evidence/source-and-network-preservation.json', 'docs/preview-readonly-native-20261013/evidence/source-hygiene.json'], 'docs/preview-existing-api-compatibility-20261014': ['docs/preview-existing-api-compatibility-20261014/FINDING.md', 'docs/preview-existing-api-compatibility-20261014/INDEPENDENT-REVIEW.md', 'docs/preview-existing-api-compatibility-20261014/evidence/source-bindings.json', 'docs/preview-existing-api-compatibility-20261014/evidence/owned-capacity-recovery.json', 'docs/preview-existing-api-compatibility-20261014/evidence/source-hygiene.json', 'docs/preview-existing-api-compatibility-20261014/evidence/seal-packets.py', 'docs/preview-existing-api-compatibility-20261014/evidence/attempt0-seal-receipt.json']}
ROOT = Path(__file__).resolve().parents[3]


def read(path, revision=None):
    if revision:
        return subprocess.check_output(['git', '--no-pager', 'show', revision+':'+path], cwd=ROOT)
    return (ROOT/path).read_bytes()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def privacy(rows, revision=None):
    findings=[]
    decoded=0
    patterns={
        'private-key': re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
        'aws-access-key': re.compile(rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
        'clerk-key': re.compile(rb'\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9+/=]{15,}'),
        'openai-key': re.compile(rb'\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}'),
        'github-token': re.compile(rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})'),
        'bearer-token': re.compile(rb'(?i)Bearer\s+[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_.-]+'),
        'db-connection': re.compile(rb'postgres(?:ql)?://[^\s"\'<>`]+'),
    }
    for row in rows:
        path=row['path']
        data=read(path, revision)
        observations=[data]
        if path.endswith('/attempt0-entrypoint-emit.stderr.raw.json'):
            raw=json.loads(data)
            value=base64.b64decode(raw['data'], validate=True)
            assert len(value)==raw['bytes'] and sha(value)==raw['sha256']
            observations.append(value)
            decoded+=1
        for observation in observations:
            for kind, pattern in patterns.items():
                for match in pattern.finditer(observation):
                    # Exact existing synthetic-only connection in the liveness evidence.
                    if kind=='db-connection' and match.group().startswith(b'postgresql://synthetic:synthetic@'):
                        continue
                    dynamic = b'postgresql://' + b'${encodeURIComponent(role)}:${encodeURIComponent(password)}@127.0.0.1:5432/postgres?connection_limit=1'
                    if kind=='db-connection' and path=='docs/preview-readonly-native-20261013/evidence/catalog-native-probe.cjs' and match.group()==dynamic:
                        continue
                    findings.append({'path':path, 'kind':kind})
    assert not findings, 'Credential-shaped finding; contents intentionally not printed'
    return {'result':'PASS','finite_files_scanned':len(rows),'decoded_raw_observations':decoded,
            'method':'finite plaintext and exact lossless raw observation scan, plus independent source review',
            'patterns':list(patterns),'findings':findings,
            'actual_connection_inputs_not_recorded':True,
            'known_connection_literal_exception':'postgresql://synthetic:synthetic@ in the synthetic liveness fixture only',
            'noncredential_source_constructor':'one exact variable-only local URL constructor in catalog-native-probe.cjs',
            'scope':'selected source hashes, source review, local metadata and synthetic fixture evidence; no live user records'}


def seal(verify_revision=None):
    results=[]
    for packet, paths in FINITE.items():
        assert len(set(paths))==len(paths) and all(p.startswith(packet+'/') for p in paths)
        rows=[]
        for path in sorted(paths):
            data=read(path,verify_revision)
            rows.append({'path':path,'bytes':len(data),'sha256':sha(data)})
        exclusions=[packet+'/evidence/SHA256-INDEX.json',packet+'/evidence/privacy-review.json']
        index={'finite_exclusions':exclusions,'reason':'index cannot hash itself and privacy report is derived','rows':rows}
        report=privacy(rows,verify_revision)
        if verify_revision:
            assert json.loads(read(exclusions[0],verify_revision))==index
            assert json.loads(read(exclusions[1],verify_revision))==report
            actual=subprocess.check_output(['git','ls-tree','-r','--name-only',verify_revision,'--',packet],cwd=ROOT).decode().splitlines()
            assert sorted(actual)==sorted(paths+exclusions), 'Finite tree coverage mismatch'
        else:
            actual=sorted(str(p.relative_to(ROOT)) for p in (ROOT/packet).rglob('*') if p.is_file())
            assert actual in [sorted(paths+exclusions),sorted(paths)], 'Finite filesystem coverage mismatch'
            (ROOT/exclusions[0]).write_text(json.dumps(index,indent=2)+'\n')
            (ROOT/exclusions[1]).write_text(json.dumps(report,indent=2)+'\n')
        results.append({'packet':packet,'rows':len(rows),'privacy':report['result'],'verification':verify_revision or 'worktree'})
    print(json.dumps({'result':'PASS','packets':results},indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--verify-commit')
    args=parser.parse_args()
    if args.verify_commit:
        assert re.fullmatch('[a-f0-9]{40}',args.verify_commit)
    seal(args.verify_commit)
