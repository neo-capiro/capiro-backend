from pathlib import Path
import hashlib, json
packet=Path('docs/cleanup-exact-parser-backend-acceptance-independent-review-20261012')
index=json.loads((packet/'SHA256-INDEX.json').read_text())
for row in index['packet']:
    path=Path(row['path'])
    assert packet in path.parents
    content=path.read_bytes()
    assert len(content)==row['bytes']
    assert hashlib.sha256(content).hexdigest()==row['sha256'], str(path)
assert sorted(str(p) for p in packet.rglob('*') if p.is_file() and p.name!='SHA256-INDEX.json') == sorted(row['path'] for row in index['packet'])
print(json.dumps({'source':index['source'],'tree':index['tree'],'packetHashes':len(index['packet']),'verifiedArchiveFiles':index['verifiedArchiveFiles'],'failures':0}))
