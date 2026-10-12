// Core skeleton source is opaque API qualification data, never a browser module.
// Backend/default mode has no Web reads. --frontend-parity separately checks current source bytes and five source-policy obligations.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,lstatSync,existsSync,mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

export const DECLARED_COMPONENT_REFS = {
  "core-api": "1e99f0921b207318c6d2abf03927b5c4daa5768b",
  "intel-api": "0732f2511796411c2d9a492e6a3b0a4bc33cb225",
  "engagement-api": "192cca3a1386eb2ceb370e01f6041e338709ab24",
  "api-strategy": "e04b01744570134e9b1f0316b2fa377e89057505",
  "meriv2-orchestrator": "5d97ebc64dc9d2c99ea9fca5e1b409f16d3196bf",
  "workspace": "193703e34f2bedbb69d87d6a8ee303f65ab8dbda",
  "memory-review": "32a4320d0386f5608e0bf59af3671c91e665c100",
  "legiwatch-api-104": "41aead03cd5ad9fec8abecb45e6c12569b0ea08e",
  "legiwatch-api-89": "d6fef85b726e6c7f4c5c674f82a47602894a64f9"
};

export const OWNED_INPUT = {
  "corePin": "1e99f0921b207318c6d2abf03927b5c4daa5768b",
  "retirementBase": "8ac4c42cc49876ec19808369c0683956e0f2f474",
  "destinationPin": "61e9b467295235829e7d8097368ce41b0434818a",
  "source": "apps/web/src/vnext/pages/engagement/outreach-v3-skeleton-editing.ts",
  "fixture": "apps/api/src/outreach-v3/state/__fixtures__/legacy-ui-contracts/outreach-v3-skeleton-editing.ts.txt",
  "reader": "apps/api/src/outreach-v3/state/outreach-content-skeleton-boundaries.spec.ts",
  "coreInput": {
    "ref": "1e99f0921b207318c6d2abf03927b5c4daa5768b",
    "blob": "07a82c29a30090a6521bf9528c838e4145b288bd",
    "sha256": "44df643386b3ddc4e88a039b32b0a54ea91b43323eab8b952f576c2974798e0b",
    "bytes": 7644,
    "lines": 236
  },
  "coreReader": {
    "ref": "1e99f0921b207318c6d2abf03927b5c4daa5768b",
    "blob": "189abf78e8cfa6ed4377a234521ba28d6ae05230",
    "sha256": "e004a4032a092a3d840e88491486e2838e453496d19a38a3ca655c7e963cebfb",
    "bytes": 5434,
    "lines": 140
  },
  "sourceComponentVariants": [
    {
      "blob": "07a82c29a30090a6521bf9528c838e4145b288bd",
      "sha256": "44df643386b3ddc4e88a039b32b0a54ea91b43323eab8b952f576c2974798e0b",
      "bytes": 7644,
      "components": [
        "core-api",
        "intel-api",
        "engagement-api",
        "api-strategy",
        "meriv2-orchestrator",
        "workspace",
        "memory-review",
        "legiwatch-api-104",
        "legiwatch-api-89"
      ]
    }
  ],
  "readerComponentVariants": [
    {
      "blob": "189abf78e8cfa6ed4377a234521ba28d6ae05230",
      "sha256": "e004a4032a092a3d840e88491486e2838e453496d19a38a3ca655c7e963cebfb",
      "bytes": 5434,
      "components": [
        "core-api",
        "intel-api",
        "engagement-api",
        "api-strategy",
        "meriv2-orchestrator",
        "workspace",
        "memory-review",
        "legiwatch-api-104",
        "legiwatch-api-89"
      ]
    }
  ],
  "evidence": {
    "core": {
      "input": {
        "ref": "1e99f0921b207318c6d2abf03927b5c4daa5768b",
        "blob": "07a82c29a30090a6521bf9528c838e4145b288bd",
        "sha256": "44df643386b3ddc4e88a039b32b0a54ea91b43323eab8b952f576c2974798e0b",
        "bytes": 7644,
        "lines": 236
      },
      "reader": {
        "ref": "1e99f0921b207318c6d2abf03927b5c4daa5768b",
        "blob": "189abf78e8cfa6ed4377a234521ba28d6ae05230",
        "sha256": "e004a4032a092a3d840e88491486e2838e453496d19a38a3ca655c7e963cebfb",
        "bytes": 5434,
        "lines": 140
      }
    },
    "retirementBase": {
      "input": {
        "ref": "8ac4c42cc49876ec19808369c0683956e0f2f474",
        "blob": "07a82c29a30090a6521bf9528c838e4145b288bd",
        "sha256": "44df643386b3ddc4e88a039b32b0a54ea91b43323eab8b952f576c2974798e0b",
        "bytes": 7644,
        "lines": 236
      },
      "reader": {
        "ref": "8ac4c42cc49876ec19808369c0683956e0f2f474",
        "blob": "189abf78e8cfa6ed4377a234521ba28d6ae05230",
        "sha256": "e004a4032a092a3d840e88491486e2838e453496d19a38a3ca655c7e963cebfb",
        "bytes": 5434,
        "lines": 140
      }
    },
    "destination61e": {
      "input": {
        "ref": "61e9b467295235829e7d8097368ce41b0434818a",
        "blob": "07a82c29a30090a6521bf9528c838e4145b288bd",
        "sha256": "44df643386b3ddc4e88a039b32b0a54ea91b43323eab8b952f576c2974798e0b",
        "bytes": 7644,
        "lines": 236
      },
      "reader": {
        "ref": "61e9b467295235829e7d8097368ce41b0434818a",
        "blob": "189abf78e8cfa6ed4377a234521ba28d6ae05230",
        "sha256": "e004a4032a092a3d840e88491486e2838e453496d19a38a3ca655c7e963cebfb",
        "bytes": 5434,
        "lines": 140
      }
    }
  },
  "readerReplacement": {
    "before": "join(\n      process.cwd(),\n      '..',\n      'web',\n      'src',\n      'vnext',\n      'pages',\n      'engagement',\n      'outreach-v3-skeleton-editing.ts',\n    )",
    "after": "join(__dirname, '__fixtures__/legacy-ui-contracts/outreach-v3-skeleton-editing.ts.txt')",
    "occurrences": 1
  },
  "originalReaderSha256": "e004a4032a092a3d840e88491486e2838e453496d19a38a3ca655c7e963cebfb"
};

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const sha256=(bytes)=>createHash('sha256').update(bytes).digest('hex');
const blob=(bytes)=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
function checkedRead(rootDirectory,path,reads){
 assert.equal(typeof path,'string');assert.ok(path&&!path.startsWith('/')&&!path.includes('\\')&&!path.split('/').some((p)=>!p||p==='.'||p==='..'),'Unsafe input path');
 const parts=path.split('/');for(let count=1;count<=parts.length;count++)assert.equal(lstatSync(resolve(rootDirectory,...parts.slice(0,count))).isSymbolicLink(),false,'Symlink input path');
 reads.push(path);return readFileSync(resolve(rootDirectory,path));
}
export function verifyOutreachSkeletonOwnedInput(rootDirectory,reads=[]){
 const input=checkedRead(rootDirectory,OWNED_INPUT.fixture,reads);assert.equal(input.length,OWNED_INPUT.coreInput.bytes,'Owned input size drift');assert.equal(sha256(input),OWNED_INPUT.coreInput.sha256,'Owned input identity drift');assert.equal(blob(input),OWNED_INPUT.coreInput.blob,'Owned Core blob drift');
 let reader=checkedRead(rootDirectory,OWNED_INPUT.reader,reads).toString('utf8');const {before,after,occurrences}=OWNED_INPUT.readerReplacement;assert.equal(reader.split(after).length-1,occurrences,'Owned read operand drift');reader=reader.replaceAll(after,before);assert.equal(sha256(Buffer.from(reader)),OWNED_INPUT.originalReaderSha256,'Original skeleton case/assertion drift');return reads;
}
export function verifyCurrentFrontendSkeletonInput(rootDirectory,reads=[]){
 verifyOutreachSkeletonOwnedInput(rootDirectory,reads);const source=checkedRead(rootDirectory,OWNED_INPUT.source,reads);assert.equal(sha256(source),OWNED_INPUT.coreInput.sha256,'Current frontend input byte drift');assert.equal(blob(source),OWNED_INPUT.coreInput.blob,'Current frontend Core blob drift');return reads;
}
function fixture(run){const directory=mkdtempSync(join(tmpdir(),'skeleton-owned-input-'));try{for(const path of [OWNED_INPUT.fixture,OWNED_INPUT.reader]){const target=join(directory,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,readFileSync(join(root,path)));}run(directory);}finally{rmSync(directory,{recursive:true,force:true});}}
const change=(directory,path,edit)=>writeFileSync(join(directory,path),edit(readFileSync(join(directory,path),'utf8')));
test('backend input preserves exact Core bytes and all ten original boundary cases',()=>{const reads=verifyOutreachSkeletonOwnedInput(root);assert.equal(reads.some((p)=>p.startsWith('apps/web/')),false);});
test('backend identity succeeds with Web absent and makes zero Web read attempts',()=>fixture((directory)=>{assert.equal(existsSync(join(directory,'apps/web')),false);assert.deepEqual(verifyOutreachSkeletonOwnedInput(directory),[OWNED_INPUT.fixture,OWNED_INPUT.reader]);}));
test('missing opaque source is refused',()=>fixture((directory)=>{rmSync(join(directory,OWNED_INPUT.fixture));assert.throws(()=>verifyOutreachSkeletonOwnedInput(directory),/ENOENT/);}));
test('same-size opaque source drift is refused',()=>fixture((directory)=>{change(directory,OWNED_INPUT.fixture,(source)=>source.replace('maxSlots: 12','maxSlots: 13'));assert.throws(()=>verifyOutreachSkeletonOwnedInput(directory),/input identity drift/);}));
test('restored current-Web read operand is refused',()=>fixture((directory)=>{const {before,after}=OWNED_INPUT.readerReplacement;change(directory,OWNED_INPUT.reader,(source)=>source.replace(after,before));assert.throws(()=>verifyOutreachSkeletonOwnedInput(directory),/read operand drift/);}));
test('skipping a browser/server syntax obligation is refused',()=>fixture((directory)=>{change(directory,OWNED_INPUT.reader,(source)=>source.replace("  it('uses the identical slot-key shape'", "  it.skip('uses the identical slot-key shape'"));assert.throws(()=>verifyOutreachSkeletonOwnedInput(directory),/case\/assertion drift/);}));
test('removing a server schema assertion is refused',()=>fixture((directory)=>{change(directory,OWNED_INPUT.reader,(source)=>source.replace('    expect(validateContentSkeleton(skeleton)).toEqual([]);\n',''));assert.throws(()=>verifyOutreachSkeletonOwnedInput(directory),/case\/assertion drift/);}));
test('opaque symlink substitution is refused before reading',()=>fixture((directory)=>{rmSync(join(directory,OWNED_INPUT.fixture));symlinkSync('missing.txt',join(directory,OWNED_INPUT.fixture));assert.throws(()=>verifyOutreachSkeletonOwnedInput(directory),/Symlink input path/);}));
if(process.argv.includes('--frontend-parity')){
 test('explicit current frontend source matches the retained Core input bytes',()=>{verifyCurrentFrontendSkeletonInput(root);});
 test('current frontend absence is refused independently',()=>fixture((directory)=>{assert.throws(()=>verifyCurrentFrontendSkeletonInput(directory),/ENOENT/);}));
 test('current frontend byte drift is refused independently',()=>fixture((directory)=>{const target=join(directory,OWNED_INPUT.source);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,readFileSync(join(directory,OWNED_INPUT.fixture)));verifyCurrentFrontendSkeletonInput(directory);change(directory,OWNED_INPUT.source,(source)=>source.replace('maxSlots: 12','maxSlots: 13'));assert.throws(()=>verifyCurrentFrontendSkeletonInput(directory),/frontend input byte drift/);}));
 const currentSource=checkedRead(root,OWNED_INPUT.source,[]).toString('utf8');
 // These are the five retained source obligations, not browser rendering/served-policy proof.
 test('frontend source obligation: uses the identical double-brace token pattern',()=>{assert.ok(currentSource.includes('/\\{\\{([a-z][a-z0-9_]{0,39})\\}\\}/g'));});
 test('frontend source obligation: uses the identical slot-key shape',()=>{assert.ok(currentSource.includes('/^[a-z][a-z0-9_]{0,39}$/'));});
 test('frontend source obligation: collapses 3+ newlines exactly as the server assembler does',()=>{assert.ok(currentSource.includes("replace(/\\n{3,}/g, '\\n\\n')"));});
 test('frontend source obligation: drops a token-only line exactly as the server assembler does',()=>{assert.ok(currentSource.includes('/^\\s*(?:\\{\\{[a-z][a-z0-9_]{0,39}\\}\\}\\s*)+$/'));});
 test('frontend source obligation: declares the same limits the server schemas enforce',()=>{for(const literal of ['maxSlots: 12','maxBodyChars: 8_000','maxSubjectChars: 400','maxInstructionChars: 1_000','maxLabelChars: 120'])assert.ok(currentSource.includes(literal));});
}
