import fs from 'node:fs';
import { projectContextPlaneDiff } from '../../../scripts/lib/context-plane-scope.mjs';
const rows=[];
for(const scope of ['backend','frontend']){
 const diff='diff --git a/apps/api/src/example.ts b/apps/api/src/example.ts\nindex 1111111..2222222 100644\n--- a/apps/api/src/example.ts\n+++ b/apps/api/src/example.ts\n@@ -0,0 +1 @@\n+++ count;\n';
 try{rows.push({scope,accepted:true,projected:projectContextPlaneDiff(diff,scope)});}catch(error){rows.push({scope,accepted:false,error:error.message});}
}
const receipt={source:'b46dad56b0025d3f1043809d3322fe936f5d501f',helperSourceIdenticalTo:'61453eca11f5aa93d67285c2016db34f66eaf6b6',addedSource:'++ count;',cases:rows,sqlExecuted:false};
fs.writeFileSync(new URL('./original-valid-hunk-refusal.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt));
