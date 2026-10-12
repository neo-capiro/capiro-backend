const fs = require('node:fs'), cp = require('node:child_process'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const C = '1e99f0921b207318c6d2abf03927b5c4daa5768b', Q = '7ea444c74a5637577aa0eb3cb99cb420b5f8223e';
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const models = [];
for (const path of ['apps/api/prisma/schema.prisma', 'apps/workspace/prisma/schema.prisma']) {
  const old = cp.execFileSync('git', ['show', `${C}:${path}`], { encoding: 'utf8' });
  const current = cp.execFileSync('git', ['show', `${Q}:${path}`], { encoding: 'utf8' });
  for (const match of old.matchAll(/^model ((?:WsNewsletter|Newsletter)\w+) \{[\s\S]*?^\}/gm)) {
    assert(!current.includes(`model ${match[1]} {`));
    models.push({ path, name: match[1], originalBlock: match[0], sha256: hash(match[0]), absentFromQ: true });
  }
}
assert.equal(models.filter(m => m.path.startsWith('apps/api/')).length, 5);
assert.equal(models.filter(m => m.path.startsWith('apps/workspace/')).length, 11);
const api = cp.execFileSync('git', ['show', `${C}:apps/api/prisma/schema.prisma`], { encoding: 'utf8' });
const version = api.match(/^model OutreachDraftVersion \{[\s\S]*?^\}/m)[0];
const originalFormatFields = version.split('\n').filter(line => /^\s+(?:contentFormat|newsletterStageId)\s/.test(line));
assert.equal(originalFormatFields.length, 2);
const result = { source: C, Q, models, originalFormatFields, migrationExecution: false, schemaOrGeneratorExecution: false, applicationAcceptance: false };
fs.writeFileSync('docs/cleanup-newsletter-two-contract-independent-review-20261012/evidence/schema-before-golden.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ models: models.length, core: 5, workspace: 11, originalFormatFields, applicationAcceptance: false }));
