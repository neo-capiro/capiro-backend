import { readdirSync, readFileSync } from 'node:fs';
import { aws, root, save, need } from './auth-preflight.mjs';

const binding = JSON.parse(readFileSync(root+'/oneoff-binding.json','utf8'));
need(binding.taskDefinition === 'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-meri-fresh-benchmark-20261003:1','UNEXPECTED_OWN_DEFINITION');
const starts = readdirSync(root).filter(n=>n.endsWith('-task-start.json'));
const arns = starts.map(n=>JSON.parse(readFileSync(root+'/'+n,'utf8')).taskArn);
need(arns.length===16 && new Set(arns).size===16,'TASK_COUNT_MISMATCH');
need(arns.every(a=>a.startsWith('arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/')),'TASK_SCOPE_MISMATCH');
const described=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',...arns]);
need(!described.failures?.length && described.tasks.length===arns.length,'TASKS_NOT_ALL_FOUND');
need(described.tasks.every(t=>t.lastStatus==='STOPPED' && t.taskDefinitionArn===binding.taskDefinition),'OWN_TASKS_NOT_STOPPED');
const result=aws(['ecs','deregister-task-definition','--task-definition',binding.taskDefinition]);
need(result.taskDefinition.taskDefinitionArn===binding.taskDefinition && result.taskDefinition.status==='INACTIVE','DEFINITION_NOT_INACTIVE');
save('aws-cleanup.json',{
  completedAt:new Date().toISOString(),
  taskDefinition:binding.taskDefinition,
  taskDefinitionStatus:result.taskDefinition.status,
  allTasksStopped:true,
  tasks:described.tasks.map(t=>({taskArn:t.taskArn,lastStatus:t.lastStatus,stopCode:t.stopCode,stoppedAt:t.stoppedAt,containers:t.containers.map(c=>({name:c.name,exitCode:c.exitCode,lastStatus:c.lastStatus}))})),
  serviceUpdated:false
});
console.log(JSON.stringify({ownTasksStopped:arns.length,taskDefinitionStatus:result.taskDefinition.status}));
