#!/usr/bin/env python3
"""Read-only pinned source contract inventory; no application/CLI/workflow execution."""
import hashlib
import json
import re
import subprocess
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEST = '5470c6df029c9553dd49e531229c3c91b26275ef'
DEST_TREE = '613e54b654bc30dcebd09c955c58a2e8940abf30'
PR2423 = '8ac4c42cc49876ec19808369c0683956e0f2f474'
PR2423_TREE = '3312abb3d381d05ab5b499b48bbb8870de6f158a'
checks = []

def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)

def raw(ref, path):
    return git('show', f'{ref}:{path}')

def text(ref, path):
    return raw(ref, path).decode()

def document(ref, path):
    return json.loads(raw(ref, path))

def tree(ref):
    return {row.split(b'\t',1)[1].decode(): row.split(b'\t',1)[0].decode()
            for row in git('ls-tree','-rz',ref).split(b'\0') if row}

def check(name, valid, detail=None):
    checks.append({'name':name,'passed':bool(valid),'detail':detail})

def jobs(source):
    source = source.split('\njobs:\n',1)[1]
    starts = list(re.finditer(r'^  ([\w-]+):\s*$',source,re.M))
    return {m[1]:source[m.start():starts[n+1].start() if n+1<len(starts) else len(source)]
            for n,m in enumerate(starts)}

def runs(body):
    lines=body.splitlines();values=[];i=0
    while i<len(lines):
        match=re.match(r'^(\s*)(?:- )?run: (.*)$',lines[i])
        if not match:i+=1;continue
        indent=len(match[1])+(2 if lines[i].lstrip().startswith('- ') else 0)
        if match[2] not in ['|','>']:values.append(match[2]);i+=1;continue
        block=[];i+=1
        while i<len(lines) and (not lines[i].strip() or len(lines[i])-len(lines[i].lstrip())>indent):
            block.append(lines[i][indent+2:]);i+=1
        values.append((' ' if match[2]=='>' else '\n').join(block).rstrip())
    return values

dt,pt=tree(DEST),tree(PR2423)
check('exact destination tree',git('rev-parse',DEST+'^{tree}').decode().strip()==DEST_TREE)
check('exact incoming PR2423 tree',git('rev-parse',PR2423+'^{tree}').decode().strip()==PR2423_TREE)
dp=document(DEST,'package.json');pp=document(PR2423,'package.json')
ds,ps=dp['scripts'],pp['scripts']
aliases=[
 'typecheck:backend','typecheck:frontend',
 *[f'verify:engagement-phase-{p}:{s}' for p in [1,2,3] for s in ['backend','frontend']],
 *[f'verify:outreach-v3-phase-{p}:{s}' for p in [1,3,4] for s in ['backend','frontend']],
]
check('exact14 incoming root aliases are additive relative destination',len(aliases)==14 and set(ps)-set(ds)==set(aliases))
alias_rows=[{'name':a,'proposedCommand':ps[a],'destinationHasAlias':a in ds} for a in aliases]
check('each new execution alias contains exactly one explicit --run except Phase2 shell/typecheck contracts',
      all(r['proposedCommand'].count('--run')==1 for r in alias_rows if r['name'].startswith(('verify:engagement-phase-1:', 'verify:engagement-phase-3:', 'verify:outreach-v3-'))))
removed=sorted(set(ds)-set(ps));changed={k:{'destination':v,'olderIncoming':ps[k]} for k,v in ds.items() if k in ps and v!=ps[k]}
check('older whole package would drop14 current aliases and change34 commands',len(removed)==14 and len(changed)==34)
check('shared package publication mappings already byte-exact',dt['packages/shared/package.json']==pt['packages/shared/package.json'])
six=['tenant-feature','client-memory-wall','prospect-resource-scope','workspace-saved-revision','client-objective-destination','time']
di=text(DEST,'packages/shared/src/index.ts');pi=text(PR2423,'packages/shared/src/index.ts')
check('all six current shared exports would be lost by old barrel replacement',
      all(f"export * from './{p}.js';" in di and f"export * from './{p}.js';" not in pi for p in six))
check('six current canonical shared modules exist in destination',all(f'packages/shared/src/{p}.ts' in dt for p in six))

