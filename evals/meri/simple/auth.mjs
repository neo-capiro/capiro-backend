// Signs in as the designated test account (neo@capiro.ai) in capiro-internal
// through a short-lived Clerk sign-in token: the same ordinary session a
// browser gets. Refuses any other account or organization and always revokes
// the session. The runner only reads and opens conversations; it never approves.
import { execFileSync } from 'node:child_process';

export const TENANT = {
  id: '17b63099-bc0f-4ac5-b596-496161e9481e',
  slug: 'capiro-internal',
  clerkOrgId: 'org_3DB7EKoeKfF8ZLu6cW4d9Vn6CT0',
};
export const TEST_ACCOUNT = 'neo@capiro.ai';
export const API = 'https://os.capiro.ai';
const need = (ok, code) => {
  if (!ok) throw new Error(code);
};

function aws(args) {
  return JSON.parse(
    execFileSync('C:/Program Files/Amazon/AWSCLIV2/aws.exe',
      [...args, '--profile', 'capiro-dev', '--region', 'us-east-1', '--output', 'json', '--no-cli-pager'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 << 20, timeout: 90000 }),
  );
}

export async function withTestAccount(work) {
  const secret = aws(['secretsmanager', 'get-secret-value', '--secret-id',
    'arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/clerk/secret-key-FT67tM']).SecretString;
  need(typeof secret === 'string' && /^sk_/.test(secret), 'CLERK_SECRET_SHAPE');
  const clerk = async (method, path, body) => {
    const r = await fetch('https://api.clerk.com/v1' + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`CLERK_${method}_${r.status}_${j.errors?.[0]?.code ?? 'FAILED'}`);
    return j;
  };
  const users = await clerk('GET', `/users?email_address=${encodeURIComponent(TEST_ACCOUNT)}`);
  need(Array.isArray(users) && users.length === 1, 'TEST_ACCOUNT_NOT_UNIQUE');
  const user = users[0];
  need(user.email_addresses.some((e) => e.email_address.toLowerCase() === TEST_ACCOUNT), 'TEST_ACCOUNT_MISMATCH');
  const memberships = await clerk('GET', `/users/${user.id}/organization_memberships?limit=100`);
  need(memberships.data.some((m) => m.organization.id === TENANT.clerkOrgId && m.organization.slug === TENANT.slug),
    'TEST_ACCOUNT_NOT_IN_CAPIRO_INTERNAL');
  const cookies = new Map();
  const front = async (path, body) => {
    const r = await fetch('https://clerk.app.capiro.ai/v1' + path, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Origin: API, 'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: new URLSearchParams(body),
    });
    for (const value of r.headers.getSetCookie()) {
      const pair = value.split(';')[0], at = pair.indexOf('=');
      cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    const j = await r.json();
    if (!r.ok) throw new Error(`CLERK_FRONT_${r.status}_${j.errors?.[0]?.code ?? 'FAILED'}`);
    return j.response ?? j;
  };
  let session, ticket;
  try {
    ticket = await clerk('POST', '/sign_in_tokens', { user_id: user.id, expires_in_seconds: 120 });
    const signed = await front('/client/sign_ins', { strategy: 'ticket', ticket: ticket.token });
    session = { id: signed.created_session_id };
    need(session.id && signed.status === 'complete', 'SESSION_NOT_ACTIVE');
    await front(`/client/sessions/${session.id}/touch`, { active_organization_id: TENANT.clerkOrgId, intent: 'select_org' });
    const token = async () => {
      const next = await front(`/client/sessions/${session.id}/tokens/capiro`, {});
      need(typeof next.jwt === 'string', 'TOKEN_MISSING');
      return next.jwt;
    };
    const request = async (path, method = 'GET', body, timeoutMs = 60000) =>
      fetch(API + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: 'Bearer ' + (await token()), 'x-capiro-tenant': TENANT.slug,
          'User-Agent': 'Capiro-Meri-Authorized-QA/1.0', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    const json = async (path, method, body) => {
      const r = await request(path, method, body);
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP_${r.status}_${method ?? 'GET'}_${path.split('?')[0]}: ${text.slice(0, 200)}`);
      return text ? JSON.parse(text) : null;
    };
    const me = await json('/api/me');
    need(me.tenant?.id === TENANT.id, 'ORDINARY_TENANT_MISMATCH');
    const upload = async (path, filename, bytes, mime) => {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: mime }), filename);
      const r = await fetch(API + path, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000), body: form,
        headers: { Authorization: 'Bearer ' + (await token()), 'x-capiro-tenant': TENANT.slug, 'User-Agent': 'Capiro-Meri-Authorized-QA/1.0' },
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`UPLOAD_${r.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    };
    const download = async (path) => {
      const r = await fetch(path.startsWith('http') ? path : API + path, {
        redirect: 'follow', signal: AbortSignal.timeout(120000),
        headers: { Authorization: 'Bearer ' + (await token()), 'x-capiro-tenant': TENANT.slug, 'User-Agent': 'Capiro-Meri-Authorized-QA/1.0' },
      });
      return { status: r.status, contentType: r.headers.get('content-type'), bytes: Buffer.from(await r.arrayBuffer()) };
    };
    return await work({ me, request, json, upload, download });
  } finally {
    if (session?.id) await clerk('POST', `/sessions/${session.id}/revoke`);
    else if (ticket?.id) await clerk('POST', `/sign_in_tokens/${ticket.id}/revoke`);
  }
}
