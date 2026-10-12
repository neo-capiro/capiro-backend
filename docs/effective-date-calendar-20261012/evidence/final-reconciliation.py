"""Source-only Git/blob verification and final documentation reconciliation.

Run from the repository root. This reads Git objects and writes only this docs
directory. It does not run tests, databases, migrations, native engines or providers.
"""
import datetime
import hashlib
import itertools
import json
import pathlib
import subprocess

doc = pathlib.Path('docs/effective-date-calendar-20261012')
ev = doc / 'evidence'
main = '4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace'
prior = '7b6fdae2b9ff1fa6d3fbe594ff1a5a0084f6fa5f'


def blob(head, path):
    return subprocess.check_output(['git', 'show', head + ':' + str(path)])


def digest(data):
    return hashlib.sha256(data).hexdigest()


def paths(base, head):
    return sorted(p for p in subprocess.check_output(
        ['git', 'diff', '--name-only', base, head], text=True).splitlines()
        if not p.startswith('docs/'))


for old, new in [('current-published-source-matrix.json', 'published-source-matrix-at-7b6fdae.json'),
                 ('SHA256SUMS-current.json', 'SHA256SUMS-at-7b6fdae.json')]:
    data = blob(prior, ev / old)
    target = ev / new
    if target.exists():
        assert target.read_bytes() == data
    else:
        target.write_bytes(data)

old_checks = []
for head, name in [('f5a043c2558c1073b46bbeab81e60c403830d299', 'SHA256SUMS.json'),
                   ('762aea0004dba51643ff370e7029de266966b74e', 'SHA256SUMS-at-762aea.json'),
                   (prior, 'SHA256SUMS-at-7b6fdae.json')]:
    manifest = json.loads((ev / name).read_text())
    bad = [p for p, h in manifest['files'].items() if digest(blob(head, p)) != h]
    assert not bad, bad
    old_checks.append(dict(sourceHead=head, manifest=name,
                           filesVerified=len(manifest['files']), failures=bad))

published = 'c05b85a29a75cbaaa8538fd7f9a97e298a23913e'
accepted = '490076ab8a9a5db72eda97b0d576a81e87f81cbb'
ws_doc = 'docs/workspace-objective-revisions-20261012'
review = json.loads(blob(published, ws_doc + '/evidence/independent-review/RECEIPT.json'))
for item in review['sourcePaths']:
    assert blob(accepted, item['path']) == blob(published, item['path'])
    assert digest(blob(published, item['path'])) == item['sha256']
for item in review['publishedSeams']:
    assert blob(item['publishedHead'], item['path']) == blob(published, item['path'])
    assert digest(blob(published, item['path'])) == item['sha256']
changed = subprocess.check_output(['git', 'diff', '--name-only', accepted, published], text=True).splitlines()
assert all(p.startswith('docs/') for p in changed)
ws_manifest = json.loads(blob(published, ws_doc + '/evidence/SHA256SUMS.json'))
# Workspace's published evidence manifest intentionally uses a descriptor list.
ws_files = ws_manifest['files']
assert isinstance(ws_files, list)
for item in ws_files:
    assert digest(blob(published, item['path'])) == item['sha256'], item['path']

snapshots = json.loads((ev / 'final-published-candidate-refresh.json').read_text())['candidates']
assert len(snapshots) == 5 and all(s['draft'] and s['state'] == 'open' and not s['merged'] for s in snapshots)
base_by_pr = {2401: '6c26ac2dad3756a61b6733329dea7ce3c9138ece',
              2402: '72bfea4c5f574c2d9dba63c6bbc63dac1c7e377e', 2403: main,
              2404: '4a784b58a0d41251ae6d7dea75a9b4858abc8665',
              2405: '3c20f798c731403ffe2bbb6fa75dcb1bbf80bb16'}
candidates = []
for snapshot in snapshots:
    pr, head = snapshot['pr'], snapshot['head']
    base = base_by_pr[pr]
    tree = subprocess.check_output(['git', 'rev-parse', head + '^{tree}'], text=True).strip()
    candidates.append(dict(pr=pr, url=f'https://github.com/neo-capiro/capirov2/pull/{pr}',
                           head=head, tree=tree, prBaseBranch=snapshot['base'],
                           prBaseHead=snapshot['baseHead'], incrementalBase=base,
                           draft=True, merged=False, incrementalSourcePaths=paths(base, head),
                           wholeCandidateSourcePaths=paths(main, head)))
pairs = [dict(prs=[a['pr'], b['pr']],
              incrementalSourceIntersection=sorted(set(a['incrementalSourcePaths']) & set(b['incrementalSourcePaths'])),
              wholeCandidateSourceIntersection=sorted(set(a['wholeCandidateSourcePaths']) & set(b['wholeCandidateSourcePaths'])))
         for a, b in itertools.combinations(candidates, 2)]
