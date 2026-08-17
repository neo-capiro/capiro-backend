import assert from 'node:assert/strict';
import test from 'node:test';
import { isRoleSafe } from './health.service.ts';

const safe = {
  currentUser: 'capiro_defense_serve_login',
  capabilityMember: true,
  isSuperuser: false,
  hasBypassRls: false,
  hasCreateDb: false,
  hasCreateRole: false,
  hasSchemaCreate: false,
  isPromoterMember: false,
  canMutateActiveSnapshot: false,
  unexpectedDirectGrantCount: 0,
} as const;

test('a login with only capability-role membership is safe', () => {
  assert.equal(isRoleSafe(safe), true);
});

test('a login not a member of the capability role is unsafe', () => {
  assert.equal(isRoleSafe({ ...safe, capabilityMember: false }), false);
});

test('a superuser login is unsafe even if it is also a capability member', () => {
  assert.equal(isRoleSafe({ ...safe, isSuperuser: true }), false);
});

test('a BYPASSRLS login is unsafe', () => {
  assert.equal(isRoleSafe({ ...safe, hasBypassRls: true }), false);
});

test('a CREATEDB login is unsafe', () => {
  assert.equal(isRoleSafe({ ...safe, hasCreateDb: true }), false);
});

test('a CREATEROLE login is unsafe', () => {
  assert.equal(isRoleSafe({ ...safe, hasCreateRole: true }), false);
});

test('a login with schema CREATE is unsafe', () => {
  assert.equal(isRoleSafe({ ...safe, hasSchemaCreate: true }), false);
});

test('a login that is also a member of the promoter role is unsafe', () => {
  assert.equal(isRoleSafe({ ...safe, isPromoterMember: true }), false);
});

test('a login that can mutate the active-snapshot pointer is unsafe', () => {
  assert.equal(isRoleSafe({ ...safe, canMutateActiveSnapshot: true }), false);
});

test('a login with an unexpected direct grant is unsafe', () => {
  assert.equal(isRoleSafe({ ...safe, unexpectedDirectGrantCount: 1 }), false);
});
