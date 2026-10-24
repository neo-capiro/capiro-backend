import { EventEmitter } from 'node:events';
import { ForbiddenException } from '@nestjs/common';
import { MeriController } from './meri.controller.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';
import type { TenantContext } from '@capiro/shared';
import type { Request } from 'express';
const ctx:TenantContext={tenantId:'11111111-1111-4111-8111-111111111111',userId:'22222222-2222-4222-8222-222222222222',clerkUserId:'user_synthetic',tenantSlug:'synthetic',role:'standard_user'};
function fixture(secret?:string){const req=Object.assign(new EventEmitter(),{headers:secret?{'x-internal-service-secret':secret}:{},aborted:false,res:Object.assign(new EventEmitter(),{writableEnded:false,destroyed:false})}) as Request;
 const read=jest.fn(async()=>({synthetic:true}));const controller=Object.assign(Object.create(MeriController.prototype),{automaticClientContext:{read}}) as MeriController;
 const guard=new ToolServiceSecretGuard({get:(key:string)=>({NODE_ENV:'test',INTERNAL_SERVICE_SECRET:'synthetic-service',MERI_TOOLS_REQUIRE_SERVICE_SECRET:false})[key]} as never);
 guard.canActivate({switchToHttp:()=>({getRequest:()=>req})} as never);return {req,read,controller};}
test('automatic route refuses observe-only guard admission without verified service identity',()=>{for(const secret of [undefined,'wrong']){const f=fixture(secret);expect(()=>f.controller.automaticContext(ctx,{},f.req)).toThrow(ForbiddenException);expect(f.read).not.toHaveBeenCalled();}});
test('verified private service request passes only the actual authenticated actor context',async()=>{const f=fixture('synthetic-service'),body={schemaVersion:1,clientId:'33333333-3333-4333-8333-333333333333'};await f.controller.automaticContext(ctx,body,f.req);expect(f.read).toHaveBeenCalledWith(ctx,body);expect(f.req.listenerCount('aborted')).toBe(0);expect(f.req.res!.listenerCount('close')).toBe(0);});
