require('./strict-source-read-refusal.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const before = fs.readFileSync(path.join(__dirname, 'clients.service.before.ts.txt'), 'utf8');
const after = fs.readFileSync(path.join(root, 'apps/api/src/clients/clients.service.ts'), 'utf8');
const insertion = "      // Match memory readers' client-before-grant lock order and serialize\n" +
  '      // complete roster replacements for this tenant/client.\n' +
  '      const locked = await tx.$queryRaw<Array<{ id: string }>>`\n' +
  '        SELECT id FROM clients\n' +
  '        WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${clientId}::uuid\n' +
  '        FOR UPDATE\n' +
  '      `;\n' +
  "      if (!locked.length) throw new NotFoundException('Client not found');\n\n";
const inverse = after.replace(insertion, '');
if (after.split(insertion).length !== 2 || inverse !== before) throw new Error('Original whole ClientsService bytes were not preserved outside the unique lock insertion');
const oldCases = JSON.parse(fs.readFileSync(path.join(__dirname, '01-before-jest.json'))).testResults.flatMap(x => x.assertionResults.map(t => t.fullName)).sort();
const newCases = JSON.parse(fs.readFileSync(path.join(__dirname, '02-candidate-jest.json'))).testResults.flatMap(x => x.assertionResults.map(t => t.fullName)).sort();
if (JSON.stringify(oldCases) !== JSON.stringify(newCases) || oldCases.length !== 16) throw new Error('Before/after case identity changed');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const result = {
  sourceHead: '926b269ad6e3b5ed789b5d18f55306df310d046c',
  sourceTree: '20f6c336489913c6f4c16a98f2a16fed4847ecd4',
  baseline: '277053c8196dc1be4789c42ea304b0de0553fe00',
  originalSha256: sha256(before), candidateSha256: sha256(after),
  uniqueInsertionCount: 1, wholeFileInverseEqual: inverse === before,
  originalImportsAndAllOtherMethodsEqual: true,
  unchanged16CaseNames: oldCases,
  providerOrDatabaseOperation: false,
};
fs.writeFileSync(path.join(__dirname, '04-source-inverse.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
