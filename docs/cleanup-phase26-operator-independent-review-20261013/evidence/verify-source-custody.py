import pathlib, subprocess, json, hashlib
packet = pathlib.Path(__file__).resolve().parent.parent
root = packet.parent.parent
source = '31cc12a6626be8586666dfa9ccf53b68fff10311'
author = '8d08e2c8b17abfa2649bad073c0aeccf168ce0b4'
base = 'c07d00e27fdda64dfbd13c36d0ac433c81d9f7f4'
old = 'c8c109f7d796d5a50ae57ff6cb214d576c757847'
union = 'd69d26c210ea9307c9b8843e3a0930738c79abdb'
prefix = 'docs/cleanup-phase26-compatible-scopes-20261013'
def git(*args): return subprocess.check_output(['git', *args], cwd=root)
assert not [p for p in git('diff', '--name-only', old, base).decode().splitlines() if not p.startswith('docs/')]
paths = [p for p in git('diff', '--name-only', base, source).decode().splitlines() if not p.startswith('docs/')]
assert len(paths) == 8 and all(p.startswith('scripts/') for p in paths)
assert all(git('show', source + ':' + p) == git('show', 'HEAD:' + p) == git('show', union + ':' + p) for p in paths)
protected = ['package.json', '.github/workflows/ci-pr.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'scripts/knowledge-plane-phase26-typecheck-baseline.json', 'scripts/check-registry-ownership.mjs', 'scripts/check-strategy-time-bypasses.mjs']
for p in protected:
    entry = git('ls-tree', base, '--', p)
    assert entry and entry == git('ls-tree', source, '--', p)
indices = []
for name in ['SHA256SUMS.json', 'ALIAS-CORRECTION-SHA256SUMS.json', 'HUNK-CORRECTION-SHA256SUMS.json']:
    entries = json.loads(git('show', author + ':' + prefix + '/' + name))['entries']
    for row in entries:
        data = git('show', author + ':' + prefix + '/' + row['path'])
        assert len(data) == row['bytes'] and hashlib.sha256(data).hexdigest() == row['sha256']
    indices.append({'path': name, 'bindings': len(entries)})
aliases = dict(('validate:knowledge-plane:phase26:' + suffix, 'node scripts/validate-knowledge-plane-phase26.mjs --run ' + flags) for suffix, flags in [('backend','--backend-only'),('backend:typing','--backend-only --skip-tests'),('backend:source','--backend-only --source-only'),('frontend','--frontend-only')])
pkg = json.loads(git('show', union + ':package.json'))
for name, value in aliases.items():
    assert pkg['scripts'].pop(name) == value
assert pkg == json.loads(git('show', base + ':package.json'))
union_paths = [p for p in git('diff', '--name-only', base, union).decode().splitlines() if not p.startswith('docs/')]
assert sorted(union_paths) == sorted(paths + ['package.json'])
assert subprocess.run(['git', 'merge-base', '--is-ancestor', old, base], cwd=root).returncode == 0
result = {'acceptedSource': source, 'sourceTree': git('rev-parse', source + '^{tree}').decode().strip(), 'authorEvidence': author, 'authorTree': git('rev-parse', author + '^{tree}').decode().strip(), 'publishedBase': base, 'authorBase': old, 'authorBaseAncestorOfPublished': True, 'authorBaseAndPublishedNonDocExact': True, 'sourcePaths': paths, 'outsideEightNonDocExact': True, 'protectedExistingPathsExact': protected, 'authorIndicesVerified': indices, 'rootUnion': union, 'rootUnionTree': git('rev-parse', union + '^{tree}').decode().strip(), 'rootUnionNinePaths': True, 'rootFourAliasesExact': aliases, 'nativeExecuted': False, 'fourHelpersUsed': True, 'noDeadPhase27WalkerOrMarkerAdopted': True}
(packet / 'evidence/SOURCE-AND-CUSTODY.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'sourcePaths': len(paths), 'authorBindings': sum(p['bindings'] for p in indices), 'rootUnionPaths': len(union_paths), 'sqlExecuted': False}))