originals = json.loads((ev / 'original-candidate-refresh-0843.json').read_text())['candidates']
original_intersections = []
for original in originals:
    assert original['unchanged']
    head = original['originalHead']
    base = subprocess.check_output(['git', 'merge-base', main, head], text=True).strip()
    own = paths(base, head)
    original['sourceMergeBase'], original['sourcePathsFromMergeBase'] = base, own
    for current in candidates:
        intersection = sorted(set(own) & set(current['incrementalSourcePaths']))
        original_intersections.append(dict(originalPR=original['pr'], candidatePR=current['pr'],
                                           originalHead=head, candidateHead=current['head'],
                                           incrementalSourceIntersection=intersection))
matrix = dict(main=main, verifiedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
              pathScope='Source/package/schema/test paths only; docs/evidence excluded. Incremental implementation bases, actual PR base heads and whole candidates are distinct. Original candidate paths start at their recorded merge base with main.',
              calendarSnapshotNotice='The calendar row is an immutable source/evidence pin before this docs-only handoff publication. The later exact publication head/tree is reported in PR2403 metadata and the completion receipt; runtime source remains unchanged.',
              currentSourceCandidates=candidates, pairs=pairs, preservedOriginalCandidates=originals,
              originalCandidateIntersections=original_intersections,
              sharedHelper=dict(publishedPR=2404, head=candidates[3]['head'],
                                acceptedSource='d198733d66ea6b6b29eaafbccb6a76b6a174b239',
                                path='packages/shared/src/client-objective-destination.ts',
                                gitBlob='767a11ddff2ff43a39cdf572029b40a4976facac',
                                sha256='a7fafdf28c55cb9af93b2faf5fbb4b824023622cc68b08501e0d367dcf4a5443',
                                workspaceConsumerPR=2405, workspaceHead=published, byteIdentical=True),
              objectiveDestinationsReadObservationOnly=True,
              objectiveDurableCreationOrAssociationClosed=False,
              generalWorkspaceAuthorityClosed=False,
              preservedSnapshots=['initial-published-source-matrix.json', 'published-source-matrix-at-762aea.json',
                                  'published-source-matrix-at-7b6fdae.json'])
(ev / 'current-published-source-matrix.json').write_text(json.dumps(matrix, indent=2) + '\n')
receipt = dict(verifiedAt=matrix['verifiedAt'],
               scope='Docs/evidence reconciliation only. No test repetition, DB or provider operations.',
               retainedReaderFailure='final-reconciliation-initial-error.log',
               preservedManifestChecks=old_checks,
               workspacePublished=dict(pr=2405, head=published, tree=candidates[-1]['tree'],
                                       acceptedSource=accepted, acceptedSourcePathsVerified=len(review['sourcePaths']),
                                       publishedSeamIdentitiesVerified=len(review['publishedSeams']),
                                       publishedEvidenceFilesVerified=len(ws_files), runtimeChangesAfterReview=[],
                                       independentCases=82, combinedCases=133),
               originalHeadsVerified=len(originals), newCandidateStatesVerified=len(candidates),
               sourcePairIntersections=len(pairs), originalCandidateIntersections=len(original_intersections),
               noCombinedRuntimeOrNativeAcceptance=True)
(ev / 'final-publication-reconciliation.json').write_text(json.dumps(receipt, indent=2) + '\n')
manifest = json.loads((ev / 'SHA256SUMS-at-7b6fdae.json').read_text())
listed = set(manifest['files'])
listed.update(str(ev / p) for p in ['published-source-matrix-at-7b6fdae.json', 'SHA256SUMS-at-7b6fdae.json',
                                   'original-candidate-refresh-0843.json', 'final-published-candidate-refresh.json',
                                   'final-publication-reconciliation.json', 'final-reconciliation-initial-error.log',
                                   'final-reconciliation.py'])
manifest['preservedPriorPublication'] = prior
manifest['scope'] = 'Current calendar source/evidence plus final five-slice consolidated handoff; earlier 66/98/105 manifests remain immutable and verified against their recorded heads.'
manifest['files'] = {p: digest(pathlib.Path(p).read_bytes()) for p in sorted(listed)}
(ev / 'SHA256SUMS-current.json').write_text(json.dumps(manifest, indent=2) + '\n')
assert all(digest(pathlib.Path(p).read_bytes()) == h for p, h in manifest['files'].items())
print(json.dumps(dict(preservedManifests=old_checks, workspaceSourcePaths=len(review['sourcePaths']),
                      publishedSeams=len(review['publishedSeams']), workspaceEvidenceFiles=len(ws_files),
                      originalHeads=len(originals), candidatePairs=len(pairs),
                      originalCandidatePairs=len(original_intersections), currentManifestFiles=len(manifest['files'])), indent=2))
