"""Exact model-loop failure category extraction; raw messages remain in memory."""
import boto3,datetime,hashlib,json,pathlib,re
from botocore.config import Config
ROOT=pathlib.Path(__file__).parent
TASK='arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/7c2c0b85e6f346a5b3102ddf8eefa32c'
TD='arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-meriv2-orchestrator:87'
s=boto3.Session(region_name='us-east-1');ecs=s.client('ecs',config=Config(retries={'total_max_attempts':1}));logs=s.client('logs',config=Config(retries={'total_max_attempts':1}))
td=ecs.describe_task_definition(taskDefinition=TD)['taskDefinition']
c=next(c for c in td['containerDefinitions'] if c['name']=='meriv2-orchestrator');conf=c['logConfiguration']['options'];stream=conf['awslogs-stream-prefix']+'/meriv2-orchestrator/'+TASK.rsplit('/',1)[1]
patterns={
 'insufficient_quota':r'insufficient_quota|exceeded your current quota',
 'insufficient_credits':r'insufficient.?credits|insufficient.?balance|credit balance.{0,40}(?:low|zero|insufficient)|payment required',
 'rate_limit':r'rate_limit|rate limit|too many requests|throttl',
 'permission':r'permission|not authorized|access.?denied|organization must be verified|does not have access',
 'invalid_api_key':r'invalid_api_key|incorrect api key|authentication failed',
 'unsupported_parameter':r'unsupported_parameter|unsupported parameter|not supported with this model',
 'invalid_parameter':r'invalid_parameter|invalid value|invalid parameter|missing required parameter',
 'model_not_found':r'model_not_found|model.{0,30}not found|model.{0,30}does not exist',
 'missing_provider_config':r'(?:missing|not configured|not set).{0,60}(?:model|provider|api.?key)',
 'context_length':r'context_length_exceeded|maximum context length',
 'upstream_timeout':r'timed out|timeout',
}
items=[];calls=1
for start,end in [('2026-10-02T02:44:08+00:00','2026-10-02T02:44:23+00:00'),('2026-10-02T02:52:00+00:00','2026-10-02T02:52:48+00:00')]:
 token=None
 for _ in range(3):
  args={'logGroupName':conf['awslogs-group'],'logStreamName':stream,'startFromHead':True,'startTime':int(datetime.datetime.fromisoformat(start).timestamp()*1000),'endTime':int(datetime.datetime.fromisoformat(end).timestamp()*1000),'limit':1000}
  if token:args['nextToken']=token
  page=logs.get_log_events(**args);calls+=1
  for e in page['events']:
   line=re.sub(r'\x1b\[[0-9;]*[A-Za-z]','',e['message'])
   if 'MeriV3 model loop failed:' not in line:continue
   suffix=line.split('MeriV3 model loop failed:',1)[1].strip()
   statuses=sorted(set(re.findall(r'(?<!\d)([45]\d\d)(?!\d)',suffix)))
   providers=[p for p in ('OpenAI','OpenRouter','Bedrock','Anthropic','Google','Azure') if p.lower() in suffix.lower()]
   codes=[p for p in ('insufficient_quota','insufficient_credits','rate_limit_exceeded','invalid_api_key','permission_error','model_not_found','unsupported_parameter','invalid_request_error','context_length_exceeded','AccessDeniedException','ThrottlingException','ValidationException') if p in suffix]
   safe_terms=[p for p in ('temperature','max_output_tokens','max_tokens','reasoning','effort','quota','billing','permission','credits','unsupported','model') if re.search(r'\b'+re.escape(p)+r'\b',suffix,re.I)]
   items.append({'atUtc':datetime.datetime.fromtimestamp(e['timestamp']/1000,datetime.timezone.utc).isoformat(),'marker':'MeriV3 model loop failed:','messageSha256':hashlib.sha256(suffix.encode()).hexdigest(),'httpStatuses':statuses,'providersExplicitlyNamedInMessage':providers,'safeCodes':codes,'categories':[k for k,v in patterns.items() if re.search(v,suffix,re.I)],'safeParameterOrCauseTerms':safe_terms,'messageLength':len(suffix)})
  if page.get('nextForwardToken')==token:break
  token=page.get('nextForwardToken')
out={'observedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'taskArn':TASK,'taskDefinition':TD,'exactFailureEvents':items,'readOnlyCalls':calls,'externalWrites':0,'rawMessagesPersisted':False}
p=ROOT/'synthetic-model-loop-failure-categories.json'
with p.open('x',encoding='utf-8') as f:json.dump(out,f,indent=2)
print(json.dumps(out,indent=2));print('RECEIPT_SHA256='+hashlib.sha256(p.read_bytes()).hexdigest())
