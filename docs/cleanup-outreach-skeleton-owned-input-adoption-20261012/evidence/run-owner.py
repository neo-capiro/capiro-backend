import pathlib,subprocess,json,sys,os
root=pathlib.Path(__file__).resolve().parents[3];p=pathlib.Path(__file__).resolve().parent
mode=sys.argv[1];assert mode in ['before','after','web-refused']
preload=p/('web-read-refusal.cjs' if mode=='web-refused' else 'no-external-ports.cjs')
command=['node','--require',str(preload),'/workspace/capirov2/apps/api/node_modules/jest/bin/jest.js','--config',str(p/'focused.jest.cjs'),'--runInBand','--runTestsByPath',str(root/'apps/api/src/outreach-v3/state/outreach-content-skeleton-boundaries.spec.ts'),'--json','--outputFile',str(p/f'{mode}-results.json')]
env={'PATH':os.environ['PATH'],'CI':'1','LANG':'C.UTF-8','TZ':'UTC'}
with (p/f'{mode}.stdout').open('wb') as out,(p/f'{mode}.stderr').open('wb') as err:r=subprocess.run(command,cwd=root/'apps/api',env=env,stdout=out,stderr=err)
receipt={'mode':mode,'source':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'command':command,'cwd':str(root/'apps/api'),'envKeys':sorted(env),'exit':r.returncode,'noNativeDbOrProviderQualification':True,'transformDiagnostics':False};(p/f'{mode}-command.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt,indent=2))
