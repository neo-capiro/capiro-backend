import pathlib, hashlib, json, subprocess, sys, tarfile
root = pathlib.Path(sys.argv[1]).resolve()
packet = root / 'docs/shared-newsletter-receiving-packed-distribution-20261013'
current = packet / 'qualified-38fec5c8'
old_head = '3684613caf831cf62dc3759281a673134503f99a'
source = '38fec5c83585850ed75a7d3693b3b90d517e70af'
sha = lambda b: hashlib.sha256(b).hexdigest()
def git(*args):
    return subprocess.check_output(['git', *args], cwd=root)
def read_pack(p):
    with tarfile.open(p, 'r:gz') as t:
        members = t.getmembers()
        assert all(m.isfile() for m in members)
        return {m.name: t.extractfile(m).read() for m in members}
archives = {
    '794': packet / 'artifact/capiro-shared-0.0.0.tgz',
    '37': packet / 'qualified-37d574a3/artifact/capiro-shared-0.0.0.tgz',
    '38': current / 'artifact/capiro-shared-0.0.0.tgz',
}
packed = {k: read_pack(v) for k, v in archives.items()}
expected = {'794': '4c293521172c5981e1d8fb2f049495da781b24a93883b68313230b186f90c291',
            '37': 'f23e28ffa0e1a62491c2e772717d185619d947ffcb00b9864dc45b3bc5d17237',
            '38': '3e435f280fac8fd301eb753e9fc7ead93691cf979fc1641792fedd88e1bfd6d5'}
for k, v in archives.items():
    assert sha(v.read_bytes()) == expected[k]
    assert len(packed[k]) == 187
bodies = []
maps = []
for suffix, output in [('.d.ts', bodies), ('.d.ts.map', maps)]:
    names = sorted(p for p in packed['38'] if p.endswith(suffix))
    assert len(names) == 37
    assert all(sorted(p for p in a if p.endswith(suffix)) == names for a in packed.values())
    for n in names:
        row = {'path': n, 'sha256': {k: sha(a[n]) for k, a in packed.items()},
               'equal37To38': packed['37'][n] == packed['38'][n],
               'equal794To38': packed['794'][n] == packed['38'][n]}
        assert row['equal37To38']
        if suffix == '.d.ts':
            assert row['equal794To38']
        output.append(row)
old_index = json.loads((packet / 'SHA256-INDEX.json').read_bytes())
assert len(old_index['entries']) == 100
preserved = []
for row in old_index['entries']:
    relative = pathlib.PurePosixPath(row['path'])
    assert not relative.is_absolute() and '..' not in relative.parts
    p = packet / row['path']
    b = p.read_bytes()
    assert len(b) == row['bytes'] and sha(b) == row['sha256']
    assert b == git('show', old_head + ':' + str(p.relative_to(root)))
    preserved.append({'path': row['path'], 'sha256': row['sha256'], 'bytes': len(b)})
assert (packet / 'SHA256-INDEX.json').read_bytes() == git('show', old_head + ':' + str((packet/'SHA256-INDEX.json').relative_to(root)))
reused = []
for old, new in [
 ('qualified-37d574a3/evidence/qualify-packed-consumer-attempt-1.mjs', 'evidence/qualify-packed-consumer.mjs'),
 ('qualified-37d574a3/evidence/prepare-and-pack.py', 'evidence/prepare-and-pack.py'),
 ('qualified-37d574a3/evidence/consumer-positive.ts', 'evidence/consumer-positive.ts'),
 ('qualified-37d574a3/evidence/consumer-negative.ts', 'evidence/consumer-negative.ts'),
 ('qualified-37d574a3/evidence/renderer-characterizations.cjs', 'evidence/renderer-characterizations.cjs')]:
    a = (packet/old).read_bytes(); b = (current/new).read_bytes()
    assert a == b, (old, new)
    reused.append({'original': old, 'final': new, 'sha256': sha(b)})
