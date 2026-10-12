import pathlib,subprocess,json,sys,os
root=pathlib.Path(__file__).resolve().parents[3]
p=pathlib.Path(__file__).resolve().parent
mode=sys.argv[1]
assert mode in ['before','after']
paths=['apps/api/scripts/lib/memory-admin-self-approval-contract.spec.ts','apps/api/scripts/lib/memory-phase3-review-inbox-contract.spec.ts','apps/api/src/funding-opportunities/opportunity-explanation.spec.ts']
command=['node','--require',str(p/'no-external-ports.cjs'),'apps/api/node_modules/jest/bin/jest.js','--config',str(p/'focused.jest.cjs'),'--runInBand','--runTestsByPath',*paths,'--json','--outputFile',str(p/f'{mode}-results.json')]
env={'PATH':os.environ['PATH'],'CI':'1','LANG':'C.UTF-8','TZ':'UTC'}
with (p/f'{mode}.stdout').open('wb') as stdout,(p/f'{mode}.stderr').open('wb') as stderr:
    r=subprocess.run(command,cwd=root,env=env,stdout=stdout,stderr=stderr)
receipt={'mode':mode,'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'command':command,'envKeys':sorted(env),'exit':r.returncode,'tests':paths,'nativeDBProviderOrClientAction':False,'jestDiagnostics':False,'jestTypecheckClaim':False}
(p/f'{mode}-command.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt,indent=2))
