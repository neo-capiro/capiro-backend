import hashlib,json,pathlib,subprocess,datetime
root=pathlib.Path(r'C:\dev\main\outputs\meri-c2-20261003')
AWS=r'C:\Program Files\Amazon\AWSCLIV2\aws.exe'
policy=root/'case12-native-iam-policy-candidate-v1.json'
cluster='arn:aws:ecs:us-east-1:967807252336:cluster/capiro-dev'
task='arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/'+'a'*32
def test(name,action,resource,region='us-east-1',at='2026-10-04T12:10:00Z',tag=True,scope=cluster,expected='allowed'):
    contexts=[{'ContextKeyName':'aws:RequestedRegion','ContextKeyValues':[region],'ContextKeyType':'string'},
      {'ContextKeyName':'aws:CurrentTime','ContextKeyValues':[at],'ContextKeyType':'date'},
      {'ContextKeyName':'ecs:cluster','ContextKeyValues':[scope],'ContextKeyType':'string'}]
    if tag: contexts.append({'ContextKeyName':'aws:ResourceTag/meri-case12-setup-owner','ContextKeyValues':['11111111-1111-4111-8111-111111111111'],'ContextKeyType':'string'})
    request={'PolicyInputList':[policy.read_text()],'ActionNames':[action],'ResourceArns':[resource],'ContextEntries':contexts}
    request_path=root/('case12-iam-simulation-'+name+'.json')
    with request_path.open('x',encoding='utf-8') as f: json.dump(request,f)
    response=subprocess.run([AWS,'iam','simulate-custom-policy','--cli-input-json','file://'+request_path.as_posix(),
       '--profile','capiro-dev','--region','us-east-1','--output','json','--no-cli-pager'],capture_output=True,text=True,timeout=30)
    if response.returncode: raise RuntimeError('IAM_SIMULATION_FAILED')
    result=json.loads(response.stdout)['EvaluationResults'][0]
    decision=result['EvalDecision']
    assert decision==expected,(name,decision)
    return {'name':name,'action':action,'expected':expected,'actual':decision,'missingContextValues':result.get('MissingContextValues',[])}
checks=[test('tagged-helper-task','ecs:DescribeTasks',task),
 test('untagged-task','ecs:DescribeTasks',task,tag=False,expected='implicitDeny'),
 test('wrong-cluster','ecs:DescribeTasks',task,scope=cluster+'-other',expected='implicitDeny'),
 test('expired-task','ecs:DescribeTasks',task,at='2026-10-04T21:00:00Z',expected='implicitDeny'),
 test('task-definition-read','ecs:DescribeTaskDefinition','*'),
 test('foreign-region-definition','ecs:DescribeTaskDefinition','*',region='us-west-2',expected='implicitDeny'),
 test('expired-definition','ecs:DescribeTaskDefinition','*',at='2026-10-04T21:00:00Z',expected='implicitDeny'),
 test('no-run-task','ecs:RunTask','arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-meri-c2-case12-setup:1',expected='implicitDeny')]
result={'kind':'case12-native-iam-proposed-policy-simulation','version':1,'status':'PASS_SIMULATION_ONLY',
 'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'policySha256':hashlib.sha256(policy.read_bytes()).hexdigest(),'checks':checks,'iamMutation':False,
 'roleArn':'arn:aws:iam::967807252336:role/Capiro-dev-Compute-ApiTaskRole12FAD4A7-szq3QeeZJSCQ',
 'proposedPolicyName':'MeriCase12NativeSetupReads20261004','expiresAt':'2026-10-04T21:00:00Z',
 'documentedLimitation':'DescribeTaskDefinition has no resource-level IAM restriction; required Resource * is constrained by region and expiration.',
 'actualEcsHelperAccess':'NOT_RUN','deploymentAuthorization':'NOT_GRANTED_BY_THIS_ARTIFACT'}
with (root/'case12-native-iam-policy-candidate-qualification-v1.json').open('x',encoding='utf-8') as f: json.dump(result,f,indent=2);f.write('\n')
print(json.dumps({'status':result['status'],'checks':len(checks),'policySha256':result['policySha256']}))
