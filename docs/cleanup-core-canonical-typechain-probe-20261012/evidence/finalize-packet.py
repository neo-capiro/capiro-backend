import pathlib,json,hashlib,subprocess
root=pathlib.Path.cwd();packet=root/'docs/cleanup-core-canonical-typechain-probe-20261012';ev=packet/'evidence';base='681309d208f2c1c344892f8f446a7fa0b4db0a31'
script=json.loads((root/'apps/api/package.json').read_text())['scripts']['typecheck'];commands=script.split(' && ')
first=json.loads((ev/'01-supplied-prerequisites.json').read_text());final=json.loads((ev/'02-short-owned-temp.json').read_text());log=(ev/'02-short-owned-temp.log').read_text()
assert first['exitCode']==1 and len(first['executed'])==16 and len(first['unrun'])==1
assert final['exitCode']==0 and final['signal'] is None and final['executed']==commands and not final['unrun']
assert 'PE_PHASE_A_B_SAFETY_OK' in log
assert len(commands)==17 and sum(s.startswith('tsc ') for s in commands)==16
assert subprocess.check_output(['git','diff','--name-only',base],cwd=root,text=True).strip()==''
for receipt in [first,final]:
    p=pathlib.Path(receipt['rawLog']['path']);b=p.read_bytes();assert len(b)==receipt['rawLog']['bytes'] and hashlib.sha256(b).hexdigest()==receipt['rawLog']['sha256']
rows=[{'index':i+1,'command':command,'firstAttempt':'PASS' if i<15 else ('CLI_HOST_FAIL_ENTRY_UNRUN' if i==15 else 'UNRUN'),'correctedHostAttempt':'PASS'} for i,command in enumerate(commands)]
(ev/'result.json').write_text(json.dumps({'baseHead':base,'baseTree':subprocess.check_output(['git','rev-parse',base+'^{tree}'],cwd=root,text=True).strip(),'canonicalChainExit':0,'totalSegments':17,'compilerInvocations':16,'safeActualScriptInvocations':1,'segments':rows,'originalFailureRetained':True,'sourceDelta':[],'hostChangeOnly':'owned TMPDIR shortened; no canonical flags or executable substitutions','qualification':'Canonical package script body run directly with cached real tools/current client declarations/compiled prerequisites; no pnpm lifecycle/install, clean-install/native Postgres/RLS/provider/app-bootstrap/runtime acceptance claim'},indent=2)+'\n')
readme='''The actual canonical Core package typecheck passed on `681309d208f2c1c344892f8f446a7fa0b4db0a31` (tree `c82bd49d324f50631ae017ffdbac12504e9c7d1c`). All 17 segments ran and returned exit 0: 16 compiler invocations and the actual `tsx scripts/verify-pe-phase-a-safety.ts` entry, which emitted `PE_PHASE_A_B_SAFETY_OK`. No product/source/config/package changes were made.

The exact `apps/api/package.json` script was executed directly from `apps/api` with its original `&&` sequence and flags, using real cached Node v24.19.0, TypeScript 5.9.3 and tsx 4.23.15. The launcher environment is recorded; the shell/child tools can add their normal controlled process variables. No package manager, install, native generation, app bootstrap, database, migration, paid model, real provider/message/upload/customer operation ran.

The first attempt passed its first 15 compiler segments, then the cached tsx CLI failed before evaluating the safety entry. Its 145-byte Unix IPC pathname exceeded the local Linux `sun_path[108]` capacity. The final LegiWatch step was skipped by the preserved `&&` protocol. The raw error, child exit 1, original runner, and source/native-declaration identity receipts remain intact. The second attempt shortened only owned `TMPDIR`, producing an equivalent 56-byte IPC pathname. That complete retry passed all segments; no compiler flags, source, executable implementation or assertions changed.

The safety entry and all seven source modules in its runtime import closure were inspected before execution. They use Node built-ins, synthetic assertions, pure helpers, and source `readFileSync` checks. The ingestion, audit and migration entrypoints are read as text. The assertion-mapper import is type-only and is not evaluated. This is a bounded audit of this exact source closure, not an assurance for arbitrary scripts.

Worktree-local links resolve the exact current generated Core schema/declarations, the current prebuilt Shared/Auth/MCore declarations, and cached Defense declarations. The supplied native-client schema matches Core byte-for-byte; the client/native engine was not imported or instantiated. Shared/Auth/MCore source matches the pinned base. Defense source/config/export fields match the pinned base; its older cache has only an unused scorecard alias/script delta. The actual resolver paths and 78 Defense declaration hashes are preserved. The preliminary composition-folder inspection did not reveal those cache realpaths; the correction is recorded explicitly. No missing-Defense compiler failure occurred, and no extra package builds were needed.

This closes the ordinary canonical Core typecheck with these cached prerequisites. It does not establish a clean frozen install, native PostgreSQL/RLS or migration acceptance, real provider behavior, full app bootstrap or frontend acceptance. Database/provider/security/credentials and the separate unpublished reporting owner's work were untouched.

Evidence: [final result](evidence/result.json), [successful raw log](evidence/02-short-owned-temp.log), [actual child command/exit receipt](evidence/02-short-owned-temp.json), [original host failure](evidence/01-supplied-prerequisites.log), [host correction](evidence/01-host-temp-path-correction.json), [safety/source audit](evidence/safety-and-prerequisite-audit.json), [resolver identities](evidence/tool-and-resolution-identities.json), [Defense provenance](evidence/defense-cache-lineage.json), and [SHA index](SHA256-INDEX.json).
'''
(packet/'README.md').write_text(readme)
files=[]
for p in sorted(packet.rglob('*')):
    if not p.is_file() or 'local-tmp' in p.parts or p.name=='SHA256-INDEX.json':continue
    b=p.read_bytes();files.append({'path':str(p.relative_to(root)),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
(packet/'SHA256-INDEX.json').write_text(json.dumps({'scope':'Curated task packet only; excludes index itself, owned temp/IPC/tsx cache and dependency symlinks/generated outputs. Source/dependency/tool identities are separate receipts.','files':files},indent=2)+'\n')
for item in files:
    b=(root/item['path']).read_bytes();assert len(b)==item['bytes'] and hashlib.sha256(b).hexdigest()==item['sha256']
print(json.dumps({'canonicalExit':0,'compilerInvocations':16,'safety':1,'filesIndexed':len(files),'nonDocSourceDelta':[]}))
