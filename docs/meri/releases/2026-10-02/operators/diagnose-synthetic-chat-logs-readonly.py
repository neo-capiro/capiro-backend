"""Bounded read-only log category extraction; no raw log text is persisted."""
import boto3, datetime, hashlib, json, pathlib, re, sys
from botocore.config import Config
ROOT=pathlib.Path(__file__).parent
WINDOWS=[('2026-10-02T02:44:08+00:00','2026-10-02T02:44:23+00:00'),('2026-10-02T02:52:00+00:00','2026-10-02T02:52:48+00:00')]
EXPECTED={'api':486,'meriv2-orchestrator':87}
TOKENS=('meri-foundation-20260928-t1','meri-foundation-20260928-t2','f2d6cf8f-057c-479a-8110-62fe5086d43f','52e91176-08f0-4d89-9633-bc212f5bdbbf')
ALLOWED={('sts','get_caller_identity'),('ecs','describe_services'),('ecs','list_tasks'),('ecs','describe_tasks'),('ecs','describe_task_definition'),('logs','get_log_events')}
session=boto3.Session(region_name='us-east-1');clients={};calls=[]
def need(ok,msg):
 if not ok:raise RuntimeError(msg)
def call(namespace,operation,**kwargs):
 need((namespace,operation) in ALLOWED,'Read-only allowlist violation')
 if namespace not in clients:clients[namespace]=session.client(namespace,config=Config(retries={'total_max_attempts':1},connect_timeout=10,read_timeout=30))
 result=getattr(clients[namespace],operation)(**kwargs);calls.append({'operation':namespace+'.'+operation,'exitCode':0});return result
categories={
 'accessDenied':r'AccessDenied|not authorized|permission denied',
 'throttling':r'Throttl|too many requests|rate.?limit',
 'budgetOrCredits':r'insufficient.?credits|credit balance|budget.{0,30}(?:exhaust|exceed)|payment required',
 'validation':r'ValidationException|validation failed|invalid request',
 'missingProviderConfig':r'(?:missing|not configured|not set|undefined).{0,60}(?:model|provider|api.?key|bedrock)|(?:model|provider|api.?key|bedrock).{0,60}(?:missing|not configured|not set)',
 'inferenceProfile':r'on-demand throughput|inference profile',
 'modelUnavailable':r'model.{0,50}(?:not found|not supported|unsupported|unavailable|invalid)|(?:not found|unsupported|invalid).{0,50}model',
 'timeout':r'Timeout|timed out|ETIMEDOUT',
 'connection':r'ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed',
 'database':r'Prisma.{0,30}(?:Error|Exception)|\bP(?:1001|1002|2021|2022)\b|relation .+ does not exist',
 'providerFailure':r'provider.{0,60}(?:fail|error)|(?:fail|error).{0,60}provider|Bedrock.{0,60}(?:fail|error)',
 'fallback':r'fallback|graceful degradation|degrad(?:ed|ation)',
 'missingRelation':r'relation .+ does not exist',
}
def count_logs(events):
 output={'eventCount':len(events),'syntheticIdentityMatchedEventCount':0,'warningLikeEventCount':0,'errorLikeEventCount':0,'categories':{k:0 for k in categories},'errorClassCounts':{},'loggerClassCounts':{},'httpErrorStatusCounts':{}}
 safe_events=[]
 for event in events:
  line=re.sub(r'\x1b\[[0-9;]*[A-Za-z]','',event['message'])
  synthetic=any(t in line for t in TOKENS)
  error=bool(re.search(r'\b(?:error|fatal|exception)\b|ERR_[A-Z_]+',line,re.I))
  output['syntheticIdentityMatchedEventCount']+=synthetic
  output['warningLikeEventCount']+=bool(re.search(r'\bwarn(?:ing)?\b',line,re.I))
  output['errorLikeEventCount']+=error
  matched=[k for k,v in categories.items() if re.search(v,line,re.I)]
  for k in matched:output['categories'][k]+=1
  classes=sorted(set(re.findall(r'\b[A-Z][A-Za-z]{2,60}(?:Exception|Error)\b',line)))
  loggers=sorted(set(re.findall(r'\b[A-Z][A-Za-z0-9]{2,65}(?:Service|Controller|Adapter|Gateway)\b',line)))
  statuses=sorted(set(re.findall(r'\b(?:status|statusCode|httpStatus)\W{0,5}([45]\d\d)\b',line,re.I)))
  for field,values in [('errorClassCounts',classes),('loggerClassCounts',loggers),('httpErrorStatusCounts',statuses)]:
   for value in values:output[field][value]=output[field].get(value,0)+1
  if error or matched:
   safe_events.append({'atUtc':datetime.datetime.fromtimestamp(event['timestamp']/1000,datetime.timezone.utc).isoformat(),'syntheticIdentityMatched':synthetic,'categories':matched,'errorClasses':classes,'loggerClasses':loggers,'httpErrorStatuses':statuses})
 output['safeErrorEvents']=safe_events
 return output

