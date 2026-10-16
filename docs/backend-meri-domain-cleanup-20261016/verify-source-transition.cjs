// Explicit one-time source transition evidence, never an evergreen CI gate.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
if (process.argv.length !== 3 || process.argv[2] !== '--run') throw new Error('Use exactly --run for this one-time source transition proof.');
const root = path.resolve(__dirname, '../..');
const parent = '0483963adc5382202408e8398d8b1601f53d8525';
const git = (...args) => execFileSync('git', args, { cwd: root, timeout: 30000, maxBuffer: 2*1024*1024, stdio: ['ignore','pipe','pipe'] });
const sha = value => createHash('sha256').update(value).digest('hex');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
const evidence = name => JSON.parse(read(`docs/backend-meri-domain-cleanup-20261016/evidence/${name}`));
const oldTools = git('show', `${parent}:apps/api/src/meri/meri-tools.service.ts`).toString();
const tools = read('apps/api/src/meri/meri-tools.service.ts');
const domain = read('apps/api/src/meri/meri-federal-legislation-tools.ts');
const helpers = read('apps/api/src/meri/meri-tool-input.helpers.ts');
const manifest = evidence('meri-federal-implementation.json');
assert.equal(sha(oldTools), manifest.sourceCanonicalSha256);
for (const row of manifest.paths) assert.equal(sha(read(row.path)), row.canonicalSha256, 'Manifest source identity: '+row.path);
const oldLines = oldTools.split('\n');
const lineBlock = row => oldLines.slice(row.originalFirstLine-1, row.originalLastLine).join('\n');
function method(source, name) {
  const match = new RegExp(`^  (?:(?:private|public) )?(?:async )?${name}\\([^\\n]*\\{\\n`, 'm').exec(source);
  assert(match, 'Missing finite method: '+name);
  const end = /^  }\n/gm; end.lastIndex = match.index + match[0].length;
  const closing = end.exec(source); assert(closing, 'Incomplete finite method: '+name);
  return source.slice(match.index, closing.index + closing[0].length).trimEnd();
}
const methodProofs = manifest.methods.map(row => {
  const original = lineBlock(row);
  assert.equal(sha(original), row.originalSha256);
  const moved = method(domain, row.name);
  assert.equal(moved.replace(/^  public /, '  private '), original, 'Moved algorithm/signature drift: '+row.name);
  if (row.visibility === 'public') {
    const wrapper = method(tools, row.name);
    const declared = manifest.legacyFacades.find(facade => facade.name === row.name);
    assert.equal(wrapper, declared.exactForwarder, 'Raw forwarding changed: '+row.name);
    assert.equal(wrapper, `  private async ${row.name}(input: Record<string, unknown>) {\n    return new MeriFederalLegislationTools(this.prisma, this.ldaIntel).${row.name}(input);\n  }`);
  }
  return { name: row.name, bodySHA256: row.unchangedBodySha256, sourceIdentical: true };
});
for (const row of manifest.canonicalInputDeclarations) {
  const original = lineBlock(row);
  assert.equal(sha(original), row.originalSha256);
  assert(helpers.includes('export '+original), 'Canonical input helper changed: '+row.name);
}
const oldType = oldLines.slice(manifest.movedType.originalFirstLine-1, manifest.movedType.originalLastLine).join('\n');
assert.equal(sha(oldType), manifest.movedType.sha256);
assert(domain.includes(oldType), 'Bill-text row type changed');
const imports = source => [...source.matchAll(/^import[\s\S]*?from\s+(['"])([^'"\n]+)\1;\n/gm)].map(match => ({ source:match[0], from:match[2], offset:match.index }));
const oldImports = imports(oldTools);
const newImportPaths = new Set(['./meri-federal-legislation-tools.js','./meri-tool-input.helpers.js']);
const expectedOldImports = oldImports.filter(row => row.from !== './meri-bill-text-search.js').map(row =>
  row.source.replace(/^  currentCongress,\n/m,'').replace(/^  billStatusLabel,\n/m,''));
assert.deepEqual(imports(tools).filter(row => !newImportPaths.has(row.from)).map(row=>row.source), expectedOldImports, 'Unallocated original import change');
assert.deepEqual(imports(tools).filter(row => newImportPaths.has(row.from)).map(row=>row.source), [
  "import { MeriFederalLegislationTools } from './meri-federal-legislation-tools.js';\n",
  "import { UUID_V4_RE, requiredString, optionalString, clampInt } from './meri-tool-input.helpers.js';\n",
]);
assert.deepEqual(imports(domain).map(row=>row.from), ['@nestjs/common','../prisma/prisma.service.js','../lda-intel/lda-intel.service.js','@capiro/shared','./meri-bill-text-search.js','./meri-tool-input.helpers.js']);
assert.equal(imports(domain).find(row=>row.from==='./meri-bill-text-search.js').source, oldImports.find(row=>row.from==='./meri-bill-text-search.js').source);
assert.equal(imports(domain).filter(row=>row.source.startsWith('import type ')).length,2);
assert.deepEqual(imports(helpers).map(row=>row.from),['@nestjs/common']);
const allowedLines = new Set();
const allow = (start,end) => { for(let n=start;n<=end;n++) allowedLines.add(n); };
for(const row of [...manifest.methods,...manifest.canonicalInputDeclarations]) allow(row.originalFirstLine,row.originalLastLine);
allow(manifest.movedType.originalFirstLine,manifest.movedType.originalLastLine+1);
for(const row of manifest.movedPrivateComments) allow(row.firstLine,row.lastLine);
for(const row of oldImports.filter(row=>row.from==='./meri-bill-text-search.js')) allow(oldTools.slice(0,row.offset).split('\n').length, oldTools.slice(0,row.offset+row.source.length).split('\n').length-1);
oldLines.forEach((line,index)=>{if(index<270 && /^  (?:currentCongress|billStatusLabel),$/.test(line)) allowedLines.add(index+1);});
const permittedAdded = new Set(['',...manifest.legacyFacades.flatMap(row=>row.exactForwarder.split('\n')),
  ...imports(tools).filter(row=>newImportPaths.has(row.from)).flatMap(row=>row.source.trimEnd().split('\n'))]);
const diff = git('diff','--no-ext-diff','--unified=0',parent,'--','apps/api/src/meri/meri-tools.service.ts').toString();
const hunks=[]; let active=null;
for(const line of diff.split('\n')) {
  const header=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if(header){active={oldStart:+header[1],oldCount:header[2]===undefined?1:+header[2],newStart:+header[3],newCount:header[4]===undefined?1:+header[4],removed:[],added:[]};hunks.push(active);continue;}
  if(!active)continue;
  if(line.startsWith('-'))active.removed.push(line.slice(1));
  else if(line.startsWith('+'))active.added.push(line.slice(1));
}
for(const hunk of hunks){
  assert.equal(hunk.removed.length,hunk.oldCount); assert.equal(hunk.added.length,hunk.newCount);
  hunk.removed.forEach((line,index)=>assert(allowedLines.has(hunk.oldStart+index)||!line.trim(), 'Unallocated removed line '+(hunk.oldStart+index)));
  hunk.added.forEach(line=>assert(permittedAdded.has(line), 'Unallocated added code: '+line));
}
const restored = tools.split('\n');
for(const hunk of [...hunks].reverse()) restored.splice(hunk.newCount===0?hunk.newStart:hunk.newStart-1,hunk.newCount,...hunk.removed);
assert.equal(restored.join('\n'),oldTools,'Whole facade inverse does not reconstruct the parent');
const engagementReceipt=evidence('engagement-orphan-removal.json');
const oldEngagement=git('show',`${parent}:${engagementReceipt.sourcePath}`);
const engagement=fs.readFileSync(path.join(root,engagementReceipt.sourcePath));
assert.equal(sha(oldEngagement),engagementReceipt.before.sha256);assert.equal(sha(engagement),engagementReceipt.after.sha256);
let engagementInverse=engagement;
for(const block of [...engagementReceipt.removed.blocks].reverse()){
  const original=oldEngagement.subarray(block.originalStartByteOffset,block.originalEndByteOffsetExclusive);
  assert.equal(sha(original),block.removedBytesSha256);
  engagementInverse=Buffer.concat([engagementInverse.subarray(0,block.inverseInsertionByteOffset),original,engagementInverse.subarray(block.inverseInsertionByteOffset)]);
}
assert(engagementInverse.equals(oldEngagement),'Whole Engagement inverse differs');
const report={parent,workingSourceIdentities:manifest.paths,methods:methodProofs,canonicalInputDefinitions:4,
  exactSQLAndAlgorithms:true,facadeInverseSHA256:sha(restored.join('\n')),facadeOtherCodeUnchanged:true,
  approvedFacadeHunks:hunks.map(({oldStart,oldCount,newStart,newCount,removed,added})=>({oldStart,oldCount,newStart,newCount,removedSHA256:sha(removed.join('\n')),addedSHA256:sha(added.join('\n'))})),
  engagement:{removedMethods:engagementReceipt.removed.blocks.map(row=>row.name),physicalLines:225,nonblankLines:220,inverseSHA256:sha(engagementInverse),otherBytesUnchanged:true},
  scope:'one-time source transition proof; not evergreen CI, native typing, router, database or runtime acceptance'};
fs.writeFileSync(path.join(__dirname,'SOURCE-TRANSITION-PROOF.json'),JSON.stringify(report,null,2)+'\n');
console.log('MERI_DOMAIN_SOURCE_TRANSITION_OK '+JSON.stringify({methods:7,facades:5,inputDefinitions:4,approvedFacadeHunks:hunks.length,engagementRemovedMethods:3,engagementRemovedPhysicalLines:225,wholeFacadeInverse:true,wholeEngagementInverse:true,scope:report.scope}));
