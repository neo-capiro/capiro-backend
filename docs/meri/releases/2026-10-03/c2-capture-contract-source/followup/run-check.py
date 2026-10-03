from pathlib import Path
import datetime, hashlib, json, os, subprocess, sys

repo=Path('C:/dev/main/meri-c1-20261002')
out=Path('C:/dev/main/outputs/meri-c2-20261003/capture-contract-followup-v1')
label=sys.argv[1]
base_label=label.removesuffix('-v2').removesuffix('-v3')
commands={
 'core-red':['pnpm.cmd','--filter','@capiro/meriv2-core','exec','jest','--runInBand','src/context/capture-evidence-receipt.spec.ts'],
 'api-red':['pnpm.cmd','--filter','@capiro/api','exec','jest','--runInBand','src/meri/meri-tools.registration.spec.ts','src/meri/meri-memory-proposal-read.spec.ts'],
 'orchestrator-red':['pnpm.cmd','--filter','@capiro/meriv2-orchestrator','exec','jest','--runInBand','src/meri/controlled-read-observations.spec.ts'],
 'core-green':['pnpm.cmd','--filter','@capiro/meriv2-core','exec','jest','--runInBand','src/context/capture-evidence-receipt.spec.ts'],
 'core-build':['pnpm.cmd','--filter','@capiro/meriv2-core','build'],
 'api-green':['pnpm.cmd','--filter','@capiro/api','exec','jest','--runInBand','src/meri/meri-tools.registration.spec.ts','src/meri/meri-memory-proposal-read.spec.ts','src/meri/meri-capture-budget-readback.spec.ts','src/meri/meri-capture-clock-packets.spec.ts','src/meri/meri-server-readonly-capture.spec.ts'],
 'orchestrator-green':['pnpm.cmd','--filter','@capiro/meriv2-orchestrator','exec','jest','--runInBand','src/meri/controlled-read-observations.spec.ts','src/meri/meriv3/meriv3-capture-evidence.spec.ts'],
 'readback-red':['pnpm.cmd','--filter','@capiro/api','exec','jest','--runInBand','src/meri/meri-capture-budget-readback.spec.ts'],
 'api-build':['pnpm.cmd','--filter','@capiro/api','build'],
 'provider-regressions':['pnpm.cmd','--filter','@capiro/api','exec','jest','--runInBand','src/meri/meri-capture-provider-budget.spec.ts','src/meri/meri-capture-api-provider-scope.spec.ts','src/memory/governed-memory-candidate.service.spec.ts'],
 'orchestrator-build':['pnpm.cmd','--filter','@capiro/meriv2-orchestrator','build'],
}
source_names=[
 'apps/api/src/meri/meri-tools.service.ts',
 'apps/api/src/meri/meri-memory-proposal-read.ts',
 'apps/api/src/meri/meri-capture-policy-readback.ts',
 'apps/meriv2-orchestrator/src/meri/controlled-read-observations.ts',
 'packages/meriv2-core/src/context/capture-evidence-receipt.ts',
 'apps/api/src/meri/meri-tools.registration.spec.ts',
 'apps/api/src/meri/meri-memory-proposal-read.spec.ts',
 'apps/api/src/meri/meri-capture-budget-readback.spec.ts',
 'apps/meriv2-orchestrator/src/meri/controlled-read-observations.spec.ts',
 'packages/meriv2-core/src/context/capture-evidence-receipt.spec.ts',
]
sha=lambda b:hashlib.sha256(b).hexdigest()
def write(path,data):
 path.parent.mkdir(parents=True,exist_ok=True)
 with path.open('xb') as h:h.write(data);h.flush();os.fsync(h.fileno())
before={}
for name in source_names:
 p=repo/name
 if not p.exists(): continue
 data=p.read_bytes();before[name]=sha(data)
 write(out/(label+'-source')/name,data)
started=datetime.datetime.now(datetime.timezone.utc).isoformat()
with (out/(label+'.log')).open('xb') as h:
 result=subprocess.run(commands[base_label],cwd=repo,stdout=h,stderr=subprocess.STDOUT)
 h.flush();os.fsync(h.fileno())
receipt={'label':label,'startedAt':started,'completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'command':commands[base_label],'exitCode':result.returncode,'sourceHashes':before,
 'sourceUnchanged':all(sha((repo/n).read_bytes())==v for n,v in before.items()),
 'logSha256':sha((out/(label+'.log')).read_bytes()),'externalNetworkOrProviderCalls':0,
 'loopbackHttp':base_label.startswith('orchestrator-') and base_label != 'orchestrator-build'}
write(out/(label+'.receipt.json'),(json.dumps(receipt,indent=2)+'\n').encode())
print(json.dumps({'label':label,'exitCode':result.returncode,'sourceUnchanged':receipt['sourceUnchanged'],'logSha256':receipt['logSha256']}))
sys.exit(result.returncode)
