from pathlib import Path
import hashlib

root = Path('C:/dev/main/outputs/meri-c2-20261003')
source = (root / 'verify-clock-provider-served-v2.mjs').read_text(encoding='utf-8')
source = source.replace("  if(service==='web-vnext')assert.deepEqual(live.baseline,expected.baseline);",
"  let oldTaskReadback={status:'NOT_CHECKED_UNCHANGED_SERVICE',requestedCount:null,observedCount:null,drainingCount:null};\n  if(service==='web-vnext')assert.deepEqual(live.baseline,expected.baseline);")
old = """    assert.equal(recent.nextToken,undefined);
    for(let i=0;i<recent.taskArns.length;i+=100){
      const tasks=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',...recent.taskArns.slice(i,i+100)]);assert.equal(tasks.failures?.length??0,0);
      assert.ok(tasks.tasks.every(t=>t.lastStatus==='STOPPED'),'Old service task still draining');
    }"""
new = """    assert.equal(recent.nextToken,undefined);assert.ok(Array.isArray(recent.taskArns));
    assert.equal(new Set(recent.taskArns).size,recent.taskArns.length);
    let observedCount=0;
    for(let i=0;i<recent.taskArns.length;i+=100){
      const requested=recent.taskArns.slice(i,i+100);
      const tasks=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',...requested]);assert.equal(tasks.failures?.length??0,0);
      assert.ok(Array.isArray(tasks.tasks));assert.equal(tasks.tasks.length,requested.length);
      assert.deepEqual(tasks.tasks.map(t=>t.taskArn).sort(),[...requested].sort(),'Incomplete or duplicate task readback');
      for(const task of tasks.tasks){assert.equal(task.clusterArn,'arn:aws:ecs:us-east-1:967807252336:cluster/capiro-dev');
        assert.equal(task.group,'service:capiro-dev-'+service);assert.equal(task.lastStatus,'STOPPED','Old service task still draining');}
      observedCount+=tasks.tasks.length;
    }
    oldTaskReadback={status:'ALL_REQUESTED_TASKS_STOPPED',requestedCount:recent.taskArns.length,observedCount,drainingCount:0};"""
assert source.count(old) == 1
source = source.replace(old, new)
assert source.count('oldDrainingTasks:0') == 1
source = source.replace('oldDrainingTasks:0', 'oldTaskReadback')
dest = root / 'verify-clock-provider-served-v3.mjs'
with dest.open('x', encoding='utf-8', newline='\n') as stream:
    stream.write(source)
print(hashlib.sha256(dest.read_bytes()).hexdigest())