results=[]
need(call('sts','get_caller_identity')['Account']=='967807252336','Wrong account')
for name,revision in EXPECTED.items():
 response=call('ecs','describe_services',cluster='capiro-dev',services=['capiro-dev-'+name]);need(not response.get('failures') and len(response['services'])==1,'Ambiguous service')
 service=response['services'][0];need(service['taskDefinition'].endswith('/capiro-dev-'+name+':'+str(revision)),'Unexpected task revision')
 td=call('ecs','describe_task_definition',taskDefinition=service['taskDefinition'])['taskDefinition']
 target=[c for c in td['containerDefinitions'] if c['name']==name];need(len(target)==1,'Ambiguous container')
 log=target[0]['logConfiguration'];need(log['logDriver']=='awslogs','Unknown logger')
 listing=call('ecs','list_tasks',cluster='capiro-dev',serviceName='capiro-dev-'+name,desiredStatus='RUNNING');need(not listing.get('nextToken'),'Unbounded task set')
 task_response=call('ecs','describe_tasks',cluster='capiro-dev',tasks=listing['taskArns']);need(not task_response.get('failures'),'Task readback failed')
 for task in task_response['tasks']:
  need(task['taskDefinitionArn']==service['taskDefinition'],'Task from other deployment')
  stream=log['options']['awslogs-stream-prefix']+'/'+name+'/'+task['taskArn'].rsplit('/',1)[1]
  for start,end in WINDOWS:
   token=None;events=[];complete=False
   for _ in range(4):
    args={'logGroupName':log['options']['awslogs-group'],'logStreamName':stream,'startFromHead':True,'startTime':int(datetime.datetime.fromisoformat(start).timestamp()*1000),'endTime':int(datetime.datetime.fromisoformat(end).timestamp()*1000),'limit':1000}
    if token:args['nextToken']=token
    page=call('logs','get_log_events',**args);events.extend(page['events'])
    if page.get('nextForwardToken')==token:complete=True;break
    token=page.get('nextForwardToken')
   results.append({'service':name,'taskDefinition':service['taskDefinition'],'taskArn':task['taskArn'],'windowStart':start,'windowEnd':end,'complete':complete,**count_logs(events)})
output={'observedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'Exact current API486/orchestrator87 task log streams in the two bounded synthetic UI windows. Temporal association alone is not request identity. No raw logs, customer payloads or provider messages retained.','verdict':'DIAGNOSTIC_OBSERVATIONS','tasks':results,'calls':calls,'externalWrites':0}
path=ROOT/'synthetic-chat-log-categories.json'
with path.open('x',encoding='utf-8') as handle:json.dump(output,handle,indent=2)
print(json.dumps({'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'readCalls':len(calls),'results':results},indent=2))
