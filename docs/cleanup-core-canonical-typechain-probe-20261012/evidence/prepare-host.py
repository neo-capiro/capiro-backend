import pathlib,json,hashlib,os,subprocess
root=pathlib.Path.cwd(); packet=root/'docs/cleanup-core-canonical-typechain-probe-20261012'; ev=packet/'evidence'
cached=pathlib.Path('/workspace/capirov2-cleanup-reviewed-source-composition/apps/api/node_modules')
api=root/'apps/api/node_modules'
assert api.is_symlink() and api.resolve()==cached.resolve()
api.unlink(); api.mkdir()
links=[]
def link(dst,target):
    dst.parent.mkdir(parents=True,exist_ok=True); os.symlink(str(target),str(dst)); links.append({'path':str(dst.relative_to(root)),'target':str(target),'realpath':str(dst.resolve()),'exists':dst.exists()})
for item in sorted(cached.iterdir()):
    if item.name in ['.bin','@capiro','@prisma']: continue
    link(api/item.name,item.resolve())
for scope in ['@capiro','@prisma']:
    (api/scope).mkdir()
    for item in sorted((cached/scope).iterdir()):
        if scope=='@capiro' and item.name in ['shared','meriv2-core']: continue
        if scope=='@prisma' and item.name=='client': continue
        link(api/scope/item.name,item.resolve())
for package in ['shared','auth','meriv2-core']:
    own=root/'packages'/package
    link(own/'dist',pathlib.Path('/tmp/capirov2-cleanup-meri-reviewed-runtime-conversion/packages')/package/'dist')
    link(api/'@capiro'/package,own)
link(api/'@prisma/client',pathlib.Path('/tmp/capirov2-local-native-prerequisite-20261012/core-client'))
(api/'.bin').mkdir()
link(api/'.bin/node',pathlib.Path('/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node'))
link(api/'.bin/tsc',pathlib.Path('/workspace/capirov2/node_modules/typescript/bin/tsc').resolve())
link(api/'.bin/tsx',pathlib.Path('/workspace/capirov2/node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/cli.mjs'))
def ident(path):
    b=path.read_bytes(); return {'path':str(path),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
script=json.loads((root/'apps/api/package.json').read_text())['scripts']['typecheck']
(ev/'canonical-script.txt').write_text(script+'\n')
files=['apps/api/package.json','tsconfig.base.json','apps/api/tsconfig.json','apps/api/prisma/schema.prisma','apps/api/scripts/verify-pe-phase-a-safety.ts','apps/api/scripts/lib/defense-budget-ingest-mode.ts','apps/api/scripts/lib/defense-budget-commit.ts','apps/api/scripts/lib/pe-exact-sha-loader-contract.ts','apps/api/scripts/lib/pe-migration-guards.ts','apps/api/src/defense-budget/promotion/legacy-budget-write-gate-v1.ts','apps/api/src/defense-budget/promotion/snapshot-read-mode-v1.ts']
files += ['apps/api/'+seg.split(' -p ')[1].split()[0] for seg in script.split(' && ') if ' -p ' in seg]
external=[pathlib.Path('/tmp/capirov2-local-native-prerequisite-20261012/core-client')/p for p in ['package.json','schema.prisma','index.d.ts']]
external += [root/'packages'/p/'dist/index.d.ts' for p in ['shared','auth','meriv2-core']]
record={'baseHead':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'baseTree':subprocess.check_output(['git','rev-parse','HEAD^{tree}'],text=True).strip(),'script':script,'segments':[{'index':i+1,'command':s} for i,s in enumerate(script.split(' && '))],'sourceIdentities':[ident(root/p) for p in files],'externalIdentities':[ident(p) for p in external],'links':links,'node':subprocess.check_output([str(api/'.bin/node'),'--version'],text=True).strip(),'typescript':subprocess.check_output([str(api/'.bin/node'),str(api/'.bin/tsc'),'--version'],text=True).strip(),'safetyAudit':{'runtimeClosure':['node:assert','node:fs','node:path','node:crypto','./lib/defense-budget-ingest-mode.js','./lib/defense-budget-commit.js','./lib/pe-migration-guards.js','./lib/pe-exact-sha-loader-contract.js','../src/defense-budget/promotion/legacy-budget-write-gate-v1.js','../src/defense-budget/promotion/snapshot-read-mode-v1.js'],'typeOnlyAssertionMapperNotEvaluated':True,'effectScope':'source readFileSync, synthetic assertions, pure helpers, console success; no shell, SQL, provider/client construction','readAsTextOnly':['scripts/entrypoint.sh','scripts/entrypoint-legacy.sh','scripts/entrypoint-dispatcher.inc','scripts/ingest-defense-budget-pdf.ts','scripts/audit-llamaparse-pe-units.ts']},'nativeGeneratedClient':'read-only supplied declarations/package; no import, client creation, generation, native loading or connections','packageExecution':'actual existing Node/typescript/tsx via symlinks; no shim function/fake compiler/PM/install'}
(ev/'host-audit.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps({'segments':len(record['segments']),'links':len(links),'node':record['node'],'typescript':record['typescript'],'trackedDelta':subprocess.check_output(['git','diff','--name-only'],text=True).splitlines()}))
