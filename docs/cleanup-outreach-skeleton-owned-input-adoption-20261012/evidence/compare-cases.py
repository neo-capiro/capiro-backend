import pathlib,json,re
p=pathlib.Path(__file__).resolve().parent
js={mode:json.loads((p/f'{mode}-results.json').read_text()) for mode in ['before','after','web-refused']}
def cases(j):return [{'name':t['fullName'],'status':t['status'],'passingAssertions':t['numPassingAsserts']} for s in j['testResults'] for t in s['assertionResults']]
c=cases(js['before']);assert c==cases(js['after'])==cases(js['web-refused']) and len(c)==10
assert all(j['numPassedTests']==10 and j['numFailedTests']==0 and j['numPendingTests']==0 and j['numTodoTests']==0 for j in js.values())
for mode,count in [('node-controls',16),('default-web-refused-node',8)]:
    output=(p/f'{mode}.stdout').read_text()
    for key,value in [('tests',count),('pass',count),('fail',0),('skipped',0),('todo',0)]: assert re.search(rf'^(?:#|ℹ) {key} {value}$',output,re.M)
receipt={'source':'2d88ac7063e0e5b75c0490411a3758cb655beb01','actualOriginalBeforeAndAfterAndWebRefusedCases':c,'casesAndPassingAssertionCountsIdentical':True,'caseCount':10,'allPass':True,'skippedTodo':0,'nodeControlCountWithExplicitFrontendSourceParity':16,'nodeDefaultControlCountWithWebReadsRefused':8,'architecturePureDesignOnlyFakeChecks':json.loads((p/'architecture-pure-assessment.json').read_text())['checks'],'architectureAdopted':False,'nativeServiceUiOrProviderAcceptance':False}
(p/'CASE-PRESERVATION.json').write_text(json.dumps(receipt,indent=2)+'\n')
(p/'NODE-CONTROL-COMMANDS.json').write_text(json.dumps({'source':receipt['source'],'commands':[{'argv':['env','-i','PATH=<inherited search path>','node','scripts/ci/outreach-skeleton-owned-input.spec.mjs','--frontend-parity'],'exit':0,'tests':16},{'argv':['env','-i','PATH=<inherited search path>','node','--require','./docs/cleanup-outreach-skeleton-owned-input-adoption-20261012/evidence/web-read-refusal.cjs','scripts/ci/outreach-skeleton-owned-input.spec.mjs'],'exit':0,'tests':8}],'environmentKeys':['PATH'],'frontendReadOnlySourceParityNotBrowserExecution':True},indent=2)+'\n')
print(json.dumps({'actualOwnerCases':10,'nodeControls':16,'defaultNodeWebRefused':8,'fakeArchitectureDesignControls':receipt['architecturePureDesignOnlyFakeChecks']},indent=2))
