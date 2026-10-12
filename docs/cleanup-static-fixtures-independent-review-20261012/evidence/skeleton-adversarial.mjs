import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { OWNED_INPUT, verifyOutreachSkeletonOwnedInput } from '../../../scripts/ci/outreach-skeleton-owned-input.spec.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
function fixture(run) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'independent-skeleton-'));
  try {
    for(const name of [OWNED_INPUT.fixture,OWNED_INPUT.reader]){const out=path.join(dir,name);fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,fs.readFileSync(path.join(root,name)));}
    run(dir);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
function edit(dir,name,transform){const file=path.join(dir,name);fs.writeFileSync(file,transform(fs.readFileSync(file,'utf8')));}
test('independent: removing the malformed-key refusal preserves case count but is rejected',()=>fixture(dir=>{
  edit(dir,OWNED_INPUT.reader,text=>text.replace('{{Bad-Key}}','{{good_key}}'));
  assert.throws(()=>verifyOutreachSkeletonOwnedInput(dir),/case\/assertion drift/);
}));
test('independent: flipping null-clear acceptance without deleting its case is rejected',()=>fixture(dir=>{
  edit(dir,OWNED_INPUT.reader,text=>text.replace('.not.toThrow();','.toThrow();'));
  assert.throws(()=>verifyOutreachSkeletonOwnedInput(dir),/case\/assertion drift/);
}));
test('independent: adding a second live-Web read operand is rejected before execution',()=>fixture(dir=>{
  edit(dir,OWNED_INPUT.reader,text=>text+"\nreadFileSync('apps/web/source.ts');\n");
  assert.throws(()=>verifyOutreachSkeletonOwnedInput(dir),/case\/assertion drift/);
}));
test('independent: substituting a different owned frontend snapshot is rejected',()=>fixture(dir=>{
  fs.writeFileSync(path.join(dir,OWNED_INPUT.fixture),fs.readFileSync(path.join(root,'apps/api/src/intelligence/__fixtures__/legacy-ui-contracts/intelligence-mappings-shared.ts.txt')));
  assert.throws(()=>verifyOutreachSkeletonOwnedInput(dir),/input size drift/);
}));
test('independent: reader symlink is refused before reading even with exact target bytes',()=>fixture(dir=>{
  const reader=path.join(dir,OWNED_INPUT.reader),saved=path.join(dir,'exact-reader.txt');fs.copyFileSync(reader,saved);fs.unlinkSync(reader);fs.symlinkSync(saved,reader);
  assert.throws(()=>verifyOutreachSkeletonOwnedInput(dir),/Symlink input path/);
}));
test('independent: missing reader has no fallback to live Web',()=>fixture(dir=>{
  fs.unlinkSync(path.join(dir,OWNED_INPUT.reader));
  assert.throws(()=>verifyOutreachSkeletonOwnedInput(dir),/ENOENT/);
}));
test('independent: adding invisible fixture bytes cannot hide behind source-policy strings',()=>fixture(dir=>{
  edit(dir,OWNED_INPUT.fixture,text=>text+'\u200b');
  assert.throws(()=>verifyOutreachSkeletonOwnedInput(dir),/input size drift/);
}));
