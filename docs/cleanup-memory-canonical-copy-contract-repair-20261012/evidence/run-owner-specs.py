import pathlib,subprocess,json,sys,os
root=pathlib.Path(__file__).resolve().parents[3];p=pathlib.Path(__file__).resolve().parent
mode=sys.argv[1];assert mode in ['before','after','web-refused']
preload=p/('strict-web-read-refusal.cjs' if mode=='web-refused' else 'strict-source-read-refusal.cjs')
paths=['apps/api/scripts/lib/memory-admin-self-approval-contract.spec.ts','apps/api/scripts/lib/memory-phase3-review-inbox-contract.spec.ts','apps/api/src/funding-opportunities/opportunity-explanation.spec.ts']
command=['node','--require',str(preload),'/workspace/capirov2/apps/api/node_modules/jest/bin/jest.js','--config',str(p/'focused.jest.cjs'),'--runInBand','--runTestsByPath',*[str(root/path) for path in paths],'--json','--outputFile',str(p/f'{mode}-results.json')]
env={'PATH':os.environ['PATH'],'CI':'1','LANG':'C.UTF-8','TZ':'UTC'}
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
with (p/f'{mode}.stdout').open('wb') as out,(p/f'{mode}.stderr').open('wb') as err:r=subprocess.run(command,cwd=root,env=env,stdout=out,stderr=err)
receipt={'source':head,'sourceTree':subprocess.check_output(['git','rev-parse',f'{head}^{{tree}}'],cwd=root,text=True).strip(),'command':command,'envKeys':sorted(env),'cwd':str(root),'exit':r.returncode,'protectedUnselectedImplementationReadExplicitlyRefused':True,'noApplicationSetupBootstrap':True,'noNativeDbProviderAction':True,'transformDiagnostics':False};(p/f'{mode}-command.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt,indent=2))
