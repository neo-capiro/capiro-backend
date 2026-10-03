import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const root = 'C:/dev/main/outputs/meri-fresh-20261003';
const ctx = { tenantId:'f2d6cf8f-057c-479a-8110-62fe5086d43f', tenantSlug:'meri-foundation-20260928-t1', userId:'b1f758fc-17bd-40f8-bef2-fa2d2380300f', clerkUserId:'user_3Jw2FvWZkYGKmxWGx13tNJxFD2A', role:'standard_user' };
export { root, ctx };
export function aws(args) {
  try { return JSON.parse(execFileSync('C:/Program Files/Amazon/AWSCLIV2/aws.exe', [...args,'--profile','capiro-dev','--region','us-east-1','--output','json','--no-cli-pager'], {encoding:'utf8', windowsHide:true, stdio:['ignore','pipe','pipe'], maxBuffer:8*1024*1024, timeout:90000})); }
  catch(e) { throw new Error('AWS_COMMAND_FAILED_'+args.slice(0,2).join('_')); }
}
export function save(name, value) { writeFileSync(root+'/'+name, JSON.stringify(value,null,2)+'\n', {flag:'wx'}); }
export const need=(ok,code)=>{if(!ok) throw new Error(code)};
export async function withAuth(work) {
  const secret = aws(['secretsmanager','get-secret-value','--secret-id','arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/clerk/secret-key-FT67tM']).SecretString;
  need(typeof secret==='string' && /^sk_/.test(secret),'CLERK_SECRET_SHAPE');
  async function clerk(method,path,body) {
    const r=await fetch('https://api.clerk.com/v1'+path,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    const j=await r.json();
    if(!r.ok) throw new Error('CLERK_'+method+'_'+r.status+'_'+(j.errors?.[0]?.code||'FAILED'));
    return j;
  }
  const user=await clerk('GET','/users/'+ctx.clerkUserId);
  need(user.public_metadata?.fixtureNamespace==='meri-foundation-20260928' && /synthetic/i.test(user.first_name+' '+user.last_name),'SYNTHETIC_USER_MISMATCH');
  const membership=await clerk('GET','/users/'+ctx.clerkUserId+'/organization_memberships?limit=100');
  need(membership.total_count===1 && membership.data.length===1,'SYNTHETIC_MEMBERSHIP_COUNT');
  const m=membership.data[0];
  need(m.role==='org:member' && m.organization.slug===ctx.tenantSlug && m.organization.public_metadata?.fixtureNamespace==='meri-foundation-20260928','SYNTHETIC_ORG_MISMATCH');
  let session, ticket;
  const cookies=new Map();
  async function front(path,body) {
    const r=await fetch('https://clerk.app.capiro.ai/v1'+path,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Origin:'https://os.capiro.ai','Content-Type':'application/x-www-form-urlencoded',Cookie:[...cookies].map(([k,v])=>k+'='+v).join('; ')},body:new URLSearchParams(body)});
    for(const value of r.headers.getSetCookie()) { const pair=value.split(';')[0], pos=pair.indexOf('='); cookies.set(pair.slice(0,pos),pair.slice(pos+1)); }
    const j=await r.json();
    if(!r.ok) throw new Error('CLERK_FRONT_'+r.status+'_'+(j.errors?.[0]?.code||'FAILED'));
    return j.response??j;
  }
  try {
    ticket=await clerk('POST','/sign_in_tokens',{user_id:ctx.clerkUserId,expires_in_seconds:120});
    const signed=await front('/client/sign_ins',{strategy:'ticket',ticket:ticket.token});
    session={id:signed.created_session_id};
    need(session.id && signed.status==='complete','SESSION_NOT_ACTIVE');
    await front('/client/sessions/'+session.id+'/touch',{active_organization_id:m.organization.id,intent:'select_org'});
    const token=await front('/client/sessions/'+session.id+'/tokens/capiro',{});
    need(typeof token.jwt==='string','TOKEN_MISSING');
    const refresh=async()=>{const next=await front('/client/sessions/'+session.id+'/tokens/capiro',{});need(typeof next.jwt==='string','TOKEN_MISSING');return next.jwt;};
    return await work({bearer:token.jwt,refresh,clerk,sessionId:session.id,orgId:m.organization.id});
  } finally { if(session?.id) { const revoked=await clerk('POST','/sessions/'+session.id+'/revoke'); need(revoked.status==='revoked','SESSION_NOT_REVOKED'); } else if(ticket?.id) { await clerk('POST','/sign_in_tokens/'+ticket.id+'/revoke'); } }
}
if(process.argv[1]?.endsWith('auth-preflight.mjs')) {
  const result={run:'fresh-independent-benchmark',startedAt:new Date().toISOString(),newProviderTurns:0};
  try { await withAuth(async({bearer})=>{
    const r=await fetch('https://os.capiro.ai/api/me',{headers:{Authorization:'Bearer '+bearer,'User-Agent':'Capiro-Meri-Authorized-QA/1.0','x-capiro-tenant':ctx.tenantSlug},redirect:'error',signal:AbortSignal.timeout(30000)});
    const me=await r.json(); need(r.ok && me.tenant?.id===ctx.tenantId && me.user?.id===ctx.userId && me.role==='standard_user','ORDINARY_IDENTITY_UNVERIFIED_'+r.status);
    Object.assign(result,{status:'AUTH_READY',apiSha:r.headers.get('x-capiro-release-sha'),tenantId:ctx.tenantId,actorUserId:ctx.userId,role:me.role,meriv3Chat:me.features?.meriv3Chat});
  }); result.sessionRevoked=true; } catch(e) { Object.assign(result,{status:'BLOCKED',code:e.message}); process.exitCode=1; }
  save('auth-preflight-ticket.json',result); console.log(JSON.stringify(result));
}
