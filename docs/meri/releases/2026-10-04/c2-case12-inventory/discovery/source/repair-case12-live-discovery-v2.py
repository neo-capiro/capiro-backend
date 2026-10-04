from pathlib import Path
import hashlib,subprocess
r=Path(__file__).resolve().parent
old=r/'case12-live-discovery-inner-v1.mjs'
inner=r/'case12-live-discovery-inner-v2.mjs'
text=old.read_text(encoding='utf-8')
assert text.count('mi.id=mc.committed_memory_id')==1
text=text.replace('mi.id=mc.committed_memory_id','mi.id=mc.committed_memory_item_id')
assert not inner.exists()
inner.write_bytes(text.encode())
outer=(r/'read-case12-live-discovery-v1.mjs').read_text(encoding='utf-8')
outer=outer.replace('case12-live-discovery-v1','case12-live-discovery-v2').replace('case12-live-discovery-inner-v1','case12-live-discovery-inner-v2')
outer=outer.replace(hashlib.sha256(old.read_bytes()).hexdigest(),hashlib.sha256(inner.read_bytes()).hexdigest())
out=r/'read-case12-live-discovery-v2.mjs'
assert not out.exists()
out.write_bytes(outer.encode())
for p in (inner,out):
 subprocess.run(['C:/Program Files/nodejs/node.exe','--check',str(p)],check=True)
 print(p.name,hashlib.sha256(p.read_bytes()).hexdigest())