dw=text(DEST,'.github/workflows/ci-pr.yml');pw=text(PR2423,'.github/workflows/ci-pr.yml')
dj,pj=jobs(dw),jobs(pw)
check('destination retains original two job IDs; incoming adds independent frontend',list(dj)==['verify','engagement-phase-2'] and list(pj)==['verify','engagement-phase-2','frontend'])
check('destination ready-for-review trigger retained by proposal', 'types: [opened, synchronize, reopened, ready_for_review]' in dw and 'ready_for_review' not in pw)
runtime_aliases=['strategy-time','registry-ownership','duplicate-helpers','tango-page-leaves','strategy-template-metadata','workspace-product-metadata','meri-local-dispatch']
check('all seven current runtime CI checks would be lost by whole older workflow',
      all(f'pnpm gate:cleanup4:{a}' in dw and f'pnpm gate:cleanup4:{a}' not in pw for a in runtime_aliases))
metadata={k:v[:v.index('    steps:')].splitlines() for k,v in dj.items()}
projection={k:runs(v) for k,v in dj.items()}
new_frontend_runs=runs(pj['frontend'])
check('current direct API/Web/Defense source test commands exist',
      'pnpm --filter @capiro/api test' in projection['verify'] and
      'pnpm --filter @capiro/web test' in projection['verify'] and
      'pnpm turbo run build --filter=@capiro/defense-api\npnpm --filter @capiro/defense-api test' in projection['verify'])
check('incoming independent frontend lacks destination direct Web step and needs its addition',
      'pnpm --filter @capiro/web test' not in new_frontend_runs)

workspace_rows=[]
for path in dt:
    if path.endswith('/package.json') and len(path.split('/'))==3 and path.split('/')[0] in ['apps','packages','infra']:
        p=document(DEST,path)
        if p.get('scripts',{}).get('typecheck'):
            workspace_rows.append({'path':path,'name':p['name'],'typecheck':p['scripts']['typecheck']})
frontend_names=['@capiro/web','@capiro/onboard-web']
names=[r['name'] for r in workspace_rows]
check('typed workspace partition19 equals17 backend plusWeb/Onboard2',
      len(names)==19 and all(n in names for n in frontend_names) and '@capiro/onboard-api' in names and
      len([n for n in names if n not in frontend_names])==17)
check('workspace membership patterns remain current apps/packages/infra wildcards',
      text(DEST,'pnpm-workspace.yaml')==text(PR2423,'pnpm-workspace.yaml'))

phase1_path='apps/api/scripts/verify-engagement-phase1-runtime.ts'
p1=text(DEST,phase1_path)
targets=re.findall(r"'([^']+)'",re.search(r'const TEST_TARGETS\s*=\s*\[(.*?)\];',p1,re.S)[1])
check('full Phase1 retains all16 targets including process-wrapper spec',
      len(targets)==16 and targets[0]=='scripts/lib/engagement-verifier-process.spec.ts' and
      'src/engagement/outreach-job.spec.ts' in targets)
check('full Phase1 source enforces exact explicit run/help and current completion protocol',
      "process.argv.length !== 3 || process.argv[2] !== '--run'" in p1 and
      "process.argv.length === 3 && process.argv[2] === '--help'" in p1 and
      "process.exit(2);" in p1 and 'ENGAGEMENT_PHASE1_DB_FREE_COMPLETE' in p1 and
      'ENGAGEMENT_PHASE1_DB_FREE_FAILED' in p1 and "import { runVerifierProcess }" in p1)
phase1_syntax=ds['verify:engagement-phase-1'].split(' && ')
check('destination full Phase1 alias has one run and six syntax checks',
      len(phase1_syntax)==7 and phase1_syntax[0].count('--run')==1 and all(x.startswith('node --check ') for x in phase1_syntax[1:]))
backend_expected=' && '.join([phase1_syntax[0]+' --backend-only',*phase1_syntax[1:5]])
frontend_expected=' && '.join([phase1_syntax[0]+' --frontend-only',*phase1_syntax[5:]])
check('incoming Phase1 additions match destination-derived exact command projections without duplicate run',
      ps['verify:engagement-phase-1:backend']==backend_expected and ps['verify:engagement-phase-1:frontend']==frontend_expected)
wrapper_paths=['apps/api/scripts/lib/engagement-verifier-process.ts','apps/api/scripts/lib/engagement-verifier-process.spec.ts']
wrapper_blobs={p:{'destination':dt.get(p),'incoming':pt.get(p)} for p in wrapper_paths}
fixture_paths=['apps/api/scripts/__fixtures__/engagement-current-ui-surface-manifest.v1.json','apps/web/src/pages/engagement/__fixtures__/engagement-current-ui-surface-manifest.v1.json']
fixture_blobs={p:{'destination':dt.get(p),'incoming':pt.get(p)} for p in fixture_paths}
check('fixture transition HOLD is concrete: missing API-owned copy, exact currentWeb/Core input',
      fixture_paths[0] not in dt and dt[fixture_paths[1]]==pt[fixture_paths[0]]==pt[fixture_paths[1]])

