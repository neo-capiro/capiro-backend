const fs=require('node:fs'),path=require('node:path');
const wt='/tmp/capirov2-preview-minimum-source-20261013';const packet=path.join(wt,'docs/preview-minimum-source-20261013');
const cdk=require(path.join(wt,'infra/cdk/node_modules/aws-cdk-lib'));
const ec2=cdk.aws_ec2;const {Template}=require(path.join(wt,'infra/cdk/node_modules/aws-cdk-lib/assertions'));
const {previewConfig}=require(path.join(wt,'infra/cdk/lib/config.ts'));
const owned=`/tmp/preview-minimum-comparison-${process.pid}`;if(fs.existsSync(owned))throw Error('FRESH_DIRECTORY_REQUIRED');fs.mkdirSync(owned);fs.symlinkSync(path.join(wt,'infra/cdk/node_modules'),path.join(owned,'node_modules'),'dir');
try{
for(const name of ['data-stack','assets-stack'])fs.copyFileSync(path.join(packet,'comparison-baseline',name+'.ts.txt'),path.join(owned,name+'.ts'));
const oldData=require(path.join(owned,'data-stack.ts')).DataStack,oldAssets=require(path.join(owned,'assets-stack.ts')).AssetsStack;
const newData=require(path.join(wt,'infra/cdk/lib/data-stack.ts')).DataStack,newAssets=require(path.join(wt,'infra/cdk/lib/assets-stack.ts')).AssetsStack;
const results=[];
for(const envName of ['dev','staging','prod']){
const docs=[];
for(const [label,Data,Assets] of [['baseline',oldData,oldAssets],['candidate',newData,newAssets]]){
const app=new cdk.App({outdir:path.join(owned,envName+'-'+label)});const env={account:'967807252336',region:'us-east-1'};
const cfg={...previewConfig('https://synthetic-preview.clerk.accounts.dev'),envName};
const parent=new cdk.Stack(app,'ComparisonNetwork',{env});const vpc=ec2.Vpc.fromVpcAttributes(parent,'Vpc',{vpcId:'vpc-00000000000000001',availabilityZones:['us-east-1a','us-east-1b'],publicSubnetIds:['subnet-00000000000000001','subnet-00000000000000002'],privateSubnetIds:['subnet-00000000000000003','subnet-00000000000000004'],privateSubnetRouteTableIds:['rtb-00000000000000001','rtb-00000000000000002'],isolatedSubnetIds:['subnet-00000000000000005','subnet-00000000000000006'],isolatedSubnetRouteTableIds:['rtb-00000000000000003','rtb-00000000000000004']});
const group=ec2.SecurityGroup.fromSecurityGroupId(parent,'DatabaseGroup','sg-00000000000000001',{mutable:false});
const data=new Data(app,'ComparisonData',{env,cfg,vpc,dbSecurityGroup:group});const assets=new Assets(app,'ComparisonAssets',{env,cfg});
docs.push({data:Template.fromStack(data).toJSON(),assets:Template.fromStack(assets).toJSON()});
}
const assert=require('node:assert/strict');assert.deepEqual(docs[0],docs[1]);results.push({envName,templatePropertiesExact:true,scope:'same fixed synthetic config using this discriminator; not actual deployed environment inventory'});
}
console.log(JSON.stringify({result:'PASS',baselineHead:'f61c401803f039dac92866400edd04e74ba8ea5d',cases:results,AWSOperationRequested:false}));
}finally{fs.rmSync(owned,{recursive:true});}
