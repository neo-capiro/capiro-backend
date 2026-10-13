import pathlib,json,hashlib
root=pathlib.Path('/tmp/capirov2-cleanup-meri-local-dispatch-conversion');p=root/'docs/meri-application-authority-pr52-actual-client-qualification-20261013/evidence';file=p/'03-owned-http-client-pair.json';raw=file.read_bytes();r=json.loads(raw)
assert r['total']==r['passed']==1 and r['failed']==0 and r['actualLoopbackHttp'] and r['nativePrisma']
assert r['sourceHead']=='bbb38185058fdc64c204da723943aee055b3dad3' and r['sourceTree']=='77a6cc091e6bfa02afa8b9e558a7d2e2a1e523a2'
assert r['wholeAppBootstrap'] is False and r['liveClerk'] is False and r['TLS'] is False and r['currentRunAuthority'] is False
assert r['targetIdentity']['databaseOid']==16917 and len(r['receipts'])==1
consumer=r['receipts'][0]['actualConsumer'];assert len(consumer['captures'])==2
identity=consumer['identity'];context=consumer['context'];caps=consumer['captures'];hashid=consumer['identitySha256']
assert identity['principal']==context['principal']=={'tenantId':'a1000000-0000-4000-8000-000000000001','actorId':'a2000000-0000-4000-8000-000000000001'}
assert context['identityRevision']==identity['identityRevision'] and context['identitySha256']==hashid
assert consumer['privateReceiverSource']['head']=='4699fdea910ba25c809725630443198c8ae189e4'
observed=[]
for n,(cap,expected,path) in enumerate(zip(caps,[identity,context],['/api/clio/application-authority/identity','/api/clio/application-authority/context'])):
 request=cap['request'];response=cap['response'];assert request['method']=='POST' and request['path']==path and response['status']==200
 assert set(response['headers'])<=set(['content-type','cache-control','content-encoding','content-length'])
 assert response['headers']['cache-control']=='no-store' and response['headers']['content-type'].lower()=='application/json; charset=utf-8'
 assert response['headers'].get('content-encoding','identity')=='identity'
 for label,obj in [('request',request),('response',response)]:
  b=obj['bodyUtf8'].encode('utf-8');assert len(b)==obj['bodyBytes'] and hashlib.sha256(b).hexdigest()==obj['bodySha256']
 assert len(response['bodyUtf8'].encode('utf-8'))==int(response['headers']['content-length'])
 assert json.loads(response['bodyUtf8'])==expected
 assert request['sentAtMs']<=expected['checkedAtMs']<=response['receivedAtMs']<expected['expiresAtMs']
 decoded=json.loads(request['bodyUtf8'])
 if n==0:assert decoded=={}
 else:assert decoded=={'identitySha256':hashid,'conversationId':'a5000000-0000-4000-8000-000000000001','clientId':'a4000000-0000-4000-8000-000000000001'}
 observed.append({'method':request['method'],'path':path,'status':200,'requestBytes':request['bodyBytes'],'requestSha256':request['bodySha256'],'responseBytes':response['bodyBytes'],'responseSha256':response['bodySha256'],'safeHeaders':response['headers'],'freshBoundAtCapture':True})
assert caps[1]['request']['sentAtMs']>=caps[0]['response']['receivedAtMs']
command=json.loads((p/'03-owned-http-client-pair.command.json').read_text());assert command['exitCode']==0 and command['runAuthorCases'] is False and command['privateConfigUnlinked']
assert not pathlib.Path('/tmp/capiro-authority-http-pr52-pair-private-20261013.json').exists()
def scan(value):
 if isinstance(value,dict):
  assert not any(k.lower() in ['authorization','credential','identitycredential','cookie','set-cookie','clerk_secret_key','password','connectionurl','bearer'] for k in value)
  for v in value.values():scan(v)
 elif isinstance(value,list):
  for v in value:scan(v)
scan(r)
for path in [file,p/'03-owned-http-client-pair.stdout.log',p/'03-owned-http-client-pair.stderr.log',p/'03-owned-http-client-pair.command.json']:
 b=path.read_bytes();assert b'fixture-local-only' not in b and b'Bearer ' not in b and b'postgresql://' not in b
summary={'actualSource':'df397f60811a4aae6a799dc3534e2c2884d58c9f','consumerPrivateHead':'4699fdea910ba25c809725630443198c8ae189e4','producerHead':r['sourceHead'],'originalActualOutput':{'path':str(file.relative_to(root)),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()},'onePairPassed':True,'actualHttpResponses':2,'captures':observed,'actualPrivateCanonicalDigest':hashid,'pairDtoIdentityAndSelectorsMatched':True,'captureUtf8BodiesUnchanged':True,'credentialFieldsOrValuesInActualEvidence':False,'author45AndIndependent24Replayed':False,'privateConfigRemoved':True,'nativeQueries':r['nativeQueries'],'cleanupQualification':'E184 driver awaited app.close and Prisma.disconnect in finally; child naturally exited0, no force/timeout. No new socket or DB cleanup probe by this lane.','remainingLimits':{'TLS':False,'liveClerk':False,'currentRunAuthority':False,'wholeAppBootstrap':False,'nativeRlsQualificationByThisPair':False}}
out=p/'04-actual-pair-custody.json';assert not out.exists();out.write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({'onePair':'PASS','responses':2,'bodyBytes':[x['responseBytes'] for x in observed],'bodyHashes':[x['responseSha256'] for x in observed],'rawResultHash':summary['originalActualOutput']['sha256'],'privateConfigRemoved':True,'credentialsAbsent':True,'childExit':0}))
