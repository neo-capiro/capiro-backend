const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const ts = require('/workspace/capirov2/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript');
const repo = '/tmp/capirov2-cleanup-strategy-template-independent-review';
const root = path.resolve(__dirname, '../..');
const base = '9db4e1cd5589a05e08fb88caa38a4ac44937def5';
const head = 'd5c121973438a29a65515496f395f4ad7568d006';
const paths = ['auth/clerk.service.ts','tenant/tenant-context.middleware.ts','context/context-security-scope.service.ts',
 'context/context.module.ts','meri/meri.service.ts','meri/meri.controller.ts','auth/application-authority.ts','auth/application-authority.spec.ts'].map(p=>'apps/api/src/'+p);
const git = (...args) => cp.execFileSync('git', args, {cwd:repo,encoding:'utf8'});
const cases = [];
function check(name, pass) { cases.push({name,passed:Boolean(pass)}); }
check('exact eight changed paths', git('diff','--name-only',base,head).trim().split('\n').sort().join('\n') === [...paths].sort().join('\n'));
const bindings = paths.map(p => {
 const bytes=fs.readFileSync(path.join(root,p));
 const committed=cp.execFileSync('git',['show',head+':'+p],{cwd:repo});
 check('physical equals frozen '+p,bytes.equals(committed));
 return {path:p,gitBlob:git('rev-parse',head+':'+p).trim(),sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
});
function owner(source, targetName) {
 const file=ts.createSourceFile('owner.ts',source,ts.ScriptTarget.Latest,true);
 const clazz=file.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text===targetName);
 return {file,clazz, members:new Map(clazz.members.filter(n=>n.name||ts.isConstructorDeclaration(n)).map(n=>[ts.isConstructorDeclaration(n)?'constructor':n.name.getText(file),n]))};
}
for (const rel of ['auth/clerk.service.ts','context/context-security-scope.service.ts','meri/meri.service.ts','meri/meri.controller.ts','tenant/tenant-context.middleware.ts']) {
 const p='apps/api/src/'+rel;
 const targetName={'auth/clerk.service.ts':'ClerkService','context/context-security-scope.service.ts':'ContextSecurityScopeService',
 'meri/meri.service.ts':'MeriService','meri/meri.controller.ts':'MeriController','tenant/tenant-context.middleware.ts':'TenantContextMiddleware'}[rel];
 const original=owner(git('show',base+':'+p),targetName), current=owner(fs.readFileSync(path.join(root,p),'utf8'),targetName);
 for(const [name,node] of original.members) {
  const candidate=current.members.get(name);
  if(rel==='tenant/tenant-context.middleware.ts'&&name==='use') continue;
  if(rel==='meri/meri.service.ts'&&name==='constructor') {
   check('Meri original constructor parameters byte-exact', node.parameters.every((parameter,index)=>parameter.getText(original.file)===candidate.parameters[index]?.getText(current.file)));
   check('Meri constructor only two optional canonical owner additions',candidate.parameters.length===node.parameters.length+2&&candidate.parameters.slice(-2).map(n=>n.name.getText(current.file)).join('|')==='applicationAuthorityTenant|applicationAuthorityScope');
  } else check(rel+' original member '+name+' byte-exact',candidate&&node.getText(original.file)===candidate.getText(current.file));
 }
}
const middlewarePath='apps/api/src/tenant/tenant-context.middleware.ts';
const before=owner(git('show',base+':'+middlewarePath),'TenantContextMiddleware');
const after=owner(fs.readFileSync(path.join(root,middlewarePath),'utf8'),'TenantContextMiddleware');
let use=after.members.get('use').getText(after.file);
const additions=[
`    // Also cover authentication/authorization denials before the controller.
    const authorityPaths = [
      '/api/clio/application-authority/identity', '/api/clio/application-authority/context',
      '/clio/application-authority/identity', '/clio/application-authority/context',
    ];
    if ([req.path, (req.originalUrl ?? req.url ?? '').split('?')[0]].some(
      (path) => path !== undefined && authorityPaths.includes(path),
    )) res.setHeader('Cache-Control', 'no-store');
`,
`    let selectedAuthorityMembership: { id: string; tenantId: string } | undefined;
    let selectedAuthorityImpersonation: string | null = null;
`,
`      selectedAuthorityMembership = { id: chosen.id, tenantId: chosen.tenantId };
`,
`        selectedAuthorityImpersonation = session.id;
`,
`    if (selectedAuthorityMembership) {
      applicationAuthorityRequests.set(req, {
        context: ctx,
        claims: { ...claims },
        membershipId: selectedAuthorityMembership.id,
        membershipTenantId: selectedAuthorityMembership.tenantId,
        requestedSlug,
        impersonationId: selectedAuthorityImpersonation,
      });
    }
`,
];
for(const [index,addition] of additions.entries()) {
 check('exact one middleware instrumentation block '+index,use.split(addition).length===2);
 use=use.replace(addition,'');
}
check('whole original middleware use byte-exact outside explicit instrumentation',use===before.members.get('use').getText(before.file));
let contextModuleSource=fs.readFileSync(path.join(root,'apps/api/src/context/context.module.ts'),'utf8');
contextModuleSource=contextModuleSource.replace("import { ContextSecurityScopeService } from './context-security-scope.service.js';\n",'').replaceAll('    ContextSecurityScopeService,\n','');
check('whole ContextModule inverse byte-exact',contextModuleSource===git('show',base+':apps/api/src/context/context.module.ts'));
const delta=git('diff','--unified=0',base,head,'--',...paths.slice(0,6));
const removed=delta.split('\n').filter(line=>line.startsWith('-')&&!line.startsWith('---')).map(line=>line.slice(1));
check('only original lines replaced are three expanded imports',removed.length===3&&removed.every(line=>[
 "import { Injectable, Logger } from '@nestjs/common';",
 "import { Injectable } from '@nestjs/common';",
 "import { ClerkService, type ClerkSessionClaims } from '../auth/clerk.service.js';",
].includes(line)));
const result={base,head,tree:git('rev-parse',head+'^{tree}').trim(),total:cases.length,passed:cases.filter(c=>c.passed).length,failed:cases.filter(c=>!c.passed).length,cases,sourceBindings:bindings,
 limits:{fullCore:false,appBootstrap:false,prismaRuntime:false,providerCalls:false,protectedImplementationRead:false}};
fs.writeFileSync(path.join(__dirname,'evidence/17-source-preservation.json'),JSON.stringify(result,null,2)+'\n');
process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.failed?1:0;
