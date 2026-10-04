import {createRequire} from 'node:module';
import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const require=createRequire('C:/dev/main/meri-c1-20261002/apps/api/package.json');
const {ECSClient,DescribeTasksCommand}=require('@aws-sdk/client-ecs');
process.env.AWS_PROFILE='capiro-dev';
const ecs=new ECSClient({region:'us-east-1',maxAttempts:1,ignoreConfiguredEndpointUrls:true});
try {
 const result=await ecs.send(new DescribeTasksCommand({cluster:'capiro-dev',tasks:['arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/2c12fa6a72654b0485ab4ee1f02f2bdf'],include:['TAGS']}),{abortSignal:AbortSignal.timeout(10000)});
 assert.equal(result.failures?.length??0,0);assert.equal(result.tasks.length,1);
 const task=result.tasks[0];assert.equal(task.lastStatus,'STOPPED');
 assert.equal(task.taskDefinitionArn,'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-meri-c2-case12-iam-probe-20261004:1');
 const proof={at:new Date().toISOString(),status:'ACTUAL_SDK_TASK_OVERRIDE_SHAPE_READ',sdkVersion:require('@aws-sdk/client-ecs/package.json').version,taskArn:task.taskArn,taskDefinitionArn:task.taskDefinitionArn,overrides:task.overrides,nativeSourceSha256:createHash('sha256').update(readFileSync('C:/dev/main/meri-c1-20261002/apps/api/src/meri/meri-case12-native-setup-admission.ts')).digest('hex'),awsWrites:0,providerCalls:0};
 writeFileSync('C:/dev/main/outputs/meri-c2-20261003/case12-actual-sdk-overrides-v1.json',JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify(proof));
}finally{ecs.destroy();}
