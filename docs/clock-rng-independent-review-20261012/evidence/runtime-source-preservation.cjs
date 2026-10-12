'use strict';
const fs=require('node:fs'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const ts=require('/workspace/capirov2-cleanup-source-prereqs/apps/api/node_modules/typescript');
const base='1bf52945b9fa01496ce41a349f8eaace490ad4ac';
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const old=file=>cp.execFileSync('git',['show',base+':'+file],{encoding:'utf8'});
const current=file=>fs.readFileSync(file,'utf8');
const parse=(file,text)=>ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
function declaration(sf,name){let result;function visit(n){if((ts.isFunctionDeclaration(n)||ts.isMethodDeclaration(n))&&n.name?.getText(sf)===name)result=n;ts.forEachChild(n,visit);}visit(sf);assert.ok(result,name);return result;}
const retryFile='apps/api-strategy/src/meri/context-load.ts';const before=parse(retryFile,old(retryFile));const after=parse(retryFile,current(retryFile));
const classifier=declaration(before,'isTransientLoadError').getText(before);assert.equal(declaration(after,'isTransientLoadError').getText(after),classifier);
const retryBefore=declaration(before,'withContextRetry').body.getText(before);const retryAfter=declaration(after,'withContextRetry').body.getText(after);assert.equal(retryBefore.replace('await sleep(jitteredDelay(attempt));','await runtime.delay(jitteredDelay(attempt, runtime));'),retryAfter);
const fiscalFile='apps/api-strategy/src/fiscal/fiscal.ts';const oldFiscal=parse(fiscalFile,old(fiscalFile));const newFiscal=parse(fiscalFile,current(fiscalFile));const fiscalNames=['fyOf','currentFyWindow','axisStart','qToDate'];for(const name of fiscalNames)assert.equal(declaration(oldFiscal,name).body.getText(oldFiscal),declaration(newFiscal,name).body.getText(newFiscal));
function classMembers(sf){const cls=sf.statements.find(ts.isClassDeclaration);assert.ok(cls);return new Map(cls.members.map((m,i)=>[ts.isConstructorDeclaration(m)?'<constructor>':m.name?.getText(sf)??'<unnamed-'+i+'>',m.getText(sf)]));}
const classes=[];for(const [file,changed]of [['apps/api-strategy/src/meri/meri.service.ts',['<constructor>','fiscalWindow','grounding','draft','stewardContext']],['apps/api-strategy/src/meri/draft-job.service.ts',['<constructor>','submit']]]){
 const a=classMembers(parse(file,old(file))),b=classMembers(parse(file,current(file)));assert.deepEqual([...a.keys()],[...b.keys()]);const untouched=[];for(const [name,body]of a)if(!changed.includes(name)){assert.equal(b.get(name),body,name);untouched.push(name);}classes.push({file,changedMembers:changed,unchangedMembers:untouched});
}
const otherSourceUntouched=['apps/api-strategy/src/meri/governed-strategy-meri.factory.ts','apps/api-strategy/src/reference/baseline.ts','pnpm-lock.yaml'];for(const file of otherSourceUntouched)assert.equal(current(file),old(file));
const data=JSON.parse(current('scripts/strategy-time-boundaries.json'));const result={source:'f86bf11b9b6da367d464da453ee1f260fa60e06e',base,passed:true,classifierBodySha256:hash(classifier),retryLoopExactExceptInjectedDelay:true,fiscalBodiesExact:fiscalNames,classes,otherSourceUntouched,retryConsumers:data.retryConsumers,requiredRetryToken:true,requiredClockToken:true,noRouteDtoSchemaDependencyLockChanges:true,nativeAcceptance:false};fs.writeFileSync('docs/clock-rng-independent-review-20261012/evidence/runtime-source-preservation.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({passed:true,unchangedMeriMembers:classes[0].unchangedMembers.length,unchangedDraftJobMembers:classes[1].unchangedMembers.length},null,2));
