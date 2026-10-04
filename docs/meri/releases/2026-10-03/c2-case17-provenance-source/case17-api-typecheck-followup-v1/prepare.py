from pathlib import Path
import hashlib,json,difflib,subprocess,datetime
repo=Path('C:/dev/main/meri-c1-20261002');out=Path(__file__).parent
paths=['apps/api/src/meri/meri-capture-clock-packets.spec.ts','apps/api/src/meri/meri-memory-proposal-read.spec.ts']
hash=lambda b:hashlib.sha256(b).hexdigest()
files=[];patch=''
for p in paths:
    old=(repo/p).read_text();new=old
    if 'clock-packets' in p:
        start=new.index("  it.each([\n    ['missing'")
        end=new.index("])(\'keeps %s unproved",start)
        block=new[start:end]
        block=block.replace('it.each([','it.each<[string, (h: any) => unknown]>([',1)
        block=block.replace('.map(\n', '.map<[string, (h: any) => unknown]>(\n')
        assert block.count('.map<[string, (h: any) => unknown]>')==2
        block=block.replace('] as const,', '],')
        new=new[:start]+block+new[end:]
    else:
        new=new.replace("import type { MeriServerReadonlyCapturePolicy } from '@capiro/meriv2-core';\n",'')
        assert new.count('} as MeriServerReadonlyCapturePolicy;')==1
        new=new.replace('} as MeriServerReadonlyCapturePolicy;', '};')
        new=new.replace('result.candidates[0].proposedText','result.candidates[0]!.proposedText').replace('result.candidates[0].contentTruncated','result.candidates[0]!.contentTruncated')
    assert old!=new
    for folder,text in [('base',old),('source',new)]:
        target=out/folder/p;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(text.encode())
    files.append({'path':p,'baseSha256':hash(old.encode()),'sha256':hash(new.encode()),'bytes':len(new.encode()),'source':str(out/'source'/p),'base':str(out/'base'/p)})
    patch+=f'diff --git a/{p} b/{p}\n'+''.join(difflib.unified_diff(old.splitlines(keepends=True),new.splitlines(keepends=True),fromfile='a/'+p,tofile='b/'+p))
(out/'candidate.patch').write_bytes(patch.encode())
(out/'preparation.json').write_bytes((json.dumps({'sourceHead':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo).decode().strip(),'files':files,'patchSha256':hash(patch.encode()),'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat()},indent=2)+'\n').encode())
print(json.dumps({'patchSha256':hash(patch.encode()),'files':files}))
