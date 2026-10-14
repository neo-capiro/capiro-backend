const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const dir=path.resolve(__dirname,'../../docs/runtime-production-closure-20261014/vendor-source');
const proof=JSON.parse(fs.readFileSync(path.join(dir,'PROVENANCE.json')));
test('source fixtures match integrity-verified archive provenance, no vendor/native execution',()=>{
 for(const x of proof.files){const b=fs.readFileSync(path.join(dir,x.path));assert.equal(b.length,x.bytes);assert.equal(crypto.createHash('sha256').update(b).digest('hex'),x.sha256);}
 assert.equal(proof.nativeFilesExtracted,false);assert.equal(proof.executed,false);assert.equal(proof.modelDownloads,0);
});
function codexTarget(platform,arch,glibcVersionRuntime){
 const s=fs.readFileSync(path.join(dir,'codex-runtime.js'),'utf8');
 const begin=s.indexOf('var libc =');const end=s.indexOf('// ../native/windows-files.mts');assert.ok(begin>=0&&end>begin);
 let selected;const context={__filename:'synthetic-selector.js',process:{platform,arch,report:{getReport:()=>({header:{glibcVersionRuntime}})}},import_node_module:{createRequire:()=>p=>{selected=p;return {};}}};
 vm.runInNewContext(s.slice(begin,end)+'\nunixBinding();',context);return selected;
}
test('exact Codex selector asks for present linux-arm64-musl; other seven variants are unselected by this branch',()=>{
 const selected=codexTarget('linux','arm64',undefined);assert.equal(selected,'./native/linux-arm64-musl/unix.node');
 assert.equal(proof.codexNativeEntryPaths.some(p=>p.path.endsWith(selected.slice(2))),true);
 assert.equal(proof.codexNativeEntryPaths.length,8);
 assert.equal(proof.codexNativeEntryPaths.filter(p=>!p.path.endsWith(selected.slice(2))).length,7);
});
test('Codex glibc and alternate platform payloads follow vendor branch, not inferred inactivity',()=>{
 for(const [os,arch,glibc,expected] of [['linux','arm64','2.31','linux-arm64-gnu'],['linux','x64',undefined,'linux-x64-musl'],['darwin','arm64',undefined,'darwin-arm64']])assert.equal(codexTarget(os,arch,glibc),'./native/'+expected+'/unix.node');
});
function onnxTarget(platform,arch){
 const s=fs.readFileSync(path.join(dir,'onnx-binding.js'),'utf8');let selected;
 const requireFake=p=>{if(p.endsWith('onnxruntime_binding.node')){selected=p;return {};}if(p==='worker_threads')return {isMainThread:true};if(p==='onnxruntime-common')return {env:{},Tensor:function(){}};throw Error('Unexpected vendor import '+p);};
 vm.runInNewContext(s,{exports:{},require:requireFake,process:{platform,arch}});return selected;
}
test('compiled ONNX selector uses platform/arch only; no model or native loading',()=>{
 assert.equal(onnxTarget('linux','arm64'),'../bin/napi-v6/linux/arm64/onnxruntime_binding.node');
 assert.equal(onnxTarget('linux','x64'),'../bin/napi-v6/linux/x64/onnxruntime_binding.node');
 assert.equal(onnxTarget('win32','x64'),'../bin/napi-v6/win32/x64/onnxruntime_binding.node');
});
