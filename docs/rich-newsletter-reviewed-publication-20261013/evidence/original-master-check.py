import json,hashlib
from pathlib import Path
p=Path('docs/phase26-reviewed-publication-20261013/SHA256SUMS.json');rows=json.loads(p.read_text());m=[]
for name,want in rows.items():
 path=Path(name)
 if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=want:m.append(name)
assert m==['docs/cleanup-retirement-additional-reviewed-inputs-20261012/HANDOFF.md'],m
print(json.dumps({'verifiedPhysicalEntries':len(rows)-len(m),'intentionalSupersession':m,'preservedOldBytes':'docs/rich-newsletter-reviewed-publication-20261013/HANDOFF-PR2435.md'}))
