/*
 * Review-only ML-08/ML-10 reproduction. It reads and executes existing service
 * methods with fake storage/providers; it does not modify product files or
 * contact a provider. The desired safety assertions intentionally fail on the
 * audited baseline. This is outside the product Jest testMatch.
 *
 * Run from the repository root: NODE_PATH=<dependencies>/node_modules \
 *   node --test docs/a1/oauth-approval/reproduce.cjs
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');

const root = resolve(__dirname, '../../..');
const msPath = 'apps/api/src/engagement/microsoft/microsoft-oauth.service.ts';
const graphPath = 'apps/api/src/engagement/microsoft/microsoft-graph-sync.service.ts';
const googlePath = 'apps/api/src/engagement/google/google-oauth.service.ts';
const provider = { microsoft_365: 'microsoft_365', google_workspace: 'google_workspace' };
const status = { connected: 'connected', needs_configuration: 'needs_configuration' };
const bindings = {
  BadRequestException: Error,
  ForbiddenException: Error,
  NotFoundException: Error,
  ServiceUnavailableException: Error,
  EngagementProvider: provider,
  EngagementConnectionStatus: status,
  MICROSOFT_SCOPES: ['Mail.Read', 'Mail.Send'],
  GOOGLE_SCOPES: ['gmail.readonly', 'gmail.send'],
  STATE_TTL_SECONDS: 600,
  randomBytes: crypto.randomBytes,
  createHmac: crypto.createHmac,
  timingSafeEqual: crypto.timingSafeEqual,
  hasRequiredResourceScopes: () => true,
};

function source(path) {
  return ts.createSourceFile(path, readFileSync(resolve(root, path), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function compile(text, exportedName) {
  const js = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  new Function('exports', ...Object.keys(bindings), js)(exports, ...Object.values(bindings));
  return exports[exportedName];
}

function methods(path, className, names) {
  const ast = source(path);
  const cls = ast.statements.find((n) => ts.isClassDeclaration(n) && n.name?.text === className);
  assert.ok(cls, `missing ${className}`);
  const members = names.map((name) => {
    const member = cls.members.find((n) => n.name?.getText(ast) === name);
    assert.ok(member, `missing ${className}.${name}`);
    return member.getText(ast);
  });
  return compile(`export class Subject { ${members.join('\n')} }`, 'Subject');
}

function selector() {
  const ast = source(msPath);
  const fn = ast.statements.find((n) => ts.isFunctionDeclaration(n) &&
    n.name?.text === 'selectRefreshTokenForAccount');
  return compile(fn.getText(ast), 'selectRefreshTokenForAccount');
}

function cache(entries) {
  return JSON.stringify({ RefreshToken: Object.fromEntries(entries.map(([account, token]) =>
    [account, { home_account_id: account, secret: token }])) });
}

test('ML-10 OAuth: unmatched expected account never selects a different account', () => {
  assert.equal(selector()(cache([['A', 'token-A'], ['B', 'token-B']]), 'C'), undefined);
});

test('ML-10 OAuth: absent account with multiple cache entries fails closed', () => {
  assert.equal(selector()(cache([['A', 'token-A'], ['B', 'token-B']]), null), undefined);
});

test('ML-10 refresh: unmatched expected account never selects a different account', () => {
  const Subject = methods(graphPath, 'MicrosoftGraphSyncService', ['extractRotatedRefreshToken']);
  const service = new Subject();
  service.msal = { getTokenCache: () => ({ serialize: () => cache([['A', 'a'], ['B', 'b']]) }) };
  service.logger = { warn() {} };
  assert.equal(service.extractRotatedRefreshToken('C'), undefined);
});

for (const [name, path, className, providerName] of [
  ['Microsoft', msPath, 'MicrosoftOAuthService', 'microsoft_365'],
  ['Google', googlePath, 'GoogleOAuthService', 'google_workspace'],
]) {
  test(`ML-08 ${name}: empty top-level Connect creates an independent connection`, async () => {
    const Subject = methods(path, className, ['start']);
    const service = new Subject();
    const existing = { id: 'existing-A', provider: providerName, createdByUserId: 'actor-A' };
    let creations = 0;
    service.assertConfigured = () => {};
    service.prisma = { withTenant: async (_tenant, fn) => fn({ integrationConnection: {
      findFirst: async () => existing,
      create: async ({ data }) => { creations++; return { id: 'new-B', ...data }; },
    } }) };
    service.signState = () => 'signed-state';
    service.getMsal = () => ({ getAuthCodeUrl: async () => 'https://mock.invalid/authorize' });
    const result = await service.start({ tenantId: 'tenant-A', userId: 'actor-A' }, {});
    assert.equal(result.connectionId, 'new-B');
    assert.equal(creations, 1);
  });

  test(`ML-08 ${name}: callback persistence rejects changing A's stable identity to B`, async () => {
    const Subject = methods(path, className, ['persistToken']);
    const service = new Subject();
    const writes = [];
    const current = {
      id: 'connection-A', tenantId: 'tenant-A', provider: providerName,
      createdByUserId: 'actor-A', accountEmail: 'a@example.invalid',
      token: { homeAccountId: 'account-A', refreshTokenCiphertext: 'old-A-refresh' },
    };
    service.tokenCrypto = {
      encrypt: (value) => ({ ciphertext: value, iv: 'fake-iv', authTag: 'fake-tag' }),
      getKeyVersion: () => 'fake-v1',
    };
    service.prisma = { withTenant: async (_tenant, fn) => fn({
      integrationConnection: {
        findUnique: async () => current,
        update: async (args) => writes.push(['connection', args]),
      },
      integrationConnectionToken: {
        findUnique: async () => current.token,
        upsert: async (args) => writes.push(['token', args]),
      },
    }) };
    const expires = new Date('2030-01-01T00:00:00Z');
    const invoke = name === 'Microsoft'
      ? () => service.persistToken('tenant-A', 'connection-A', {
          accessToken: 'new-B-access', account: { homeAccountId: 'account-B', username: 'b@example.invalid' },
        }, undefined, expires)
      : () => service.persistToken('tenant-A', 'connection-A', {
          access_token: 'new-B-access',
        }, expires, { sub: 'account-B', email: 'b@example.invalid' });
    await assert.rejects(invoke);
    assert.equal(writes.length, 0);
  });
}

test('ML-10 refresh: a late response cannot overwrite a newer rotated token', async () => {
  const Subject = methods(graphPath, 'MicrosoftGraphSyncService', ['persistRefreshedAccessToken']);
  const service = new Subject();
  const current = { homeAccountId: 'A', refreshTokenCiphertext: 'newer-rotation' };
  service.logger = { warn() {} };
  service.tokenCrypto = {
    encrypt: (value) => ({ ciphertext: value, iv: 'fake-iv', authTag: 'fake-tag' }),
    getKeyVersion: () => 'fake-v1',
  };
  service.extractRotatedRefreshToken = () => 'older-late-rotation';
  service.prisma = { withTenant: async (_tenant, fn) => fn({
    integrationConnectionToken: {
      findUnique: async () => current,
      update: async ({ data }) => Object.assign(current, data),
    },
    integrationConnection: { update: async () => {} },
  }) };
  await service.persistRefreshedAccessToken('tenant-A', 'connection-A', {
    accessToken: 'older-access', scopes: ['Mail.Read', 'Mail.Send'],
  }, 'A');
  assert.equal(current.refreshTokenCiphertext, 'newer-rotation');
});

test('control: OAuth selector returns the exact account when it exists', () => {
  assert.equal(selector()(cache([['A', 'token-A'], ['B', 'token-B']]), 'A'), 'token-A');
});
