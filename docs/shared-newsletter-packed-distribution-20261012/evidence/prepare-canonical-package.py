#!/usr/bin/env python3
"""Materialize only the pinned canonical package and compiler base; no install."""
import hashlib
import json
import os
import subprocess
from pathlib import Path

ROOT=Path(__file__).resolve().parents[3]
SOURCE='fe50dc1c2de1660a036e338cf81acdcf0f2fb26a'
TREE='00ca67ae1f2cacc1ae0b51fff25cb33d58954f67'
STAGE=Path('/tmp/capiro-shared-newsletter-dist-fe50-20261012')
assert not STAGE.exists(), 'Stage must be pristine, never reuse stale compiler output'
STAGE.mkdir()

def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT)
assert git('rev-parse',SOURCE+'^{tree}').decode().strip()==TREE
rows=[]
for item in git('ls-tree','-rz',SOURCE,'--','packages/shared','tsconfig.base.json').split(b'\0'):
    if not item:continue
    meta,name=item.split(b'\t',1);mode,kind,oid=meta.decode().split();name=name.decode()
    assert kind=='blob' and mode in ['100644','100755'], (name,mode)
    raw=git('show',SOURCE+':'+name);target=STAGE/name
    target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(raw)
    os.chmod(target,0o755 if mode=='100755' else 0o644)
    rows.append({'path':name,'mode':mode,'gitBlob':oid,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
assert len([r for r in rows if r['path'].startswith('packages/shared/')])==38
(STAGE/'node_modules').symlink_to('/workspace/capirov2/node_modules',target_is_directory=True)
(STAGE/'build-state').mkdir()
(STAGE/'npm-cache').mkdir()
pkg=json.loads((STAGE/'packages/shared/package.json').read_bytes())
assert pkg['name']=='@capiro/shared' and pkg['version']=='0.0.0'
assert not set(pkg.get('scripts',{})) & {'prepare','prepack','postpack','prepublish','prepublishOnly','install','preinstall','postinstall'}
five=['newsletter.ts','newsletter-render.ts','newsletter-fonts.ts','newsletter-fonts.catalog.ts','newsletter-social-share.ts']
original=[]
for filename in five:
    path='packages/shared/src/'+filename;current=git('show',SOURCE+':'+path)
    for ref in ['1e99f0921b207318c6d2abf03927b5c4daa5768b','193703e34f2bedbb69d87d6a8ee303f65ab8dbda']:
        assert current==git('show',ref+':'+path), (path,ref)
    original.append({'path':path,'sha256':hashlib.sha256(current).hexdigest(),'originalCwByteExact':True})
print(json.dumps({'source':SOURCE,'tree':TREE,'stage':str(STAGE),'package':pkg,'canonicalFiles':rows,
                  'fiveOriginalModules':original,'compilerOutputPristine':not (STAGE/'packages/shared/dist').exists(),
                  'cacheBindingPrivateUnpacked':str(STAGE/'node_modules'),'productSourceEdits':0},indent=2))
