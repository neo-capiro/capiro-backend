import hashlib
import json
import pathlib
import shutil
import subprocess

packet = pathlib.Path(__file__).resolve().parent
consumer = pathlib.Path('/tmp/capiro-shared-independent-consumer-20261012/node_modules/@capiro/shared')
stage = pathlib.Path('/tmp/capiro-shared-independent-emission-20261012')
assert not stage.exists(), 'Pristine emission directory required'
shared = stage / 'packages/shared'
shared.mkdir(parents=True)
shutil.copytree(consumer / 'src', shared / 'src')
for name in ['package.json','tsconfig.json']:
    shutil.copyfile(consumer / name, shared / name)
source = 'fe50dc1c2de1660a036e338cf81acdcf0f2fb26a'
base = subprocess.check_output(['git','show',source + ':tsconfig.base.json'], cwd=packet)
(stage / 'tsconfig.base.json').write_bytes(base)
(stage / 'node_modules').symlink_to('/workspace/capirov2/node_modules', target_is_directory=True)
argv = ['/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node','/workspace/capirov2/node_modules/typescript/bin/tsc','-p',str(shared / 'tsconfig.json'),'--tsBuildInfoFile',str(stage / 'shared.tsbuildinfo')]
result = subprocess.run(argv,cwd=stage,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','TZ':'UTC'},stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=60)
(packet / 'reemit-packed-source.log').write_bytes(result.stdout)
receipt = {'argv':argv,'cwd':str(stage),'exitCode':result.returncode,'sourceInputs':'all 36 source files extracted from immutable tarball','rootConfigSource':source,'rootConfigSha256':hashlib.sha256(base).hexdigest(),'cachedCompilerTypesOnlyLink':'/workspace/capirov2/node_modules','publicConsumerSourceAliases':False}
(packet / 'reemit-packed-source-command.json').write_text(json.dumps(receipt,indent=2)+'\n')
assert result.returncode == 0, result.stdout.decode()
rows = []
original = {str(path.relative_to(consumer/'dist')):path for path in (consumer/'dist').rglob('*') if path.is_file()}
emitted = {str(path.relative_to(shared/'dist')):path for path in (shared/'dist').rglob('*') if path.is_file()}
assert set(original) == set(emitted)
for name,path in sorted(original.items()):
    data=path.read_bytes();assert data == emitted[name].read_bytes(),name
    rows.append({'path':'dist/'+name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
assert len(rows) == 144
(packet/'reemit-packed-source-equality.json').write_text(json.dumps({'all144PackedDistFilesByteExact':True,'rows':rows},indent=2)+'\n')
print(json.dumps({'exitCode':0,'packedDistFilesCompared':len(rows),'allByteExact':True}))
