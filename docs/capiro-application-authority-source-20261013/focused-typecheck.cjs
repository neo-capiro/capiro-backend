const fs = require('node:fs');
const path = require('node:path');
const child = require('node:child_process');
const ts = require('/workspace/capirov2/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript');
const root = path.resolve(__dirname, '../..');
const api = path.join(root, 'apps/api/src');
const virtual = new Map();
const put = (name, source) => virtual.set(path.join(api, name), source);
put('prisma/prisma.service.ts', `import type { Prisma } from '@prisma/client'; export declare class PrismaService {
 withTenant<T>(id:string, fn:(tx:Prisma.TransactionClient)=>Promise<T>):Promise<T>;
 withSystem<T>(fn:(tx:Prisma.TransactionClient)=>Promise<T>):Promise<T>;
}`);
put('config/config.schema.ts', 'export interface AppConfig { CLERK_SECRET_KEY:string; CLERK_JWT_ISSUER?:string; }');
put('auth/clerk-role.util.ts', `import type { TenantRole } from '@capiro/shared'; export declare function mapClerkRoleToCapiro(role:string|undefined,slug:string):TenantRole;`);
put('tenant/tenant-context.store.ts', `import type { TenantContext } from '@capiro/shared'; export declare class TenantContextStore { run<T>(ctx:TenantContext, fn:()=>T):T; }`);
put('context/context.types.ts', `export declare class ContextResolutionError extends Error { constructor(code:string,message:string,details?:unknown); }
export interface ContextSecurityScopeInput { authorizedClientIds?:readonly string[]; authorizedMailboxConnectionIds?:readonly string[]; allowGlobalPublic?:boolean; allowExternalResearch?:boolean; graphPartitions?:readonly unknown[]; }
export interface ResolvedContextSecurityScope { tenantId:string; actorUserId:string; authorizedClientIds:string[]; authorizedMailboxConnectionIds:string[]; allowGlobalPublic:boolean; allowExternalResearch:boolean; graphPartitions:unknown[]; }`);
const sharedSource = child.execFileSync('git', ['show', '9db4e1cd5589a05e08fb88caa38a4ac44937def5:packages/shared/src/index.ts'], { cwd: '/tmp/capirov2-cleanup-strategy-template-independent-review', encoding: 'utf8' });
const sharedAST = ts.createSourceFile('shared.ts', sharedSource, ts.ScriptTarget.Latest, true);
const sharedNames = ['TENANT_ROLES','TenantRole','AUTH_DENIED_REASONS','AuthDeniedReason','TenantContext','TENANT_HEADER','authDeniedEvent'];
const shared = sharedAST.statements.filter(node => {
  if (ts.isVariableStatement(node)) return node.declarationList.declarations.some(d => sharedNames.includes(d.name.getText(sharedAST)));
  return node.name && sharedNames.includes(node.name.getText(sharedAST));
}).map(node => node.getText(sharedAST)).join('\n');
put('__shared.ts', shared);
const serviceSource = fs.readFileSync(path.join(api, 'meri/meri.service.ts'), 'utf8');
const serviceAST = ts.createSourceFile('service.ts', serviceSource, ts.ScriptTarget.Latest, true);
const clazz = serviceAST.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'MeriService');
const names = ['applicationAuthorityIdentity','applicationAuthorityContext','ensureConversation','ensureClientVisible'];
const methods = clazz.members.filter(n => ts.isMethodDeclaration(n) && names.includes(n.name.getText(serviceAST))).map(n=>n.getText(serviceAST));
put('__meri-selected.ts', `import { ForbiddenException,NotFoundException } from '@nestjs/common';
import type { Request } from 'express'; import type { TenantContext } from '@capiro/shared';
import { PrismaService } from './prisma/prisma.service.js';
import { TenantContextMiddleware } from './tenant/tenant-context.middleware.js';
import { ContextSecurityScopeService } from './context/context-security-scope.service.js';
import { assertApplicationAuthorityIdentityBody,parseApplicationAuthorityContextBody,applicationAuthorityIdentityReceipt,readApplicationAuthorityContext } from './auth/application-authority.js';
declare function authorizeResearchPortfolioConversation(tx:unknown,ctx:TenantContext,row:unknown):Promise<unknown>;
declare function authorizeMeriProspectScope(owner:unknown,ctx:TenantContext,metadata:unknown):Promise<{prospectId:string;canonicalOrganizationId:string|null;linkedClientId:string|null;scopeVersion:string}|null>;
export class SelectedMeriOwner {
declare prisma: PrismaService; declare applicationAuthorityTenant?:TenantContextMiddleware;
declare applicationAuthorityScope?:ContextSecurityScopeService; declare bizdevScope?:unknown;
${methods.join('\n')}
}`);
const controllerSource = fs.readFileSync(path.join(api, 'meri/meri.controller.ts'), 'utf8');
const controllerAST = ts.createSourceFile('controller.ts', controllerSource, ts.ScriptTarget.Latest, true);
const controller = controllerAST.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'MeriController');
const routeMethods = controller.members.filter(n => ts.isMethodDeclaration(n) && ['applicationAuthorityIdentity','applicationAuthorityContext'].includes(n.name.getText(controllerAST))).map(n=>n.getText(controllerAST));
put('__controller-selected.ts', `import { Body,Post,HttpCode,Header,Req } from '@nestjs/common'; import type { Request } from 'express'; import type { TenantContext } from '@capiro/shared'; import {SelectedMeriOwner} from './__meri-selected'; declare function CurrentTenant():ParameterDecorator; export class SelectedController { declare service: SelectedMeriOwner; ${routeMethods.join('\n')} }`);
const options = { target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,moduleResolution:ts.ModuleResolutionKind.Node10,
 strict:true,noUncheckedIndexedAccess:true,skipLibCheck:true,experimentalDecorators:true,esModuleInterop:true,noEmit:true,
 types:['node'],typeRoots:['/workspace/capirov2/apps/api/node_modules/@types'] };