old_packet = root / 'docs/shared-newsletter-packed-distribution-20261012'
for name in ['renderer-characterizations.cjs', 'original-C-renderer-golden.json']:
    old = old_packet/'evidence'/name
    new = current/'evidence/consumer-attempt-1'/name
    assert old.read_bytes() == new.read_bytes()
    reused.append({'original': str(old.relative_to(root)), 'final': str(new.relative_to(current)), 'sha256': sha(new.read_bytes())})
old_tar = old_packet/'artifact/capiro-shared-0.0.0.tgz'
assert sha(old_tar.read_bytes()) == '697d826647e88e7f8559da386be7de1ae6408dc61c73877b86c2e17275fd63ab'
corpus = current/'evidence/newsletter-receiving-corpus.cjs'
assert corpus.read_bytes() == git('show', source+':scripts/ci/fixtures/newsletter-receiving-corpus.cjs')
assert all(a['package/package.json'] == packed['38']['package/package.json'] for a in packed.values())
assert packed['38']['package/package.json'] == git('show', source+':packages/shared/package.json')
for path in ['packages/shared', 'scripts/ci/fixtures/newsletter-receiving-corpus.cjs']:
    assert not git('diff', '--name-only', source, 'HEAD', '--', path)
binding = json.loads((current/'evidence/canonical-source-binding.json').read_bytes())
assert binding['source'] == source
for row in binding['canonicalFiles']:
    b = git('show', source+':'+row['path'])
    assert len(b) == row['bytes'] and sha(b) == row['sha256']
    assert git('rev-parse', source+':'+row['path']).decode().strip() == row['gitBlob']
source_bindings = []
prior_bindings = json.loads((packet/'FINAL-QUALIFICATION.json').read_bytes())['sourceBindings']
for row in prior_bindings:
    p = row['path']; b = git('show', source+':'+p)
    source_bindings.append({'path': p, 'gitBlob': git('rev-parse', source+':'+p).decode().strip(), 'sha256': sha(b), 'bytes': len(b)})
result = {'sourceHead': source, 'sourceTree': git('rev-parse', source+'^{tree}').decode().strip(),
 'artifactSha256': expected['38'], 'artifactBytes': archives['38'].stat().st_size,
 'declarationBodiesCount': len(bodies), 'allDeclarationBodiesEqual794And37': True,
 'declarationBodies': bodies, 'declarationMapsCount': len(maps),
 'allDeclarationMapsEqual37': True, 'declarationMaps': maps,
 'historicalPacketHead': old_head, 'historicalIndexedFilesPreservedPhysicallyAndInGit': preserved,
 'historicalIndexByteExact': True, 'reusedInvariantInputsByteExact': reused,
 'old697dArtifactPreserved': True, '794And37ArtifactsPreserved': True,
 'packageMetadataByteExact794And37AndCurrentSource': True,
 'finalCorpusMatchesExactSource': True, 'sourceBindings': source_bindings,
 'canonicalSourceConfigIdentitiesVerified': len(binding['canonicalFiles']),
 'fullCore17Reexecuted': False, 'qualificationScope': 'Exact published declaration-byte continuity allows the root to reuse prior Core17 qualification; no new Core run, runtime API, provider, frontend page, delivery or native database acceptance.'}
out = current/'evidence/final38-continuity.json'
assert not out.exists()
out.write_text(json.dumps(result, indent=2)+'\n')
print(json.dumps({'declarationBodiesEqual794And37':len(bodies), 'declarationMapsEqual37':len(maps),
 'declarationMapsDifferFrom794':sum(not x['equal794To38'] for x in maps),
 'oldIndexedFilesPreserved':len(preserved), 'reusedInvariantInputs':len(reused),
 'canonicalSourceConfigIdentitiesVerified':len(binding['canonicalFiles']), 'sourceBindings':len(source_bindings)}, indent=2))
