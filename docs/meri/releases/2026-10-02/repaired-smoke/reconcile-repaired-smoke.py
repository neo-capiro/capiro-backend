import hashlib,json,pathlib,datetime
r=pathlib.Path(__file__).parent
def read(n):return json.loads((r/n).read_text(encoding='utf-8-sig'))
a=read('synthetic-meri-ui-v8-smoke-result.json');b=read('synthetic-meri-ui-v9-readonly-result.json');c=read('synthetic-meri-ui-v10-smoke-result.json')
assert read('synthetic-meri-ui-v8-command-exit.json')['exitCode']==1
assert read('synthetic-meri-ui-v9-readonly-exit.json')['exitCode']==0 and read('synthetic-meri-ui-v10-command-exit.json')['exitCode']==0
assert len(a['tenants'])==len(b['tenants'])==len(c['tenants'])==1
x,y,z=a['tenants'][0],b['tenants'][0],c['tenants'][0]
assert x['tenant']==y['tenant']=='meri-foundation-20260928-t1' and z['tenant']=='meri-foundation-20260928-t2'
assert x['conversationId']==y['conversationId'] and x['turnsSent']==z['turnsSent']==1 and y['turnsSent']==0
assert y['originalSelectorResult']=='STRICT_MODE_DUPLICATE' and y['globalExactMatches']==5 and y['assistantVisibleExactMatches']==1
for row in [x,y,z]:
 assert row['identityVerified'] and row['sessionRevoked'] and row['blockedMutationCount']==0
 assert row['savedAssistant']['assistantExpectedEqual'] and row['savedAssistant']['assistantTextLength']==26
 assert row['savedAssistant']['assistantTextSha256']=='b372f30b8260e3c2167ec08ea8506c32d466148b413041bf7bb6dcb1eb249f63'
for row in [x,z]:assert row['streamStatus']==201 and row['doneReceived'] and row['streamErrors']==row['toolCalls']==0
assert y['expectedReplyVisible'] and z['expectedReplyVisible'] and b['verdict']==c['verdict']=='PASS'
providers=[]
for n in ['synthetic-v8-t1-provider-log-readback.json','synthetic-v10-t2-provider-log-readback.json']:
 p=read(n);assert p['boundedPaginationComplete']
 turns=[t for t in p['structuredTelemetry'] if t['event']=='meriv3.turn' and t['syntheticTenantMatched']]
 assert len(turns)==1
 t=turns[0];assert t['providerCallCount']==1 and t['toolsUsedCount']==0 and not t['held'] and not t['aborted'] and not t['telemetry']['partial']
 for k in ['modelLoopFailure','noCredits','http429','providerFailure','errorLike']:assert p['safeMarkerCounts'][k]==0
 providers.append({'source':n,'model':t['model'],'inputTokens':t['inputTokens'],'outputTokens':t['outputTokens'],'providerCallCount':1,'completed':True})
promotion=read('api-jsonb-promotion-receipt.json');assert promotion['status']=='ecs-healthy-manual-acceptance-required'
inputs=['api-jsonb-promotion-receipt.json','synthetic-meri-ui-v8-command-exit.json','synthetic-meri-ui-v8-smoke-result.json','synthetic-meri-ui-v9-readonly-exit.json','synthetic-meri-ui-v9-readonly-result.json','synthetic-meri-ui-v10-command-exit.json','synthetic-meri-ui-v10-smoke-result.json','synthetic-meri-ui-v10-t2-assistant.png']
out={'verdict':'PASS','scope':'Exact no-tool reply visible and persisted for both approved synthetic tenants after reply-format and signed-number fixes','observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceServices':c['deployedServices'],'newConversations':2,'newTurns':2,'extraT1RetryTurns':0,'sessionsCreatedAndRevoked':3,'providerCalls':providers,'v8HistoricalVerdictPreserved':'BLOCKED / exit1; strict page-wide locator matched5; V9 zero-turn diagnosis proves1 actual assistant match','v9Readonly':'PASS / exit0','v10RemainingT2':'PASS / exit0','uiVisualReview':'Root inspected synthetic assistant screenshot: expected acknowledgment and completion controls visible','fullFile01Acceptance':False,'original75LiveCasesRun':0,'migrationOrLedgerChanges':0,'modelRoutingChanges':0,'inputs':{n:hashlib.sha256((r/n).read_bytes()).hexdigest() for n in inputs},'telemetryCaveat':'Generic fallback marker count2 is not an observed fallback; actual one-call completion telemetry is used.'}
(r/'repaired-two-tenant-smoke-reconciliation.json').write_bytes((json.dumps(out,indent=2)+'\n').encode());print(json.dumps({'verdict':'PASS','newTurns':2,'sessionsRevoked':3,'fullFile01Acceptance':False}))
