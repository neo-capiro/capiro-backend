// Independent source-only oracle: derive expectations from anchored802 Git blobs, never author golden values.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const ts = require('/workspace/capirov2/node_modules/typescript');
const root = path.resolve(__dirname, '../../..');
const base = '802bbd0b2c510a44e46a9952d8127e7edc55aaaa';
const sourceHead = '77e936d2a695203819b7d46277bf63ab6a659539';
const docHead = '9f10c9e091dc4fd717d9d54e87586927d31d801e';
const read = p => fs.readFileSync(path.join(root,p),'utf8');
const before = p => cp.execFileSync('git',['show',`${base}:${p}`],{cwd:root,encoding:'utf8',maxBuffer:2000000});
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const configPath = 'apps/workspace/src/cascade/cascade.config.ts';
const registryPath = 'apps/workspace/src/cascade/workspace-product.registry.ts';
const servicePath = 'apps/workspace/src/cascade/cascade.service.ts';
const testPath = 'apps/workspace/test/cascade.spec.ts';
const oldConfig = before(configPath), oldService=before(servicePath), oldTest=before(testPath);
for(const [name,contents] of [['actual802-cascade.config.ts',oldConfig],['actual802-cascade.service.ts',oldService],['actual802-cascade.spec.ts',oldTest]]) {
 const file=path.join(__dirname,name);if(fs.existsSync(file))assert.equal(fs.readFileSync(file,'utf8'),contents);else fs.writeFileSync(file,contents);
}
assert.equal(read(servicePath),oldService); assert.equal(read(testPath),oldTest);
const newConfig=read(configPath), newRegistry=read(registryPath);
const code = text => ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,experimentalDecorators:true}}).outputText;
const moduleContexts = new WeakMap();
function load(text, imports={}) {
  const module={exports:{}};
  const context=Object.values(imports).map(value=>moduleContexts.get(value)).find(Boolean)??vm.createContext({process:undefined,fetch:undefined});
  context.reviewModule=module;
  context.reviewRequire=id=>{assert(Object.prototype.hasOwnProperty.call(imports,id),'unapproved pure dependency '+id);return imports[id];};
  vm.runInContext('(function(module,exports,require){'+code(text)+'})(reviewModule,reviewModule.exports,reviewRequire);',context,{timeout:1000});
  delete context.reviewModule;delete context.reviewRequire;
  moduleContexts.set(module.exports,context);
  return module.exports;
}
function pair() { const registry=load(newRegistry); return {before:load(oldConfig),after:load(newConfig,{'./workspace-product.registry.js':registry}),registry}; }
function service(c) {return new (load(oldService,{'./cascade.config.js':c,'@nestjs/common':{Injectable:()=>target=>target}}).CascadeService)();}
function capture(work) {
  try {const value=work();return {ok:true,type:typeof value,json:JSON.stringify(value)??null,...(typeof value==='function'?{functionName:value.name}:{})};}
  catch(error){return {ok:false,name:error.name,message:error.message};}
}
const results=[];
function check(label,run){run();results.push({label,result:'PASS'});}
function differential(label,run){check(label,()=>{const p=pair();assert.deepEqual(run(p.after,p.registry),run(p.before),label);});}
const maps=['PRODUCT_META','SUGGESTED_SECTIONS','SUGGESTED_PAGES'];
const lists=['CANONICAL_PRODUCTS','UNIVERSAL_PRODUCTS','FUNDING_PRODUCTS'];
const original=load(oldConfig), names=Object.keys(original.PRODUCT_META), industries=original.WSC.industries();
assert.equal(names.length,11); assert.equal(industries.length,8);
for(const k of [...maps,...lists,'CASCADE','INDUSTRY_DATA','SECTION_LIBRARY']) differential('exact serialized original '+k,c=>JSON.stringify(c[k]));
for(const k of maps)differential('independent insertion order '+k,c=>Object.keys(c[k]).join('|'));
for(const k of lists)differential('independent list order '+k,c=>c[k].join('|'));
check('eleven descriptors and all six ranks match original values/order',()=>{
  const p=pair(), ds=Object.values(p.registry.WORKSPACE_PRODUCT_REGISTRY);assert.equal(ds.length,11);
  assert.deepEqual(ds.map(d=>d.name),names);
  for(const d of ds){assert.deepEqual(JSON.parse(JSON.stringify(d.metadata)),JSON.parse(JSON.stringify(original.PRODUCT_META[d.name])));assert.equal(JSON.stringify(d.sections),JSON.stringify(original.SUGGESTED_SECTIONS[d.name]));assert.equal(d.pages,original.SUGGESTED_PAGES[d.name]);}
  const projectionMaps={metadata:maps[0],sections:maps[1],pages:maps[2],canonical:lists[0],universal:lists[1],funding:lists[2]};
  for(const [projection,key] of Object.entries(projectionMaps)){
    const expected=maps.includes(key)?Object.keys(original[key]):Array.from(original[key]);
    for(const d of ds)assert.equal(d.orders[projection],expected.includes(d.name)?expected.indexOf(d.name):null);
    const included=ds.filter(d=>d.orders[projection]!==null);assert.equal(new Set(included.map(d=>d.orders[projection])).size,included.length);
  }
});
function parse(text){return ts.createSourceFile('x.ts',text,ts.ScriptTarget.Latest,true);}
function declarationText(text,name){const sf=parse(text);let found;function v(n){if((ts.isVariableDeclaration(n)||ts.isFunctionDeclaration(n)||ts.isInterfaceDeclaration(n))&&n.name?.getText(sf)===name)found=n.getText(sf);ts.forEachChild(n,v);}v(sf);assert(found,name);return found;}
for(const name of ['WSC','sectionSpecFor','INDUSTRY_DATA','SECTION_LIBRARY','CascadeProduct','CascadeIndustry','ProductMeta','IndustryDatum','SectionSpec'])check('byte-exact untouched owner '+name,()=>assert.equal(declarationText(newConfig,name),declarationText(oldConfig,name)));
check('19 CASCADE name references replace only original names',()=>{
 const old=parse(oldConfig), now=parse(newConfig);let oldCascade,newCascade;
 function v(n,sf,which){if(ts.isVariableDeclaration(n)&&n.name.getText(sf)==='CASCADE'){if(which==='old')oldCascade=n.initializer;else newCascade=n.initializer;}ts.forEachChild(n,x=>v(x,sf,which));}v(old,old,'old');v(now,now,'new');
 const replacements=[]; function gather(n){if(ts.isPropertyAccessExpression(n)&&n.name.text==='name'&&ts.isPropertyAccessExpression(n.expression)&&n.expression.expression.getText(now)==='WORKSPACE_PRODUCT_REGISTRY'){replacements.push({start:n.getStart(now)-newCascade.getStart(now),end:n.end-newCascade.getStart(now),value:pair().registry.WORKSPACE_PRODUCT_REGISTRY[n.expression.name.text].name});}ts.forEachChild(n,gather);}gather(newCascade);assert.equal(replacements.length,19);
 let reconstructed=newCascade.getText(now); for(const r of replacements.reverse())reconstructed=reconstructed.slice(0,r.start)+JSON.stringify(r.value)+reconstructed.slice(r.end);
 const normalize=s=>parse('const c='+s).statements[0].declarationList.declarations[0].initializer;
 const printer=ts.createPrinter(); const a=printer.printNode(ts.EmitHint.Expression,normalize(reconstructed),parse('')),b=printer.printNode(ts.EmitHint.Expression,normalize(oldCascade.getText(old)),parse(''));
 assert.equal(a.replaceAll('"',"'"),b.replaceAll('"',"'"));
});
const label = v => v === null ? 'null' : typeof v === 'object' ? 'object' : typeof v === 'symbol' ? 'symbol' : String(v);
const odd=['','unknown','White Paper',' White paper ','__proto__','constructor','toString','valueOf','hasOwnProperty','prototype',null,undefined,0,false,Symbol('unknown'),{toString:()=>names[0]},{toString:()=>{throw new Error('coercion failure');}}];
for(const product of [...names,...odd])for(const method of ['meta','suggestedSections','suggestedPages','isFunding'])differential(`${method} product ${label(product)}`,c=>capture(()=>c.WSC[method](product)));
for(const product of [...names,...odd])differential('service defaults '+label(product),c=>capture(()=>service(c).defaultsFor(product)));
for(const industry of [...industries,'unknown','',null,undefined,'__proto__','constructor']){
 differential('productsFor '+String(industry),c=>capture(()=>c.WSC.productsFor(industry)));
 differential('dataFor '+String(industry),c=>capture(()=>c.WSC.dataFor(industry)));
 for(const product of [...names,...odd])differential('pathwaysFor '+String(industry)+' '+label(product),c=>capture(()=>c.WSC.pathwaysFor(industry,product)));
 for(const pathways of [[],null,undefined,['NDAA Authorization','NDAA Authorization'],['Defense Appropriations','NDAA Authorization','Defense Appropriations'],['unknown'],['__proto__'],['constructor'],'NDAA Authorization',0,{}])differential('committeesFor '+String(industry)+' '+String(pathways),c=>capture(()=>c.WSC.committeesFor(industry,pathways)));
}
const sections=[...new Set([...Object.values(original.SUGGESTED_SECTIONS).flat(),...original.SECTION_LIBRARY,'','unmatched','THE ASK',' Requested amount title','title funding history','budget recommendations','objective contact','recipient operative provision','definitions summary','summary analysis','BACKGROUND','  Opening','Effective date funding history','q&a budget'])];
for(const section of [...sections,null,undefined,0,false,Symbol('heading'),{},['title'],{toLowerCase(){throw new Error('lowercase failure');}}])differential('section ordered rule '+label(section),c=>capture(()=>c.WSC.specFor(section)));
for(const [k,expected] of Object.entries({
 'title budget':'short','budget recommendations':'table','objective contact':'bullets','recipient information operative provision':'short','definitions summary':'prose','summary analysis':'prose','background':'prose','unmatched':'prose',
}))check('seven-rule priority/fallback '+k,()=>assert.equal(original.WSC.specFor(k).format,expected));
const mutationScenarios={
 metaShared:c=>{const meta=c.WSC.meta(names[0]);meta.cover=!meta.cover;return c.WSC.meta(names[0]).cover===meta.cover;},
 metaReplacement:c=>{c.PRODUCT_META={[names[0]]:{icon:'replacement',desc:'replacement'}};return capture(()=>c.WSC.meta(names[0]));},
 sectionsExportMutation:c=>{c.SUGGESTED_SECTIONS[names[0]].push('mutated');return JSON.stringify(c.WSC.suggestedSections(names[0]));},
 sectionsReplacement:c=>{c.SUGGESTED_SECTIONS={[names[0]]:['replacement']};return JSON.stringify(c.WSC.suggestedSections(names[0]));},
 pagesReplacement:c=>{c.SUGGESTED_PAGES={[names[0]]:77};return c.WSC.suggestedPages(names[0]);},
 pagesZero:c=>{c.SUGGESTED_PAGES[names[0]]=0;return c.WSC.suggestedPages(names[0]);},
 fundingReplacement:c=>{c.FUNDING_PRODUCTS=['replacement'];return c.WSC.isFunding('replacement');},
 canonicalReplacement:c=>{c.CANONICAL_PRODUCTS=['replacement'];return JSON.stringify(c.WSC.allLibraryProducts());},
 universalReplacement:c=>{c.UNIVERSAL_PRODUCTS=['replacement'];return JSON.stringify(c.WSC.productsFor(industries[0]));},
 cascadeReplacement:c=>{c.CASCADE=[{industry:'new',products:[],pathways:{new:['new']}}];return JSON.stringify([c.WSC.industries(),c.WSC.productsFor('new'),c.WSC.committeesFor('new',['new'])]);},
 dataReplacement:c=>{c.INDUSTRY_DATA={new:[{label:'new'}]};return JSON.stringify(c.WSC.dataFor('new'));},
 libraryReplacement:c=>{c.SECTION_LIBRARY=['replacement'];return JSON.stringify(service(c).sectionLibrary());},
 sectionsCopyIsolation:c=>{c.WSC.suggestedSections(names[0]).push('copy mutation');return c.WSC.suggestedSections(names[0]).includes('copy mutation');},
 libraryCopyIsolation:c=>{service(c).sectionLibrary().push('copy mutation');return c.SECTION_LIBRARY.includes('copy mutation');},
 pagesGetter:c=>{const events=[];Object.defineProperty(c.SUGGESTED_PAGES,names[0],{get(){events.push('page read');return 0;}});return {value:c.WSC.suggestedPages(names[0]),events};},
 throwingSectionsGetter:c=>{Object.defineProperty(c.SUGGESTED_SECTIONS,names[0],{get(){throw new Error('section read failure');}});return capture(()=>c.WSC.suggestedSections(names[0]));},
 prototypePages:c=>{Object.setPrototypeOf(c.SUGGESTED_PAGES,{inherited:91});return c.WSC.suggestedPages('inherited');},
 prototypeSections:c=>{Object.setPrototypeOf(c.SUGGESTED_SECTIONS,{inherited:['inherited']});return JSON.stringify(c.WSC.suggestedSections('inherited'));},
};
for(const [label,run] of Object.entries(mutationScenarios))differential('mutable/CJS/getter/prototype '+label,run);
differential('plain mutable maps/list export descriptors',c=>JSON.stringify([...maps,...lists,'CASCADE','INDUSTRY_DATA','SECTION_LIBRARY'].map(k=>({k,proto:c[k]&&Object.getPrototypeOf(c[k])===Object.getPrototypeOf(c.PRODUCT_META),frozen:Object.isFrozen(c[k]),descriptor:((d)=>({writable:d.writable,enumerable:d.enumerable,configurable:d.configurable,get:!!d.get}))(Object.getOwnPropertyDescriptor(c,k))}))));
differential('shared/reference versus fresh-copy semantics',c=>{
 const w=c.WSC,p=names[0],i=industries[0];return {
 knownMetadataShared:w.meta(p)===c.PRODUCT_META[p],unknownMetadataFresh:w.meta('unknown')!==w.meta('unknown'),
 knownSectionsFresh:w.suggestedSections(p)!==w.suggestedSections(p), unknownSectionsFresh:w.suggestedSections('unknown')!==w.suggestedSections('unknown'),
 whiteNdaaDistinct:c.SUGGESTED_SECTIONS['White paper']!==c.SUGGESTED_SECTIONS['NDAA Authorization Request'],
 knownDataShared:w.dataFor(i)===c.INDUSTRY_DATA[i], unknownDataFresh:w.dataFor('unknown')!==w.dataFor('unknown'),
 knownPathwayShared:w.pathwaysFor(i,'NDAA Authorization Request')===c.CASCADE[0].products[0].pathways,
 universalPathwayFresh:w.pathwaysFor(i,'Member letter')!==w.pathwaysFor(i,'Member letter'),
 committeesFresh:w.committeesFor(i,[])!==w.committeesFor(i,[]),libraryFresh:w.allLibraryProducts()!==w.allLibraryProducts(),
 sectionSpecFresh:w.specFor('Background')!==w.specFor('Background'),wordTupleFresh:w.specFor('Background').targetWords!==w.specFor('Background').targetWords,
 };});
