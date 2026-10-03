import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync,existsSync } from 'node:fs';
import { aws } from '../meri-fresh-20261003/auth-preflight.mjs';
const output='C:/dev/main/outputs/meri-c2-20261003/case01-token-lifetime-readback-v2.json';
assert.equal(existsSync(output),false);
const require=createRequire('C:/dev/main/meri-c1-20261002/apps/api/package.json');
const {createClerkClient}=require('@clerk/backend');
const secret=aws(['secretsmanager','get-secret-value','--secret-id','arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/clerk/secret-key-FT67tM']).SecretString;
assert.equal(typeof secret,'string'); assert.equal(/^sk_/u.test(secret),true);
const clerk=createClerkClient({secretKey:secret});
const templates=await clerk.jwtTemplates.list({limit:100});
const rows=Array.isArray(templates)?templates:templates.data; assert.equal(Array.isArray(rows),true); const selected=rows.filter(row=>row.name==='capiro');
assert.equal(selected.length,1);
const result={status:'READ_ONLY_TOKEN_TEMPLATE_LIFETIME',observedAt:new Date().toISOString(),name:'capiro',
  lifetimeSeconds:selected[0].lifetime,allowedClockSkewSeconds:selected[0].allowedClockSkew,
  templateWrites:0,sessionsCreated:0,providerCalls:0,claimsOrCredentialsPersisted:false};
writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result));