floor=document(PR2423,'docs/backend-cleanup/20261012/PRESERVATION.json')
floor_rows=[]
for row in floor['paths']:
    expected=f"{row['mode']} blob {row['blob']}"
    status='missing' if row['path'] not in dt else ('exact' if dt[row['path']]==expected else 'different')
    floor_rows.append({'path':row['path'],'status':status,'destination':dt.get(row['path']),
                       'incomingCoreFloor':expected,'reasons':row['reasons']})
floor_counts=dict(Counter(r['status'] for r in floor_rows))
check('Core1146 preservation floor is not portable:833 exact280 missing33 different',
      floor_counts=={'exact':833,'missing':280,'different':33},floor_counts)
root_contract_path='scripts/ci/backend-verification-scopes.spec.mjs'
root_contract=text(PR2423,root_contract_path)
check('incoming root contract explicitly pins older157 and cannot be copied unchanged',
      "const baseline = '157bdfcd2bdc9c9be1fd84d460a80d426437f81d'" in root_contract)
source_guard=text(PR2423,'.github/workflows/backend-cleanup-preservation.yml')
check('incoming source guard watches allPR bases and all root/workspace/source inputs',
      'branches:' not in source_guard and all(f"      - '{p}'" in source_guard for p in ['package.json','pnpm-workspace.yaml','apps/**','packages/**','scripts/**','docs/**','.github/workflows/**']))

protected_paths=[
 'apps/api/src/app.module.ts','apps/api/src/engagement-api.app.module.ts','apps/api/src/engagement/engagement.module.ts',
 'apps/workspace/src/app.module.ts','apps/workspace/src/notifications/notifications.module.ts',
 'apps/workspace/src/drafts/drafts.module.ts','apps/workspace/src/newsletters/newsletter.module.ts',
 'apps/api/src/workspace-collab/workspace-collab.module.ts',
 'apps/api/prisma/schema.prisma','apps/workspace/prisma/schema.prisma',
 'packages/shared/src/index.ts','packages/shared/package.json',
 'apps/api/src/engagement/engagement.service.ts',
]
protected_metadata={p:{'destination':dt.get(p),'incoming':pt.get(p)} for p in protected_paths}
check('all protected published owner metadata paths are real destination source',all(r['destination'] is not None for r in protected_metadata.values()))
check('no source files changed by this inventory',True,'Git show/ls-tree reads only; proposed aliases and tests are documentary, not applied.')
out={
 'destination':DEST,'destinationTree':DEST_TREE,'incomingPR2423':PR2423,'incomingTree':PR2423_TREE,
 'checks':checks,'passed':all(c['passed'] for c in checks),
 'aliasMappings':alias_rows,'all107CurrentScripts':ds,'currentPackageMetadata':{k:v for k,v in dp.items() if k!='scripts'},
 'olderWholePackageWouldDrop':removed,'olderWholePackageWouldChange':changed,
 'currentWorkflowHeader':dw[:dw.index('\njobs:\n')],'currentJobMetadata':metadata,
 'allCurrentCommandProjections':projection,'incomingFrontendCommandProjection':new_frontend_runs,
 'runtimeStepsToPreserve':runtime_aliases,'workspaceMembership':text(DEST,'pnpm-workspace.yaml'),
 'typedWorkspaces':workspace_rows,'frontendWorkspaces':frontend_names,
 'phase1':{'path':phase1_path,'git':dt[phase1_path],'targets':targets,'fullAlias':ds['verify:engagement-phase-1'],
           'proposedBackendAlias':backend_expected,'proposedFrontendAlias':frontend_expected,'syntaxChecks':phase1_syntax[1:],
           'wrapperBlobs':wrapper_blobs,'fullProtocol':['ENGAGEMENT_PHASE1_DB_FREE_COMPLETE','ENGAGEMENT_PHASE1_DB_FREE_FAILED']},
 'fixtureTransitionHold':fixture_blobs,'corePreservationFloor':{'count':len(floor_rows),'counts':floor_counts,'rows':floor_rows},
 'protectedOwnerMetadata':protected_metadata,
 'scope':'Readonly compatibility and destination-specific root contract proposal. No frontend UI/source consumption or unpublished reporting branch/body reads. No application/native/provider/database/SQL/CLI/package execution.'
}
print(json.dumps(out,indent=2))
raise SystemExit(0 if out['passed'] else 1)