for(const method of ['productsFor','pathwaysFor','committeesFor','suggestedSections'])differential('detached original receiver '+method,c=>capture(()=>{const f=c.WSC[method];return f(industries[0],names[0]);}));
check('new canonical aliases preserve projected object/array identity',()=>{const p=pair();const aliases={PRODUCT_META:'WORKSPACE_PRODUCT_METADATA',SUGGESTED_SECTIONS:'WORKSPACE_PRODUCT_SECTIONS',SUGGESTED_PAGES:'WORKSPACE_PRODUCT_PAGES',CANONICAL_PRODUCTS:'WORKSPACE_PRODUCT_CANONICAL',UNIVERSAL_PRODUCTS:'WORKSPACE_PRODUCT_UNIVERSAL',FUNDING_PRODUCTS:'WORKSPACE_PRODUCT_FUNDING'};for(const [a,b]of Object.entries(aliases))assert.equal(p.after[a],p.registry[b]);for(const d of Object.values(p.registry.WORKSPACE_PRODUCT_REGISTRY)){assert.equal(p.after.PRODUCT_META[d.name],d.metadata);assert.equal(p.after.SUGGESTED_SECTIONS[d.name],d.sections);}});
check('registry has zero runtime imports and no runtime reverse cycle',()=>{assert(!/require\(/.test(code(newRegistry)));assert.deepEqual([...code(newConfig).matchAll(/require\("([^"]+)"\)/g)].map(m=>m[1]),['./workspace-product.registry.js']);});
check('oracle catches a descriptor/page/order/name behavior regression',()=>{for(const [from,to]of [["name: 'White paper'","name: 'Wrong paper'"],['pages: 2,','pages: 99,'],['sections: 10,','sections: 0,']]){assert(newRegistry.includes(from));const mutated=load(newRegistry.replace(from,to)),c=load(newConfig,{'./workspace-product.registry.js':mutated});assert.notEqual(JSON.stringify([c.PRODUCT_META,c.SUGGESTED_PAGES,c.SUGGESTED_SECTIONS]),JSON.stringify([original.PRODUCT_META,original.SUGGESTED_PAGES,original.SUGGESTED_SECTIONS]));}});
const originalBindings=[configPath,servicePath,testPath].map(p=>({path:p,blob:cp.execFileSync('git',['rev-parse',`${base}:${p}`],{cwd:root,encoding:'utf8'}).trim(),sha256:sha(before(p))}));
console.log(JSON.stringify({result:'PASS independent original802 differential',base,baseTree:cp.execFileSync('git',['rev-parse',`${base}^{tree}`],{cwd:root,encoding:'utf8'}).trim(),sourceHead,docHead,originalBindings,descriptorCount:names.length,projectionCount:6,cascadeNameReferences:19,checks:results.length,results,scope:'pure data/helper VM evaluation and thin identity-decorator service only; no application/provider/DB graph; no native/type/runtime/security acceptance'},null,2));
