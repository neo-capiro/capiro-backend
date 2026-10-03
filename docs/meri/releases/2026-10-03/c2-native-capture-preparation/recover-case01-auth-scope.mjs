// Read-only recovery of authentication locators for the existing Pat/T1 fixture.
// This is not a fixture manifest, seed receipt, binding or capture capability.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync, existsSync } from 'node:fs';
import { aws } from '../meri-fresh-20261003/auth-preflight.mjs';
import { assertCase01SyntheticIdentity } from './case01-native-bootstrap-v2/run-case01-native.mjs';

const root = 'C:/dev/main/outputs/meri-c2-20261003';
const require = createRequire('C:/dev/main/meri-c1-20261002/apps/api/package.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (name, value) => {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const fd = openSync(root + '/' + name, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  return { path: name, bytes: bytes.length, sha256: hash(bytes) };
};
assert.equal(existsSync(root + '/case01-recovered-auth-scope.private.json'), false);
assert.equal(existsSync(root + '/case01-auth-scope-readback.json'), false);
const journalPath = 'C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl';
const journalHash = hash(readFileSync(journalPath));
assert.equal(journalHash, 'abe458973e6998db20586c781ac5a3cbd4ca2fa565425e62722f0eb9c985210b');
assert.equal(hash(readFileSync(root + '/case01-native-bootstrap-v2/run-case01-native.mjs')),
  '655cc278a1a76ff55cf7a0ceae96ccfc325a016e0e3a0d53c21f43f276c171d1');
const canonicalBytes = readFileSync(root + '/case01-canonical-bind-plan-v1/result.json');
const canonical = JSON.parse(canonicalBytes);
assert.equal(canonical.exitCode, 0);
const proof = canonical.receipts.find(row => row.status === 'CANONICAL_BINDING_PLAN_ONLY');
assert.equal(proof.plan.status, 'READY');
assert.deepEqual(proof.request, {
  tenantId: 'f2d6cf8f-057c-479a-8110-62fe5086d43f',
  tenantSlug: 'meri-foundation-20260928-t1',
  actorUserId: 'b1f758fc-17bd-40f8-bef2-fa2d2380300f',
  clerkUserId: 'user_3Jw2FvWZkYGKmxWGx13tNJxFD2A',
  clientId: '41f9ec63-3963-479f-b747-59a3767ef44b',
  caseId: '01', captureRunId: 'bd35c0f4-1604-4371-b7e9-a1338369e53f',
});
assert.equal(aws(['sts', 'get-caller-identity']).Arn, 'arn:aws:iam::967807252336:user/capirocli');
const secret = aws(['secretsmanager', 'get-secret-value', '--secret-id',
  'arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/clerk/secret-key-FT67tM']).SecretString;
assert.match(secret, /^sk_/u);
const { createClerkClient } = require('@clerk/backend');
const clerk = createClerkClient({ secretKey: secret });
const [instance, user, memberships] = await Promise.all([
  clerk.instance.get(),
  clerk.users.getUser(proof.request.clerkUserId),
  clerk.users.getOrganizationMembershipList({ userId: proof.request.clerkUserId, limit: 100 }),
]);
assert.equal(memberships.totalCount, 1);
assert.equal(memberships.data.length, 1);
const membership = memberships.data[0];
assert.equal(membership.organization.slug, proof.request.tenantSlug);
assert.equal(membership.role, 'org:member');
const organization = await clerk.organizations.getOrganization({ organizationId: membership.organization.id });
const namespace = 'meri-foundation-20260928';
const emails = user.emailAddresses.filter(row => row.emailAddress.includes(namespace) && row.emailAddress.endsWith('@example.com'));
assert.equal(emails.length, 1);
const manifest = {
  kind: 'meri-case01-recovered-auth-scope',
  scope: 'AUTH_IDENTITY_ONLY_NOT_FIXTURE_MANIFEST',
  namespace, target: 'capiro-dev', status: 'ready',
  recoveredAt: new Date().toISOString(),
  source: { canonicalLocatorReceipt: 'case01-canonical-bind-plan-v1/result.json', canonicalLocatorReceiptSha256: hash(canonicalBytes),
    clerkReadOnlyOperations: ['instance.get', 'users.getUser', 'users.getOrganizationMembershipList', 'organizations.getOrganization'] },
  targetBinding: { clerkInstanceId: instance.id },
  ids: { tenants: { t1: { tenantId: proof.request.tenantId, clerkOrgId: organization.id } },
    users: { pat: { userId: proof.request.actorUserId, clerkUserId: proof.request.clerkUserId } } },
  handles: { users: { pat: emails[0].emailAddress } },
  fixtureAuthority: false, captureAuthority: false,
};
const config = {
  caseId: '01', captureRunId: proof.request.captureRunId,
  scope: {
    actors: { PAT: { userId: proof.request.actorUserId, clerkUserId: proof.request.clerkUserId,
      role: 'standard_user', tenantPhysicalId: proof.request.tenantId } },
    tenants: { T1: { physicalId: proof.request.tenantId } },
    clients: { ASTER: { physicalId: proof.request.clientId } },
  },
};
assertCase01SyntheticIdentity({ manifest, config, instance, user, organization, memberships });
assert.equal(hash(readFileSync(journalPath)), journalHash);
const artifact = save('case01-recovered-auth-scope.private.json', manifest);
const result = {
  status: 'EXISTING_SYNTHETIC_AUTH_IDENTITY_READ_ONLY_PASS', recordedAt: new Date().toISOString(),
  actor: 'PAT', tenant: 'T1', client: 'ASTER', role: 'standard_user',
  localAuthScope: artifact, canonicalLocatorReceiptSha256: hash(canonicalBytes), journalSha256: journalHash,
  oldPrivateManifest: 'Not found in referenced evidence location; identity locators recovered from retained canonical receipt and four live Clerk reads.',
  validation: 'Actual bootstrap assertCase01SyntheticIdentity passed against the four returned SDK objects.',
  protectedBoundaries: 'Canonical fixture, binding, qualification and native capture authority remain separate and are rechecked by their existing owners.',
  actualActions: { clerkReads: 4, authenticationSessionsCreated: 0, signInTicketsCreated: 0, conversationCreations: 0,
    providerCalls: 0, journalWrites: 0, databaseWrites: 0, fixtureMutations: 0, secretsPersisted: 0, nativeOperatorExecutions: 0 },
  captureAuthority: false, liveAcceptance: 'NOT_RUN',
};
save('case01-auth-scope-readback.json', result);
console.log(JSON.stringify({ status: result.status, authScopeSha256: artifact.sha256,
  sessionsCreated: 0, providerCalls: 0, journalWrites: 0, secretsPersisted: 0 }));
