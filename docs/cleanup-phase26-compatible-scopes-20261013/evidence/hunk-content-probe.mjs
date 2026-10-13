import { projectKnowledgeCensusDiff } from '../../../scripts/lib/knowledge-census-scope.mjs';
const results = [];
for (const file of ['apps/api/src/example.ts', 'apps/web/src/example.ts']) {
  for (const [kind, hunk, content] of [['increment', '@@ -0,0 +1 @@', '+++ count;'], ['decrement', '@@ -1 +0,0 @@', '--- count;']]) {
    const diff = `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n${hunk}\n${content}\n`;
    for (const scope of ['backend', 'frontend']) {
      let accepted = false, detail;
      try { const projected = projectKnowledgeCensusDiff(diff, scope); accepted = projected === (file.startsWith('apps/web/') === (scope === 'frontend') ? diff : ''); }
      catch (error) { detail = error.message; }
      results.push({file, kind, scope, accepted, detail});
    }
  }
}
console.log(JSON.stringify({results, passed:results.filter((r)=>r.accepted).length, total:results.length, noIO:true}, null, 2));
process.exitCode = results.every((r)=>r.accepted) ? 0 : 1;