const host = ts.createCompilerHost(options);
const originalRead = host.readFile.bind(host), originalExists = host.fileExists.bind(host);
const originalDirectoryExists = host.directoryExists.bind(host);
host.directoryExists = name => [...virtual.keys()].some(file => file.startsWith(name + '/')) || originalDirectoryExists(name);
host.readFile = name => {
  if (name.endsWith('/engagement.service.ts')) throw new Error('Protected reporting source read forbidden');
  return virtual.has(name) ? virtual.get(name) : originalRead(name);
};
host.fileExists = name => virtual.has(name) || originalExists(name);
host.resolveModuleNames = (names, containing) => names.map(name => {
  if (name === '@capiro/shared') return { resolvedFileName:path.join(api,'__shared.ts'),extension:ts.Extension.Ts };
  const lookup = containing.startsWith(api) && !name.startsWith('.') && !name.startsWith('/')
    ? '/workspace/capirov2/apps/api/src/__authority_type_host.ts' : containing;
  const result = ts.resolveModuleName(name, lookup, options, host).resolvedModule;
  return result;
});
const roots = ['auth/application-authority.ts','auth/application-authority.spec.ts','auth/clerk.service.ts',
 'tenant/tenant-context.middleware.ts','context/context-security-scope.service.ts','__meri-selected.ts','__controller-selected.ts'].map(p=>path.join(api,p));
const program = ts.createProgram(roots, options, host);
const diagnostics = ts.getPreEmitDiagnostics(program);
process.stdout.write(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory:()=>root,getCanonicalFileName:n=>n,getNewLine:()=> '\n'}));
process.stdout.write(JSON.stringify({ diagnostics:diagnostics.length,roots:7,actualOwners:5,
 selectedMeriMethods:methods.length,selectedControllerMethods:routeMethods.length,
 fullCore:false,protectedImplementationRead:false,prismaRuntime:false })+'\n');
process.exitCode = diagnostics.length ? 1 : 0;
