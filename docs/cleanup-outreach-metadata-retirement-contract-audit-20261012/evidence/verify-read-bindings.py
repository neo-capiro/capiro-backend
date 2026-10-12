import hashlib, json, pathlib, subprocess
root = pathlib.Path(__file__).resolve().parents[3]
packet = pathlib.Path(__file__).resolve().parent.parent
bindings = json.loads((packet/'evidence/READ-BINDINGS.json').read_text())
checks = []
for row in bindings['rows']:
    repo = root if row['repository'] == 'capirov2' else pathlib.Path('/workspace/capiro-frontend')
    assert row['path'] != 'apps/api/src/engagement/engagement.service.ts', 'protected implementation must never be read'
    data = subprocess.check_output(['git', 'show', f"{row['ref']}:{row['path']}"], cwd=repo)
    blob = subprocess.check_output(['git', 'rev-parse', f"{row['ref']}:{row['path']}"], cwd=repo, text=True).strip()
    assert hashlib.sha256(data).hexdigest() == row['sha256'] and len(data) == row['bytes'] and blob == row['blob']
    checks.append({'repository':row['repository'],'path':row['path'],'verified':True})
for item in bindings['legacyNewsletterOwnerSourceOriginals']:
    data = subprocess.check_output(['git','show',f"{item['ref']}:apps/api/src/engagement/newsletter-outreach.service.ts"],cwd=root)
    assert hashlib.sha256(data).hexdigest() == item['sha256'] and item['sourceExact']
for ref in ['f3fab43ab8e01a066f56559fabb273969f01f1ff','d587441261fd356ee5144a8fc29cb2f771d062b8']:
    paths = subprocess.check_output(['git','diff','--name-only',bindings['destination'],ref],cwd=root,text=True).splitlines()
    assert all(p.startswith('docs/') for p in paths)
    checks.append({'laterRoot':ref,'changedPaths':len(paths),'onlyDocs':True})
print(json.dumps({'checks':checks,'protectedBodyRead':False,'applicationChanged':False},indent=2))
