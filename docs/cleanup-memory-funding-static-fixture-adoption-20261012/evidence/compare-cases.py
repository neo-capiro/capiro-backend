import json,pathlib
p=pathlib.Path(__file__).resolve().parent
results={mode:json.loads((p/f'{mode}-results.json').read_text()) for mode in ['before','after','web-refused']}
def statuses(j):return [{'name':t['fullName'],'status':t['status'],'assertions':t['numPassingAsserts']} for s in j['testResults'] for t in s['assertionResults']]
b=statuses(results['before']);a=statuses(results['after']);w=statuses(results['web-refused']);assert a==b==w and len(a)==60
summaries={mode:{key:value[key] for key in ['numTotalTests','numPassedTests','numFailedTests','numPendingTests','numTodoTests','numTotalTestSuites']} for mode,value in results.items()}
assert all(r['numPassedTests']==59 and r['numFailedTests']==1 and r['numPendingTests']==0 and r['numTodoTests']==0 for r in summaries.values())
failures=[r['name'] for r in a if r['status']=='failed'];assert failures==['memory administrator self-approval policy contract removes the independent-approver claim from every active shared-memory UI surface']
receipt={'source':'44eda40f7951e73722566862649939e51a8f151a','beforeAfterAndWebRefusedCasesAndAssertionCountsIdentical':True,'summaries':summaries,'allCaseStatuses':a,'inheritedFailure':failures,'failureBoundary':'Current exact Web MemoryFileEditor delegates copy to an existing helper; the original static assertion expects literal Submitted for approval in the editor file. The fixture deliberately preserves that same source and refusal. No source/fixture/assertion repair is part of this slice.','structuralControls':json.loads((p/'static-controls.json').read_text())['checks'],'refusalControls':len(json.loads((p/'refusal-controls.json').read_text())['controls']),'fullFloorOrNativeUiAcceptance':False}
(p/'CASE-PRESERVATION.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({k:v for k,v in receipt.items() if k!='allCaseStatuses'},indent=2))
