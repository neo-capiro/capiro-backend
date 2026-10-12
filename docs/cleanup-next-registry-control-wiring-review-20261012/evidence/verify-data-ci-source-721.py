import subprocess,json,hashlib,yaml
from pathlib import Path
BASE='6a4b48e6286a270ab18c033eb4ccaf6f72f42c70';HEAD='721bfd4825bfccd819be50172ed712023891f978';OUT=Path('docs/cleanup-next-registry-control-wiring-review-20261012/evidence')
def git(*args):return subprocess.check_output(['git',*args])
def tree(ref):
 result={}
 for record in git('ls-tree','-rz',ref).split(b'\0'):
  if record:
   meta,path=record.split(b'\t',1);result[path.decode()]=meta.decode()
 return result
base,head=tree(BASE),tree(HEAD);changed=sorted(p for p in base.keys()|head.keys() if base.get(p)!=head.get(p));source=[p for p in changed if not p.startswith('docs/')];assert source==['.github/workflows/ci-pr.yml','package.json','scripts/check-registry-ownership.mjs','scripts/check-registry-ownership.test.mjs','scripts/registry-ownership.json']
protected=[p for p in base if p not in source];assert all(base[p]==head.get(p) for p in protected)
apps=[p for p in base if p.startswith('apps/')];schema=[p for p in base if p.endswith('.prisma')or'/migrations/'in p];packets=[p for p in base if p.startswith('docs/')];assert all(base[p]==head.get(p)for p in apps+schema+packets)
oldPkg=json.loads(git('show',BASE+':package.json'));newPkg=json.loads(git('show',HEAD+':package.json'));alias=newPkg['scripts'].pop('gate:cleanup4:registry-ownership');assert alias=='node scripts/check-registry-ownership.mjs && node --test scripts/check-registry-ownership.test.mjs';assert oldPkg==newPkg
oldYaml=git('show',BASE+':.github/workflows/ci-pr.yml').decode();newYaml=git('show',HEAD+':.github/workflows/ci-pr.yml').decode();oldWorkflow=yaml.load(oldYaml,Loader=yaml.BaseLoader);newWorkflow=yaml.load(newYaml,Loader=yaml.BaseLoader);found=[]
for job,body in newWorkflow['jobs'].items():
 for i,step in enumerate(body.get('steps',[])):
  if step.get('name')=='Guard existing Strategy template vocabulary ownership':found.append((job,i,step))
assert len(found)==1;job,index,step=found[0];assert step=={'name':'Guard existing Strategy template vocabulary ownership','run':'pnpm gate:cleanup4:registry-ownership'};newWorkflow['jobs'][job]['steps'].pop(index);assert newWorkflow==oldWorkflow
steps=oldWorkflow['jobs'][job]['steps'];dependency=[i for i,s in enumerate(steps)if'pnpm install'in s.get('run','')];assert dependency and max(dependency)<index
assert newYaml==oldYaml.replace('      - name: Test apps/api\n','      - name: Guard existing Strategy template vocabulary ownership\n        run: pnpm gate:cleanup4:registry-ownership\n\n      - name: Test apps/api\n')
nativeConditions=[{'name':s['name'],'condition':s.get('if'),'command':s.get('run')}for s in steps if s.get('name')in['Test apps/api','Test apps/defense-api']];assert len(nativeConditions)==2
original='79cba71ca8359f9cac178ddc3314cb34c0d46da5';originalTree=tree(original);assert originalTree['package.json']==head['package.json'];assert originalTree['.github/workflows/ci-pr.yml']==head['.github/workflows/ci-pr.yml'];beforeConfig=json.loads(git('show',original+':scripts/registry-ownership.json'));afterConfig=json.loads(git('show',HEAD+':scripts/registry-ownership.json'));beforeHash=[x.pop('sha256')for x in beforeConfig['profiles'][0]['carriers']];afterHash=[x.pop('sha256')for x in afterConfig['profiles'][0]['carriers']];assert beforeConfig==afterConfig;assert len(beforeHash)==len(afterHash)==2;assert all(a!=b for a,b in zip(beforeHash,afterHash));
clock='scripts/strategy-time-boundaries.json';assert base[clock]==head[clock]
records=[{'path':p,'gitTreeEntry':head[p],'sha256':hashlib.sha256(git('show',HEAD+':'+p)).hexdigest()}for p in source]
result={'acceptedDataWiringSource':HEAD,'tree':git('rev-parse',HEAD+'^{tree}').decode().strip(),'base':BASE,'onlySourcePaths':records,'baselineUnchangedOutsideSourcePaths':len(protected),'allBaselineAppPathsUnchanged':len(apps),'allSchemaMigrationPathsUnchanged':len(schema),'allBaselineDocumentationPathsUnchanged':len(packets),'packageOnlyNewAlias':alias,'ciAndAliasExact79Blobs':True,'dataOnlyTwoFullStatementHashesUpdated':{'before':beforeHash,'after':afterHash},'workflowOnlyNewStep':step,'workflowJob':job,'stepIndex':index,'dependencyStepIndices':dependency,'allOriginalWorkflowValuesUnchanged':True,'originalNativeReadinessConditions':nativeConditions,'typescriptDeclaredBeforeAndAfter':oldPkg['devDependencies']['typescript'],'clock119AllowanceDataAnd123DeferredSamplesUnchanged':True,'noAppExtractionOrReportMetadataConversion':True,'noCIOrInstallExecution':True,'nativeAcceptance':False,'genericGuardAcceptance':False}
(OUT/'data-ci-source-preservation-721.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:result[k]for k in['acceptedDataWiringSource','tree','baselineUnchangedOutsideSourcePaths','allBaselineAppPathsUnchanged','allSchemaMigrationPathsUnchanged','allBaselineDocumentationPathsUnchanged','stepIndex','dependencyStepIndices','noAppExtractionOrReportMetadataConversion']},indent=2))
